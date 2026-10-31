/**
 * 平台网络层拦截器（注入 AI 网页主世界执行）。
 *
 * 与 DOM 方案的根本差异：这里直接 hook fetch/XHR 读取服务端 SSE 流，
 * 因此不依赖任何 DOM 选择器 —— 平台改版不会导致回复收不到。
 * 只观察、不改写：克隆响应体读一份副本，页面自身消费原 body。
 *
 * 派发的事件（主世界 window）：
 *   lidow-ai-stream   { text, think, finished, accumulatedTokens }
 *   lidow-ai-response { text, finished, status, tokenUsage, msgIds }
 *   lidow-ai-error    { text, reason, bizCode }
 * 由 overlay preload 通过 window.addEventListener 接收后转 IPC 上报主进程。
 */

export interface ProviderHookSpec {
  /** 平台 id（日志用） */
  id: string
  /** 判定是否为对话补全请求 */
  isCompletion: (url: string, method: string) => boolean
  /** 判定是否为「用户主动停止」请求 */
  isStopStream?: (url: string, method: string) => boolean
  /** 从 SSE 帧对象中提取回复文本（返回增量） */
  extract: (
    frame: unknown,
    ctx?: ExtractCtx
  ) => {
    text?: string
    /** true 时 text 是本轮完整文本，直接替换累计值（新协议整段快照） */
    replace?: boolean
    think?: string
    finished?: boolean
    incomplete?: boolean
    exhausted?: boolean
  } | null
  /** 从帧对象捕获 token/消息 id（可选） */
  captureMeta?: (frame: unknown) => { accumulatedTokens?: number; msgIds?: unknown } | null
  /**
   * 请求体里「用户输入」的字段名。给了就会在发送前把系统提示词前缀拼进该字段 ——
   * 这样即使用户直接在网页输入框里发送，AI 也能拿到工具协议与工作目录。
   */
  promptField?: string
  /** 请求体里的对话 id 字段（如 chat_session_id）：用于判断该网页对话是否已注入过系统提示词 */
  sessionField?: string
}

/** DeepSeek 补齐帧：p/v 增量补丁 + response/fragments 结构 */
interface ExtractResult {
  text?: string
  /** true 时 text 是本轮完整文本，直接替换累计值 */
  replace?: boolean
  think?: string
  finished?: boolean
  incomplete?: boolean
  /** 上下文耗尽（平台侧明确提示开新会话），触发自动续接而非普通重试 */
  exhausted?: boolean
}

/**
 * 片段类型表容器：DeepSeek 先下发 fragments 数组（含 type），之后的增量补丁
 * 只给 `response/fragments/-1/content` 这样的路径 —— 不带类型。必须记住每个
 * 下标的类型，否则思考内容会被当成正文流进对话（实测：思考过程整段显示）。
 *
 * 必须是「每条流独立」的状态：做成模块级数组时，多次会话会串数据
 * （测试里连续调用即失败）。所以由调用方传进来。
 */
interface ExtractCtx {
  fragmentTypes: string[]
  /** 当前正在追加的片段下标（-1 = 未知）：顶层 {v:"..."} 帧靠它区分 THINK / 正文 */
  currentIndex: number
  /** 是否已经处理过首个快照（后续快照只同步类型，不重复追加内容） */
  observed: boolean
  /** ChatGPT 新版 Workspace 的增量/patch 流状态 */
  chatgpt?: { id: string; text: string }
  /** Claude 旧协议 completion 字段可能是累计快照，用来算增量 */
  claudeText?: string
}

/** DeepSeek 补齐帧提取：p/v 增量补丁 + fragments APPEND + BATCH 展开（cuckoo 同款逻辑） */
function deepseekExtract(
  frame: unknown,
  ctx: ExtractCtx = { fragmentTypes: [], currentIndex: -1, observed: false }
): ExtractResult | null {
  const f = frame as Record<string, unknown>
  if (!f || typeof f !== 'object') return null
  const p = typeof f.p === 'string' ? f.p : undefined
  const v = f.v

  // BATCH 批量帧：{ o: 'BATCH', v: [子帧...] } → 逐个提取后合并
  if (f.o === 'BATCH' && Array.isArray(v)) {
    const merged: ExtractResult = {}
    for (const sub of v) {
      const r = deepseekExtract(sub, ctx)
      if (!r) continue
      if (r.text) merged.text = (merged.text ?? '') + r.text
      if (r.think) merged.think = (merged.think ?? '') + r.think
      if (r.finished) merged.finished = true
      if (r.incomplete) merged.incomplete = true
      if (r.exhausted) merged.exhausted = true
    }
    return Object.keys(merged).length > 0 ? merged : null
  }

  if (p === 'response/status' || p === 'quasi_status') {
    if (v === 'FINISHED') return { finished: true }
    if (v === 'INCOMPLETE') return { incomplete: true }
    return null
  }

  // 快照帧：{v:{response:{fragments:[{type,content}...]}}} —— 回复首段内容在这里。
  // 类型表整体替换；只有首个快照消费内容（后续快照可能是重复/更新，避免重复追加）。
  if (p === undefined && v && typeof v === 'object') {
    const resp = (v as Record<string, unknown>).response as Record<string, unknown> | undefined
    if (resp && typeof resp === 'object') {
      const frags = resp.fragments
      if (Array.isArray(frags) && frags.length > 0) {
        const types = frags.map((fr) =>
          String((fr as { type?: string })?.type ?? 'RESPONSE').toUpperCase()
        )
        ctx.fragmentTypes = types
        ctx.currentIndex = types.length - 1
        const first = !ctx.observed
        ctx.observed = true
        if (!first) return null
        const merged: ExtractResult = {}
        for (let i = 0; i < frags.length; i++) {
          const fr = frags[i] as { content?: string; text?: string }
          const content =
            typeof fr?.content === 'string'
              ? fr.content
              : typeof fr?.text === 'string'
                ? fr.text
                : ''
          if (!content) continue
          if (types[i] === 'THINK') merged.think = (merged.think ?? '') + content
          else merged.text = (merged.text ?? '') + content
        }
        return Object.keys(merged).length > 0 ? merged : null
      }
    }
  }

  // fragments APPEND：{ p: '<path>/fragments', o: 'APPEND', v: [{type, content}...] }
  if (p && p.endsWith('/fragments') && f.o === 'APPEND' && Array.isArray(v)) {
    const merged: ExtractResult = {}
    for (const frag of v) {
      const fr = frag as { type?: string; content?: string; text?: string }
      const type = String(fr?.type ?? 'RESPONSE').toUpperCase()
      ctx.fragmentTypes.push(type)
      const content =
        typeof fr?.content === 'string' ? fr.content : typeof fr?.text === 'string' ? fr.text : ''
      if (!content) continue
      if (type === 'THINK') merged.think = (merged.think ?? '') + content
      else merged.text = (merged.text ?? '') + content
    }
    ctx.currentIndex = ctx.fragmentTypes.length - 1
    return Object.keys(merged).length > 0 ? merged : null
  }

  // 文本增量补丁：p 形如 response/fragments/-1/content
  if (p && typeof v === 'string') {
    // reasoning_content / thinking_content 独立帧：内容已包含在 THINK 片段里，
    // 再追加会重复（对齐 cuckoo：这类帧直接忽略）
    if (/reasoning_content|thinking_content$/.test(p)) return null
    if (/(content|text|markdown|delta)$/.test(p)) {
      // 按片段下标判断它到底是 THINK 还是正文：
      // -1 表示当前片段。不查类型表的话，思考内容会被当正文显示（实测踩中）
      const m = /\/fragments\/(-?\d+)\//.exec(p)
      const raw = m ? Number(m[1]) : -1
      const idx = raw === -1 ? ctx.currentIndex : raw
      const type = idx >= 0 ? (ctx.fragmentTypes[idx] ?? '') : ''
      if (type === 'THINK') return { think: v }
      return { text: v }
    }
  }
  // 顶层 {v: string} 帧：DeepSeek 思考/正文的绝大多数增量都是这种形式，
  // 必须按当前片段类型归类 —— 此前一律当正文，导致思考整段漏进气泡。
  if (p === undefined && typeof v === 'string') {
    const type = ctx.fragmentTypes[ctx.currentIndex] ?? ''
    return type === 'THINK' ? { think: v } : { text: v }
  }
  return null
}

/** 生成注入主世界的自包含 IIFE 源码 */
export function buildHookSource(
  spec: ProviderHookSpec,
  sysPrompt = '',
  repeatSysPrompt = false
): string {
  // 内联进模板前先做一次 JS 字符串字面量转义（含换行/引号/反斜杠）
  const sysLiteral = JSON.stringify(sysPrompt)
  const promptField = spec.promptField ? JSON.stringify(spec.promptField) : 'null'
  const sessionField = spec.sessionField ? JSON.stringify(spec.sessionField) : 'null'
  const repeatLiteral = repeatSysPrompt ? 'true' : 'false'
  return String.raw`(() => {
  var MARKER = '__lidowHookInstalled__';
  var SYS_PROMPT = ${sysLiteral};
  var PROMPT_FIELD = ${promptField};
  var SESSION_FIELD = ${sessionField};
  var REPEAT_SYS_PROMPT = ${repeatLiteral};
  // 已装过：刷新配置后直接返回，避免重复包一层 fetch/XHR。
  if (window[MARKER]) {
    window['__lidowSysPrompt__'] = SYS_PROMPT;
    window['__lidowRepeatSysPrompt__'] = REPEAT_SYS_PROMPT;
    window['__lidowSessionField__'] = SESSION_FIELD;
    return;
  }
  window[MARKER] = true;
  window['__lidowSysPrompt__'] = SYS_PROMPT;
  window['__lidowRepeatSysPrompt__'] = REPEAT_SYS_PROMPT;
  window['__lidowSessionField__'] = SESSION_FIELD;

  var isCompletion = ${spec.isCompletion};
  var isStopStream = ${spec.isStopStream ?? 'function () { return false; }'};
  var extractFn = ${spec.extract};
  // 片段类型表由每条流各自持有（见 streamCtx）：多请求并发/重试时互不覆盖。
  // deepseekExtract 用它区分 THINK 与正文。
  function extract(f, ctx) {
    try { return extractFn(f, ctx); } catch (e) { return null; }
  }
  var userStopped = false;
  // 已被 lidow 自己注入过的 prompt 打标，避免同一请求重复拼接
  var INJECT_TAG = '__lidow_injected__';

  // 系统提示词注入状态：同一网页对话只注入一次（设置里显式开启“每轮注入”除外）。
  // 标记按对话 id 存在 sessionStorage，跨页面重载仍有效。
  var SYS_MARK_PREFIX = 'lidow:sysSent:';
  var SYS_PENDING_KEY = 'lidow:sysSent:pending';
  var newChatInjected = false;

  function currentPath() {
    try { return typeof location !== 'undefined' ? String(location.pathname) : '' } catch (e) { return '' }
  }
  function isChatUrl(path) {
    return /\/chat\/s\/[a-f0-9-]+/i.test(path);
  }
  function looksLikeNewChat() {
    return !isChatUrl(currentPath());
  }
  function conversationKey(obj) {
    var field = window['__lidowSessionField__'];
    var sid = field && obj ? obj[field] : null;
    if (sid !== undefined && sid !== null && String(sid)) return 'sid:' + String(sid);
    var m = /\/chat\/s\/([a-f0-9-]+)/i.exec(currentPath());
    if (m) return 'sid:' + m[1];
    return 'new';
  }
  function hasSysMark(key) {
    try { return sessionStorage.getItem(SYS_MARK_PREFIX + key) === '1' } catch (e) { return false }
  }
  function setSysMark(key) {
    try { sessionStorage.setItem(SYS_MARK_PREFIX + key, '1') } catch (e) {}
  }
  function hasPending() {
    try { return sessionStorage.getItem(SYS_PENDING_KEY) === '1' } catch (e) { return false }
  }
  function setPending() {
    try { sessionStorage.setItem(SYS_PENDING_KEY, '1') } catch (e) {}
  }
  function clearPending() {
    try { sessionStorage.removeItem(SYS_PENDING_KEY) } catch (e) {}
  }
  /** 记录当前对话已经有系统提示词：已有 chat id 直接记；新对话等拿到 id 后转移 */
  function markSysSent(obj) {
    var key = conversationKey(obj);
    if (key.indexOf('sid:') === 0) {
      setSysMark(key);
      newChatInjected = false;
      return;
    }
    newChatInjected = true;
    setPending();
  }
  // 进入新对话入口（URL 不是某个 chat id）时，上一段 pending 不能带到新对话
  try {
    if (typeof location !== 'undefined' && looksLikeNewChat()) clearPending();
    if (typeof setInterval === 'function' && typeof location !== 'undefined') {
      var lastHookPath = currentPath();
      setInterval(function () {
        var p = currentPath();
        if (p === lastHookPath) return;
        var wasChat = isChatUrl(lastHookPath);
        lastHookPath = p;
        if (!isChatUrl(p)) {
          clearPending();
          newChatInjected = false;
        } else if (!wasChat && newChatInjected) {
          // 新对话刚拿到 chat id：保留 pending，下一条网页消息转移标记
        } else {
          // 从别的聊天/页面进入已有对话：不能把上一段的 pending 记到它头上
          clearPending();
          newChatInjected = false;
        }
      }, 800);
    }
  } catch (e) {}

  /**
   * 把系统提示词拼进请求体的用户输入字段。
   * 关键规则：
   *  - Lidow 自己发送的消息由 loop 按设置决定是否带系统提示词，hook 绝不能再补；
   *    否则工具轮次、后续用户消息都会重复一整段系统提示词（实测）。
   *  - 用户直接在网页输入框发送时：默认每个对话只注入一次；设置开启“每轮注入”才每次拼。
   *
   * 顺带把「用户在网页里亲手发的消息」上报给 Lidow（纯净模式要同步这条
   * 用户消息）。经 lidow 自己发送的消息由 preload 打了 outgoing 标记，
   * 这里消费掉，避免把工具观察/重试提示也记成用户发言。
   */
  function injectPrompt(body) {
    if (typeof body !== 'string') return body;
    var obj = null;
    try { obj = JSON.parse(body); } catch (e) { return body; }
    if (!obj || typeof obj !== 'object' || !PROMPT_FIELD) return body;
    var cur = obj[PROMPT_FIELD];
    if (typeof cur !== 'string' || !cur) return body;
    var fromLidow = false;
    try {
      fromLidow = !!(window.__lidowNet && window.__lidowNet.isOutgoing && window.__lidowNet.isOutgoing(cur));
    } catch (e) {}
    if (!fromLidow) emit('prompt', { text: cur });
    var sys = window['__lidowSysPrompt__'] || SYS_PROMPT;
    if (!sys) return body;
    if (cur.indexOf(INJECT_TAG) === 0) return body;
    // 本轮已经带系统提示词（loop 首轮或此前注入过）：记下该对话，网页直发时不再重复
    if (cur.indexOf(sys) === 0) {
      markSysSent(obj);
      return body;
    }
    if (fromLidow) return body;
    if (window['__lidowRepeatSysPrompt__']) {
      obj[PROMPT_FIELD] = sys + '\n\n---\n\n# 用户任务\n\n' + cur;
      markSysSent(obj);
      return JSON.stringify(obj);
    }
    var key = conversationKey(obj);
    if (hasSysMark(key)) return body;
    if (key.indexOf('sid:') === 0 && hasPending()) {
      // 新对话刚拿到 chat id：第一条已带过系统提示词，这一条只转移标记
      setSysMark(key);
      clearPending();
      newChatInjected = false;
      return body;
    }
    if (key === 'new' && newChatInjected) return body;
    obj[PROMPT_FIELD] = sys + '\n\n---\n\n# 用户任务\n\n' + cur;
    markSysSent(obj);
    return JSON.stringify(obj);
  }

  // 经 contextBridge 暴露的桥上报（CustomEvent 无法跨 contextIsolation 世界）
  function emit(kind, detail) {
    try {
      if (window.__lidowNet && window.__lidowNet.emit) window.__lidowNet.emit(kind, detail);
    } catch (e) {}
  }

  function createDecoder() {
    var buffer = '', frames = [];
    return {
      push: function (text) {
        buffer += text;
        var parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || '';
        return parts;
      },
      finish: function () {
        var rest = buffer ? [buffer] : [];
        buffer = '';
        return rest;
      }
    };
  }

  function parseData(block) {
    if (!block || !block.trim()) return null;
    var data = null;
    var lines = block.split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('data:') === 0) {
        var d = lines[i].slice(5).trim();
        data = data == null ? d : data + '\n' + d;
      }
    }
    if (data == null) return null;
    try { return JSON.parse(data); } catch (e) { return null; }
  }

  function observeStream(body) {
    if (!body || !body.getReader) return;
    var reader = body.getReader();
    var decoder = new TextDecoder();
    var frameDecoder = createDecoder();
    // 每条流独立类型表：多个请求（重试/并发）不能互相清空
    var streamCtx = { fragmentTypes: [], currentIndex: -1, observed: false };
    var text = '', think = '', finished = false, incomplete = false, exhausted = false, dispatched = false, lastEmit = 0;
    var accTokens = null;

    function emitStream(force) {
      var now = Date.now();
      if (!force && now - lastEmit < 80) return;
      lastEmit = now;
      emit('stream', {
        text: text, think: think, finished: finished,
        accumulatedTokens: typeof accTokens === 'number' ? accTokens : null
      });
    }

    function consume(chunk) {
      var blocks = frameDecoder.push(chunk);
      for (var i = 0; i < blocks.length; i++) {
        var parsed = parseData(blocks[i]);
        if (!parsed) continue;
        var r = null;
        r = extract(parsed, streamCtx);
        if (r) {
          if (typeof r.text === 'string' && r.text) {
            if (r.replace) text = r.text;
            else text += r.text;
          }
          if (typeof r.think === 'string' && r.think) think += r.think;
          if (r.finished) finished = true;
          if (r.incomplete) incomplete = true;
          if (r.exhausted) exhausted = true;
        }
        // token 捕获
        try {
          if (parsed && parsed.p === 'accumulated_token_usage' && typeof parsed.v === 'number') accTokens = parsed.v;
          if (parsed && parsed.v && parsed.v.response && typeof parsed.v.response.accumulated_token_usage === 'number') {
            accTokens = parsed.v.response.accumulated_token_usage;
          }
        } catch (e) {}
      }
      emitStream(false);
      if ((finished || incomplete || exhausted) && !dispatched) {
        dispatched = true;
        emitStream(true);
        finishDispatch();
      }
    }

    function finishDispatch() {
      var status = userStopped ? 'stopped' : (incomplete || exhausted) ? 'error' : text.length > 0 ? 'finished' : 'error';
      if (status === 'error') {
        emit('error', { text: text, reason: exhausted ? 'context_exhausted' : incomplete ? 'incomplete' : 'empty' });
      } else {
        emit('response', {
          text: text, finished: status === 'finished', status: status,
          tokenUsage: typeof accTokens === 'number' ? { accumulatedTokens: accTokens } : null
        });
      }
    }

    function pump() {
      reader.read().then(function (r) {
        if (r.done) {
          var tail = decoder.decode();
          if (tail) consume(tail);
          var rest = frameDecoder.finish();
          for (var i = 0; i < rest.length; i++) {
            var parsed = parseData(rest[i]);
            if (!parsed) continue;
            var rr = null;
            rr = extract(parsed, streamCtx);
            if (rr) {
              if (typeof rr.text === 'string' && rr.text) {
                if (rr.replace) text = rr.text;
                else text += rr.text;
              }
              if (typeof rr.think === 'string' && rr.think) think += rr.think;
              if (rr.finished) finished = true;
              if (rr.incomplete) incomplete = true;
            }
          }
          if (!dispatched) { dispatched = true; emitStream(true); finishDispatch(); }
          return;
        }
        var chunk = decoder.decode(r.value, { stream: true });
        if (chunk) consume(chunk);
        pump();
      }).catch(function () {
        if (!dispatched) {
          dispatched = true;
          emit('error', { text: text, reason: 'stream-error' });
        }
      });
    }
    pump();
  }
  // ---------- fetch 拦截 ----------
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = (init && init.method) || (input && input.method) || 'GET';
    if (isStopStream(url, method)) { userStopped = true; return origFetch.apply(this, arguments); }
    var isCompletionReq = isCompletion(url, method);
    if (isCompletionReq) userStopped = false;
    // 与 XHR 一致：把工具协议注入请求体（fetch 走 body 字段）
    if (isCompletionReq && PROMPT_FIELD && init && typeof init.body === 'string') {
      var injectedBody = injectPrompt(init.body);
      if (injectedBody !== init.body) {
        try {
          init = Object.assign({}, init, { body: injectedBody });
          arguments[1] = init;
        } catch (e) {}
      }
    }
    var p = origFetch.apply(this, arguments);
    if (!isCompletionReq) return p;
    return p.then(function (response) {
      try {
        if (response && response.body) observeStream(response.clone().body);
      } catch (e) {}
      return response;
    }, function (err) {
      emit('error', { text: '', reason: 'network' });
      throw err;
    });
  };

  // ---------- XHR 拦截（部分平台走 XHR）----------
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  var xhrInfo = new WeakMap();
  XMLHttpRequest.prototype.open = function (m, u) {
    try {
      var isC = isCompletion(u, m);
      xhrInfo.set(this, { url: u, method: m, isCompletion: isC });
      this.__lidowIsCompletion = isC;
      this.__lidowUrl = String(u);
      if (isStopStream(u, m)) userStopped = true;
    } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    var info = xhrInfo.get(xhr);
    // 双通道判定：WeakMap + 实例属性，任一命中即视为 completion
    var isC = (info && info.isCompletion === true) || xhr.__lidowIsCompletion === true;
    if (!isC) return origSend.apply(this, arguments);
    userStopped = false;
    // 用户直接在网页里发送时，把工具协议/工作目录注入进请求体，
    // 让 AI 与「经 lidow 发送」时看到同样的上下文
    var args = arguments;
    if (PROMPT_FIELD && args.length > 0 && typeof args[0] === 'string') {
      var injected = injectPrompt(args[0]);
      if (injected !== args[0]) {
        try {
          var replaced = Array.prototype.slice.call(args);
          replaced[0] = injected;
          args = replaced;
        } catch (e) {}
      }
    }
    // DeepSeek 用 XHR 流式（responseType 可能是 text 或 stream）：
    // progress 事件不可靠，改用 readystatechange + 轮询增量读取。
    var lastLen = 0;
    // 新一轮 XHR 流的独立类型表
    var streamCtx = { fragmentTypes: [], currentIndex: -1, observed: false };
    var acc = { text: '', think: '', finished: false, incomplete: false, exhausted: false, dispatched: false };
    var timer = null;

    var frameDecoder = (function () {
      var buffer = '';
      return {
        push: function (text) {
          buffer += text;
          var parts = buffer.split(/\r?\n\r?\n/);
          buffer = parts.pop() || '';
          return parts;
        },
        finish: function () {
          var rest = buffer ? [buffer] : [];
          buffer = '';
          return rest;
        }
      };
    })();

    function consumeChunk() {
      if (acc.dispatched) return;
      var raw = '';
      try {
        if (xhr.responseType === '' || xhr.responseType === 'text') raw = xhr.responseText || '';
        else if (xhr.responseType === 'arraybuffer' && xhr.response) raw = new TextDecoder().decode(new Uint8Array(xhr.response));
        else return;
      } catch (e) { return; }
      if (raw.length <= lastLen) return;
      var delta = raw.slice(lastLen);
      lastLen = raw.length;
      var blocks = frameDecoder.push(delta);
      for (var i = 0; i < blocks.length; i++) {
        var parsed = parseData(blocks[i]);
        if (!parsed) continue;
        var r = null;
        r = extract(parsed, streamCtx);
        if (!r) continue;
        if (typeof r.text === 'string' && r.text) acc.text += r.text;
        if (typeof r.think === 'string' && r.think) acc.think += r.think;
        if (r.finished) acc.finished = true;
        if (r.incomplete) acc.incomplete = true;
        if (r.exhausted) acc.exhausted = true;
      }
      emit('stream', { text: acc.text, think: acc.think, finished: acc.finished, accumulatedTokens: null });
      if (acc.finished || acc.incomplete || acc.exhausted) finish('frame');
    }

    function finish(why) {
      if (acc.dispatched) return;
      acc.dispatched = true;
      if (timer) { clearInterval(timer); timer = null; }
      var status = userStopped ? 'stopped' : (acc.incomplete || acc.exhausted) ? 'error' : acc.text.length > 0 ? 'finished' : 'error';
      if (status === 'error') emit('error', { text: acc.text, reason: acc.exhausted ? 'context_exhausted' : acc.incomplete ? 'incomplete' : 'empty' });
      else emit('response', { text: acc.text, finished: status === 'finished', status: status, tokenUsage: null });
    }

    xhr.addEventListener('readystatechange', function () {
      if (xhr.readyState === 3) consumeChunk();
      else if (xhr.readyState === 4) {
        consumeChunk();
        var rest = frameDecoder.finish();
        for (var i = 0; i < rest.length; i++) {
          var parsed = parseData(rest[i]);
          if (!parsed) continue;
          var r = null;
          r = extract(parsed, streamCtx);
          if (!r) continue;
          if (typeof r.text === 'string' && r.text) acc.text += r.text;
          if (typeof r.think === 'string' && r.think) acc.think += r.think;
          if (r.finished) acc.finished = true;
          if (r.incomplete) acc.incomplete = true;
          if (r.exhausted) acc.exhausted = true;
        }
        finish('done');
      }
    });
    xhr.addEventListener('load', function () {
      consumeChunk();
      var rest2 = frameDecoder.finish();
      for (var i2 = 0; i2 < rest2.length; i2++) {
        var parsed2 = parseData(rest2[i2]);
        if (!parsed2) continue;
        var r2 = null;
        try { r2 = extract(parsed2, streamCtx); } catch (e) { r2 = null; }
        if (!r2) continue;
        if (typeof r2.text === 'string' && r2.text) acc.text += r2.text;
        if (typeof r2.think === 'string' && r2.think) acc.think += r2.think;
        if (r2.finished) acc.finished = true;
        if (r2.incomplete) acc.incomplete = true;
        if (r2.exhausted) acc.exhausted = true;
      }
      finish('load');
    });
    xhr.addEventListener('error', function () { finish('error'); });
    // 兜底轮询：某些环境 readystatechange 不逐块触发
    timer = setInterval(consumeChunk, 120);

    return origSend.apply(this, args);
  };
})();`
}

/** DeepSeek：POST /api/v0/chat/completion，SSE 帧 p/v 补丁结构 */
export const DEEPSEEK_HOOK: ProviderHookSpec = {
  id: 'deepseek',
  isCompletion: (url, method) =>
    method.toUpperCase() === 'POST' && url.indexOf('/api/v0/chat/completion') !== -1,
  isStopStream: (url, method) =>
    method.toUpperCase() === 'POST' && url.indexOf('/api/v0/chat/stop_stream') !== -1,
  extract: deepseekExtract,
  captureMeta: () => null,
  promptField: 'prompt',
  sessionField: 'chat_session_id'
}

/**
 * ChatGPT：兼容两套 SSE 协议。
 * - 旧版 `POST /backend-api/conversation`：每帧是完整消息快照 `{message:{...}}`
 * - 新版 Workspace `POST /backend-api/f/conversation`：`event: delta` 帧，
 *   首个消息在 `{v:{message}}`，之后是 JSON-Patch：`/message/content/parts/0` append。
 *   只认 `frame.message` 会把新协议全部漏掉 → 流结束 text 为空 → 误判 empty 并重试。
 */
export const CHATGPT_HOOK: ProviderHookSpec = {
  id: 'chatgpt',
  isCompletion: (url, method) =>
    method.toUpperCase() === 'POST' && /\/backend-api\/(conversation|f\/conversation)/.test(url),
  extract: (frame, ctx) => {
    type Msg = {
      id?: string
      author?: { role?: string }
      content?: { parts?: unknown[] }
      status?: string
    }
    const f = frame as {
      message?: Msg
      v?: unknown
      p?: string
      o?: string
      error?: unknown
      // cuckoo 同款：上下文耗尽横幅在 conversation_detail_metadata 节点里
      type?: string
      banner_info?: { name?: string; call_to_action?: unknown }
    }
    if (!f || typeof f !== 'object') return null
    if (f.error) return null
    // 上下文耗尽：call_to_action 含 continue_in_new_chat → 触发自动续接（而非普通重试）
    if (f.type === 'conversation_detail_metadata' && f.banner_info) {
      const ctas = Array.isArray(f.banner_info.call_to_action) ? f.banner_info.call_to_action : []
      if (ctas.includes('continue_in_new_chat')) return { exhausted: true }
    }
    if (f.type === 'message_stream_complete') return { finished: true }

    const state = (ctx ?? {}) as ExtractCtx
    const cg = (state.chatgpt ??= { id: '', text: '' })

    /** 消息快照：同一 id 的后续快照只回传增量，避免把整段回答重复追加 */
    const applyMessage = (msg: Msg): ExtractResult | null => {
      if (msg.author?.role !== 'assistant') return null
      const parts = Array.isArray(msg.content?.parts)
        ? (msg.content.parts.filter((x) => typeof x === 'string') as string[])
        : null
      if (!parts) return null
      const full = parts.join('')
      if (cg.id !== (msg.id ?? '')) {
        cg.id = msg.id ?? ''
        cg.text = full
        return full ? { text: full, replace: true } : null
      }
      if (full === cg.text) return null
      if (full.indexOf(cg.text) === 0) {
        const delta = full.slice(cg.text.length)
        cg.text = full
        return delta ? { text: delta } : null
      }
      cg.text = full
      return { text: full, replace: true }
    }

    // 旧协议：顶层完整消息快照
    if (f.message && typeof f.message === 'object') {
      const r = applyMessage(f.message)
      if (r) return r
      // 用户消息也会带 finished_successfully：不能拿它当本轮回复结束
      if (f.message.author?.role === 'assistant' && f.message.status === 'finished_successfully') {
        return { finished: true }
      }
      return null
    }

    // 新协议：{v:{message}} 消息快照
    if (f.v && typeof f.v === 'object' && !Array.isArray(f.v)) {
      const msg = (f.v as { message?: Msg }).message
      if (msg) {
        const r = applyMessage(msg)
        if (r) return r
        if (msg.author?.role === 'assistant' && msg.status === 'finished_successfully') {
          return { finished: true }
        }
        return null
      }
    }

    // 新协议：JSON-Patch（{o:'patch',v:[...]} 或 {p,o,v}）
    const patches: { p?: string; o?: string; v?: unknown }[] = Array.isArray(f.v)
      ? (f.v as { p?: string; o?: string; v?: unknown }[])
      : typeof f.p === 'string'
        ? [{ p: f.p, o: f.o, v: f.v }]
        : []
    let deltaText = ''
    let replacedText = ''
    let finished = false
    for (const patch of patches) {
      if (!patch || typeof patch !== 'object') continue
      if (patch.p === '/message/content/parts/0' && typeof patch.v === 'string') {
        if (patch.o === 'append') {
          deltaText += patch.v
          cg.text += patch.v
        } else if (patch.o === 'replace') {
          replacedText = patch.v
          cg.text = patch.v
        }
      } else if (patch.p === '/message/status' && patch.v === 'finished_successfully') {
        finished = true
      }
    }
    if (replacedText) return { text: replacedText, replace: true, ...(finished ? { finished } : {}) }
    if (deltaText || finished) {
      return {
        ...(deltaText ? { text: deltaText } : {}),
        ...(finished ? { finished } : {})
      }
    }
    return null
  }
}

/** Claude：POST /api/.../completion，SSE 事件含 completion 字段增量 */
export const CLAUDE_HOOK: ProviderHookSpec = {
  id: 'claude',
  isCompletion: (url, method) =>
    method.toUpperCase() === 'POST' &&
    /\/api\/organizations\/.+\/chat_conversations\/.+\/completion/.test(url),
  isStopStream: (url, method) => method.toUpperCase() === 'POST' && /\/completion\/stop/.test(url),
  extract: (frame, ctx) => {
    const f = frame as {
      type?: string
      completion?: string
      stop_reason?: string
      delta?: { text?: string }
    }
    if (!f || typeof f !== 'object') return null
    const state = (ctx ?? {}) as ExtractCtx
    if (f.type === 'completion' && typeof f.completion === 'string') {
      // 旧版 claude.ai 的 completion 是「到目前为止全文」：直接追加会整段重复
      const prev = state.claudeText ?? ''
      state.claudeText = f.completion
      if (f.completion.startsWith(prev)) return { text: f.completion.slice(prev.length) }
      return { text: f.completion, replace: true }
    }
    if (f.type === 'content_block_delta' && typeof f.delta?.text === 'string') {
      state.claudeText = (state.claudeText ?? '') + f.delta.text
      return { text: f.delta.text }
    }
    if (f.stop_reason) return { finished: true }
    return null
  }
}

export const HOOKS: Record<string, ProviderHookSpec> = {
  deepseek: DEEPSEEK_HOOK,
  chatgpt: CHATGPT_HOOK,
  claude: CLAUDE_HOOK
}
