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
  extract: (frame: unknown) => { text?: string; think?: string; finished?: boolean; incomplete?: boolean } | null
  /** 从帧对象捕获 token/消息 id（可选） */
  captureMeta?: (frame: unknown) => { accumulatedTokens?: number; msgIds?: unknown } | null
}

/** DeepSeek 补齐帧：p/v 增量补丁 + response/fragments 结构 */
function deepseekExtract(frame: unknown): { text?: string; think?: string; finished?: boolean; incomplete?: boolean } | null {
  const f = frame as Record<string, unknown>
  if (!f || typeof f !== 'object') return null
  const p = typeof f.p === 'string' ? f.p : undefined
  const v = f.v
  if (p === 'response/status' || p === 'quasi_status') {
    if (v === 'FINISHED') return { finished: true }
    if (v === 'INCOMPLETE') return { incomplete: true }
    return null
  }
  // 文本增量补丁：p 形如 response/fragments/-1/content
  if (p && typeof v === 'string') {
    if (/reasoning_content|thinking_content$/.test(p)) return { think: v }
    if (/(content|text|markdown|delta)$/.test(p)) {
      // THINK 片段（推理过程）单独归入 think，避免与正文混在一起
      return { text: v }
    }
  }
  // 顶层 {v: string} 帧
  if (p === undefined && typeof v === 'string') return { text: v }
  return null
}

/** 生成注入主世界的自包含 IIFE 源码 */
export function buildHookSource(spec: ProviderHookSpec): string {
  return String.raw`(() => {
  var MARKER = '__lidowHookInstalled__';
  if (window[MARKER]) return;
  window[MARKER] = true;

  var isCompletion = ${spec.isCompletion};
  var isStopStream = ${spec.isStopStream ?? 'function () { return false; }'};
  var extractFn = ${spec.extract};
  var userStopped = false;

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
        var parts = buffer.split(/\\r?\\n\\r?\\n/);
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
    var lines = block.split(/\\r\\n|\\r|\\n/);
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('data:') === 0) {
        var d = lines[i].slice(5).trim();
        data = data == null ? d : data + '\\n' + d;
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
    var text = '', think = '', finished = false, incomplete = false, dispatched = false, lastEmit = 0;
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
        try { r = extractFn(parsed); } catch (e) { r = null; }
        if (r) {
          if (typeof r.text === 'string' && r.text) text += r.text;
          if (typeof r.think === 'string' && r.think) think += r.think;
          if (r.finished) finished = true;
          if (r.incomplete) incomplete = true;
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
      if ((finished || incomplete) && !dispatched) {
        dispatched = true;
        emitStream(true);
        finishDispatch();
      }
    }

    function finishDispatch() {
      var status = userStopped ? 'stopped' : incomplete ? 'error' : text.length > 0 ? 'finished' : 'error';
      if (status === 'error') {
        emit('error', { text: text, reason: incomplete ? 'incomplete' : 'empty' });
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
            try { rr = extractFn(parsed); } catch (e) { rr = null; }
            if (rr) {
              if (typeof rr.text === 'string' && rr.text) text += rr.text;
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
      xhrInfo.set(this, { url: u, method: m });
      if (isStopStream(u, m)) userStopped = true;
    } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    var info = xhrInfo.get(xhr);
    if (!(info && isCompletion(info.url, info.method))) return origSend.apply(this, arguments);
    userStopped = false;
    // DeepSeek 用 XHR 流式（responseType 可能是 text 或 stream）：
    // progress 事件不可靠，改用 readystatechange + 轮询增量读取。
    var lastLen = 0;
    var acc = { text: '', think: '', finished: false, incomplete: false, dispatched: false };
    var timer = null;

    function readDelta() {
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
      var blocks = delta.split(/\r?\n\r?\n/);
      for (var i = 0; i < blocks.length; i++) {
        var parsed = parseData(blocks[i]);
        if (!parsed) continue;
        var r = null;
        try { r = extractFn(parsed); } catch (e) { r = null; }
        if (!r) continue;
        if (typeof r.text === 'string' && r.text) acc.text += r.text;
        if (typeof r.think === 'string' && r.think) acc.think += r.think;
        if (r.finished) acc.finished = true;
        if (r.incomplete) acc.incomplete = true;
      }
      emit('stream', { text: acc.text, think: acc.think, finished: acc.finished, accumulatedTokens: null });
      if (acc.finished || acc.incomplete) finish('frame');
    }

    function finish(why) {
      if (acc.dispatched) return;
      acc.dispatched = true;
      if (timer) { clearInterval(timer); timer = null; }
      var status = userStopped ? 'stopped' : acc.incomplete ? 'error' : acc.text.length > 0 ? 'finished' : 'error';
      if (status === 'error') emit('error', { text: acc.text, reason: acc.incomplete ? 'incomplete' : 'empty' });
      else emit('response', { text: acc.text, finished: status === 'finished', status: status, tokenUsage: null });
    }

    xhr.addEventListener('readystatechange', function () {
      if (xhr.readyState === 3) readDelta();      // LOADING：开始有数据
      else if (xhr.readyState === 4) { readDelta(); finish('done'); }
    });
    xhr.addEventListener('load', function () { readDelta(); finish('load'); });
    xhr.addEventListener('error', function () { finish('error'); });
    // 兜底轮询：某些环境 readystatechange 不逐块触发
    timer = setInterval(readDelta, 120);

    return origSend.apply(this, arguments);
  };
})();`
}

/** DeepSeek：POST /api/v0/chat/completion，SSE 帧 p/v 补丁结构 */
export const DEEPSEEK_HOOK: ProviderHookSpec = {
  id: 'deepseek',
  isCompletion: (url, method) => method.toUpperCase() === 'POST' && url.indexOf('/api/v0/chat/completion') !== -1,
  isStopStream: (url, method) => method.toUpperCase() === 'POST' && url.indexOf('/api/v0/chat/stop_stream') !== -1,
  extract: deepseekExtract,
  captureMeta: () => null
}

/** ChatGPT：POST /backend-api/conversation，data: 行内为 JSON 增量（message.content.parts） */
export const CHATGPT_HOOK: ProviderHookSpec = {
  id: 'chatgpt',
  isCompletion: (url, method) => method.toUpperCase() === 'POST' && /\/backend-api\/(conversation|f\/conversation)/.test(url),
  extract: (frame) => {
    const f = frame as { message?: { author?: { role?: string }; content?: { parts?: unknown[] }; status?: string }; error?: unknown }
    if (!f || typeof f !== 'object') return null
    if (f.error) return null
    const msg = f.message
    if (msg?.author?.role === 'assistant' && Array.isArray(msg.content?.parts)) {
      const text = msg.content.parts.filter((x) => typeof x === 'string').join('')
      return { text }
    }
    if (msg?.status === 'finished_successfully') return { finished: true }
    return null
  }
}

/** Claude：POST /api/.../completion，SSE 事件含 completion 字段增量 */
export const CLAUDE_HOOK: ProviderHookSpec = {
  id: 'claude',
  isCompletion: (url, method) => method.toUpperCase() === 'POST' && /\/api\/organizations\/.+\/chat_conversations\/.+\/completion/.test(url),
  isStopStream: (url, method) => method.toUpperCase() === 'POST' && /\/completion\/stop/.test(url),
  extract: (frame) => {
    const f = frame as { type?: string; completion?: string; stop_reason?: string; delta?: { text?: string } }
    if (!f || typeof f !== 'object') return null
    if (f.type === 'completion' && typeof f.completion === 'string') return { text: f.completion }
    if (f.type === 'content_block_delta' && typeof f.delta?.text === 'string') return { text: f.delta.text }
    if (f.stop_reason) return { finished: true }
    return null
  }
}

export const HOOKS: Record<string, ProviderHookSpec> = {
  deepseek: DEEPSEEK_HOOK,
  chatgpt: CHATGPT_HOOK,
  claude: CLAUDE_HOOK
}
