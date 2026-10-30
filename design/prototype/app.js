/* Lidow 界面原型 v3：桌面端工作台 + 管理页 + 设置。数据均为演示数据。 */

const ic = (name) => `<i data-lucide="${name}"></i>`

const NAV = [
  {
    group: 'main',
    items: [
      { id: 'home', label: '工作台', icon: 'layout-dashboard' },
      { id: 'projects', label: '工作区', icon: 'folders' },
      { id: 'sessions', label: '会话', icon: 'messages-square' },
      { id: 'files', label: '文件', icon: 'folder-tree' },
      { id: 'tasks', label: '任务', icon: 'list-checks' }
    ]
  },
  {
    group: 'agent',
    items: [
      { id: 'skills', label: '技能', icon: 'sparkles' },
      { id: 'agents', label: '子代理', icon: 'bot' },
      { id: 'mcp', label: 'MCP', icon: 'plug' },
      { id: 'plugins', label: '插件', icon: 'puzzle' },
      { id: 'quick', label: '快捷指令', icon: 'command' }
    ]
  },
  {
    group: 'data',
    items: [
      { id: 'memory', label: '记忆', icon: 'brain' },
      { id: 'knowledge', label: '知识库', icon: 'library' },
      { id: 'audit', label: '审计', icon: 'scroll-text' }
    ]
  }
]

const VIEW_LABEL = { ...Object.fromEntries(NAV.flatMap((g) => g.items.map((i) => [i.id, i.label]))), settings: '设置' }

const PROVIDERS = {
  deepseek: { name: 'DeepSeek', letter: 'D' },
  claude: { name: 'Claude', letter: 'C' },
  chatgpt: { name: 'ChatGPT', letter: 'G' }
}

const S = {
  view: 'home',
  theme: localStorage.getItem('lidow-theme') || 'light',
  themeChoice: localStorage.getItem('lidow-theme-choice') || 'light',
  accent: '#4f6bed',
  dock: 'review',
  dockOpen: true,
  paneOpen: true,
  session: 's1',
  paneQuery: '',
  skillTab: 'project',
  settingsSection: 'appearance',
  palette: false,
  paletteQuery: '',
  paletteSel: 0,
  slash: false,
  slashSel: 0,
  modal: null,
  thinkOpen: false,
  toolOpen: true,
  planState: 'pending',
  confirmState: 'pending',
  running: false,
  composerText: '',
  sessionSearch: '',
  followUps: {},
  settings: {
    pet: true,
    deleteGuard: true,
    batchLimit: 200,
    confirmDanger: true,
    ssrf: true,
    securityMod: true,
    ctf: false,
    watchdog: true,
    retry: true,
    repeatPrompt: false,
    autoCompact: true,
    cmdTimeout: 30,
    sendInterval: 1
  },
  tasks: [
    { id: 't1', title: '读取 health.ts 与 db.ts', status: 'done', ai: true, time: '3 分钟前' },
    { id: 't2', title: '复用连接池 ping() 并加超时', status: 'done', ai: true, time: '2 分钟前' },
    { id: 't3', title: '补充超时 503 分支与测试', status: 'done', ai: true, time: '1 分钟前' },
    { id: 't4', title: '跑 npm test -- health', status: 'running', ai: true, time: '刚开始' },
    { id: 't5', title: '更新 README 的 readiness 说明', status: 'pending', ai: true, time: '' },
    { id: 't6', title: '检查慢查询日志中的 N+1', status: 'failed', ai: false, time: '' }
  ]
}

const SESSIONS = [
  { id: 's1', title: '为 /health 增加数据库探活', provider: 'deepseek', time: '5分', group: '今天' },
  { id: 's2', title: '重构用户列表分页', provider: 'deepseek', time: '4小时', group: '今天' },
  { id: 's3', title: '排查慢查询日志', provider: 'claude', time: '昨天', group: '更早' },
  { id: 's4', title: '生成 v1.4 API 文档', provider: 'deepseek', time: '3天', group: '更早' },
  { id: 's5', title: '给设置页补空态', provider: 'chatgpt', time: '4天', group: '更早' }
]

const SKILLS = {
  project: [
    { id: 'sk1', name: 'animate', cat: '动画', on: true, desc: '从零构建动画，按「是否该动、目的、工具、属性、曲线与时长」的顺序做决策。', path: '.lidow/skills/animate' },
    { id: 'sk2', name: 'review-animations', cat: '动画', on: true, desc: '按高工艺标准审查动效代码，默认挑错，通过需要理由。', path: '.lidow/skills/review-animations' },
    { id: 'sk3', name: 'animation-performance', cat: '动画', on: false, desc: '把动画控制在帧预算内，定位掉帧原因并替换更便宜的实现。', path: '.lidow/skills/animation-performance' },
    { id: 'sk4', name: 'emil-design-eng', cat: '设计', on: true, desc: '界面打磨、组件设计与动效决策的隐性细节。', path: '.lidow/skills/emil-design-eng' },
    { id: 'sk5', name: 'apple-design', cat: '设计', on: true, desc: '把 Apple 的动效与手势交互思路迁移到 Web。', path: '.lidow/skills/apple-design' },
    { id: 'sk6', name: 'ask-sonner', cat: '工程', on: false, desc: 'Sonner 提示库的接入、样式与常见问题排查。', path: '.lidow/skills/ask-sonner' },
    { id: 'sk7', name: 'write-swift', cat: '工程', on: true, desc: '现代 Swift 写法与并发安全，包含 Swift 6 迁移要点。', path: '.lidow/skills/write-swift' }
  ],
  user: [
    { id: 'su1', name: 'design-taste-frontend', cat: '设计', on: true, desc: '落地页与重设计的审美标准，避免模板化输出。', path: '~/.lidow/skills/design-taste-frontend' },
    { id: 'su2', name: 'break-ui', cat: '测试', on: true, desc: '用极端数据压测界面：超长文案、缺失字段、异常数量。', path: '~/.lidow/skills/break-ui' },
    { id: 'su3', name: 'mobile-native', cat: '设计', on: true, desc: '让 Web 应用在手机上像原生应用。', path: '~/.lidow/skills/mobile-native' },
    { id: 'su4', name: 'prototype', cat: '设计', on: false, desc: '一次生成多个差异明显的方案，放在选择器里对比。', path: '~/.lidow/skills/prototype' },
    { id: 'su5', name: 'pick-ui-library', cat: '工程', on: true, desc: '按场景挑选前端库：图表、虚拟列表、拖拽、Toast。', path: '~/.lidow/skills/pick-ui-library' },
    { id: 'su6', name: 'animation-vocabulary', cat: '动画', on: true, desc: '把模糊的动效描述翻译成准确术语。', path: '~/.lidow/skills/animation-vocabulary' }
  ],
  trash: [
    { id: 'st1', name: 'find-animation-opportunities', cat: '动画', on: false, desc: '找出应该动起来的位置，并给出具体参数。', path: '回收站 · 2 小时前' },
    { id: 'st2', name: 'improve-animations', cat: '动画', on: false, desc: '审查整个代码库的动效并输出改进计划。', path: '回收站 · 昨天' }
  ]
}

const AGENTS = [
  { name: '代码审查员', scope: '项目', desc: '审查改动、指出风险并给出最小修复建议。', path: '.lidow/agents/code-reviewer.md' },
  { name: '实现规划师', scope: '项目', desc: '把模糊需求拆成边界清楚的工程计划。', path: '.lidow/agents/planner.md' },
  { name: '研究助手', scope: '用户', desc: '收集证据、比较方案，输出带引用的结论。', path: '~/.lidow/agents/researcher.md' },
  { name: '安全审查', scope: '用户', desc: '按 OWASP 检查注入、越权与敏感信息泄露。', path: '~/.lidow/agents/security.md' }
]

const MCP_SERVERS = [
  { name: 'filesystem', on: true, cmd: 'npx -y @modelcontextprotocol/server-filesystem D:\\work', tools: ['read_file', 'write_file', 'list_directory', 'search_files', 'move_file'] },
  { name: 'mysql-local', on: true, cmd: 'lidow-mcp-mysql --dsn orbit_local', tools: ['query', 'describe_table', 'explain'] }
]

const PLUGINS = [
  { name: 'github-sync', ver: '1.2.0', on: true, tag: '已安装', desc: '把任务与提交记录同步到 GitHub 项目看板。', provides: 'dsh' },
  { name: 'notion-export', ver: '0.9.4', on: true, tag: '已安装', desc: '会话与记忆导出到 Notion 数据库。', provides: 'entry' },
  { name: 'feishu-bot', ver: '2.0.1', on: false, tag: '已安装', desc: '任务完成时推送到飞书群机器人。', provides: 'webScript' }
]

const QUICK = [
  { trigger: '/review', name: '审查当前改动', tpl: '审阅当前未提交的改动，按风险从高到低列出问题，每条给出最小修复建议。' },
  { trigger: '/test', name: '补测试并跑通', tpl: '为最近修改的模块补充单元测试，覆盖失败分支，然后运行 npm test 并汇报结果。' },
  { trigger: '/perf', name: '性能体检', tpl: '分析这个页面的渲染与请求开销，给出三个可量化的优化点并按收益排序。' },
  { trigger: '/doc', name: '写使用说明', tpl: '为这个模块写一份面向新同事的使用说明，包含最小示例与常见错误。' }
]

const MEMORY = [
  { title: '项目约定：提交前必须过 typecheck', tags: ['lidow', '工程'], src: 'AI 保存', time: '2 小时前', body: '这个仓库的 CI 会跑 tsc --noEmit 与 eslint，提交前先本地跑一遍，避免推送后返工。' },
  { title: 'Diff 面板默认收在右侧', tags: ['UI', '偏好'], src: '手动', time: '昨天', body: '审阅栏默认收起宽度 360px，点击变更卡再展开，避免挤压对话区。' },
  { title: 'DeepSeek 账号 2 用于长任务', tags: ['账号'], src: '正文标记', time: '3 天前', body: '长任务固定用账号 2，额度更充足；短问答走默认账号。' }
]

const KNOWLEDGE = [
  { name: '架构决策记录', docs: 18, root: 'D:\\work\\orbit-api\\docs\\adr' },
  { name: '运维手册', docs: 42, root: 'D:\\work\\ops-handbook' }
]

const AUDIT = [
  { type: 'write', label: '文件写入', sum: 'src/routes/health.ts', time: '14:32:08', state: '' },
  { type: 'write', label: '文件写入', sum: 'test/health.test.ts', time: '14:32:11', state: '' },
  { type: 'cmd', label: '命令', sum: 'npm test -- health', time: '14:33:02', state: '' },
  { type: 'del', label: '删除', sum: '.lidow/trash/old-probe.sh', time: '13:58:40', state: '已回滚' },
  { type: 'write', label: '文件写入', sum: 'README.md', time: '11:20:15', state: '' },
  { type: 'cmd', label: '命令', sum: 'git status --short', time: '11:18:09', state: '' }
]

/* ------------------------------ 结构渲染 ------------------------------ */

function titlebar() {
  const viewLabel = S.view === 'home' ? '工作台' : VIEW_LABEL[S.view]
  return `
  <header class="titlebar">
    <div class="tb-brand">
      <span class="logo">L</span>
      <span class="tb-brandname">Lidow</span>
    </div>
    <div class="tb-crumbs">
      <button class="tb-project" data-act="nav" data-view="projects">
        ${ic('folder')}
        orbit-api
        <span class="mono">D:\\work\\orbit-api</span>
        ${ic('chevron-down')}
      </button>
      <span class="tb-sep">${ic('chevron-right')}</span>
      <span class="tb-view">${viewLabel}</span>
      ${S.view === 'home' ? '<span class="chip outline" style="margin-left:6px">DeepSeek · 账号 1</span>' : ''}
    </div>
    <div class="tb-right">
      <button class="win-btn" title="最小化">${ic('minus')}</button>
      <button class="win-btn" title="最大化">${ic('square')}</button>
      <button class="win-btn win-close" title="关闭">${ic('x')}</button>
    </div>
  </header>`
}

function rail() {
  const groups = NAV.map((g) => `
    <div class="rail-group">
      ${g.items
        .map(
          (it) => `
        <button class="rail-btn" data-act="nav" data-view="${it.id}" data-active="${S.view === it.id}">
          ${ic(it.icon)}
          <span class="rail-tip">${it.label}</span>
        </button>`
        )
        .join('')}
    </div>`).join('')

  return `
  <nav class="rail">
    ${groups}
    <div class="rail-spacer"></div>
    <button class="rail-btn" data-act="toggle-theme" title="切换主题">
      ${ic(S.theme === 'dark' ? 'sun' : 'moon')}
      <span class="rail-tip">${S.theme === 'dark' ? '浅色主题' : '深色主题'}</span>
    </button>
    <button class="rail-btn" data-act="palette-open" title="命令面板 Ctrl K">
      ${ic('command')}
      <span class="rail-tip">命令面板　Ctrl K</span>
    </button>
    <button class="rail-btn" data-act="nav" data-view="settings" data-active="${S.view === 'settings'}">
      ${ic('settings')}
      <span class="rail-tip">设置</span>
    </button>
    <button class="rail-btn" data-act="toast" title="账号">
      <span class="avatar">L</span>
      <span class="rail-tip">本地账号 · 已登录 DeepSeek</span>
    </button>
  </nav>`
}

function paneCollapsed() {
  return `
  <div class="pane-rail">
    <button data-act="collapse-pane" title="展开会话列表">${ic('panel-left-open')}</button>
  </div>`
}

function sessionPane() {
  const q = S.paneQuery.trim().toLowerCase()
  const list = SESSIONS.filter((s) => !q || s.title.toLowerCase().includes(q))
  const groups = ['今天', '更早']
  const active = SESSIONS.find((s) => s.id === S.session) || null

  return `
  <aside class="pane">
    <div class="pane-head">
      <button class="proj-btn" data-act="nav" data-view="projects">
        <span class="proj-avatar">O</span>
        <span style="min-width:0;flex:1">
          <span class="proj-name">orbit-api</span>
          <span class="proj-meta">Node · Express · MySQL</span>
        </span>
        ${ic('chevrons-up-down')}
      </button>
      <button class="icon-btn" title="收起会话列表" data-act="collapse-pane">${ic('panel-left-close')}</button>
    </div>

    <div class="pane-actions">
      <button class="btn-new" data-act="new-task">
        ${ic('plus')}
        <span>新建任务</span>
        <span class="kbd-mini">Ctrl N</span>
      </button>
    </div>

    <div class="pane-search">
      <label class="search-box">
        ${ic('search')}
        <input data-model="paneQuery" data-focus="pane-search" value="${esc(S.paneQuery)}" placeholder="搜索会话" />
        ${S.paneQuery ? `<button class="icon-btn" style="width:18px;height:18px" data-act="clear-pane">${ic('x')}</button>` : ''}
      </label>
    </div>

    <div class="pane-list" data-keep-scroll="pane">
      ${groups
        .map((g) => {
          const rows = list.filter((s) => s.group === g)
          if (!rows.length) return ''
          return `
            <div class="pane-section"><span>${g}</span><span class="count">${rows.length}</span></div>
            ${rows
              .map(
                (s) => `
              <div class="sess" data-act="session" data-id="${s.id}" data-active="${active && active.id === s.id}">
                <span class="sess-badge" data-p="${s.provider}">${PROVIDERS[s.provider].letter}</span>
                <span class="sess-title">${esc(s.title)}</span>
                <span class="sess-time">${s.time}</span>
                <button class="sess-del icon-btn" style="width:18px;height:18px" data-act="delete-session" data-id="${s.id}" title="删除会话">${ic('x')}</button>
              </div>`
              )
              .join('')}`
        })
        .join('')}
      ${list.length === 0 ? `<div class="muted" style="padding:12px 10px">没有匹配的会话</div>` : ''}
    </div>

    <div class="pane-foot">
      <span class="avatar">L</span>
      <span class="who"><b>本地工作区</b><span>零 Token · 已连接 DeepSeek</span></span>
      <button class="icon-btn" data-act="nav" data-view="settings" title="设置">${ic('settings-2')}</button>
    </div>
  </aside>`
}

/* ------------------------------ 对话 ------------------------------ */

const HEALTH_DIFF = [
  { t: 'hunk', no: '', tx: '@@ -1,9 +1,25 @@' },
  { t: 'ctx', no: '1', tx: "import { Router } from 'express'" },
  { t: 'add', no: '2', tx: "import { db } from '../lib/db'" },
  { t: 'add', no: '3', tx: "import { withTimeout } from '../lib/timeout'" },
  { t: 'ctx', no: '4', tx: '' },
  { t: 'ctx', no: '5', tx: 'export const health = Router()' },
  { t: 'ctx', no: '6', tx: '' },
  { t: 'del', no: '7', tx: "health.get('/', (_req, res) => {" },
  { t: 'del', no: '8', tx: "  res.json({ ok: true, uptime: process.uptime() })" },
  { t: 'add', no: '9', tx: "health.get('/', async (_req, res) => {" },
  { t: 'add', no: '10', tx: '  const startedAt = Date.now()' },
  { t: 'add', no: '11', tx: '  try {' },
  { t: 'add', no: '12', tx: '    await withTimeout(db.ping(), 2_000)' },
  { t: 'add', no: '13', tx: '    res.json({' },
  { t: 'add', no: '14', tx: "      ok: true, uptime: process.uptime(), db: 'up'," },
  { t: 'add', no: '15', tx: '      dbLatencyMs: Date.now() - startedAt' },
  { t: 'add', no: '16', tx: '    })' },
  { t: 'add', no: '17', tx: '  } catch {' },
  { t: 'add', no: '18', tx: "    res.status(503).json({ ok: false, db: 'down' })" },
  { t: 'add', no: '19', tx: '  }' },
  { t: 'add', no: '20', tx: '})' }
]

const TOOLS = [
  { icon: 'file-search', label: '读取文件', path: 'src/routes/health.ts', meta: '9 行', ms: '11ms' },
  { icon: 'file-search', label: '读取文件', path: 'src/lib/db.ts', meta: '18 行', ms: '8ms' },
  { icon: 'file-pen', label: '编辑文件', path: 'src/routes/health.ts', meta: '', ms: '36ms' },
  { icon: 'file-pen', label: '编辑文件', path: 'test/health.test.ts', meta: '', ms: '24ms' },
  { icon: 'terminal', label: '终端命令', path: 'npm test -- health', meta: '', ms: '1840ms' }
]

function chatMessages() {
  const follow = S.session && S.followUps[S.session] ? S.followUps[S.session] : null
  if (follow && follow.length) {
    const base =
      S.session === 's2'
        ? chatPlanScenario()
        : S.session === 's3'
          ? chatShortScenario()
          : S.session === 's1'
            ? chatTurnScenario()
            : ''
    return base + chatFollowUps(follow)
  }
  if (!S.session) return chatEmpty()
  if (S.session === 's2') return chatPlanScenario()
  if (S.session === 's3') return chatShortScenario()
  return chatTurnScenario()
}

function chatFollowUps(items) {
  return items
    .map(
      (text) => `
    <div class="msg-user"><div class="bubble">${esc(text)}</div></div>
    <div class="think">
      <span style="color:var(--accent)">${ic('loader-circle')}</span>
      <span class="t">正在思考</span>
      <span class="sum">我先读一下相关文件，结果会直接出现在这里</span>
    </div>`
    )
    .join('')
}

function chatShortScenario() {
  return `
    <div class="msg-user">
      <div class="bubble">看一下慢查询日志，找出最慢的三条，并给出索引建议。</div>
    </div>
    <div class="turn">
      <button class="think" data-act="toggle-think" data-open="${S.thinkOpen}">
        ${ic('circle-check')}
        <span class="t">已处理</span>
        <span class="sum">读取 slow.log 最近 24 小时，按 query_time 排序，结合 explain 判断索引是否命中</span>
        ${ic('chevron-right', 'chev')}
      </button>
      <div class="prose">
        <p>最慢的三条都来自 <code>users</code> 表的列表查询，共同问题是在 <code>status</code> 上做低基数过滤，却缺少复合索引：</p>
        <ul>
          <li><code>SELECT … WHERE status = ? ORDER BY created_at DESC LIMIT 20</code>：全表扫描 4.2 万行，建议加 <code>(status, created_at)</code></li>
          <li><code>SELECT COUNT(*) WHERE status = ?</code>：重复统计，建议缓存 60 秒</li>
          <li><code>SELECT … WHERE email LIKE '%@corp.com'</code>：前置通配符无法走索引，建议改为后缀匹配或全文索引</li>
        </ul>
      </div>
      <div class="tool-card">
        <button class="tool-head" data-act="toggle-tool">
          <span class="ic">${ic('circle-check')}</span>
          <span class="count">执行工具 3 次</span>
          <span class="names">读取文件、终端命令、数据库查询</span>
          <span class="dur">640ms</span>
          ${ic('chevron-down', 'chev')}
        </button>
        ${S.toolOpen ? `<div class="tool-rows">
          <div class="tool-row"><span class="ic">${ic('check')}</span><span class="label">读取文件</span><span class="path">logs/slow.log</span><span class="ms">12ms</span></div>
          <div class="tool-row"><span class="ic">${ic('check')}</span><span class="label">终端命令</span><span class="path">grep "SELECT" logs/slow.log | sort -k2 -nr | head</span><span class="ms">88ms</span></div>
          <div class="tool-row"><span class="ic">${ic('check')}</span><span class="label">数据库查询</span><span class="path">EXPLAIN SELECT …</span><span class="ms">540ms</span></div>
        </div>` : ''}
      </div>
      <div class="prose"><p>先加第一条复合索引就能覆盖 80% 的慢查询，要我直接改 migration 吗？</p></div>
    </div>`
}

function chatTurnScenario() {
  return `
    <div class="sys-note">${ic('archive')} 上下文已自动压缩，保留最近 4 轮</div>
    <div class="msg-user">
      <div class="bubble">给 /health 加上数据库连通性检查，并补一个测试。改完跑一遍测试。</div>
    </div>

    <div class="turn">
      <button class="think" data-act="toggle-think" data-open="${S.thinkOpen}">
        ${ic('circle-check')}
        <span class="t">已处理</span>
        <span class="sum">先看 health.ts 与 db.ts 的现有返回结构，复用连接池 ping()，再用 withTimeout 包一层</span>
        ${ic('chevron-right', 'chev')}
      </button>
      <div class="think-body">
        读取两个文件后确认 health 路由没有依赖注入，直接引入 lib/db 的单例连接池最省事。超时选择 2 秒，覆盖测试里的瞬时失败场景；失败统一返回 503，保持原有字段不变，只新增 db 与 dbLatencyMs。
      </div>

      <div class="prose">
        <p>已完成，改动集中在 2 个文件：</p>
        <ul>
          <li><code>src/routes/health.ts</code> 新增 <code>db.ping()</code> 探活，2 秒超时后返回 503，正常时带上 <code>dbLatencyMs</code></li>
          <li><code>test/health.test.ts</code> 覆盖数据库可用与探活超时两条分支</li>
        </ul>
      </div>

      <div class="tool-card">
        <button class="tool-head" data-act="toggle-tool">
          <span class="ic">${ic('circle-check')}</span>
          <span class="count">执行工具 5 次</span>
          <span class="names">读取文件、编辑文件、终端命令</span>
          <span class="dur">1.9s</span>
          ${ic('chevron-down', 'chev')}
        </button>
        ${S.toolOpen ? `<div class="tool-rows">${TOOLS.map(
          (t) => `
          <div class="tool-row">
            <span class="ic">${ic('check')}</span>
            <span class="label">${t.label}</span>
            <span class="path">${t.path}</span>
            <span class="ms">${t.ms}</span>
            <span class="go">${ic('chevron-right')}</span>
          </div>`
        ).join('')}</div>` : ''}
      </div>

      <button class="change-row" data-act="open-review">
        <span class="ic">${ic('file-diff')}</span>
        <span>2 个文件已修改</span>
        <span class="add">+39</span>
        <span class="del">−2</span>
        <span class="files">src/routes/health.ts, test/health.test.ts</span>
        ${ic('chevron-right')}
      </button>

      <div class="prose">
        <p><code>npm test -- health</code> 已通过（<span class="ok">2 passed</span>）。健康检查现在可以直接接到负载均衡的 readiness probe 上。</p>
      </div>
    </div>`
}

function chatPlanScenario() {
  return `
    <div class="sys-note">${ic('git-branch')} 派生自「为 /health 增加数据库探活」</div>
    <div class="msg-user">
      <div class="bubble">把用户列表的分页改成游标分页，同时保持旧接口兼容。先给我计划，别直接改。</div>
    </div>
    <div class="turn">
      <button class="think" data-act="toggle-think" data-open="${S.thinkOpen}">
        ${ic('circle-check')}
        <span class="t">已处理</span>
        <span class="sum">确认现有分页参数、索引与调用方，游标方案用 created_at + id 复合键，旧 offset 参数保留兼容</span>
        ${ic('chevron-right', 'chev')}
      </button>
      <div class="prose">
        <p>这个改动会碰 3 个文件，先给出计划和影响面。</p>
      </div>

      <div class="plan-card">
        <div class="plan-head">
          <span class="ic" data-run="${S.planState === 'approved'}">${ic(S.planState === 'approved' ? 'loader-circle' : 'list-todo')}</span>
          <b>${S.planState === 'approved' ? '正在执行计划' : '计划待确认'}</b>
          <span>${S.planState === 'approved' ? '第 1 步 · 读取 users 路由与查询层' : '等待你确认后开始执行'}</span>
        </div>
        <div class="plan-body">
          <div class="plan-goal">目标：用户列表切换为游标分页，保留旧 offset 参数，接口响应结构向后兼容。</div>
          <ol class="plan-steps">
            <li><span>读取 users 路由与查询层<small>确认现有 limit / offset 的解析位置与调用方</small></span></li>
            <li><span>实现游标编解码与复合索引查询<small>created_at + id，避免翻页时重复或漏行</small></span></li>
            <li><span>保留旧参数并补兼容测试<small>覆盖首屏、翻页、旧客户端三种调用</small></span></li>
          </ol>
        </div>
        <div class="plan-foot">
          ${S.planState === 'approved'
            ? `<button class="btn btn-outline btn-sm" data-act="plan-dismiss">${ic('square')} 停止执行</button>`
            : `<button class="btn btn-outline btn-sm" data-act="plan-dismiss">放弃</button>
               <button class="btn btn-primary btn-sm" data-act="plan-approve">${ic('play')} 确认执行</button>`}
        </div>
      </div>

      ${S.planState === 'approved'
        ? `<div class="think"><span style="color:var(--accent)">${ic('loader-circle')}</span><span class="t">正在执行</span><span class="sum">读取 src/routes/users.ts 与查询层，确认现有 limit / offset 的解析位置</span></div>`
        : `<div class="prose"><p>确认后我会先跑一遍现有测试，再开始改。</p></div>`}
    </div>`
}

function chatEmpty() {
  return `
    <div class="chat-empty">
      <span class="empty-mark">${ic('sparkles')}</span>
      <div class="empty-title">新建一个任务开始</div>
      <div class="empty-desc">描述你要做的事，Lidow 会读文件、改代码、跑命令，再把结果带回来。</div>
      <div class="quick-grid">
        <button class="quick-card" data-act="quick" data-prompt="先读一下这个项目的结构和关键配置，然后给我一份简洁的项目说明：技术栈、入口文件、主要模块。">
          <b>${ic('scan-search')} 了解这个项目</b>
          <span>扫描目录与依赖，输出项目说明</span>
        </button>
        <button class="quick-card" data-act="quick" data-prompt="用 write 工具在当前项目根目录创建 hello.txt，内容为：Hello from Lidow">
          <b>${ic('file-plus')} 创建文件</b>
          <span>用 write 工具写入新文件</span>
        </button>
        <button class="quick-card" data-act="quick" data-prompt="用 grep 工具搜索项目里所有 TODO 注释，按文件分组列出。">
          <b>${ic('search-code')} 查找代码</b>
          <span>在整个项目里搜索符号或关键字</span>
        </button>
        <button class="quick-card" data-act="quick" data-prompt="执行项目的构建命令，如果失败请分析报错原因并给出修复方案。">
          <b>${ic('hammer')} 跑一次构建</b>
          <span>执行 build 并分析失败原因</span>
        </button>
      </div>
    </div>`
}

function composer() {
  const s = SESSIONS.find((x) => x.id === S.session)
  const streaming = S.session === 's2' && S.planState === 'approved'
  return `
  <div class="composer-wrap">
    <div class="composer">
      ${S.slash ? slashMenu() : ''}
      <textarea data-model="composerText" data-focus="composer" rows="1" placeholder="交给 Lidow 一个任务…　Enter 发送，Shift+Enter 换行">${esc(S.composerText)}</textarea>
      <div class="composer-bar">
        <button class="comp-chip" data-act="toast" title="权限模式">${ic('shield')} 自主模式 ${ic('chevron-down', 'caret')}</button>
        <button class="comp-chip" data-on="true" data-act="toast" title="深度思考">${ic('brain')} 深度思考</button>
        <button class="comp-chip" data-act="toast" title="智能搜索">${ic('globe')} 搜索</button>
        <button class="comp-chip" data-act="toast" title="添加附件">${ic('paperclip')}</button>
        <div class="comp-right">
          <span class="hint">${s ? PROVIDERS[s.provider].name : 'DeepSeek'} · ${esc(S.composerText.length ? `${S.composerText.length} 字` : 'Ctrl K 命令')}</span>
          <button class="send" data-act="send" data-stop="${streaming}" title="${streaming ? '停止生成' : '发送'}">
            ${ic(streaming ? 'square' : 'arrow-up')}
          </button>
        </div>
      </div>
    </div>
  </div>`
}

const SLASH_ITEMS = [
  { cmd: '/compact', desc: '手动压缩上下文' },
  { cmd: '/new', desc: '新建会话' },
  { cmd: '/plan', desc: '要求先拆解任务计划' },
  { cmd: '/memory', desc: '让 AI 记住当前要点' },
  { cmd: '/review', desc: '快捷指令 · 审查当前改动' },
  { cmd: 'animate', desc: '技能 · 构建动画' },
  { cmd: 'review-animations', desc: '技能 · 审查动效' }
]

function slashMenu() {
  const q = S.composerText.replace(/^\//, '').toLowerCase()
  const items = SLASH_ITEMS.filter((i) => !q || i.cmd.toLowerCase().includes(q))
  return `
    <div class="slash">
      <div class="slash-head">命令与技能</div>
      ${items.map((i) => `
        <button class="slash-item" data-act="slash-pick" data-cmd="${i.cmd}">
          <span class="cmd">${i.cmd}</span>
          <span class="desc">${i.desc}</span>
        </button>`).join('')}
      ${items.length === 0 ? '<div class="muted" style="padding:10px 9px">没有匹配的指令或技能</div>' : ''}
      <div class="slash-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 填入</span><span><kbd>Esc</kbd> 关闭</span></div>
    </div>`
}

function mainHeader() {
  const s = SESSIONS.find((x) => x.id === S.session)
  const title = s ? s.title : '新任务'
  const provider = s ? PROVIDERS[s.provider] : PROVIDERS.deepseek
  const streaming = S.session === 's2' && S.planState === 'approved'
  return `
  <div class="main-head">
    <span class="main-title">${esc(title)}</span>
    <span class="chip accent">${provider.letter}</span>
    ${streaming
      ? `<span class="live"><span class="live-dot"></span>生成中 · 42 tok/s</span>`
      : `<span class="chip outline">${ic('circle-check')} 已连接网页版</span>`}
    <span class="main-sub">${S.session === 's1' ? '2 个文件 · 1.9s' : ''}</span>
    <div class="main-head-right">
      <button class="icon-btn" title="网络标签页" data-act="toast">${ic('panel-top')}</button>
      <button class="icon-btn" title="导出会话" data-act="toast">${ic('download')}</button>
      <button class="icon-btn" data-act="open-dock" data-panel="files" data-active="${S.dockOpen && S.dock === 'files'}" title="文件面板 Ctrl Alt E">${ic('panel-right')}</button>
      <button class="icon-btn" data-act="open-dock" data-panel="review" data-active="${S.dockOpen && S.dock === 'review'}" title="审阅 Ctrl Shift G">${ic('file-diff')}</button>
      <button class="icon-btn" data-act="open-dock" data-panel="terminal" data-active="${S.dockOpen && S.dock === 'terminal'}" title="终端 Ctrl \`">${ic('terminal')}</button>
      <button class="icon-btn" data-act="palette-open" title="命令面板 Ctrl K">${ic('more-horizontal')}</button>
    </div>
  </div>`
}

/* ------------------------------ 右侧栏 ------------------------------ */

function dock() {
  if (!S.dockOpen || S.view !== 'home') return ''
  const tabs = [
    { id: 'files', label: '文件', icon: 'folder-tree', n: '' },
    { id: 'tasks', label: '任务', icon: 'list-todo', n: String(S.tasks.filter((t) => t.status !== 'done' && t.status !== 'skipped').length) },
    { id: 'terminal', label: '终端', icon: 'terminal-square', n: '' },
    { id: 'review', label: '审阅', icon: 'file-diff', n: S.session === 's1' ? '2' : '' }
  ]
  return `
  <aside class="dock">
    <div class="dock-head">
      <div class="dock-tabs">
        ${tabs.map(
          (t) => `
          <button class="dock-tab" data-act="dock-tab" data-panel="${t.id}" data-active="${S.dock === t.id}">
            ${ic(t.icon)} ${t.label} ${t.n ? `<span class="n">${t.n}</span>` : ''}
          </button>`
        ).join('')}
      </div>
      <span style="flex:1"></span>
      <button class="icon-btn" title="收起侧栏" data-act="close-dock">${ic('x')}</button>
    </div>
    <div class="dock-body" data-keep-scroll="dock">
      ${S.dock === 'review' ? dockReview() : ''}
      ${S.dock === 'files' ? dockFiles() : ''}
      ${S.dock === 'tasks' ? dockTasks() : ''}
      ${S.dock === 'terminal' ? dockTerminal() : ''}
    </div>
  </aside>`
}

function dockEmpty(title, hint) {
  return `
    <div class="dock-empty">
      ${ic('file-diff')}
      <b>${title}</b>
      <span>${hint}</span>
    </div>`
}

function dockReview() {
  if (S.session !== 's1') return dockEmpty('暂无文件变更', '计划确认后，AI 修改的文件会出现在这里，可逐行审阅')
  return `
    <div class="dock-bar"><b style="font-weight:500;color:var(--text)">2 个文件</b><span style="color:var(--success)">+39</span><span style="color:var(--danger)">−2</span><span class="grow"></span><span>未提交</span></div>
    <div class="diff-list">
      <button class="diff-file" data-active="true"><span style="color:var(--accent)">M</span> src/routes/health.ts <span class="a">+19</span><span class="d">−2</span></button>
      <button class="diff-file"><span style="color:var(--success)">A</span> test/health.test.ts <span class="a">+20</span></button>
    </div>
    <div class="diff-body">
      ${HEALTH_DIFF.map(
        (l) => `<div class="diff-line ${l.t}"><span class="no">${l.no}</span><span class="tx">${esc(l.tx)}</span></div>`
      ).join('')}
    </div>`
}

function dockFiles() {
  return `
    <div class="dock-bar">
      ${ic('folder-open')} <b style="font-weight:500;color:var(--text)">orbit-api</b>
      <span class="grow"></span>
      <button class="icon-btn" style="width:22px;height:22px" data-act="toast" title="在资源管理器中打开">${ic('folder')}</button>
      <button class="icon-btn" style="width:22px;height:22px" data-act="toast" title="刷新">${ic('refresh-cw')}</button>
    </div>
    <div class="tree">
      <div class="tree-row" style="color:var(--text-3)">${ic('chevron-down', 'dir')}<span>src</span></div>
      <div class="tree-row" style="padding-left:20px">${ic('folder', 'dir')}<span>routes</span></div>
      <div class="tree-row" style="padding-left:34px" data-active="true">${ic('file-code')}<span>health.ts</span><span class="muted">28</span></div>
      <div class="tree-row" style="padding-left:34px">${ic('file-code')}<span>users.ts</span><span class="muted">164</span></div>
      <div class="tree-row" style="padding-left:20px">${ic('folder', 'dir')}<span>lib</span></div>
      <div class="tree-row" style="padding-left:34px">${ic('file-code')}<span>db.ts</span><span class="muted">42</span></div>
      <div class="tree-row" style="padding-left:34px">${ic('file-code')}<span>timeout.ts</span><span class="muted">18</span></div>
      <div class="tree-row" style="padding-left:20px">${ic('folder', 'dir')}<span>test</span></div>
      <div class="tree-row" style="padding-left:34px">${ic('file-code')}<span>health.test.ts</span><span class="muted">31</span></div>
      <div class="tree-row">${ic('file-text')}<span>package.json</span><span class="muted">38</span></div>
      <div class="tree-row">${ic('file-text')}<span>README.md</span><span class="muted">96</span></div>
    </div>
    <div class="preview">
      <div class="preview-path">${ic('file-code')} src/routes/health.ts</div>
      <pre class="code"><span class="ln">1</span><span class="k">import</span> { Router } <span class="k">from</span> <span class="s">'express'</span>
<span class="ln">2</span><span class="k">import</span> { db } <span class="k">from</span> <span class="s">'../lib/db'</span>
<span class="ln">3</span><span class="k">import</span> { withTimeout } <span class="k">from</span> <span class="s">'../lib/timeout'</span>
<span class="ln">4</span>
<span class="ln">5</span><span class="k">export const</span> health = <span class="k">new</span> Router()
<span class="ln">6</span>
<span class="ln">7</span>health.get(<span class="s">'/'</span>, <span class="k">async</span> (_req, res) =&gt; {
<span class="ln">8</span>  <span class="k">await</span> withTimeout(db.ping(), <span class="s">2_000</span>)
<span class="ln">9</span>  res.json({ ok: <span class="k">true</span>, db: <span class="s">'up'</span> })
<span class="ln">10</span>})</pre>
    </div>`
}

function dockTasks() {
  const done = S.tasks.filter((t) => t.status === 'done').length
  return `
    <div class="dock-bar"><span>已完成 ${done} / ${S.tasks.length}</span><span class="grow"></span><span class="chip accent" style="height:18px">todoWrite</span></div>
    <div>${S.tasks
      .map(
        (t) => `
      <div class="mini-task" data-st="${t.status}">
        <span class="ck">${ic('check')}</span>
        <span class="tx">${esc(t.title)}</span>
        <span class="st">${statusLabel(t.status)}</span>
      </div>`
      )
      .join('')}</div>
    <div style="padding:10px">
      <button class="btn btn-outline btn-sm" data-act="toast" style="width:100%">${ic('plus')} 添加待办</button>
    </div>`
}

function dockTerminal() {
  return `
    <div class="term">
      <div><span class="p">orbit-api</span> <span class="dim">main</span> $ npm test -- health</div>
      <div class="dim"> RUN  v2.1.3  D:\\work\\orbit-api</div>
      <div><span class="ok"> ✓ </span>test/health.test.ts &gt; 返回 200 与 db 延迟</div>
      <div><span class="ok"> ✓ </span>test/health.test.ts &gt; 数据库超时返回 503</div>
      <div class="dim"> Tests  2 passed (2)</div>
      <div class="dim"> Time   1.84s</div>
      <div><span class="p">orbit-api</span> <span class="dim">main</span> $ <span class="dim">▍</span></div>
    </div>`
}

function statusLabel(st) {
  return { pending: '待办', running: '进行中', done: '完成', failed: '失败', skipped: '跳过' }[st] || st
}

/* ------------------------------ 管理页 ------------------------------ */

function pageShell({ title, desc, actions = '', body, extraHead = '' }) {
  return `
  <div class="page-wrap">
    <div class="page" data-keep-scroll="page">
      <div class="page-inner">
        <div class="page-head">
          <div>
            <div class="page-title">${title}</div>
            ${desc ? `<div class="page-desc">${desc}</div>` : ''}
          </div>
          <div class="page-actions">${actions}</div>
        </div>
        ${extraHead}
        ${body}
      </div>
    </div>
  </div>`
}

function projectsPage() {
  const items = [
    { name: 'orbit-api', root: 'D:\\work\\orbit-api', active: true, sessions: 34, missing: false },
    { name: 'lidow-web', root: 'D:\\work\\lidow-web', active: false, sessions: 21, missing: false },
    { name: 'docs-site', root: 'D:\\archive\\docs-site', active: false, sessions: 7, missing: true }
  ]
  return pageShell({
    title: '工作区',
    desc: '<b>3</b> 个项目 · <b>1</b> 个目录不存在 · 切换后会话与工具都按新项目路由',
    actions: `<button class="btn btn-outline" data-act="toast">${ic('folder-open')} 打开目录</button>`,
    body: `
      <div class="card list-card">
        ${items
          .map(
            (p) => `
        <div class="proj-card" data-active="${p.active}" style="border:0;border-radius:0;border-bottom:1px solid var(--border-soft)">
          <span class="big">${p.name.slice(0, 1).toUpperCase()}</span>
          <div class="grow">
            <div class="row" style="gap:7px">
              <span class="list-title">${p.name}</span>
              ${p.active ? '<span class="chip accent">当前项目</span>' : ''}
              ${p.missing ? '<span class="chip danger">目录不存在</span>' : ''}
            </div>
            <div class="list-sub mono">${p.root}</div>
          </div>
          <span class="muted">${p.sessions} 个会话</span>
          <div class="list-actions">
            ${p.active ? '<button class="btn btn-sm btn-ghost" data-act="nav" data-view="files">文件</button>' : '<button class="btn btn-sm btn-outline" data-act="toast">切换</button>'}
            <button class="btn btn-sm btn-ghost" data-act="toast">移除</button>
          </div>
        </div>`
          )
          .join('')}
      </div>
      <div class="tip-card" style="margin-top:12px">
        <span class="list-ic accent">${ic('shield-check')}</span>
        <div class="grow">
          <b>项目目录就是 AI 的操作边界</b>
          <p>工具调用被锁定在当前项目内，危险命令需要二次确认，删除默认进入回收站。</p>
        </div>
        <button class="btn btn-sm btn-outline" data-act="toast">安全设置</button>
      </div>`
  })
}

function sessionsPage() {
  const rows = [
    { p: 'deepseek', t: '为 /health 增加数据库探活', time: '今天 14:32', state: '已压缩 4 轮' },
    { p: 'deepseek', t: '重构用户列表分页', time: '今天 10:18', state: '派生会话' },
    { p: 'claude', t: '排查慢查询日志', time: '昨天 21:04', state: '' },
    { p: 'deepseek', t: '生成 v1.4 API 文档', time: '昨天 09:40', state: '已压缩 2 轮' },
    { p: 'chatgpt', t: '给设置页补空态', time: '10 月 27 日', state: '' }
  ]
  return pageShell({
    title: '会话',
    desc: '按项目查看历史任务，可打开、导出或删除',
    actions: `<button class="btn btn-outline" data-act="toast">${ic('refresh-cw')} 刷新</button><button class="btn btn-primary" data-act="new-task">${ic('plus')} 新建会话</button>`,
    extraHead: `
      <div class="stats">
        <div class="stat"><div class="lb">全部会话</div><div class="val">128</div></div>
        <div class="stat"><div class="lb">使用中的平台</div><div class="val">3 <small>DeepSeek · Claude · ChatGPT</small></div></div>
        <div class="stat"><div class="lb">已压缩</div><div class="val">12 <small>最近 30 天</small></div></div>
      </div>`,
    body: `
      <div class="toolbar">
        <label class="search-box" style="width:260px">${ic('search')}<input data-model="sessionSearch" value="${esc(S.sessionSearch)}" placeholder="搜索会话标题" /></label>
        <select class="field" style="width:130px"><option>全部平台</option><option>DeepSeek</option><option>Claude</option><option>ChatGPT</option></select>
        <span class="muted">${rows.length} 个结果</span>
      </div>
      <div class="card" style="overflow:hidden">
        <table class="table">
          <thead><tr><th style="width:120px">平台</th><th>标题</th><th style="width:130px">更新时间</th><th style="width:120px">状态</th><th class="actions" style="width:120px"></th></tr></thead>
          <tbody>
            ${rows
              .map(
                (r) => `
            <tr>
              <td><span class="row" style="gap:6px"><span class="sess-badge" data-p="${r.p}">${PROVIDERS[r.p].letter}</span>${PROVIDERS[r.p].name}</span></td>
              <td class="main-cell">${r.t}</td>
              <td class="muted tnum">${r.time}</td>
              <td>${r.state ? `<span class="chip outline">${r.state}</span>` : '<span class="muted">正常</span>'}</td>
              <td class="actions"><button class="btn btn-sm btn-ghost" data-act="toast">导出</button><button class="btn btn-sm btn-ghost" data-act="toast">删除</button></td>
            </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>`
  })
}

function filesPage() {
  return `
  <div class="page-wrap">
    <div class="page" data-keep-scroll="page">
      <div class="page-inner">
        <div class="page-head">
          <div>
            <div class="page-title">项目文件</div>
            <div class="page-desc mono">D:\\work\\orbit-api · 前 3 层 <b>84</b> 个文件</div>
          </div>
          <div class="page-actions">
            <button class="btn btn-outline" data-act="toast">${ic('folder-open')} 打开目录</button>
            <button class="btn btn-outline" data-act="toast">${ic('refresh-cw')} 刷新</button>
          </div>
        </div>
        <div class="files-split">
          <div class="card" style="overflow:hidden">
            <div class="tree" style="padding:8px">
              <div class="tree-row">${ic('chevron-down', 'dir')}<span>src</span></div>
              <div class="tree-row" style="padding-left:22px">${ic('chevron-down', 'dir')}<span>routes</span></div>
              <div class="tree-row" style="padding-left:38px" data-active="true">${ic('file-code')}<span>health.ts</span></div>
              <div class="tree-row" style="padding-left:38px">${ic('file-code')}<span>users.ts</span></div>
              <div class="tree-row" style="padding-left:22px">${ic('chevron-right', 'dir')}<span>lib</span></div>
              <div class="tree-row" style="padding-left:22px">${ic('chevron-right', 'dir')}<span>test</span></div>
              <div class="tree-row">${ic('chevron-right', 'dir')}<span>docs</span></div>
              <div class="tree-row">${ic('file-text')}<span>package.json</span></div>
              <div class="tree-row">${ic('file-text')}<span>README.md</span></div>
              <div class="tree-row">${ic('file-cog')}<span>tsconfig.json</span></div>
            </div>
          </div>
          <div class="card" style="overflow:hidden">
            <div class="card-head">
              <span class="mono" style="font-size:11px">src/routes/health.ts</span>
              <span style="flex:1"></span>
              <button class="btn btn-sm btn-ghost" data-act="toast">在系统中查看</button>
            </div>
            <pre class="code" style="padding:14px;font-size:11.5px;line-height:1.9"><span class="ln"> 1</span><span class="k">import</span> { Router } <span class="k">from</span> <span class="s">'express'</span>
<span class="ln"> 2</span><span class="k">import</span> { db } <span class="k">from</span> <span class="s">'../lib/db'</span>
<span class="ln"> 3</span><span class="k">import</span> { withTimeout } <span class="k">from</span> <span class="s">'../lib/timeout'</span>
<span class="ln"> 4</span>
<span class="ln"> 5</span><span class="k">export const</span> health = <span class="k">new</span> Router()
<span class="ln"> 6</span>
<span class="ln"> 7</span>health.get(<span class="s">'/'</span>, <span class="k">async</span> (_req, res) =&gt; {
<span class="ln"> 8</span>  <span class="k">const</span> startedAt = Date.now()
<span class="ln"> 9</span>  <span class="k">try</span> {
<span class="ln">10</span>    <span class="k">await</span> withTimeout(db.ping(), <span class="s">2_000</span>)
<span class="ln">11</span>    res.json({
<span class="ln">12</span>      ok: <span class="k">true</span>, uptime: process.uptime(), db: <span class="s">'up'</span>,
<span class="ln">13</span>      dbLatencyMs: Date.now() - startedAt
<span class="ln">14</span>    })
<span class="ln">15</span>  } <span class="k">catch</span> {
<span class="ln">16</span>    <span class="c">// readiness probe 需要 503 才会摘流量</span>
<span class="ln">17</span>    res.status(<span class="s">503</span>).json({ ok: <span class="k">false</span>, db: <span class="s">'down'</span> })
<span class="ln">18</span>  }
<span class="ln">19</span>})</pre>
          </div>
        </div>
      </div>
    </div>
  </div>`
}

function tasksPage() {
  const cols = [
    { k: 'pending', label: '待办' },
    { k: 'running', label: '进行中' },
    { k: 'done', label: '已完成' },
    { k: 'failed', label: '失败' }
  ]
  const done = S.tasks.filter((t) => t.status === 'done').length
  return pageShell({
    title: '任务看板',
    desc: `<b>${done} / ${S.tasks.length}</b> 已完成 · AI 会通过 todoWrite 自动同步进度`,
    actions: `<button class="btn btn-outline" data-act="toast">${ic('refresh-cw')} 刷新</button><button class="btn btn-outline" data-act="toast">清理已完成</button>`,
    extraHead: `
      <div class="stats">
        <div class="stat"><div class="lb">待办</div><div class="val">${S.tasks.filter((t) => t.status === 'pending').length}</div></div>
        <div class="stat"><div class="lb">进行中</div><div class="val">${S.tasks.filter((t) => t.status === 'running').length}</div></div>
        <div class="stat"><div class="lb">已完成</div><div class="val">${done}</div></div>
        <div class="stat"><div class="lb">失败</div><div class="val">${S.tasks.filter((t) => t.status === 'failed').length}</div></div>
      </div>`,
    body: `
      <div class="toolbar">
        <input class="field" data-model="newTask" placeholder="添加待办，回车确认" style="width:320px" />
        <button class="btn btn-primary" data-act="add-task">${ic('plus')} 添加</button>
        <span class="grow"></span>
        <span class="muted">${ic('sparkles')} 与 AI 双向同步</span>
      </div>
      <div class="kanban">
        ${cols
          .map(
            (c) => `
          <div class="kcol" data-k="${c.k}">
            <div class="kcol-head"><span class="dot"></span>${c.label}<span class="n">${S.tasks.filter((t) => t.status === c.k).length}</span></div>
            <div class="kcol-body">
              ${S.tasks
                .filter((t) => t.status === c.k)
                .map(
                  (t) => `
                <div class="kcard" data-st="${t.status}">
                  <div class="tx">${esc(t.title)}</div>
                  <div class="meta">${t.ai ? `<span class="ai">${ic('sparkles')} AI</span>` : '<span>手动</span>'}${t.time ? `<span>· ${t.time}</span>` : ''}</div>
                </div>`
                )
                .join('')}
              ${S.tasks.filter((t) => t.status === c.k).length === 0 ? '<div class="muted" style="padding:10px;text-align:center">暂无任务</div>' : ''}
            </div>
          </div>`
          )
          .join('')}
      </div>`
  })
}

function skillsPage() {
  const tab = S.skillTab
  const list = SKILLS[tab]
  const groups = [...new Set(list.map((s) => s.cat))]
  return pageShell({
    title: '技能',
    desc: `项目 <b>${SKILLS.project.length}</b> · 用户 <b>${SKILLS.user.length}</b> · 回收站 <b>${SKILLS.trash.length}</b> · orbit-api`,
    actions: `
      <button class="btn btn-outline" data-act="toast">${ic('folder-open')} 打开目录</button>
      <button class="btn btn-outline" data-act="toast">${ic('download')} 导入现有技能</button>
      <button class="btn btn-outline" data-act="toast">${ic('github')} 从 GitHub 安装</button>
      <button class="btn btn-primary" data-act="toast">${ic('plus')} 新建技能</button>`,
    extraHead: `
      <div class="tabs-line">
        <button data-act="skill-tab" data-tab="project" data-active="${tab === 'project'}">项目技能<span class="count">${SKILLS.project.length}</span></button>
        <button data-act="skill-tab" data-tab="user" data-active="${tab === 'user'}">用户技能<span class="count">${SKILLS.user.length}</span></button>
        <button data-act="skill-tab" data-tab="trash" data-active="${tab === 'trash'}">回收站<span class="count">${SKILLS.trash.length}</span></button>
        <span style="flex:1"></span>
        <span class="muted" style="padding-bottom:8px">${tab === 'trash' ? '删除后 30 天内可恢复' : '渐进式披露 · 只有被用到时才注入上下文'}</span>
      </div>`,
    body: groups
      .map(
        (g) => `
      <div class="skill-group">
        <div class="skill-group-head">${g} <span style="font-weight:400;letter-spacing:0">${list.filter((s) => s.cat === g).length}</span></div>
        <div class="card">
          ${list
            .filter((s) => s.cat === g)
            .map(
              (s) => `
            <div class="skill-row" data-disabled="${!s.on && tab !== 'trash'}">
              <span class="skill-ic">${ic(tab === 'trash' ? 'trash-2' : 'sparkles')}</span>
              <div class="grow">
                <div class="name-line">
                  <span class="name">${s.name}</span>
                  ${!s.on && tab !== 'trash' ? '<span class="chip">已禁用</span>' : ''}
                </div>
                <div class="desc">${esc(s.desc)}</div>
              </div>
              <span class="path">${s.path}</span>
              <div class="actions">
                ${tab === 'trash'
                  ? `<button class="btn btn-sm btn-outline" data-act="toast">恢复</button><button class="btn btn-sm btn-ghost" data-act="toast">永久删除</button>`
                  : `<button class="btn btn-sm btn-ghost" data-act="toast">查看</button><button class="toggle" data-on="${s.on}" data-act="toggle-skill" data-id="${s.id}" title="${s.on ? '已启用' : '已禁用'}"></button>`}
              </div>
            </div>`
            )
            .join('')}
        </div>
      </div>`
      )
      .join('')
  })
}

function agentsPage() {
  return pageShell({
    title: '子代理',
    desc: `<b>${AGENTS.length}</b> 个 · 放在项目 .lidow/agents 或用户 ~/.lidow/agents`,
    actions: `<button class="btn btn-outline" data-act="toast">${ic('folder-open')} 打开目录</button><button class="btn btn-outline" data-act="toast">${ic('refresh-cw')} 刷新</button>`,
    body: `
      <div class="card list-card">
        ${AGENTS.map(
          (a) => `
        <div class="list-item">
          <span class="list-ic accent">${ic('bot')}</span>
          <div class="grow">
            <div class="row" style="gap:6px"><span class="list-title">${a.name}</span><span class="chip outline">${a.scope}</span></div>
            <div class="list-sub">${a.desc}</div>
            <div class="list-sub mono" style="font-size:10px">${a.path}</div>
          </div>
          <div class="list-actions"><button class="btn btn-sm btn-ghost" data-act="toast">查看</button><button class="btn btn-sm btn-ghost" data-act="toast">编辑</button></div>
        </div>`
        ).join('')}
      </div>`
  })
}

function mcpPage() {
  const tools = MCP_SERVERS.reduce((n, s) => n + s.tools.length, 0)
  return pageShell({
    title: 'MCP 连接器',
    desc: `<b>${MCP_SERVERS.length}</b> 个服务 · <b>${tools}</b> 个可用工具 · 兼容 Claude Desktop 配置格式`,
    actions: `<button class="btn btn-primary" data-act="toast">${ic('plus')} 添加 MCP 服务器</button>`,
    body: `
      <div class="card list-card">
        ${MCP_SERVERS.map(
          (m) => `
        <div class="list-item" style="align-items:flex-start;padding:14px">
          <span class="list-ic ${m.on ? 'success' : ''}">${ic('plug')}</span>
          <div class="grow">
            <div class="row" style="gap:6px">
              <span class="list-title">${m.name}</span>
              <span class="chip ${m.on ? 'success' : ''}">${m.on ? '已启用' : '已停用'}</span>
              <span class="muted">${m.tools.length} 个工具</span>
            </div>
            <div class="list-sub mono" style="font-size:10px;margin-bottom:6px">${m.cmd}</div>
            <div class="row" style="flex-wrap:wrap;gap:5px">
              ${m.tools.map((t) => `<span class="chip outline mono" style="font-size:10px">${m.name}/${t}</span>`).join('')}
            </div>
          </div>
          <div class="list-actions">
            <button class="toggle" data-on="${m.on}" data-act="toast"></button>
            <button class="btn btn-sm btn-ghost" data-act="toast">移除</button>
          </div>
        </div>`
        ).join('')}
      </div>
      <div class="tip-card" style="margin-top:12px">
        <span class="list-ic">${ic('terminal')}</span>
        <div class="grow">
          <b>stdio 与 HTTP 两种接入方式</b>
          <p>支持从 Claude Desktop 配置一键导入，连接状态与工具清单实时可见。</p>
        </div>
        <button class="btn btn-sm btn-outline" data-act="toast">导入配置</button>
      </div>`
  })
}

function pluginsPage() {
  return pageShell({
    title: '插件与扩展',
    desc: 'DSH 兼容 <b>119</b> / <b>119</b> · 安装后立即加载生效',
    actions: `<button class="btn btn-outline" data-act="toast">${ic('refresh-cw')} 刷新</button>`,
    extraHead: `<div class="tabs-line"><button data-active="true">已安装<span class="count">3</span></button><button data-act="toast">内置精选<span class="count">8</span></button><button data-act="toast">在线市场<span class="count">24</span></button></div>`,
    body: `
      <div class="card list-card">
        ${PLUGINS.map(
          (p) => `
        <div class="list-item" style="padding:13px 14px">
          <span class="list-ic accent">${ic('puzzle')}</span>
          <div class="grow">
            <div class="row" style="gap:6px"><span class="list-title">${p.name}</span><span class="muted mono">v${p.ver}</span><span class="chip outline">${p.provides}</span><span class="chip ${p.on ? 'success' : ''}">${p.on ? '已启用' : '已停用'}</span></div>
            <div class="list-sub">${p.desc}</div>
          </div>
          <div class="list-actions">
            <button class="toggle" data-on="${p.on}" data-act="toast"></button>
            <button class="btn btn-sm btn-ghost" data-act="toast">卸载</button>
          </div>
        </div>`
        ).join('')}
      </div>
      <div class="card" style="margin-top:12px">
        <div class="card-head"><b>在线市场</b><span class="muted">GitHub + Gitee 双源</span></div>
        <div class="card-body row">
          <input class="field" style="flex:1" placeholder="搜索市场（GitHub / Gitee），回车搜索" />
          <button class="btn btn-primary" data-act="toast">搜索</button>
        </div>
      </div>`
  })
}

function quickPage() {
  return pageShell({
    title: '快捷指令',
    desc: `<b>${QUICK.length}</b> 条 · 在对话框输入 /触发词 使用`,
    actions: '',
    body: `
      <div class="quick-cols">
        <div class="card">
          <div class="card-head"><b>新增指令</b><span class="muted">输入 / 即可唤起</span></div>
          <div class="card-body" style="display:flex;flex-direction:column;gap:10px">
            <label><div class="muted" style="margin-bottom:4px">名称</div><input class="field" style="width:100%" placeholder="例如：审查当前改动" /></label>
            <label><div class="muted" style="margin-bottom:4px">触发词</div><input class="field" style="width:100%" placeholder="/review" /></label>
            <label><div class="muted" style="margin-bottom:4px">提示词模板</div><textarea class="field" rows="5" style="width:100%" placeholder="描述这条指令要 AI 做什么"></textarea></label>
            <div class="row"><span class="grow"></span><button class="btn btn-primary" data-act="toast">保存指令</button></div>
          </div>
        </div>
        <div class="card list-card">
          <div class="card-head"><b>已保存的指令</b><span class="muted">${QUICK.length} 条，输入 / 唤起</span></div>
          ${QUICK.map(
            (q) => `
          <div class="list-item" style="align-items:flex-start">
            <span class="list-ic">${ic('command')}</span>
            <div class="grow">
              <div class="row" style="gap:8px"><span class="mono" style="font-size:11.5px;color:var(--accent)">${q.trigger}</span><span class="list-title">${q.name}</span></div>
              <div class="list-sub" style="margin-top:2px">${esc(q.tpl)}</div>
            </div>
            <div class="list-actions"><button class="btn btn-sm btn-ghost" data-act="toast">编辑</button><button class="btn btn-sm btn-ghost" data-act="toast">删除</button></div>
          </div>`
          ).join('')}
        </div>
      </div>`
  })
}

function memoryPage() {
  return pageShell({
    title: '用户记忆',
    desc: `<b>${MEMORY.length}</b> 条 · 跨会话生效，AI 通过 remember 工具写入`,
    actions: `<button class="btn btn-primary" data-act="toast">${ic('plus')} 新增记忆</button>`,
    extraHead: `<div class="toolbar"><label class="search-box" style="width:280px">${ic('search')}<input data-model="memorySearch" placeholder="搜索记忆" /></label><span class="muted">${MEMORY.length} 条</span></div>`,
    body: `
      <div class="card list-card">
        ${MEMORY.map(
          (m) => `
        <div class="list-item" style="align-items:flex-start;padding:14px">
          <span class="list-ic accent">${ic('brain')}</span>
          <div class="grow">
            <div class="row" style="gap:7px">
              <b style="font-size:12.5px">${m.title}</b>
              <span style="flex:1"></span>
              <span class="muted">${m.src} · ${m.time}</span>
              <button class="icon-btn" style="width:22px;height:22px" data-act="toast" title="删除">${ic('trash-2')}</button>
            </div>
            <div class="row" style="gap:4px;margin-top:4px">${m.tags.map((t) => `<span class="chip outline">${t}</span>`).join('')}</div>
            <div class="memory-body">${esc(m.body)}</div>
          </div>
        </div>`
        ).join('')}
      </div>`
  })
}

function knowledgePage() {
  return pageShell({
    title: '本地知识库',
    desc: `<b>${KNOWLEDGE.length}</b> 个库 · 挂载目录后 AI 可用 kbSearch 工具检索`,
    actions: `<button class="btn btn-outline" data-act="toast">${ic('refresh-cw')} 刷新</button><button class="btn btn-primary" data-act="toast">${ic('folder-open')} 挂载目录</button>`,
    body: `
      <div class="card list-card" style="margin-bottom:12px">
        ${KNOWLEDGE.map(
          (k) => `
        <div class="list-item">
          <span class="list-ic accent">${ic('library')}</span>
          <div class="grow">
            <div class="row" style="gap:6px"><span class="list-title">${k.name}</span><span class="chip outline">${k.docs} 文档</span></div>
            <div class="list-sub mono" style="font-size:10px">${k.root}</div>
          </div>
          <div class="list-actions"><button class="btn btn-sm btn-ghost" data-act="toast">重建索引</button><button class="btn btn-sm btn-ghost" data-act="toast">移除</button></div>
        </div>`
        ).join('')}
      </div>
      <div class="card">
        <div class="card-head"><b>检索测试</b><span class="muted">不会消耗网页版额度</span></div>
        <div class="card-body">
          <div class="row" style="margin-bottom:12px">
            <select class="field" style="width:180px"><option>全部知识库</option><option>架构决策记录</option><option>运维手册</option></select>
            <input class="field" style="flex:1" placeholder="查询内容，回车检索" />
            <button class="btn btn-primary" data-act="toast">${ic('search')} 搜索</button>
          </div>
          <div class="muted" style="margin-bottom:6px">上次检索「游标分页」的结果</div>
          <div class="list-card" style="border:1px solid var(--border);border-radius:var(--r-md)">
            ${[
              { p: 'docs/adr/0007-pagination.md', r: '0.91', s: '列表接口统一使用游标分页，游标由 created_at 与 id 组成，禁止在公开参数里暴露 offset 上限。' },
              { p: 'docs/adr/0003-db-pool.md', r: '0.84', s: '连接池探活复用 db.ping()，超时 2 秒，失败返回 503 以配合 readiness probe。' },
              { p: 'ops/runbook/health.md', r: '0.72', s: '健康检查包含 uptime、db 状态与延迟三部分，告警阈值为连续 3 次 503。' }
            ].map(
              (x) => `
              <div class="list-item" style="align-items:flex-start">
                <span class="list-ic">${ic('file-text')}</span>
                <div class="grow">
                  <div class="row" style="gap:6px"><span class="mono" style="font-size:10.5px;color:var(--text-2)">${x.p}</span><span class="chip accent">相关度 ${x.r}</span></div>
                  <div class="list-sub" style="margin-top:3px">${x.s}</div>
                </div>
              </div>`
            ).join('')}
          </div>
        </div>
      </div>`
  })
}

function auditPage() {
  return pageShell({
    title: '执行审计',
    desc: `<b>${AUDIT.length}</b> 条记录 · 文件改动可单步回滚`,
    actions: `<button class="btn btn-outline" data-act="toast">${ic('download')} 导出</button>`,
    extraHead: `<div class="toolbar"><div class="segmented"><button data-active="true">全部</button><button data-act="toast">文件写入</button><button data-act="toast">删除</button><button data-act="toast">命令</button><button data-act="toast">工具</button></div><span class="grow"></span><span class="muted">最近 7 天</span></div>`,
    body: `
      <div class="card" style="overflow:hidden">
        <table class="table always-actions">
          <thead><tr><th style="width:110px">类型</th><th>内容</th><th style="width:110px">时间</th><th style="width:120px"></th></tr></thead>
          <tbody>
            ${AUDIT.map(
              (a) => `
            <tr>
              <td><span class="audit-type ${a.type}">${a.label}</span></td>
              <td class="${a.type === 'cmd' ? 'mono' : ''}" style="font-size:11.5px">${a.sum}</td>
              <td class="muted tnum">${a.time}</td>
              <td class="actions">${a.state === '已回滚' ? '<span class="chip outline">已回滚</span>' : a.type === 'write' ? '<button class="btn btn-sm btn-ghost" data-act="toast">回滚</button>' : '<button class="btn btn-sm btn-ghost" data-act="toast">查看</button>'}</td>
            </tr>`
            ).join('')}
          </tbody>
        </table>
      </div>`
  })
}

/* ------------------------------ 设置 ------------------------------ */

const SETTINGS_NAV = [
  { id: 'appearance', label: '外观', icon: 'palette' },
  { id: 'security', label: '安全', icon: 'shield-check' },
  { id: 'resilience', label: '对话韧性', icon: 'activity' },
  { id: 'accounts', label: '平台与账号', icon: 'users' },
  { id: 'mcp', label: 'MCP 服务器', icon: 'plug' },
  { id: 'sync', label: '多端同步', icon: 'send' },
  { id: 'about', label: '关于与更新', icon: 'info' }
]

function toggleRow(key, label, hint) {
  return `
    <div class="set-row">
      <div class="grow"><div class="set-label">${label}</div>${hint ? `<div class="set-hint">${hint}</div>` : ''}</div>
      <button class="toggle" data-on="${S.settings[key]}" data-act="toggle-flag" data-key="${key}"></button>
    </div>`
}

function settingsPage() {
  const sec = S.settingsSection
  const secTitle = SETTINGS_NAV.find((s) => s.id === sec).label
  return `
  <div class="page-wrap">
    <div class="page" data-keep-scroll="page">
      <div class="page-inner">
        <div class="page-head">
          <div>
            <div class="page-title">设置</div>
            <div class="page-desc">Lidow v0.7.9 · 所有设置保存在本机</div>
          </div>
          <div class="page-actions"><button class="btn btn-outline" data-act="toast">${ic('rotate-ccw')} 恢复默认</button></div>
        </div>
        <div class="settings-shell">
          <div class="settings-nav">
            ${SETTINGS_NAV.map(
              (s) => `<button data-act="settings-section" data-section="${s.id}" data-active="${sec === s.id}">${ic(s.icon)} ${s.label}</button>`
            ).join('')}
            <div class="muted" style="padding:9px;border-top:1px solid var(--border-soft);margin-top:4px">零 Token 成本 · GPL-3.0</div>
          </div>
          <div>
            ${settingsSectionContent(sec, secTitle)}
          </div>
        </div>
      </div>
    </div>
  </div>`
}

function settingsSectionContent(sec, title) {
  if (sec === 'appearance') {
    const themes = [
      { id: 'graphite', label: '石墨', bg: '#e7e9ed', rail: '#f3f4f6', panel: '#ffffff', a: '#4f6bed' },
      { id: 'light', label: '浅色', bg: '#eef0f3', rail: '#fafbfc', panel: '#ffffff', a: '#4f6bed' },
      { id: 'dark', label: '深色', bg: '#07090d', rail: '#0f1218', panel: '#1b212b', a: '#7d94f8' },
      { id: 'midnight', label: '深空蓝', bg: '#060a13', rail: '#0e1526', panel: '#172341', a: '#5b9cf8' },
      { id: 'system', label: '跟随系统', bg: '#e9ebef', rail: '#f7f8fa', panel: '#ffffff', a: '#4f6bed' }
    ]
    return `
      <div class="set-card">
        <div class="set-head"><b>主题</b><p>选择界面配色，切换立即生效</p></div>
        <div class="theme-picker">
          ${themes
            .map(
              (t) => `
            <button class="theme-opt" data-act="set-theme" data-theme="${t.id}" data-active="${S.themeChoice === t.id}">
              <span class="theme-swatch" style="background:${t.bg}">
                <i class="tl" style="background:${t.rail}"></i>
                <i class="tr" style="background:${t.panel};--sw-accent:${t.a}"></i>
              </span>
              <span class="nm">${t.label} ${S.themeChoice === t.id ? ic('check') : ''}</span>
            </button>`
            )
            .join('')}
        </div>
        <div class="set-row">
          <div class="grow"><div class="set-label">主色</div><div class="set-hint">用于按钮、选中态与运行状态</div></div>
          <div class="swatches">
            ${['#4f6bed', '#3f8f68', '#b06a2c', '#8a5cc4', '#b04a5a']
              .map((c) => `<button class="swatch" style="background:${c}" data-active="${S.accent === c}" data-act="toast"></button>`)
              .join('')}
            <button class="btn btn-sm btn-ghost" data-act="toast">恢复默认</button>
          </div>
        </div>
        ${toggleRow('pet', '鲸鱼娘桌宠', '待机呼吸，工作状态联动，右键可投喂')}
        <div class="set-row">
          <div class="grow"><div class="set-label">界面密度</div><div class="set-hint">影响列表行高与对话区留白</div></div>
          <div class="segmented"><button data-active="true">紧凑</button><button data-act="toast">舒适</button></div>
        </div>
      </div>
      <div class="set-card">
        <div class="set-head"><b>侧栏</b><p>工作台左侧栏与右侧工具面板</p></div>
        ${toggleRow('deleteGuard', '固定展开图标栏', '关闭后仅在悬停时展开')}
        <div class="set-row"><div class="grow"><div class="set-label">右侧面板默认页</div></div><select class="field"><option>审阅</option><option>文件</option><option>任务</option><option>终端</option></select></div>
      </div>`
  }

  if (sec === 'security') {
    return `
      <div class="set-card">
        <div class="set-head"><b>危险操作</b><p>AI 执行不可逆操作前需要你确认</p></div>
        ${toggleRow('confirmDanger', '危险命令需确认', 'rm、管道注入与变体会被识别')}
        ${toggleRow('deleteGuard', '删除保护', '文件删除优先进入系统回收站')}
        <div class="set-row"><div class="grow"><div class="set-label">批量删除审批阈值</div><div class="set-hint">单次删除超过该数量时统一审批</div></div><input class="field num" value="${S.settings.batchLimit}" /></div>
        ${toggleRow('ssrf', 'SSRF 防护', '阻断私网、回环与云元数据端点')}
      </div>
      <div class="set-card">
        <div class="set-head"><b>安全 MOD</b><p>面向安全研究与授权测试场景</p></div>
        ${toggleRow('securityMod', 'AI 回复拦截', '按正则拦截越界回复')}
        ${toggleRow('ctf', 'CTF / 安全研究模式', '开启后危险命令改为提示，不自动执行')}
      </div>
      <div class="set-card">
        <div class="set-head"><b>执行限制</b></div>
        <div class="set-row"><div class="grow"><div class="set-label">命令超时</div><div class="set-hint">超时后终止进程并回报退出码</div></div><input class="field num" value="${S.settings.cmdTimeout}" /><span class="muted">秒</span></div>
      </div>`
  }

  if (sec === 'resilience') {
    return `
      <div class="set-card">
        <div class="set-head"><b>发送与重试</b><p>降低网页端限频与失败成本</p></div>
        <div class="set-row"><div class="grow"><div class="set-label">网页发送间隔</div><div class="set-hint">同一网页连续发送的最小间隔</div></div><input class="field num" value="${S.settings.sendInterval}" /><span class="muted">秒</span></div>
        ${toggleRow('retry', '失败自动重试', '首次延迟 4 秒，最多重试 10 次，429 时等待 120 秒')}
      </div>
      <div class="set-card">
        <div class="set-head"><b>看门狗</b><p>网页静默超过阈值时自动催继续</p></div>
        ${toggleRow('watchdog', '自动催继续', '静默 90 秒后发送「请继续」，最多 3 次')}
        ${toggleRow('autoCompact', '自动压缩上下文', '达到 600000 字符时压缩历史')}
        ${toggleRow('repeatPrompt', '每轮重复注入系统提示词', '默认关闭，只在会话首条发送')}
      </div>
      <div class="set-card">
        <div class="set-head"><b>用量</b></div>
        <div class="set-row"><div class="grow"><div class="set-label">累计消耗</div><div class="set-hint">服务端权威值，零 API 费用</div></div><b class="tnum">≈ 1.28M tokens</b></div>
      </div>`
  }

  if (sec === 'accounts') {
    return `
      <div class="set-card">
        <div class="set-head"><b>网页版平台</b><p>每个账号独立分区，登录态互不干扰</p></div>
        ${[
          { name: 'DeepSeek', home: 'chat.deepseek.com', accounts: ['默认账号', '账号 2'] },
          { name: 'Claude', home: 'claude.ai', accounts: ['默认账号'] },
          { name: 'ChatGPT', home: 'chatgpt.com', accounts: ['默认账号'] }
        ]
          .map(
            (p) => `
          <div class="provider-row">
            <span class="sess-badge" data-p="${p.name === 'DeepSeek' ? 'deepseek' : p.name === 'Claude' ? 'claude' : 'chatgpt'}">${p.name[0]}</span>
            <div class="grow"><div class="set-label">${p.name}</div><div class="set-hint mono">${p.home}</div></div>
            <div class="row" style="gap:5px">${p.accounts.map((a) => `<span class="chip ${a === '默认账号' ? 'accent' : 'outline'}">${a}</span>`).join('')}</div>
            <button class="btn btn-sm btn-outline" data-act="toast">添加账号</button>
          </div>`
          )
          .join('')}
      </div>`
  }

  if (sec === 'mcp') {
    return `
      <div class="set-card">
        <div class="set-head"><b>MCP 概览</b><p>已配置 2 个服务，8 个可用工具</p></div>
        <div class="set-row"><div class="grow"><div class="set-label">filesystem</div><div class="set-hint mono">5 个工具 · 已启用</div></div><span class="chip success">连接正常</span></div>
        <div class="set-row"><div class="grow"><div class="set-label">mysql-local</div><div class="set-hint mono">3 个工具 · 已启用</div></div><span class="chip success">连接正常</span></div>
      </div>`
  }

  if (sec === 'sync') {
    return `
      <div class="set-card">
        <div class="set-head"><b>群机器人推送</b><p>仅提供出站推送，任务完成或失败时通知</p></div>
        ${['飞书', '企业微信', '钉钉']
          .map(
            (n) => `
          <div class="set-row">
            <span class="list-ic">${ic('send')}</span>
            <div class="grow"><div class="set-label">${n}</div><div class="set-hint">Webhook 地址保存在本机</div></div>
            <button class="toggle" data-on="false" data-act="toast"></button>
          </div>
          <div class="set-row" style="padding-top:0"><input class="field" style="flex:1;width:auto" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…" /></div>`
          )
          .join('')}
      </div>`
  }

  return `
    <div class="set-card">
      <div class="set-head"><b>版本</b><p>Lidow v0.7.9 · GPL-3.0-or-later</p></div>
      <div class="set-row"><div class="grow"><div class="set-label">自动更新</div><div class="set-hint">启动时检查，下载完成后提示重启安装</div></div><button class="btn btn-primary" data-act="toast">检查更新</button></div>
      <div class="set-row"><div class="grow"><div class="set-label">更新通道</div></div><select class="field"><option>稳定版</option><option>预览版</option></select></div>
    </div>
    <div class="set-card">
      <div class="set-head"><b>关于</b></div>
      <div class="set-row"><div class="grow"><div class="set-label">项目主页</div><div class="set-hint">github.com/cv-superding/lidow</div></div><button class="btn btn-sm btn-outline" data-act="toast">打开</button></div>
      <div class="set-row"><div class="grow"><div class="set-label">问题反馈</div><div class="set-hint">QQ 群 287603167</div></div><button class="btn btn-sm btn-outline" data-act="toast">复制群号</button></div>
    </div>`
}

/* ------------------------------ 页面装配 ------------------------------ */

function mainContent() {
  if (S.view !== 'home') {
    const pages = {
      projects: projectsPage,
      sessions: sessionsPage,
      files: filesPage,
      tasks: tasksPage,
      skills: skillsPage,
      agents: agentsPage,
      mcp: mcpPage,
      plugins: pluginsPage,
      quick: quickPage,
      memory: memoryPage,
      knowledge: knowledgePage,
      audit: auditPage,
      settings: settingsPage
    }
    return `<main class="main">${(pages[S.view] || projectsPage)()}</main>`
  }
  return `
  <main class="main">
    ${mainHeader()}
    <div class="chat-wrap">
      <div class="chat" data-keep-scroll="chat">
        <div class="chat-inner">${chatMessages()}</div>
      </div>
      ${composer()}
    </div>
  </main>`
}

function appHTML() {
  return `
    ${titlebar()}
    <div class="app-body">
      ${rail()}
      ${S.view === 'home' ? (S.paneOpen ? sessionPane() : paneCollapsed()) : ''}
      ${mainContent()}
      ${dock()}
    </div>`
}

/* ------------------------------ 浮层 ------------------------------ */

const PALETTE_ACTIONS = [
  { group: '导航', icon: 'layout-dashboard', label: '工作台', desc: '对话与工具', act: 'nav', view: 'home' },
  { group: '导航', icon: 'list-checks', label: '任务看板', desc: 'todoWrite 同步', act: 'nav', view: 'tasks' },
  { group: '导航', icon: 'sparkles', label: '技能', desc: '16 个可用', act: 'nav', view: 'skills' },
  { group: '导航', icon: 'settings', label: '设置', desc: '主题、安全、账号', act: 'nav', view: 'settings' },
  { group: '动作', icon: 'plus', label: '新建任务', desc: 'Ctrl N', act: 'new-task' },
  { group: '动作', icon: 'file-diff', label: '打开审阅', desc: 'Ctrl Shift G', act: 'open-review' },
  { group: '动作', icon: 'terminal', label: '打开终端', desc: 'Ctrl `', act: 'open-dock', panel: 'terminal' },
  { group: '动作', icon: 'sun-moon', label: '切换主题', desc: '浅色 / 深色', act: 'toggle-theme' },
  { group: '技能', icon: 'wand-sparkles', label: 'animate', desc: '构建动画', act: 'toast' },
  { group: '技能', icon: 'scan-eye', label: 'review-animations', desc: '审查动效', act: 'toast' },
  { group: '技能', icon: 'pen-tool', label: 'emil-design-eng', desc: '界面打磨', act: 'toast' }
]

function paletteHTML() {
  const q = S.paletteQuery.trim().toLowerCase()
  const items = PALETTE_ACTIONS.filter(
    (i) => !q || i.label.toLowerCase().includes(q) || i.group.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q)
  )
  const groups = [...new Set(items.map((i) => i.group))]
  let flat = 0
  return `
  <div class="scrim" data-act="palette-close">
    <div class="palette" data-stop="1">
      <div class="palette-input">
        ${ic('search')}
        <input data-model="paletteQuery" data-focus="palette" value="${esc(S.paletteQuery)}" placeholder="搜索页面、动作或技能" />
        <kbd>Esc</kbd>
      </div>
      <div class="palette-list">
        ${groups
          .map(
            (g) => `
          <div class="palette-group">${g}</div>
          ${items
            .filter((i) => i.group === g)
            .map((i) => {
              const idx = flat++
              return `<button class="palette-item" data-act="palette-item" data-idx="${idx}" data-sel="${S.paletteSel === idx}">${ic(i.icon)} ${i.label}<span class="desc">${i.desc}</span></button>`
            })
            .join('')}`
          )
          .join('')}
        ${items.length === 0 ? '<div class="muted" style="padding:16px;text-align:center">没有匹配的命令</div>' : ''}
      </div>
      <div class="palette-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 执行</span><span><kbd>Esc</kbd> 关闭</span></div>
    </div>
  </div>`
}

function modalHTML() {
  if (S.modal === 'delete') {
    return `
    <div class="scrim" data-act="modal-close">
      <div class="modal" data-stop="1">
        <div class="modal-head">
          <span class="modal-ic">${ic('trash-2')}</span>
          <div><div class="modal-title">删除会话</div><div class="modal-sub">为 /health 增加数据库探活</div></div>
        </div>
        <div class="modal-body">
          本地记录和 <b style="color:var(--text)">DeepSeek 网页端对话</b> 会一起删除，操作不可恢复。
          <div class="modal-note">网页端删除失败时，本地记录仍会移除。</div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-outline" data-act="modal-close">取消</button>
          <button class="btn btn-danger" data-act="confirm-delete">删除</button>
        </div>
      </div>
    </div>`
  }
  return ''
}

/* ------------------------------ 渲染 ------------------------------ */

function renderOverlays() {
  const root = document.getElementById('overlay-root')
  if (S.modal) {
    root.innerHTML = modalHTML()
  } else if (S.palette) {
    root.innerHTML = paletteHTML()
  } else {
    root.innerHTML = ''
  }
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.75 } })
  if (S.palette) {
    const input = document.querySelector('[data-focus="palette"]')
    if (input) {
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    }
  }
}

function resetShell() {
  // 切换主题时重建根节点：已存在元素上继承的属性不会重新解析，新节点才能拿到新主题值
  const old = document.getElementById('app')
  const fresh = document.createElement('div')
  fresh.id = 'app'
  fresh.className = 'app'
  old.replaceWith(fresh)
  document.body.style.background = S.theme === 'dark' ? '#0b0d12' : '#f3f5f8'
}

function render(opts = {}) {
  const scrollers = {}
  document.querySelectorAll('[data-keep-scroll]').forEach((el) => {
    scrollers[el.dataset.keepScroll] = el.scrollTop
  })
  document.getElementById('app').innerHTML = appHTML()
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.75 } })
  document.querySelectorAll('[data-keep-scroll]').forEach((el) => {
    if (scrollers[el.dataset.keepScroll] != null) el.scrollTop = scrollers[el.dataset.keepScroll]
  })
  if (opts.focus) {
    const f = document.querySelector(`[data-focus="${opts.focus}"]`)
    if (f) {
      f.focus()
      if (opts.caret && f.setSelectionRange) f.setSelectionRange(f.value.length, f.value.length)
    }
  }
  renderOverlays()
  autoGrow()
}

function autoGrow() {
  const ta = document.querySelector('textarea[data-model="composerText"]')
  if (!ta) return
  ta.style.height = 'auto'
  ta.style.height = Math.min(180, Math.max(54, ta.scrollHeight)) + 'px'
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function toast(msg, level = 'info') {
  const root = document.getElementById('toast-root')
  const el = document.createElement('div')
  el.className = 'toast'
  el.dataset.level = level
  el.innerHTML = `${ic(level === 'error' ? 'circle-alert' : level === 'warn' ? 'triangle-alert' : 'circle-check')}<span>${esc(msg)}</span>`
  root.appendChild(el)
  if (window.lucide) lucide.createIcons()
  setTimeout(() => {
    el.style.transition = 'opacity 200ms ease, transform 200ms ease'
    el.style.opacity = '0'
    el.style.transform = 'translateY(6px)'
    setTimeout(() => el.remove(), 220)
  }, 2400)
}

/* ------------------------------ 行为 ------------------------------ */

function activatePaletteItem(idx) {
  const q = S.paletteQuery.trim().toLowerCase()
  const items = PALETTE_ACTIONS.filter(
    (i) => !q || i.label.toLowerCase().includes(q) || i.group.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q)
  )
  const item = items[idx]
  if (!item) return
  S.palette = false
  if (item.act === 'nav') S.view = item.view
  if (item.act === 'new-task') newTask()
  if (item.act === 'open-review') {
    S.dock = 'review'
    S.dockOpen = true
  }
  if (item.act === 'open-dock') {
    S.dock = item.panel
    S.dockOpen = true
  }
  if (item.act === 'toggle-theme') toggleTheme()
  if (item.act === 'toast') toast(`已触发：${item.label}`)
  render()
}

function newTask() {
  S.view = 'home'
  S.session = null
  S.paneQuery = ''
  S.composerText = ''
  S.slash = false
  render({ focus: 'composer' })
}

function toggleTheme() {
  S.theme = S.theme === 'dark' ? 'light' : 'dark'
  S.themeChoice = S.theme
  document.documentElement.dataset.theme = S.theme
  localStorage.setItem('lidow-theme', S.theme)
  localStorage.setItem('lidow-theme-choice', S.themeChoice)
  resetShell()
}

function handleAction(act, el) {
  switch (act) {
    case 'nav':
      S.view = el.dataset.view
      S.palette = false
      render()
      break
    case 'session':
      S.session = el.dataset.id
      S.planState = 'pending'
      S.thinkOpen = false
      render()
      break
    case 'new-task':
      newTask()
      break
    case 'delete-session':
      S.modal = 'delete'
      renderOverlays()
      break
    case 'confirm-delete':
      S.modal = null
      renderOverlays()
      toast('会话已删除', 'info')
      break
    case 'modal-close':
      S.modal = null
      renderOverlays()
      break
    case 'toggle-theme':
      toggleTheme()
      render()
      break
    case 'dock-tab':
      S.dock = el.dataset.panel
      render()
      break
    case 'open-dock':
      if (S.dockOpen && S.dock === el.dataset.panel) {
        S.dockOpen = false
      } else {
        S.dockOpen = true
        S.dock = el.dataset.panel
      }
      render()
      break
    case 'close-dock':
      S.dockOpen = false
      render()
      break
    case 'collapse-pane':
      S.paneOpen = !S.paneOpen
      render()
      break
    case 'open-review':
      S.dockOpen = true
      S.dock = 'review'
      render()
      break
    case 'toggle-think':
      S.thinkOpen = !S.thinkOpen
      render()
      break
    case 'toggle-tool':
      S.toolOpen = !S.toolOpen
      render()
      break
    case 'plan-approve':
      S.planState = 'approved'
      toast('计划已确认，开始执行')
      render()
      break
    case 'plan-dismiss':
      if (S.planState === 'approved') {
        S.planState = 'pending'
        toast('已停止执行', 'warn')
      } else {
        S.planState = 'dismissed'
        toast('已放弃本次计划', 'warn')
      }
      render()
      break
    case 'quick':
      S.composerText = el.dataset.prompt
      render({ focus: 'composer', caret: true })
      break
    case 'send':
      if (S.session === 's2' && S.planState === 'approved') {
        S.planState = 'pending'
        toast('已停止生成', 'warn')
        render()
        break
      }
      if (!S.composerText.trim()) {
        toast('先输入一个任务', 'warn')
        break
      }
      if (!S.session) {
        const id = 'dyn' + Date.now()
        const title = S.composerText.trim().slice(0, 20)
        SESSIONS.unshift({ id, title, provider: 'deepseek', time: '刚刚', group: '今天' })
        S.session = id
      }
      if (!S.followUps[S.session]) S.followUps[S.session] = []
      S.followUps[S.session].push(S.composerText.trim())
      toast('任务已发送')
      S.composerText = ''
      S.slash = false
      render()
      break
    case 'slash-pick':
      S.composerText = el.dataset.cmd + ' '
      S.slash = false
      render({ focus: 'composer', caret: true })
      break
    case 'skill-tab':
      S.skillTab = el.dataset.tab
      render()
      break
    case 'toggle-skill': {
      const id = el.dataset.id
      ;[...SKILLS.project, ...SKILLS.user].forEach((s) => {
        if (s.id === id) s.on = !s.on
      })
      render()
      break
    }
    case 'settings-section':
      S.settingsSection = el.dataset.section
      render()
      break
    case 'set-theme': {
      const choice = el.dataset.theme
      S.themeChoice = choice
      if (choice === 'dark' || choice === 'midnight') S.theme = 'dark'
      else if (choice === 'system') S.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      else S.theme = 'light'
      document.documentElement.dataset.theme = S.theme
      localStorage.setItem('lidow-theme', S.theme)
      localStorage.setItem('lidow-theme-choice', S.themeChoice)
      resetShell()
      render()
      break
    }
    case 'toggle-flag':
      S.settings[el.dataset.key] = !S.settings[el.dataset.key]
      render()
      break
    case 'add-task': {
      const input = document.querySelector('[data-model="newTask"]')
      if (!input || !input.value.trim()) {
        toast('先输入待办内容', 'warn')
        break
      }
      S.tasks.push({ id: 't' + Date.now(), title: input.value.trim(), status: 'pending', ai: false, time: '' })
      input.value = ''
      toast('待办已添加')
      render()
      break
    }
    case 'palette-open':
      S.palette = true
      S.paletteQuery = ''
      S.paletteSel = 0
      renderOverlays()
      break
    case 'palette-close':
      if (el === el.ownerDocument.querySelector('.scrim') && el.contains(document.activeElement)) return
      S.palette = false
      renderOverlays()
      break
    case 'palette-item':
      activatePaletteItem(Number(el.dataset.idx))
      break
    case 'clear-pane':
      S.paneQuery = ''
      render({ focus: 'pane-search' })
      break
    case 'toast':
      toast('原型演示：该操作在正式版中生效')
      break
    default:
      break
  }
}

/* ------------------------------ 事件 ------------------------------ */

let composing = false

document.addEventListener('compositionstart', () => (composing = true))
document.addEventListener('compositionend', (e) => {
  composing = false
  if (e.target?.dataset?.model === 'paneQuery') {
    S.paneQuery = e.target.value
    render({ focus: 'pane-search', caret: true })
  }
})

document.addEventListener('click', (e) => {
  const stop = e.target.closest('[data-stop]')
  if (stop && !e.target.closest('[data-act]')) return
  const el = e.target.closest('[data-act]')
  if (!el) return
  // 阻止点击遮罩内部冒泡到遮罩本身
  if (el.classList.contains('scrim')) {
    const inner = e.target.closest('.palette, .modal')
    if (inner) return
  }
  e.preventDefault()
  handleAction(el.dataset.act, el)
})

document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-model]')
  if (!el) return
  const key = el.dataset.model
  if (key === 'composerText') {
    S.composerText = el.value
    const shouldShow = el.value.startsWith('/')
    if (shouldShow !== S.slash) {
      S.slash = shouldShow
      // 只更新菜单，不重绘输入框，避免打断中文输入
      const wrap = el.closest('.composer')
      const old = wrap.querySelector('.slash')
      if (old) old.remove()
      if (shouldShow) wrap.insertAdjacentHTML('afterbegin', slashMenu())
    } else if (shouldShow) {
      const old = el.closest('.composer').querySelector('.slash')
      if (old) old.outerHTML = slashMenu()
    }
    autoGrow()
    return
  }
  if (key === 'paletteQuery') {
    S.paletteQuery = el.value
    S.paletteSel = 0
    renderOverlays()
    return
  }
  if (composing) return
  if (key === 'paneQuery') {
    S.paneQuery = el.value
    render({ focus: 'pane-search', caret: true })
  }
  if (key === 'sessionSearch') {
    S.sessionSearch = el.value
  }
})

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()

  if (mod && key === 'k') {
    e.preventDefault()
    S.palette = true
    S.paletteQuery = ''
    S.paletteSel = 0
    renderOverlays()
    return
  }
  if (mod && key === 'n') {
    e.preventDefault()
    newTask()
    return
  }
  if (mod && e.key === ',') {
    e.preventDefault()
    S.view = 'settings'
    render()
    return
  }
  if (mod && e.key === '`') {
    e.preventDefault()
    S.view = 'home'
    S.dockOpen = true
    S.dock = 'terminal'
    render()
    return
  }
  if (e.key === 'Escape') {
    if (S.palette) {
      S.palette = false
      renderOverlays()
      return
    }
    if (S.modal) {
      S.modal = null
      renderOverlays()
      return
    }
    if (S.slash) {
      S.slash = false
      render()
      return
    }
  }
  if (S.palette) {
    const q = S.paletteQuery.trim().toLowerCase()
    const count = PALETTE_ACTIONS.filter(
      (i) => !q || i.label.toLowerCase().includes(q) || i.group.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q)
    ).length
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      S.paletteSel = (S.paletteSel + 1) % Math.max(1, count)
      renderOverlays()
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      S.paletteSel = (S.paletteSel - 1 + count) % Math.max(1, count)
      renderOverlays()
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      activatePaletteItem(S.paletteSel)
    }
    return
  }
  if (e.key === 'Enter' && !e.shiftKey && document.activeElement?.dataset?.model === 'composerText') {
    e.preventDefault()
    handleAction('send', document.activeElement)
  }
  if (e.key === 'Enter' && document.activeElement?.dataset?.model === 'newTask') {
    e.preventDefault()
    handleAction('add-task', document.activeElement)
  }
})

/* ------------------------------ 启动 ------------------------------ */

document.documentElement.dataset.theme = S.theme
render()
setTimeout(() => toast('原型已就绪：Ctrl K 打开命令面板'), 600)
