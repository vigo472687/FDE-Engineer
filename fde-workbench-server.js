'use strict';
/*
 * FDE 工作台本地后端（零依赖，Node >= 18）
 * ------------------------------------------------
 * 职责：
 *   1. 托管 fde-workbench.html 页面
 *   2. 保管供应商配置 —— API Key 等敏感信息只落在本机
 *      .fde-data/providers.json（权限 0600），前端任何接口
 *      都拿不到完整 Key，只能拿到「是否有 Key + 尾号 4 位」
 *   3. 代理上游调用：拉取模型列表（/v1/models）、连通性测试
 *
 * 启动：node fde-workbench-server.js
 * 访问：http://127.0.0.1:7842
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const PORT = Number(process.env.FDE_PORT) || 7842;
const HOST = '127.0.0.1';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, '.fde-data');
const DATA_FILE = path.join(DATA_DIR, 'providers.json');
const HTML_FILE = path.join(ROOT, 'fde-workbench.html');
const OPS_DIR = path.join(DATA_DIR, 'ops');
const OPS_TRACES_DIR = path.join(OPS_DIR, 'traces');        // 旧版一链路一 JSON（仅用于一次性导入）
const OPS_DB_FILE = path.join(OPS_DIR, 'ops.db');           // SQLite：埋点主库
const OPS_JSON_ARCHIVE_DIR = path.join(OPS_DIR, 'traces-json'); // 导入后归档，不再读取

// 预置供应商（Key 为空，等用户自己填）
const DEFAULT_PROVIDERS = [
  { id: 'p-claude', name: 'Claude 官方', type: 'official', color: 'blue', baseUrl: 'https://api.anthropic.com', modelsUrl: '', apiKey: '', model: 'claude-opus-4-6', effort: 'medium' },
  { id: 'p-deepseek', name: 'DeepSeek', type: 'relay', color: 'indigo', baseUrl: 'https://api.deepseek.com/anthropic', modelsUrl: 'https://api.deepseek.com/models', apiKey: '', model: 'deepseek-reasoner', effort: 'medium' },
  { id: 'p-kimi', name: 'Kimi', type: 'relay', color: 'green', baseUrl: 'https://api.moonshot.cn/anthropic', modelsUrl: 'https://api.moonshot.cn/v1/models', apiKey: '', model: 'kimi-k2', effort: 'medium' },
  { id: 'p-glm', name: 'GLM', type: 'relay', color: 'amber', baseUrl: 'https://open.bigmodel.cn/api/anthropic', modelsUrl: 'https://open.bigmodel.cn/api/paas/v4/models', apiKey: '', model: 'glm-4.7', effort: 'medium' }
];

// 模型强度档位规则：按模型名从上到下匹配，命中即用；可自行增删
const EFFORT_RULES = [
  { match: /gpt-5|^o[0-9]/i,                     levels: ['minimal', 'low', 'medium', 'high'] },
  { match: /opus|fable|thinking|reasoner/i,      levels: ['minimal', 'low', 'medium', 'high', 'max'] },
  { match: /sonnet|haiku|glm|kimi|qwen|flash|lite|mini|instant|small/i, levels: ['low', 'medium'] }
];
function effortOptionsFor(model) {
  const m = String(model || '');
  for (const r of EFFORT_RULES) {
    if (r.match.test(m)) return r.levels;
  }
  return ['low', 'medium', 'high'];
}

// 模型排序：官方能力强弱（fable > opus > sonnet > haiku > 其他），同家族版本号新的在前
function sortModels(list) {
  function tier(m) {
    const s = String(m).toLowerCase();
    if (s.includes('fable')) return 0;
    if (s.includes('opus')) return 1;
    if (s.includes('sonnet')) return 2;
    if (s.includes('haiku')) return 3;
    return 4;
  }
  function ver(m) {
    const t = String(m).match(/(\d+(?:-\d+)*)$/);
    return t ? t[1].split('-').map(Number) : [];
  }
  return list.slice().sort((a, b) => {
    const d = tier(a) - tier(b);
    if (d) return d;
    const va = ver(a), vb = ver(b);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const dd = (va[i] || 0) - (vb[i] || 0);
      if (dd) return -dd;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

// ==================== 学习会话：AI 生成互动课程（teach 模式） ====================
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const jobs = new Map();           // id → {goal,status,startedAt,chars,model,providerName,effort,controller,error}
const authStyle = new Map();      // providerId → 'x-api-key' | 'bearer'（记住胜出的鉴权头）

const TEACH_SYSTEM = [
  '你是 FDE 工作台的课程讲师，为工程师生成一节可直接在浏览器打开的互动学习课程。严格遵守以下合同输出：',
  '',
  '【输出格式】',
  '- 只输出一个以 <!DOCTYPE html> 开头的完整 HTML 文档原文；禁止 markdown 代码围栏、禁止任何解释文字。',
  '- 单文件自包含：所有 CSS/JS 内联；禁止引用任何外部资源（CDN、网络字体、图片、网络请求），必须离线可打开。',
  '- 中文内容；整课体量控制在 60KB 以内。<title> 必须是 20 字以内的中文课程标题。',
  '',
  '【课程设计（teach 方法论）】',
  '- 一课只教一个与学习目标紧密相关的窄主题，10-20 分钟可完成，给学习者一个可积累的明确收获。',
  '- Tufte 风排版：大量留白、清晰层级、克制配色（黑白灰 + 一个强调色）、正文行高 1.6 以上、最大阅读宽度约 70 字符。',
  '- 4-7 个小节；全课 3-6 道 quiz：所有选项长度尽量一致、正确项位置轮换、不得用格式或顺序泄露答案；答完即时反馈（对/错 + 一句解释 + 允许重试）。',
  '- 关键论断附真实可查的外部文档链接（<a target="_blank">），增强可信度。',
  '',
  '【进度合同（必须实现）】',
  "- 优先调用宿主注入的 window.FDE：每完成一小节或一题就调用 FDE.progress(0-100, '简短标签')；全部完成调用 FDE.complete()。",
  "- 若 window.FDE 不存在，则用 parent.postMessage({type:'fde-lesson-progress', progress:0-100, label:'…'}, '*') 与 parent.postMessage({type:'fde-lesson-complete'}, '*')。",
  '',
  '【持久化合同（必须实现）】',
  '- 优先用 window.FDE.save(状态对象) 保存、FDE.load() 恢复。',
  "- 若不存在，用 localStorage，key 必须是 'fde-lesson-' + window.__LESSON_ID__；保存已答题与选择、当前小节、完成标记；页面加载时恢复进度。",
  '',
  '【禁止】alert/confirm/prompt、document.write、自动跳转。'
].join('\n');

function nextSessionId() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  let max = 0;
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    const m = f.match(/^(\d+)\.json$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return String(max + 1).padStart(4, '0');
}
function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// ==================== 用量追踪（Langfuse 风格本地埋点） ====================
// 每次「一次对话 / 一次课程生成」记一条 trace；每个模型调用、工具调用记一个 step。
// 落盘：.fde-data/ops/traces/<id>.json；接口：GET /api/ops/traces
// 计价规则（每 100 万 token）默认按公开价，可在 .fde-data/ops/pricing.json 覆盖：
//   { "pricing": [ { "match": "deepseek", "cur": "CNY", "in": 2, "out": 8, "cache": 0.5 } ] }
const OPS_PRICING_DEFAULT = [
  { match: 'claude.*opus', cur: 'USD', in: 15, out: 75, cache: 1.5 },
  { match: 'claude.*sonnet', cur: 'USD', in: 3, out: 15, cache: 0.3 },
  { match: 'claude.*haiku', cur: 'USD', in: 0.8, out: 4, cache: 0.08 },
  { match: 'deepseek.*reasoner', cur: 'CNY', in: 4, out: 16, cache: 1 },
  { match: 'deepseek', cur: 'CNY', in: 2, out: 8, cache: 0.5 },
  { match: 'kimi', cur: 'CNY', in: 4, out: 16, cache: 1 },
  { match: 'glm', cur: 'CNY', in: 4, out: 16, cache: 1 },
  { match: 'qwen', cur: 'CNY', in: 0.8, out: 2, cache: 0.2 }
];
const OPS_PRICING_FALLBACK = { cur: 'CNY', in: 2, out: 8, cache: 0.5 };
let opsPriceRules = null;
function opsPricingRules() {
  if (opsPriceRules) return opsPriceRules;
  let custom = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(OPS_DIR, 'pricing.json'), 'utf8'));
    if (j && Array.isArray(j.pricing)) custom = j.pricing;
  } catch (e) { /* 没有自定义价格 */ }
  opsPriceRules = custom.concat(OPS_PRICING_DEFAULT).map((r) => Object.assign({}, r, { re: new RegExp(String(r.match || ''), 'i') }));
  return opsPriceRules;
}
function opsPricingFor(model) {
  const s = String(model || '');
  for (const r of opsPricingRules()) if (r.re.test(s)) return r;
  return OPS_PRICING_FALLBACK;
}
function opsNormalizeUsage(usage, fallbackIn, fallbackOut) {
  const u = usage || {};
  let out = Number(u.output_tokens != null ? u.output_tokens : (u.completion_tokens || 0)) || 0;
  let hit = Number(u.cache_read_input_tokens || u.cache_read_tokens || 0) || 0;
  let miss = Number(u.input_tokens != null ? u.input_tokens : (u.prompt_tokens || 0)) || 0;
  miss += Number(u.cache_creation_input_tokens || 0) || 0;
  if (!out && fallbackOut) out = Math.round(estimateTokens(String(fallbackOut)));
  if (!miss && !hit && fallbackIn) miss = Math.round(estimateTokens(typeof fallbackIn === 'string' ? fallbackIn : JSON.stringify(fallbackIn)));
  return { cacheHit: hit, cacheMiss: miss, inputTokens: hit + miss, outputTokens: out };
}
function opsCost(model, u) {
  const p = opsPricingFor(model);
  const cachePrice = p.cache != null ? p.cache : p.in;
  const v = (u.cacheHit / 1e6) * cachePrice + (u.cacheMiss / 1e6) * p.in + (u.outputTokens / 1e6) * p.out;
  return { cost: Number(v.toFixed(9)), cur: p.cur || 'CNY' };
}
function opsTraceNew(opts) {
  const o = opts || {};
  const t = {
    id: o.id || ('tr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
    source: o.source || 'chat',
    agent: o.agent || (o.source === 'learning' ? 'learn_agent' : 'default_agent'),
    title: o.title || '',
    chatId: o.chatId || '',
    sessionId: o.sessionId || '',
    round: o.round || 1,
    model: o.model || '',
    provider: o.provider || '',
    workspace: o.workspace || '',
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: 'running',
    estimated: !!o.estimated,
    steps: []
  };
  opsTraceSave(t);
  return t;
}
// ---------- SQLite 存储（Node 内置 node:sqlite，零依赖） ----------
// 表结构与 Langfuse 的 trace / observations 对应：
//   traces(id, …, started_at, status, estimated)  一条 = 一次对话 / 一次课程生成
//   steps(trace_id, idx, …)                       一条 = 一次模型调用 / 压缩 / 工具调用
let opsDbHandle = null;
function opsDb() {
  if (opsDbHandle) return opsDbHandle;
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) {
    const msg = '当前 Node 不支持内置 SQLite（需要 Node ≥ 22.5，推荐 24）。请用新版 Node 启动：node fde-workbench-server.js';
    console.warn('  [埋点] ' + msg);
    throw new Error(msg);
  }
  fs.mkdirSync(OPS_DIR, { recursive: true });
  const db = new DatabaseSync(OPS_DB_FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS traces (
      id TEXT PRIMARY KEY,
      source TEXT, agent TEXT, title TEXT, chat_id TEXT, session_id TEXT,
      "round" INTEGER, model TEXT, provider TEXT, workspace TEXT,
      started_at TEXT, ended_at TEXT, status TEXT, estimated INTEGER, error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_traces_started ON traces(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_traces_chat ON traces(chat_id);
    CREATE TABLE IF NOT EXISTS steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      kind TEXT, title TEXT, name TEXT, model TEXT, provider TEXT, prompt TEXT, reason TEXT,
      started_at TEXT, ended_at TEXT, duration_ms INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, cache_hit INTEGER, cache_miss INTEGER,
      cost REAL, cur TEXT, status TEXT, stop_reason TEXT,
      text TEXT, thinking TEXT, args_json TEXT, judgment TEXT, result TEXT,
      content_json TEXT,
      denied INTEGER, estimated INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_steps_trace ON steps(trace_id, idx);
    CREATE INDEX IF NOT EXISTS idx_steps_started ON steps(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_steps_kind ON steps(kind, started_at DESC);
  `);
  // 老库补列：模型调用的内容成分（system / 用户输入 / 工具 / 上下文 / 思考 / 输出）
  try {
    const cols = db.prepare('PRAGMA table_info(steps)').all().map((c) => c.name);
    if (cols.indexOf('content_json') === -1) db.exec('ALTER TABLE steps ADD COLUMN content_json TEXT');
  } catch (e) { /* 新库已带该列 */ }
  opsDbHandle = db;
  return db;
}
const OPS_STEP_COLS = ['kind', 'title', 'name', 'model', 'provider', 'prompt', 'reason', 'startedAt', 'endedAt', 'durationMs',
  'inputTokens', 'outputTokens', 'cacheHit', 'cacheMiss', 'cost', 'cur', 'status', 'stopReason',
  'text', 'thinking', 'argsJson', 'judgment', 'result', 'contentJson', 'denied', 'estimated'];
const OPS_STEP_SQL_COLS = ['kind', 'title', 'name', 'model', 'provider', 'prompt', 'reason', 'started_at', 'ended_at', 'duration_ms',
  'input_tokens', 'output_tokens', 'cache_hit', 'cache_miss', 'cost', 'cur', 'status', 'stop_reason',
  'text', 'thinking', 'args_json', 'judgment', 'result', 'content_json', 'denied', 'estimated'];
function opsStepRow(traceId, idx, step) {
  return [
    traceId, idx,
    step.kind || '', step.title || '', step.name || '', step.model || '', step.provider || '', step.prompt || '', step.reason || '',
    step.startedAt || '', step.endedAt || '', Number(step.durationMs) || 0,
    Number(step.inputTokens) || 0, Number(step.outputTokens) || 0, Number(step.cacheHit) || 0, Number(step.cacheMiss) || 0,
    Number(step.cost) || 0, step.cur || 'CNY', step.status || '', step.stopReason || '',
    step.text || '', step.thinking || '',
    step.args === undefined ? null : JSON.stringify(step.args),
    step.judgment || '', step.result || '',
    step.content ? JSON.stringify(step.content) : null,
    step.denied ? 1 : 0, step.estimated ? 1 : 0
  ];
}
function opsStepFromRow(r) {
  const out = {
    kind: r.kind, title: r.title, model: r.model, provider: r.provider,
    startedAt: r.started_at, endedAt: r.ended_at, durationMs: r.duration_ms,
    inputTokens: r.input_tokens, outputTokens: r.output_tokens,
    cacheHit: r.cache_hit, cacheMiss: r.cache_miss,
    cost: r.cost, cur: r.cur, status: r.status,
    text: r.text, thinking: r.thinking
  };
  if (r.name) out.name = r.name;
  if (r.prompt) out.prompt = r.prompt;
  if (r.reason) out.reason = r.reason;
  if (r.stop_reason) out.stopReason = r.stop_reason;
  if (r.args_json) { try { out.args = JSON.parse(r.args_json); } catch (e) { out.args = {}; } }
  if (r.judgment) out.judgment = r.judgment;
  if (r.result) out.result = r.result;
  if (r.content_json) { try { out.content = JSON.parse(r.content_json); } catch (e) { /* 坏数据忽略 */ } }
  if (r.denied) out.denied = true;
  if (r.estimated) out.estimated = true;
  return out;
}
function opsTraceSave(trace) {
  if (!trace || !trace.id) return;
  try {
    const db = opsDb();
    db.prepare(`INSERT INTO traces (id, source, agent, title, chat_id, session_id, "round", model, provider, workspace, started_at, ended_at, status, estimated, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET source=excluded.source, agent=excluded.agent, title=excluded.title,
        chat_id=excluded.chat_id, session_id=excluded.session_id, "round"=excluded."round", model=excluded.model,
        provider=excluded.provider, workspace=excluded.workspace, started_at=excluded.started_at,
        ended_at=excluded.ended_at, status=excluded.status, estimated=excluded.estimated, error=excluded.error`)
      .run(trace.id, trace.source || '', trace.agent || '', trace.title || '', trace.chatId || '', trace.sessionId || '',
        Number(trace.round) || 1, trace.model || '', trace.provider || '', trace.workspace || '',
        trace.startedAt || '', trace.endedAt || null, trace.status || 'running', trace.estimated ? 1 : 0, trace.error || null);

    // 增量写：只插入还没落库的 step（trace._saved 记录已写入条数）
    const from = Number(trace._saved) || 0;
    if (trace.steps && trace.steps.length > from) {
      const ins = db.prepare('INSERT OR REPLACE INTO steps (trace_id, idx, ' + OPS_STEP_SQL_COLS.join(', ') + ') VALUES (' +
        ['?', '?', ...OPS_STEP_SQL_COLS.map(() => '?')].join(', ') + ')');
      db.exec('BEGIN');
      try {
        for (let i = from; i < trace.steps.length; i++) ins.run(...opsStepRow(trace.id, i, trace.steps[i] || {}));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      trace._saved = trace.steps.length;
    }
  } catch (e) { /* 埋点失败不影响主流程 */ }
}

// 旧版本留存的一链路一 JSON：启动时一次性导入 ops.db，然后把文件移进 traces-json/ 归档
function opsImportJsonTraces() {
  let files = [];
  try { files = fs.readdirSync(OPS_TRACES_DIR).filter((f) => /\.json$/.test(f)); } catch (e) { return 0; }
  if (!files.length) return 0;
  let imported = 0;
  const db = opsDb();
  const known = new Set(db.prepare('SELECT id FROM traces').all().map((r) => r.id));
  for (const f of files) {
    const full = path.join(OPS_TRACES_DIR, f);
    try {
      const t = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!t || !t.id) { continue; }
      if (!known.has(t.id)) {
        t._saved = 0;
        opsTraceSave(t);
        imported += 1;
      }
      fs.mkdirSync(OPS_JSON_ARCHIVE_DIR, { recursive: true });
      fs.renameSync(full, path.join(OPS_JSON_ARCHIVE_DIR, f));
    } catch (e) { /* 坏文件留在原地，下次再试 */ }
  }
  if (imported) console.log('  已把 ' + imported + ' 条 JSON 链路导入 ops.db（原文件归档到 .fde-data/ops/traces-json/）');
  return imported;
}
function opsTraceFinish(trace, status, error) {
  if (!trace) return;
  trace.endedAt = new Date().toISOString();
  trace.status = status || 'success';
  if (error) trace.error = String(error).slice(0, 600);
  opsTraceSave(trace);
}
function opsLlmStep(trace, o) {
  if (!trace) return null;
  const u = opsNormalizeUsage(o.usage, o.fallbackIn, o.fallbackOut);
  const c = opsCost(o.model, u);
  const start = o.start || Date.now();
  const step = {
    kind: o.kind || 'llm',
    title: o.title || '模型调用',
    model: o.model || '',
    provider: o.provider || '',
    prompt: o.prompt || '',
    reason: o.reason || '',
    startedAt: new Date(start).toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - start),
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheHit: u.cacheHit,
    cacheMiss: u.cacheMiss,
    cost: o.costOverride ? o.costOverride.cost : c.cost,
    cur: o.costOverride ? o.costOverride.cur : c.cur,
    status: o.status || 'success',
    stopReason: o.stopReason || '',
    text: truncateText(o.text || '', 4000),
    thinking: truncateText(o.thinking || '', 4000),
    content: o.content || null,
    estimated: !!o.estimated
  };
  trace.steps.push(step);
  opsTraceSave(trace);
  return step;
}
function opsToolStep(trace, o) {
  if (!trace) return null;
  const p = opsPricingFor(o.model);
  const start = o.start || Date.now();
  const step = {
    kind: 'tool',
    title: o.name || '工具调用',
    name: o.name || '',
    model: o.model || '',
    provider: o.provider || '',
    startedAt: new Date(start).toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - start),
    inputTokens: 0, outputTokens: 0, cacheHit: 0, cacheMiss: 0,
    cost: 0,
    cur: p.cur || 'CNY',
    status: o.status || (o.denied ? 'denied' : 'success'),
    args: o.args || {},
    judgment: truncateText(o.judgment || '', 1200),
    result: truncateText(o.result || '', 1200),
    denied: !!o.denied,
    estimated: !!o.estimated
  };
  trace.steps.push(step);
  opsTraceSave(trace);
  return step;
}
function opsTraceList(limit) {
  let db;
  try { db = opsDb(); } catch (e) { return []; }
  const n = Math.max(1, Math.min(500, Number(limit) || 200));
  let rows = [];
  try {
    rows = db.prepare('SELECT * FROM traces ORDER BY started_at DESC LIMIT ?').all(n);
  } catch (e) { return []; }
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  let stepRows = [];
  try {
    stepRows = db.prepare('SELECT * FROM steps WHERE trace_id IN (' + ids.map(() => '?').join(', ') + ') ORDER BY trace_id, idx').all(...ids);
  } catch (e) { stepRows = []; }
  const byTrace = new Map();
  for (const sr of stepRows) {
    if (!byTrace.has(sr.trace_id)) byTrace.set(sr.trace_id, []);
    byTrace.get(sr.trace_id).push(opsStepFromRow(sr));
  }
  return rows.map((r) => {
    const t = {
      id: r.id, source: r.source, agent: r.agent, title: r.title,
      chatId: r.chat_id || '', sessionId: r.session_id || '', round: r.round || 1,
      model: r.model || '', provider: r.provider || '', workspace: r.workspace || '',
      startedAt: r.started_at, endedAt: r.ended_at || null,
      status: r.status || 'success', estimated: !!r.estimated,
      steps: byTrace.get(r.id) || []
    };
    if (r.error) t.error = r.error;
    return t;
  });
}
// 接入埋点之前产生的对话：从 display 回放成 trace（Token 按文本长度估算，标记 estimated）
function backfillChatTraces() {
  const existing = new Set();
  try {
    for (const r of opsDb().prepare("SELECT DISTINCT chat_id FROM traces WHERE chat_id IS NOT NULL AND chat_id <> ''").all()) {
      existing.add(String(r.chat_id));
    }
  } catch (e) { /* 首次运行 */ }
  let files = [];
  try { files = fs.readdirSync(CHATS_DIR).filter((f) => /^\d+\.json$/.test(f)); } catch (e) { return; }
  for (const f of files) {
    let chat = null;
    try { chat = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, f), 'utf8')); } catch (e) { continue; }
    if (!chat || !chat.id || existing.has(String(chat.id))) continue;
    const display = Array.isArray(chat.display) ? chat.display : [];
    if (!display.some((d) => d.kind === 'assistant' || d.kind === 'tool')) continue;
    const baseTs = Date.parse(chat.createdAt) || Date.now();
    const endTs = Date.parse(chat.updatedAt) || baseTs;
    let run = null, ctx = 0, round = 0, lastText = '', afterTool = false;
    const ctxMsgs = [];   // 回放出的上下文消息，用于「本轮 vs 上一轮」对比
    let curUser = '';
    const pushCtx = (role, text, preview) => {
      const t = String(text || '');
      ctxMsgs.push({ role: role, tokens: estimateTokens(t), preview: (preview || t).slice(0, 160) });
    };
    const flush = () => {
      if (!run) return;
      run.endedAt = new Date(endTs).toISOString();
      run.status = 'success';
      opsTraceSave(run);
    };
    display.forEach((d, idx) => {
      const ts = new Date(baseTs + idx * 800).toISOString();
      if (d.kind === 'user' && d.text && !d.text.startsWith('[context_summary]')) {
        flush();
        round += 1;
        run = {
          id: 'tr_bf_' + chat.id + '_' + round,
          source: 'chat', agent: 'default_agent',
          title: chat.title || String(d.text).slice(0, 24),
          chatId: String(chat.id), sessionId: '', round: round,
          model: chat.model || '', provider: chat.providerName || '', workspace: '',
          startedAt: ts, endedAt: null, status: 'running', estimated: true, steps: []
        };
        ctx = estimateTokens(String(d.text)) + 3000;
        lastText = '';
        afterTool = false;
        curUser = String(d.text);
        pushCtx('user', d.text, d.text);
      } else if (d.kind === 'assistant' && run) {
        const text = String(d.text || '');
        const think = String(d.thinking || '');
        const outTok = estimateTokens(text + think);
        const step = {
          kind: 'llm', title: '模型调用', model: chat.model || '', provider: chat.providerName || '',
          prompt: 'agent-system · v1',
          reason: afterTool ? '上一轮的工具结果已回灌，继续推理' : '收到用户提问，开始第 ' + round + ' 轮推理',
          content: {
            user: { text: curUser, note: '历史回填：只还原了对话里可见的内容，system 与工具定义未记录', chars: curUser.length },
            context: (() => {
              const prev = run._prevCtx || null;
              const msgTok = ctxMsgs.reduce((n, m) => n + m.tokens, 0);
              run._prevCtx = { count: ctxMsgs.length, tokens: ctx };
              return {
                count: ctxMsgs.length, totalTokens: ctx,
                systemTokens: 3000, messageTokens: msgTok,
                prevCount: prev ? prev.count : null, prevTokens: prev ? prev.tokens : null,
                messages: ctxMsgs.slice(-60)
              };
            })(),
            estimated: true
          },
          startedAt: ts, endedAt: ts, durationMs: 0,
          inputTokens: ctx, outputTokens: outTok, cacheHit: 0, cacheMiss: ctx,
          cost: opsCost(chat.model, { cacheHit: 0, cacheMiss: ctx, outputTokens: outTok }).cost,
          cur: opsCost(chat.model, { cacheHit: 0, cacheMiss: ctx, outputTokens: outTok }).cur,
          status: 'success', stopReason: '', text: truncateText(text, 4000), thinking: truncateText(think, 4000), estimated: true
        };
        run.steps.push(step);
        ctx += outTok;
        lastText = text || think;
        afterTool = false;
        pushCtx('assistant', text || think, String(text || think).slice(0, 160));
      } else if (d.kind === 'tool' && run) {
        const argsStr = JSON.stringify(d.input || {});
        const resStr = String(d.result || '');
        run.steps.push({
          kind: 'tool', title: d.name || '工具调用', name: d.name || '', model: chat.model || '', provider: chat.providerName || '',
          startedAt: ts, endedAt: ts, durationMs: 0,
          inputTokens: 0, outputTokens: 0, cacheHit: 0, cacheMiss: 0, cost: 0,
          cur: opsPricingFor(chat.model).cur,
          status: d.denied ? 'denied' : 'success',
          args: d.input || {}, judgment: truncateText(lastText, 1200), result: truncateText(resStr, 1200),
          denied: !!d.denied, estimated: true
        });
        ctx += estimateTokens(argsStr) + estimateTokens(resStr);
        afterTool = true;
        pushCtx('tool_result', '工具结果：' + resStr, '工具结果：' + resStr.slice(0, 120));
      }
    });
    flush();
    if (run) existing.add(String(chat.id));
  }
}


// 清洗模型输出：剥 BOM / markdown 围栏 / 首个文档标签之前的闲话
function sanitizeLessonHtml(raw) {
  let s = String(raw).replace(/^﻿/, '').replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '');
  const keys = ['<!doctype', '<html'];
  let idx = -1;
  for (const k of keys) {
    const i = s.toLowerCase().indexOf(k);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx > 0) s = s.slice(idx);
  return s;
}
function extractTitle(html, fallback) {
  let t = '';
  let m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) t = m[1];
  if (!t) { m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i); if (m) t = m[1]; }
  t = String(t).replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
  if (!t) t = String(fallback || '').replace(/\s+/g, ' ').trim();
  return t.slice(0, 40);
}
// 注入宿主桥接：window.FDE 契约 + 裸 postMessage 转发（__bridge 防死循环）
function injectBridge(id, html) {
  const bridge = '<script>(function(){'
    + 'var ID=' + JSON.stringify(id) + ';window.__LESSON_ID__=ID;'
    + 'var KEY="fde-lesson-"+ID;'
    + 'function up(m){m.__bridge=1;try{parent.postMessage(m,location.origin)}catch(e){}}'
    + 'window.FDE={'
    + 'progress:function(p,label){up({type:"fde-lesson-progress",progress:Math.max(0,Math.min(100,Math.round(Number(p)||0))),label:String(label||"").slice(0,40)})},'
    + 'complete:function(){up({type:"fde-lesson-complete"})},'
    + 'save:function(o){try{localStorage.setItem(KEY,JSON.stringify(o))}catch(e){}},'
    + 'load:function(){try{return JSON.parse(localStorage.getItem(KEY)||"null")}catch(e){return null}}'
    + '};'
    + 'window.addEventListener("message",function(e){var d=e.data;'
    + 'if(e.source===window&&d&&!d.__bridge){'
    + 'if(d.type==="fde-lesson-progress")FDE.progress(d.progress,d.label);'
    + 'if(d.type==="fde-lesson-complete")FDE.complete();}});'
    + '})();</script>';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + bridge);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + bridge);
  return bridge + html;
}

// 按模型名分族组装生成请求体（当前代 Claude 走 output_config.effort；旧代用 thinking；非 Claude 只缩放 max_tokens）
function genAttempts(p, goal) {
  const effort = p.effort || 'medium';
  const MAX_TOKENS = { minimal: 16384, low: 16384, medium: 32768, high: 49152, max: 64000 };
  const maxTokens = MAX_TOKENS[effort] || 32768;
  const m = String(p.model || '').toLowerCase();
  const isClaude = m.includes('claude');
  const modernClaude = /claude-(opus-5|sonnet-5|haiku-5|fable|opus-4-[6-9]|sonnet-4-[6-9])/.test(m);
  const base = { model: p.model, max_tokens: maxTokens, stream: true, system: TEACH_SYSTEM, messages: [{ role: 'user', content: goal }] };
  if (isClaude && modernClaude) {
    const map = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', max: 'max' };
    base.output_config = { effort: map[effort] || 'medium' };
  } else if (isClaude) {
    const THINK = { minimal: 1024, low: 2048, medium: 8192, high: 16384, max: 32768 };
    const budget = THINK[effort] || 8192;
    base.thinking = { type: 'enabled', budget_tokens: budget };
    base.max_tokens = Math.max(maxTokens, budget + 4096);
  }
  // 降级链：完整体 → 剥思考/档位参数 → max_tokens 步降
  const stripped = Object.assign({}, base);
  delete stripped.output_config;
  delete stripped.thinking;
  const small = Object.assign({}, stripped, { max_tokens: Math.min(stripped.max_tokens, 32768) });
  const tiny = Object.assign({}, stripped, { max_tokens: 16384 });
  return [base, stripped, small, tiny].filter((b, i, arr) => arr.findIndex((x) => JSON.stringify(x) === JSON.stringify(b)) === i);
}

async function streamOnce(url, headers, body, job, signal) {
  const r = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: signal });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    const err = new Error('上游 ' + r.status + '：' + String(t).slice(0, 300));
    if (r.status === 401 || r.status === 403) err.authFail = true;
    if (r.status === 404) err.message += '（请确认中转支持 POST ' + url + '）';
    throw err;
  }
  const ct = String(r.headers.get('content-type') || '');
  let text = '', stop = '', usage = null;
  if (ct.includes('event-stream')) {
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s || s.startsWith(':') || !s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(payload); } catch (e) { continue; }
        if (ev.type === 'message_start' && ev.message && ev.message.usage) {
          usage = Object.assign({}, ev.message.usage);
        } else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
          text += ev.delta.text || '';
          job.chars = text.length;
        } else if (ev.type === 'message_delta') {
          if (ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason;
          if (ev.usage) usage = Object.assign(usage || {}, ev.usage);
        } else if (ev.type === 'error') {
          throw new Error('上游流错误：' + JSON.stringify(ev.error || ev).slice(0, 300));
        }
      }
    }
  } else {
    // 中转无视 stream:true，直接返回 JSON
    const j = await r.json();
    const blocks = Array.isArray(j.content) ? j.content : [];
    for (const b of blocks) { if (b && b.type === 'text') text += b.text || ''; }
    job.chars = text.length;
    stop = j.stop_reason || '';
    usage = j.usage || null;
  }
  return { text: text, stopReason: stop, usage: usage };
}

async function callMessages(p, body, job, signal) {
  const base = String(p.baseUrl || '').replace(/\/+$/, '');
  const url = base + (/\/v1$/.test(base) ? '/messages' : '/v1/messages');
  const styles = authStyle.get(p.id) ? [authStyle.get(p.id)] : ['x-api-key', 'bearer'];
  let lastErr = null;
  for (let i = 0; i < styles.length; i++) {
    const headers = { 'content-type': 'application/json' };
    if (styles[i] === 'x-api-key') { headers['x-api-key'] = p.apiKey; headers['anthropic-version'] = '2023-06-01'; }
    else { headers.authorization = 'Bearer ' + p.apiKey; }
    try {
      const out = await streamOnce(url, headers, body, job, signal);
      authStyle.set(p.id, styles[i]);
      return out;
    } catch (e) {
      lastErr = e;
      if (e && e.authFail && i < styles.length - 1) continue;
      throw e;
    }
  }
  throw lastErr;
}

async function generateLesson(p, goal, job) {
  const variants = genAttempts(p, goal);
  let text = '', stop = '', lastBody = null, lastErr = null;
  for (const body of variants) {
    try {
      const t0 = Date.now();
      const out = await callMessages(p, body, job, job.controller.signal);
      text = out.text; stop = out.stopReason; lastBody = body;
      if (!text.trim()) { lastErr = new Error('上游返回空内容'); continue; }
      opsLlmStep(job.opsTrace, {
        title: '生成课程', model: p.model, provider: p.name, prompt: 'teach-course · v1',
        usage: out.usage, start: t0, text: out.text,
        reason: '按学习目标生成完整课程',
        fallbackIn: estimateTokens(TEACH_SYSTEM) + estimateTokens(goal), fallbackOut: estimateTokens(out.text || '')
      });
      break;
    } catch (e) {
      lastErr = e;
      if (e.name === 'AbortError') throw new Error('已取消');
      if (!/上游 400/.test(e.message)) throw e;   // 仅参数类错误继续降级重试
    }
  }
  if (!lastBody || !text.trim()) throw (lastErr || new Error('生成失败'));
  if (stop === 'refusal') throw new Error('上游模型拒绝生成该内容');
  if (stop === 'max_tokens') {
    // 截断自动续写一轮
    const cont = Object.assign({}, lastBody, {
      messages: [
        { role: 'user', content: goal },
        { role: 'assistant', content: text },
        { role: 'user', content: '从截断处原样继续输出剩余内容，不要重复已有内容，不要输出任何解释。' }
      ]
    });
    try {
      const t0 = Date.now();
      const out2 = await callMessages(p, cont, job, job.controller.signal);
      text += out2.text;
      opsLlmStep(job.opsTrace, {
        title: '续写课程', model: p.model, provider: p.name, prompt: 'teach-course · v1',
        usage: out2.usage, start: t0, text: out2.text,
        reason: '上一轮输出被 max_tokens 截断，续写剩余内容',
        fallbackIn: estimateTokens(goal) + estimateTokens(text), fallbackOut: estimateTokens(out2.text || '')
      });
    } catch (e) { /* 续写失败不致命 */ }
  }
  return text;
}

// ---------- 存储 ----------
function loadStore() {
  try {
    const s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (s && Array.isArray(s.providers) && s.providers.length) return s;
  } catch (e) { /* 首次启动 */ }
  return { providers: JSON.parse(JSON.stringify(DEFAULT_PROVIDERS)), activeId: 'p-claude' };
}
function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, DATA_FILE);
  try { fs.chmodSync(DATA_FILE, 0o600); } catch (e) { /* Windows 忽略 */ }
}

// ---------- 脱敏：任何出站响应都不含完整 Key ----------
function sanitize(p) {
  return {
    id: p.id, name: p.name, type: p.type, color: p.color,
    baseUrl: p.baseUrl, modelsUrl: p.modelsUrl || '',
    model: p.model || '', effort: p.effort || 'medium',
    models: Array.isArray(p.models) ? p.models : [],
    effortOptions: effortOptionsFor(p.model),
    hasKey: p.type === 'claude-code' ? true : !!p.apiKey,
    keyTail: p.apiKey ? p.apiKey.slice(-4) : ''
  };
}

// ---------- 上游调用：拉模型列表（自动尝试 Anthropic / OpenAI 两种鉴权头） ----------
async function listModels(p) {
  const base = String(p.baseUrl || '').replace(/\/+$/, '');
  const url = p.modelsUrl || base + '/v1/models';
  if (!/^https?:\/\//.test(url)) return { ok: false, error: '模型列表地址不合法：' + url };
  const attempts = p.apiKey
    ? [
        { headers: { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' } },
        { headers: { Authorization: 'Bearer ' + p.apiKey } }
      ]
    : [{ headers: {} }];
  let lastErr = '未知错误';
  for (const a of attempts) {
    try {
      const t0 = Date.now();
      const r = await fetch(url, { headers: a.headers, signal: AbortSignal.timeout(10000) });
      const latency = Date.now() - t0;
      const text = await r.text();
      if (!r.ok) { lastErr = 'HTTP ' + r.status + '：' + text.slice(0, 160); continue; }
      let j;
      try { j = JSON.parse(text); } catch (e) { lastErr = '响应不是 JSON'; continue; }
      const arr = (j.data || j.models || [])
        .map((m) => (typeof m === 'string' ? m : m && m.id))
        .filter(Boolean);
      if (!arr.length) { lastErr = '响应中没有模型列表'; continue; }
      return { ok: true, latency, models: arr };
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
  }
  return { ok: false, error: lastErr };
}

// ---------- 引擎 B：Claude Code 订阅（Agent SDK，复用本机 CC 登录态） ----------
async function generateLessonCC(p, goal, job) {
  let mod;
  try {
    mod = await import('@anthropic-ai/claude-agent-sdk');
  } catch (e) {
    throw new Error('Claude Code 引擎未安装：请在项目目录执行 npm install 后重试');
  }
  const outPath = path.join(SESSIONS_DIR, job.id + '.html');
  const prompt = [
    '请为工程师生成一节互动学习课程。学习目标：' + goal,
    '',
    TEACH_SYSTEM,
    '',
    '【产出节奏】先快速规划结构与要点，随即开始产出，避免超长思考——课程体量以 40KB 为上限。',
    '',
    '【交付方式】',
    '- 把最终课程 HTML 用 Write 工具写入文件（绝对路径）：' + outPath,
    '- 写完后只回复 DONE，不要把 HTML 粘贴到对话里。'
  ].join('\n');
  const q = mod.query({
    prompt: prompt,
    options: {
      systemPrompt: '你是 FDE 工作台的课程讲师，只完成被要求的任务，不做任何额外动作。',
      allowedTools: ['Write'],
      permissionMode: 'acceptEdits',
      maxTurns: 6,
      includePartialMessages: true,
      cwd: SESSIONS_DIR
    }
  });
  let text = '';
  let streamedChars = 0;   // 文本 delta + Write 工具入参 delta，反映真实生成进度
  let ccUsage = null, ccCost = null;
  const ccStart = Date.now();
  const deadline = Date.now() + 1200000;
  try {
    for await (const message of q) {
      if (Date.now() > deadline) {
        try { await q.interrupt(); } catch (e) { /* 已结束 */ }
        throw new Error('Claude Code 生成超时（12 分钟）');
      }
      if (message.type === 'stream_event' && message.event && message.event.type === 'content_block_delta') {
        const d = message.event.delta || {};
        if (d.type === 'text_delta') streamedChars += (d.text || '').length;
        if (d.type === 'input_json_delta') streamedChars += (d.partial_json || '').length;
        job.chars = streamedChars;
      }
      if (message.type === 'assistant' && message.message && Array.isArray(message.message.content)) {
        for (const b of message.message.content) {
          if (b.type === 'text') { text += b.text || ''; job.chars = streamedChars; }
        }
      }
      if (message.type === 'result') {
        if (message.usage) ccUsage = message.usage;
        if (typeof message.total_cost_usd === 'number') ccCost = { cost: message.total_cost_usd, cur: 'USD' };
        if (message.is_error) throw new Error('Claude Code 返回错误：' + String(message.result || '').slice(0, 200));
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('已取消');
    throw e;
  }
  // 优先取 Write 写出的文件；取不到再退回对话文本
  let lesson = '';
  try {
    lesson = fs.readFileSync(outPath, 'utf8');
  } catch (e) {
    const clean = sanitizeLessonHtml(text);
    if (clean.length > 200) lesson = clean;
    else throw new Error('Claude Code 未产出课程文件（若未登录订阅请先在终端 claude /login）');
  }
  opsLlmStep(job.opsTrace, {
    title: '生成课程（Claude Code 订阅）', model: p.model || 'claude-code', provider: p.name,
    prompt: 'teach-course · v1', usage: ccUsage, start: ccStart,
    reason: '按学习目标生成完整课程（走本机 claude CLI 订阅额度）',
    text: lesson, fallbackOut: estimateTokens(lesson), costOverride: ccCost
  });
  return lesson;
}

// ==================== 对话（通用 Agent：工具调用 + 审批 + 目标模式） ====================
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const chatJobs = new Map();          // id → 运行中的对话任务（内存，不落盘，服务重启即清理）
const pendingApprovals = new Map();  // pendingId → { jobId, resolve(decision) }

// ---------- 工作区：一个对话绑定一个目录 ----------
// 两种来源：① 用户选定一个文件夹（kind=folder）；② 新建对话未选文件夹时自动划分的临时工作区（kind=temp）。
// 注册表落在 .fde-data/workspaces.json；临时目录落在 .fde-data/workspaces/tmp-<对话号>/。
const WORKSPACES_FILE = path.join(DATA_DIR, 'workspaces.json');
const TEMP_WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');

function loadWorkspaceStore() {
  try {
    const s = JSON.parse(fs.readFileSync(WORKSPACES_FILE, 'utf8'));
    if (s && Array.isArray(s.workspaces)) return s;
  } catch (e) { /* 首次使用或文件损坏 */ }
  return { workspaces: [] };
}
function saveWorkspaceStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeAtomic(WORKSPACES_FILE, JSON.stringify(store, null, 2));
}
function nextWorkspaceId(store) {
  let max = 0;
  for (const w of store.workspaces) {
    const m = String(w.id || '').match(/^ws(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return 'ws' + String(max + 1).padStart(3, '0');
}
function findWorkspace(id) {
  if (!id) return null;
  return loadWorkspaceStore().workspaces.find((w) => w.id === String(id)) || null;
}
function createWorkspace(opts) {
  const store = loadWorkspaceStore();
  const dir = path.resolve(String((opts && opts.dir) || ''));
  const exist = store.workspaces.find((w) => w.dir === dir);
  if (exist) return exist;
  const ws = {
    id: nextWorkspaceId(store),
    name: String((opts && opts.name) || '').trim() || path.basename(dir) || dir,
    dir: dir,
    kind: opts && opts.kind === 'temp' ? 'temp' : 'folder',
    createdAt: new Date().toISOString()
  };
  store.workspaces.push(ws);
  saveWorkspaceStore(store);
  return ws;
}
// 临时工作区的标签：拿第一条输入做简易摘要（去指令词与标点，最多 12 个字）
function deriveWorkspaceLabel(text) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  // 去掉开头的指令/上下文口头禅（最多剥两层），剩下的才是任务本身
  for (let i = 0; i < 2; i++) {
    const before = s;
    s = s.replace(/^(请|麻烦|帮我|帮忙|给我|需要你|我想|我要|能不能|可以|在当前工作区|在当前目录|在当前文件夹|在这个目录下|在工作区)/, '').trim();
    if (s === before) break;
  }
  s = s.replace(/[`*#>_~]/g, ' ');
  s = s.replace(/[，。！？、；：""''（）()【】\[\]<>{},!?;:~\/\\|]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/[.。]+$/, '').trim();
  if (!s) return '临时工作区';
  const chars = Array.from(s);
  return chars.length <= 12 ? s : chars.slice(0, 12).join('').trim() + '…';
}
function ensureTempWorkspace(chatId, firstMessage) {
  const dir = path.join(TEMP_WORKSPACES_DIR, 'tmp-' + chatId);
  fs.mkdirSync(dir, { recursive: true });
  return createWorkspace({ dir: dir, name: deriveWorkspaceLabel(firstMessage), kind: 'temp' });
}
function workspaceChatCounts() {
  const counts = {};
  try {
    for (const f of fs.readdirSync(CHATS_DIR)) {
      if (!/^\d+\.json$/.test(f)) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, f), 'utf8'));
        if (c && c.workspaceId) counts[c.workspaceId] = (counts[c.workspaceId] || 0) + 1;
      } catch (e) { /* 跳过坏文件 */ }
    }
  } catch (e) { /* 目录不存在 */ }
  return counts;
}
function listWorkspaces() {
  const counts = workspaceChatCounts();
  return loadWorkspaceStore().workspaces.map((w) => ({
    id: w.id, name: w.name, path: w.dir, dir: w.dir, kind: w.kind,
    chatCount: counts[w.id] || 0, createdAt: w.createdAt
  }));
}
// 对话实际的工作目录：绑定的工作区；历史对话没有工作区时退回用户主目录
function chatWorkspaceInfo(chat) {
  const ws = findWorkspace(chat && chat.workspaceId);
  if (!ws) return { id: '', name: '', path: os.homedir(), kind: '' };
  return { id: ws.id, name: ws.name, path: ws.dir, kind: ws.kind };
}

// 通用 Agent 的 system 提示词
const AGENT_SYSTEM = [
  '你是 FDE 工作台内置的通用 Agent，运行在用户的个人电脑上，能通过工具在本机执行命令、读写文件，帮用户完成真实任务。',
  '',
  '【行为】',
  '- 用中文回答，除非用户使用其他语言。',
  '- 需要动手做事（查文件、跑命令、改文件）时调用对应工具；工具结果返回后再继续，不要凭空猜测。',
  '- 只做用户要求的事，不做多余动作；破坏性操作先说明再执行。',
  '- 回答简洁直接给结论；关键步骤用简短列表或代码块。',
  '',
  '【目标模式】',
  '- 用户开启目标模式时：把目标拆成步骤，自主持续推进，每步用工具验证，直到目标达成；最后给出完整总结。',
  '- 未开启目标模式时：完成用户当前要求即可结束，不要反复追加无关动作。'
].join('\n');

function agentSystemText(job) {
  return AGENT_SYSTEM
    + (job && job.workspacePath ? '\n\n【当前工作区】' + job.workspacePath + (job.workspaceName ? '（' + job.workspaceName + '）' : '')
      + '\n工具里的相对路径都相对该目录解析；run_command 默认在该目录执行。不要在未确认时跳出工作区改动别处。' : '')
    + (job && job.goalMode ? '\n\n【当前已开启「目标模式」：请自主推进直到目标完成，不要提前结束。】' : '');
}

// 工具清单（Anthropic tool_use 格式）
const AGENT_TOOLS = [
  {
    name: 'run_command',
    description: '在本机执行一条 shell 命令并返回输出（合并 stdout/stderr）。用于查询、安装、构建、运行脚本等一切需要命令行完成的任务。默认在当前对话的工作区目录下执行，可用 workdir 指定工作目录（绝对路径或相对工作区）。',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的完整 shell 命令' },
        workdir: { type: 'string', description: '工作目录，默认当前工作区' }
      },
      required: ['command']
    }
  },
  {
    name: 'read_file',
    description: '读取一个文本文件，返回带行号的内容（最多 2000 行，可从 offset 开始）。',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件路径（绝对路径，或相对当前工作区）' },
        offset: { type: 'number', description: '起始行号（从 1 开始），默认 1' },
        limit: { type: 'number', description: '最多读取行数，默认 2000' }
      },
      required: ['file_path']
    }
  },
  {
    name: 'write_file',
    description: '创建或覆盖写入一个文件（自动创建父目录）。',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件路径（绝对路径，或相对当前工作区）' },
        content: { type: 'string', description: '完整文件内容' }
      },
      required: ['file_path', 'content']
    }
  },
  {
    name: 'edit_file',
    description: '通过精确字符串替换编辑文件；old_string 必须在文件中唯一出现。',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件路径（绝对路径，或相对当前工作区）' },
        old_string: { type: 'string', description: '要替换的原文（精确匹配）' },
        new_string: { type: 'string', description: '替换后的文本' }
      },
      required: ['file_path', 'old_string', 'new_string']
    }
  },
  {
    name: 'list_dir',
    description: '列出目录内容（文件与子目录）。',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录路径，默认当前工作区' } }
    }
  },
  {
    name: 'search_files',
    description: '在目录中递归搜索匹配正则表达式的文件内容（grep）。',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '搜索目录，默认当前工作区' }
      },
      required: ['pattern']
    }
  }
];

const READ_ONLY_TOOLS = new Set(['read_file', 'list_dir', 'search_files']);

// 四种审批模式（复刻 Penguin）：allow-all / deny-all / read-only / always-ask
const APPROVAL_MODES = ['allow-all', 'deny-all', 'read-only', 'always-ask'];
// 桌面端默认取「只读放行」：只读工具自动放行、其余逐个询问（Penguin 服务端默认 allow-all，这里取更稳妥档）
const DEFAULT_APPROVAL_MODE = 'read-only';
function normalizeApprovalMode(v) {
  return APPROVAL_MODES.indexOf(v) > -1 ? v : DEFAULT_APPROVAL_MODE;
}
// 决定某个工具调用走哪条路径：allow 直接执行 / deny 直接拒绝 / ask 挂起询问
function resolveToolDecision(job, name) {
  switch (normalizeApprovalMode(job.approvalMode)) {
    case 'allow-all': return 'allow';
    case 'deny-all': return 'deny';
    case 'read-only': return READ_ONLY_TOOLS.has(name) ? 'allow' : 'ask';
    case 'always-ask': default: return 'ask';
  }
}

// ==================== 上下文压缩（复刻 Penguin：summarize 模式） ====================
// Penguin 源码（penguin-core/llm/context-limits.ts）：
//   DEFAULT_CONTEXT_WINDOW=128e3、OUTPUT_SAFETY_MARGIN=1024、COMPACTION_HEADROOM=2048，
//   阈值 = contextWindow − COMPACTION_HEADROOM（128k 窗口 → 125952 token）。
// 桌面端无模型窗口登记表，取同一默认值；可用 FDE_COMPACTION_THRESHOLD 覆盖（便于测试 / 调优）。
const DEFAULT_CONTEXT_WINDOW = 128000;
const COMPACTION_HEADROOM = 2048;
const COMPACTION_THRESHOLD_TOKENS = Number(process.env.FDE_COMPACTION_THRESHOLD) > 0
  ? Number(process.env.FDE_COMPACTION_THRESHOLD)
  : (DEFAULT_CONTEXT_WINDOW - COMPACTION_HEADROOM);
// 压缩提示词（Penguin DEFAULT_COMPACTION_PROMPT 的中文等义版，[summary] 标记一致）
const COMPACTION_PROMPT = [
  '请把上面的对话记录总结成一段摘要。这段摘要将取代原记录成为唯一的上下文，',
  '所以必须包含继续任务所需的全部信息——原始请求、当前进展、下一步计划、以及任何已确认的结论或教训。',
  '不要调用任何工具；只输出纯文本，并且严格使用下面的格式，之后不要再输出任何内容：',
  '',
  '[summary]在这里写摘要…[/summary]'
].join('\n');

// 与 Penguin approximateTokens 一致：ASCII 按 4 字符/token，其余（含 CJK）按 1 token
function estimateTokens(text) {
  if (typeof text !== 'string') text = JSON.stringify(text);
  let ascii = 0, wide = 0;
  for (const ch of text) {
    if ((ch.codePointAt(0) || 0) < 128) ascii += 1; else wide += 1;
  }
  return Math.ceil(ascii / 4) + wide;
}
function messageTokens(m) {
  if (typeof m.content === 'string') return estimateTokens(m.content);
  if (Array.isArray(m.content)) {
    return m.content.reduce(function (s, b) {
      const v = b.text != null ? b.text : (b.input != null ? JSON.stringify(b.input) : (b.content != null ? JSON.stringify(b.content) : ''));
      return s + estimateTokens(v);
    }, 0);
  }
  return 0;
}
function totalTokens(messages) {
  return messages.reduce(function (s, m) { return s + messageTokens(m); }, 0);
}
// 压缩切点：最后一个「普通用户消息」（字符串 content）的位置，之前的都是完整历史
function findCompactionCut(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && typeof messages[i].content === 'string') return i;
  }
  return 0;
}
async function summarizeContext(job, prov, signal) {
  const cut = findCompactionCut(job.messages);
  const old = job.messages.slice(0, cut);
  const keep = job.messages.slice(cut);
  if (old.length < 2) return false;   // 没有可压缩的历史
  broadcast(job, { type: 'compaction_start', mode: 'summarize', reason: 'context' });
  try {
    const body = {
      model: prov.model, max_tokens: 8192, stream: false,
      system: '你是上下文压缩器，只做总结，不调用工具。',
      messages: old.concat([{ role: 'user', content: COMPACTION_PROMPT }])
    };
    const t0 = Date.now();
    const out = await callMessages(prov, body, job, signal);
    const m = String(out.text || '').match(/\[summary\]([\s\S]*?)\[\/summary\]/);
    const summary = (m ? m[1] : out.text).trim();
    if (!summary) throw new Error('压缩摘要为空');
    opsLlmStep(job.opsTrace, {
      kind: 'compaction', title: '上下文压缩', model: prov.model, provider: prov.name,
      prompt: 'context-compact · v1', usage: out.usage, start: t0, text: out.text,
      reason: '上下文超过 ' + Math.round(totalTokens(old) / 1000) + 'K token，先把旧历史压成摘要再继续',
      fallbackIn: totalTokens(old), fallbackOut: estimateTokens(out.text || '')
    });
    if (keep.length && keep[0].role === 'user' && typeof keep[0].content === 'string') {
      job.messages = [{ role: 'user', content: '[context_summary]\n' + summary + '\n\n--- 最近对话 ---\n\n' + keep[0].content }].concat(keep.slice(1));
    } else {
      job.messages = [{ role: 'user', content: '[context_summary]\n' + summary }].concat(keep);
    }
    persistChat(job);
    job.display.push({ kind: 'note', text: '已压缩上下文（保留最近 ' + keep.length + ' 条消息）' });
    broadcast(job, { type: 'note', text: '已压缩上下文' });
    return true;
  } catch (e) {
    broadcast(job, { type: 'note', text: '上下文压缩失败，保持原上下文：' + ((e && e.message) || e) });
    return false;
  }
}

function truncateText(s, n) {
  s = String(s == null ? '' : s);
  if (s.length <= n) return s;
  return s.slice(0, n) + '\n…（已截断，共 ' + s.length + ' 字符）';
}

// ---------- 文本解码 ----------
// 命令输出与本地文件不一定是 UTF-8：中文 Windows 下的 GBK / 股票行情接口的 GB18030 很常见。
// 一律先严格按 UTF-8 解，失败再按 GB18030 / Big5 解，最后才退回 UTF-8 有损解码，
// 避免中文整段变成「��ָ֤��」这类替换字符。
const TEXT_DECODERS = (() => {
  const list = [];
  for (const enc of ['utf-8', 'gb18030', 'big5']) {
    try { list.push(new TextDecoder(enc, { fatal: true })); } catch (e) { /* 该 Node 未带这份编码表 */ }
  }
  return list;
})();
function decodeText(buf) {
  if (buf == null) return '';
  if (typeof buf === 'string') return buf;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (!b.length) return '';
  let high = false;
  for (let i = 0; i < b.length; i++) { if (b[i] & 0x80) { high = true; break; } }
  if (!high) return b.toString('utf8');
  for (const d of TEXT_DECODERS) {
    try { return d.decode(b).replace(/^\uFEFF/, ''); } catch (e) { /* 换下一种编码 */ }
  }
  return b.toString('utf8');
}

// ---------- 工具实现 ----------
// 工具路径统一以当前对话的工作区为基准：相对路径 → 工作区内；绝对路径 / ~ → 原样解析
function resolveToolPath(base, p) {
  const s = String(p == null ? '' : p).trim();
  const root = (base && /^\//.test(String(base))) ? String(base) : os.homedir();
  if (!s) return path.resolve(root);
  if (s === '~') return os.homedir();
  if (s.indexOf('~/') === 0) return path.join(os.homedir(), s.slice(2));
  if (path.isAbsolute(s)) return path.resolve(s);
  return path.resolve(root, s);
}
function execCommand(command, workdir, base) {
  return new Promise((resolve) => {
    const cwd = resolveToolPath(base, workdir);
    exec(command, { cwd, timeout: 120000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' }, (err, stdoutBuf, stderrBuf) => {
      const stdout = decodeText(stdoutBuf);
      const stderr = decodeText(stderrBuf);
      let out = (stdout || '') + (stderr ? (stdout ? '\n' : '') + stderr : '');
      if (err) {
        const killed = !!(err.killed || err.signal);
        if (killed) out += '\n[命令超时或输出过大被终止]';
        else if (!out.trim()) out = '命令退出码 ' + err.code + '：' + (err.message || '');
      }
      resolve(truncateText(out, 20000) || '(无输出)');
    });
  });
}
function toolReadFile(base, fp, offset, limit) {
  const f = resolveToolPath(base, fp);
  let stat;
  try { stat = fs.statSync(f); } catch (e) { return '文件不存在：' + fp; }
  if (!stat.isFile()) return '不是文件：' + fp;
  if (stat.size > 2 * 1024 * 1024) return '文件过大（' + stat.size + ' 字节），请换用其他方式处理';
  let text;
  try { text = decodeText(fs.readFileSync(f)); } catch (e) { return '读取失败：' + e.message; }
  const lines = text.split('\n');
  const off = Math.max(1, Number(offset) || 1);
  const lim = Math.min(2000, Math.max(1, Number(limit) || 2000));
  const slice = lines.slice(off - 1, off - 1 + lim);
  const numbered = slice.map((l, i) => String(off + i).padStart(4, ' ') + '  ' + l).join('\n');
  const rest = lines.length - (off - 1 + slice.length);
  return (off > 1 ? '（从第 ' + off + ' 行开始）\n' : '') + numbered + (rest > 0 ? '\n…（还有 ' + rest + ' 行）' : '');
}
function toolWriteFile(base, fp, content) {
  const f = resolveToolPath(base, fp);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const s = String(content == null ? '' : content);
  fs.writeFileSync(f, s);
  return '已写入 ' + f + '（' + s.length + ' 字符）';
}
function toolEditFile(base, fp, oldStr, newStr) {
  const f = resolveToolPath(base, fp);
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch (e) { return '文件不存在：' + fp; }
  const idx = text.indexOf(oldStr);
  if (idx === -1) return '未找到要替换的原文（old_string 不匹配）';
  if (text.indexOf(oldStr, idx + 1) !== -1) return 'old_string 出现多次，请给出更精确的原文';
  const next = text.slice(0, idx) + newStr + text.slice(idx + oldStr.length);
  fs.writeFileSync(f, next);
  return '已修改 ' + f;
}
function toolListDir(base, p) {
  const d = resolveToolPath(base, p);
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return '目录不存在：' + (p || d); }
  return entries.map((e) => (e.isDirectory() ? '[目录] ' : '        ') + e.name).slice(0, 500).join('\n') || '(空目录)';
}
function toolSearchFiles(base, pattern, root) {
  const start = resolveToolPath(base, root);
  let re;
  try { re = new RegExp(pattern); } catch (e) { return '非法正则：' + pattern; }
  const out = [];
  const MAX = 120;
  function walk(dir, depth) {
    if (out.length >= MAX || depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (out.length >= MAX) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        let text;
        try { text = decodeText(fs.readFileSync(full)); } catch (e2) { continue; }
        text.split('\n').forEach((line, i) => {
          if (out.length >= MAX) return;
          if (re.test(line)) out.push(full + ':' + (i + 1) + ': ' + line.trim().slice(0, 160));
        });
      }
    }
  }
  walk(start, 0);
  return out.join('\n') || '无匹配';
}
async function executeTool(tu, job) {
  const name = tu.name, args = tu.input || {};
  const base = (job && job.workspacePath) || os.homedir();
  broadcast(job, { type: 'tool_start', id: tu.id, name: name, args: args });
  let result;
  try {
    switch (name) {
      case 'run_command': result = await execCommand(args.command, args.workdir, base); break;
      case 'read_file': result = toolReadFile(base, args.file_path, args.offset, args.limit); break;
      case 'write_file': result = toolWriteFile(base, args.file_path, args.content); break;
      case 'edit_file': result = toolEditFile(base, args.file_path, args.old_string, args.new_string); break;
      case 'list_dir': result = toolListDir(base, args.path); break;
      case 'search_files': result = toolSearchFiles(base, args.pattern, args.path); break;
      default: result = '未知工具：' + name;
    }
  } catch (e) {
    result = '工具执行出错：' + ((e && e.message) || e);
  }
  broadcast(job, { type: 'tool_result', id: tu.id, name: name, args: args, result: result });
  return { type: 'tool_result', tool_use_id: tu.id, content: result };
}

// ---------- 审批：挂起循环，等待用户决定 ----------
function requestApproval(job, tu) {
  return new Promise((resolve) => {
    const pendingId = 'ap' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const done = (decision) => {
      pendingApprovals.delete(pendingId);
      if (job.pending && job.pending.pendingId === pendingId) job.pending = null;
      resolve(decision);
    };
    job.pending = { pendingId: pendingId, tool: tu.name, args: tu.input || {} };
    job.status = 'awaiting_approval';
    persistChat(job);
    pendingApprovals.set(pendingId, { jobId: job.id, resolve: done });
    // 用户点「停止」时直接把挂起的审批按拒绝收掉，避免对话卡在等待审批
    const signal = job.controller && job.controller.signal;
    if (signal) {
      if (signal.aborted) { done('deny'); return; }
      signal.addEventListener('abort', () => done('deny'), { once: true });
    }
    broadcast(job, { type: 'approval_required', pendingId: pendingId, id: tu.id, name: tu.name, args: tu.input || {} });
  });
}

// ---------- 请求体：effort 档位 → 模型参数 ----------
function chatEffortConfig(p) {
  const effort = p.effort || 'medium';
  const MAX_TOKENS = { minimal: 16384, low: 16384, medium: 32768, high: 49152, max: 64000 };
  const maxTokens = MAX_TOKENS[effort] || 32768;
  const m = String(p.model || '').toLowerCase();
  const isClaude = m.indexOf('claude') > -1;
  const modernClaude = /claude-(opus-5|sonnet-5|haiku-5|fable|opus-4-[6-9]|sonnet-4-[6-9])/.test(m);
  const cfg = { max_tokens: maxTokens };
  if (isClaude && modernClaude) {
    const map = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', max: 'max' };
    cfg.output_config = { effort: map[effort] || 'medium' };
  } else if (isClaude) {
    const THINK = { minimal: 1024, low: 2048, medium: 8192, high: 16384, max: 32768 };
    const budget = THINK[effort] || 8192;
    cfg.thinking = { type: 'enabled', budget_tokens: budget };
    cfg.max_tokens = Math.max(maxTokens, budget + 4096);
  }
  return cfg;
}
function chatAttempts(p, messages, job) {
  const cfg = chatEffortConfig(p);
  const base = {
    model: p.model, max_tokens: cfg.max_tokens, stream: true,
    system: agentSystemText(job),
    messages: messages, tools: AGENT_TOOLS
  };
  if (cfg.output_config) base.output_config = cfg.output_config;
  if (cfg.thinking) base.thinking = cfg.thinking;
  const noEffort = Object.assign({}, base); delete noEffort.output_config; delete noEffort.thinking;
  const noTools = Object.assign({}, noEffort); delete noTools.tools;
  const tiny = Object.assign({}, noTools, { max_tokens: 16384 });
  return [base, noEffort, noTools, tiny].filter((b, i, arr) => arr.findIndex((x) => JSON.stringify(x) === JSON.stringify(b)) === i);
}

// ---------- 上游流式调用：收集文本/思考/工具，并广播给 SSE 客户端 ----------
async function chatStreamOnce(url, headers, body, job, signal) {
  const r = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: signal });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    const err = new Error('上游 ' + r.status + '：' + String(t).slice(0, 300));
    if (r.status === 401 || r.status === 403) err.authFail = true;
    if (r.status === 404) err.message += '（请确认中转支持 POST ' + url + '）';
    throw err;
  }
  const ct = String(r.headers.get('content-type') || '');
  let text = '', thinking = '', stop = '', usage = null;
  const toolUses = [];           // { id, name, inputStr }
  const blockState = [];         // index → { type, id, name, inputStr }
  if (ct.indexOf('event-stream') > -1) {
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s || s.charAt(0) === ':' || !s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(payload); } catch (e) { continue; }
        if (ev.type === 'message_start' && ev.message && ev.message.usage) {
          usage = Object.assign({}, ev.message.usage);
        } else if (ev.type === 'content_block_start') {
          const cb = ev.content_block || {};
          blockState[ev.index] = { type: cb.type, id: cb.id || null, name: cb.name || null, inputStr: '' };
          if (cb.type === 'tool_use') toolUses.push({ id: cb.id, name: cb.name, inputStr: '' });
        } else if (ev.type === 'content_block_delta') {
          const d = ev.delta || {};
          const st = blockState[ev.index];
          if (d.type === 'text_delta') {
            text += d.text || '';
            if (job.currentAssistant) job.currentAssistant.text += (d.text || '');
            broadcast(job, { type: 'text_delta', text: d.text || '' });
          } else if (d.type === 'thinking_delta') {
            thinking += d.thinking || '';
            if (job.currentAssistant) job.currentAssistant.thinking += (d.thinking || '');
            broadcast(job, { type: 'thinking_delta', text: d.thinking || '' });
          } else if (d.type === 'input_json_delta') {
            if (st) st.inputStr += (d.partial_json || '');
            const tu = toolUses[toolUses.length - 1];
            if (tu) tu.inputStr += (d.partial_json || '');
            broadcast(job, { type: 'tool_input_delta', partial: d.partial_json || '' });
          }
        } else if (ev.type === 'message_delta') {
          if (ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason;
          if (ev.usage) usage = Object.assign(usage || {}, ev.usage);
        } else if (ev.type === 'error') {
          throw new Error('上游流错误：' + JSON.stringify(ev.error || ev).slice(0, 300));
        }
      }
    }
  } else {
    const j = await r.json();
    const blocks = Array.isArray(j.content) ? j.content : [];
    for (const b of blocks) {
      if (b.type === 'text') { text += b.text || ''; broadcast(job, { type: 'text_delta', text: b.text || '' }); }
      else if (b.type === 'thinking') thinking += b.thinking || '';
      else if (b.type === 'tool_use') toolUses.push({ id: b.id, name: b.name, inputStr: JSON.stringify(b.input || {}) });
    }
    stop = j.stop_reason || '';
    usage = j.usage || null;
  }
  if (!stop) stop = toolUses.length ? 'tool_use' : 'end_turn';
  const parsedToolUses = toolUses.map((t) => {
    let input = {};
    try { input = t.inputStr ? JSON.parse(t.inputStr) : {}; } catch (e) { input = { _raw: t.inputStr }; }
    return { id: t.id, name: t.name, input: input };
  });
  return { text: text, thinking: thinking, stopReason: stop, toolUses: parsedToolUses, usage: usage };
}

async function callChat(p, body, job, signal) {
  const base = String(p.baseUrl || '').replace(/\/+$/, '');
  const url = base + (/\/v1$/.test(base) ? '/messages' : '/v1/messages');
  const styles = authStyle.get(p.id) ? [authStyle.get(p.id)] : ['x-api-key', 'bearer'];
  let lastErr = null;
  for (let i = 0; i < styles.length; i++) {
    const headers = { 'content-type': 'application/json' };
    if (styles[i] === 'x-api-key') { headers['x-api-key'] = p.apiKey; headers['anthropic-version'] = '2023-06-01'; }
    else { headers.authorization = 'Bearer ' + p.apiKey; }
    try {
      const out = await chatStreamOnce(url, headers, body, job, signal);
      authStyle.set(p.id, styles[i]);
      return out;
    } catch (e) {
      lastErr = e;
      if (e && e.authFail && i < styles.length - 1) continue;
      throw e;
    }
  }
  throw lastErr;
}

// ---------- 存储 ----------
function nextChatId() {
  fs.mkdirSync(CHATS_DIR, { recursive: true });
  let max = 0;
  for (const f of fs.readdirSync(CHATS_DIR)) {
    const m = f.match(/^(\d+)\.json$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return String(max + 1).padStart(4, '0');
}
function deriveChatTitle(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.slice(0, 24) || '新对话';
}
function persistChat(job) {
  fs.mkdirSync(CHATS_DIR, { recursive: true });
  writeAtomic(path.join(CHATS_DIR, job.id + '.json'), JSON.stringify({
    id: job.id, title: job.title, model: job.model, providerName: job.providerName,
    providerId: job.providerId, effort: job.effort, goalMode: !!job.goalMode,
    approvalMode: normalizeApprovalMode(job.approvalMode), workspaceId: job.workspaceId || '',
    createdAt: job.createdAt,
    updatedAt: new Date().toISOString(), messages: job.messages, display: job.display
  }, null, 2));
}
function loadChat(id) {
  try { return JSON.parse(fs.readFileSync(path.join(CHATS_DIR, id + '.json'), 'utf8')); }
  catch (e) { return null; }
}
function chatPreview(c) {
  const display = Array.isArray(c.display) ? c.display : [];
  const last = display[display.length - 1] || {};
  if (last.kind === 'assistant' && last.text) return last.text.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (last.kind === 'user' && last.text) return last.text.replace(/\s+/g, ' ').trim().slice(0, 60);
  return '';
}
function listChats() {
  const list = [];
  const seen = new Set();
  for (const job of chatJobs.values()) {
    list.push({ id: job.id, title: job.title, model: job.model, providerName: job.providerName, effort: job.effort, goalMode: job.goalMode, approvalMode: job.approvalMode, workspaceId: job.workspaceId || '', status: job.status, createdAt: job.createdAt, updatedAt: new Date().toISOString(), preview: chatPreview(job) });
    seen.add(job.id);
  }
  try {
    for (const f of fs.readdirSync(CHATS_DIR)) {
      const m = f.match(/^(\d+)\.json$/);
      if (!m || seen.has(m[1])) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, f), 'utf8'));
        list.push({ id: c.id, title: c.title, model: c.model, providerName: c.providerName, effort: c.effort, goalMode: c.goalMode, approvalMode: c.approvalMode, workspaceId: c.workspaceId || '', status: 'idle', createdAt: c.createdAt, updatedAt: c.updatedAt, preview: chatPreview(c) });
      } catch (e) { /* 跳过坏文件 */ }
    }
  } catch (e) { /* 目录不存在 */ }
  list.sort((a, b) => (a.id < b.id ? 1 : -1));
  return list;
}

// ---------- SSE 广播 ----------
function sseWrite(res, type, data) {
  try { res.write('event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) { /* 客户端已断开 */ }
}
function broadcast(job, event) {
  if (!job || !job.clients) return;
  const type = (event && event.type) || '';
  for (const res of job.clients) sseWrite(res, type, event);
}
function closeClients(job) {
  if (!job || !job.clients) return;
  for (const res of job.clients) { try { res.end(); } catch (e) { /* ignore */ } }
  job.clients.clear();
}

// ---------- Agent 循环 ----------
// 把一条消息压成可展示的预览（工具结果只留开头）
function opsMsgPreview(m) {
  const cut = (v, n) => {
    const t = typeof v === 'string' ? v : JSON.stringify(v == null ? '' : v);
    return t.length > n ? t.slice(0, n) + '…' : t;
  };
  if (typeof m.content === 'string') return cut(m.content, 160);
  if (!Array.isArray(m.content)) return '';
  const parts = [];
  for (const b of m.content) {
    if (!b) continue;
    if (b.type === 'text') parts.push(cut(b.text || '', 160));
    else if (b.type === 'tool_use') parts.push('调用工具 ' + (b.name || '') + ' ' + cut(JSON.stringify(b.input || {}), 100));
    else if (b.type === 'tool_result') parts.push('工具结果：' + cut(typeof b.content === 'string' ? b.content : JSON.stringify(b.content || ''), 120));
  }
  return cut(parts.join(' / ') || '', 200);
}
// 记录这次请求到底发了什么：system 文本、当前用户输入、可用工具、上下文消息与上轮对比
function opsChatContent(job, messages) {
  const system = agentSystemText(job);
  const sysTok = estimateTokens(system);
  const list = [];
  let msgTok = 0;
  for (const m of messages) {
    const tok = messageTokens(m);
    msgTok += tok;
    list.push({ role: m.role || '', tokens: tok, preview: opsMsgPreview(m) });
  }
  const total = sysTok + msgTok;
  // 本轮用户输入：最后一条「纯文本」的用户消息；若最后一条是工具结果回灌，则本轮没有新输入
  let userText = '';
  let lastIsToolResult = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') { userText = m.content; break; }
    if (Array.isArray(m.content) && m.content.some((b) => b && b.type === 'tool_result')) { lastIsToolResult = true; continue; }
  }
  const prev = job._opsPrevCtx || null;
  job._opsPrevCtx = { count: list.length, tokens: total };
  return {
    system: { chars: system.length, tokens: estimateTokens(system), text: system },
    user: {
      text: userText,
      note: lastIsToolResult && !userText ? '本轮没有新的用户输入，上下文末尾是工具结果回灌' : (lastIsToolResult ? '本轮由工具结果回灌触发，用户输入沿用上一轮' : ''),
      chars: userText.length
    },
    tools: AGENT_TOOLS.map((t) => ({ name: t.name, description: String(t.description || '').slice(0, 180) })),
    skills: [],
    context: {
      count: list.length,
      totalTokens: total,
      systemTokens: sysTok,
      messageTokens: msgTok,
      prevCount: prev ? prev.count : null,
      prevTokens: prev ? prev.tokens : null,
      messages: list.slice(-60)   // 只留最近 60 条，避免链路文件过大
    }
  };
}

async function runChatJob(job) {
  const maxTurns = job.goalMode ? 60 : 24;
  try {
    const store = loadStore();
    const p = store.providers.find((x) => x.id === job.providerId) || store.providers.find((x) => x.id === store.activeId);
    if (!p) throw new Error('没有可用的模型供应商');
    if (p.type === 'claude-code') throw new Error('对话需要 API 类供应商（官方 / 第三方），请在模型菜单切换到已配置 Key 的供应商');
    if (!p.apiKey) throw new Error('当前供应商未配置 API Key，请到设置里补全');
    // 用对话记录里固定的 model/effort，配上当前供应商的端点与 Key
    const prov = Object.assign({}, p, { model: job.model || p.model, effort: job.effort || p.effort || 'medium' });

    job.opsStatus = 'success';
    for (let turns = 0; turns < maxTurns; turns++) {
      // 上下文超阈值则先压缩（summarize 模式，复刻 Penguin）
      let compacted = false;
      if (totalTokens(job.messages) >= COMPACTION_THRESHOLD_TOKENS) {
        compacted = await summarizeContext(job, prov, job.controller.signal);
      }

      const roundStart = Date.now();
      broadcast(job, { type: 'assistant_start' });
      job.currentAssistant = { kind: 'assistant', text: '', thinking: '' };
      job.display.push(job.currentAssistant);

      const messages = job.messages.slice();
      let out = null, lastErr = null;
      for (const body of chatAttempts(prov, messages, job)) {
        try {
          out = await callChat(prov, body, job, job.controller.signal);
          break;
        } catch (e) {
          lastErr = e;
          if (e && e.name === 'AbortError') throw new Error('已停止');
          if (/上游 400/.test((e && e.message) || '')) continue;  // 参数/能力类错误，降级重试
          throw e;
        }
      }
      if (!out) throw (lastErr || new Error('对话失败'));
      const roundJudgment = String(out.thinking || out.text || '').trim();
      const llmContent = opsChatContent(job, messages);
      opsLlmStep(job.opsTrace, {
        title: '模型调用', model: prov.model, provider: prov.name, prompt: 'agent-system · v1',
        usage: out.usage, start: roundStart, text: out.text, thinking: out.thinking,
        stopReason: out.stopReason, content: llmContent,
        reason: (compacted ? '上下文压缩后继续；' : '')
          + (turns === 0 ? '收到用户提问，开始第 ' + ((job.opsTrace && job.opsTrace.round) || 1) + ' 轮推理' : '上一轮的工具结果已回灌，继续推理'),
        fallbackIn: totalTokens(messages), fallbackOut: estimateTokens(out.text || '')
      });

      // 组装 assistant 消息（Anthropic 格式）
      const content = [];
      if (out.text) content.push({ type: 'text', text: out.text });
      for (const tu of out.toolUses) content.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
      job.messages.push({ role: 'assistant', content: content });
      if (job.currentAssistant) {
        job.currentAssistant.text = out.text;
        job.currentAssistant.thinking = out.thinking;
        job.currentAssistant = null;
      }

      if (out.stopReason === 'refusal') throw new Error('上游模型拒绝回答该内容');
      if (out.stopReason !== 'tool_use' || out.toolUses.length === 0) break;

      // 执行工具：按四种审批模式（allow-all / deny-all / read-only / always-ask）决定路径
      const toolResults = [];
      for (const tu of out.toolUses) {
        let result;
        const toolStart = Date.now();
        let denied = false;
        const path = resolveToolDecision(job, tu.name);
        if (path === 'deny') {
          // deny-all：按策略自动拒绝
          denied = true;
          const denyMsg = '审批模式为「全部拒绝」，已自动拒绝该操作';
          job.display.push({ kind: 'tool', id: tu.id, name: tu.name, input: tu.input, denied: true, forbidden: true, result: '' });
          broadcast(job, { type: 'tool_result', id: tu.id, name: tu.name, args: tu.input || {}, denied: true, forbidden: true, result: denyMsg });
          result = { type: 'tool_result', tool_use_id: tu.id, content: denyMsg, is_error: true };
        } else if (path === 'ask') {
          // always-ask / read-only 的写类工具：挂起询问
          const decision = await requestApproval(job, tu);
          job.status = 'running';
          if (decision === 'deny') {
            denied = true;
            job.display.push({ kind: 'tool', id: tu.id, name: tu.name, input: tu.input, denied: true, result: '' });
            broadcast(job, { type: 'tool_result', id: tu.id, name: tu.name, args: tu.input || {}, denied: true, result: '用户拒绝了该操作' });
            result = { type: 'tool_result', tool_use_id: tu.id, content: '用户拒绝了该操作', is_error: true };
          } else {
            const res2 = await executeTool(tu, job);
            job.display.push({ kind: 'tool', id: tu.id, name: tu.name, input: tu.input, denied: false, result: res2.content });
            result = res2;
          }
        } else {
          // allow-all / read-only 的只读工具：直接执行
          const res2 = await executeTool(tu, job);
          job.display.push({ kind: 'tool', id: tu.id, name: tu.name, input: tu.input, denied: false, result: res2.content });
          result = res2;
        }
        opsToolStep(job.opsTrace, {
          name: tu.name, args: tu.input, model: prov.model, provider: prov.name,
          judgment: roundJudgment, result: (result && result.content) || '',
          denied: denied,
          status: result && result.is_error ? (denied ? 'denied' : 'error') : 'success',
          start: toolStart
        });
        toolResults.push(result);
      }
      job.messages.push({ role: 'user', content: toolResults });
      persistChat(job);
    }
  } catch (e) {
    const msg = String((e && e.message) || e);
    job.opsStatus = msg === '已停止' ? 'stopped' : 'error';
    job.opsError = msg;
    if (msg === '已停止') {
      job.display.push({ kind: 'note', text: '已停止当前对话。' });
    } else {
      job.display.push({ kind: 'error', text: msg });
      broadcast(job, { type: 'error', message: msg });
    }
  } finally {
    opsTraceFinish(job.opsTrace, job.opsStatus || 'success', job.opsError);
    job.status = 'idle';
    job.pending = null;
    job.currentAssistant = null;
    persistChat(job);
    broadcast(job, { type: 'done' });
    closeClients(job);
    chatJobs.delete(job.id);
  }
}

// 启动一次对话任务（新建或追问），返回 { id, status }
function launchChat(chat, firstMessage) {
  if (firstMessage !== undefined) {
    chat.messages.push({ role: 'user', content: firstMessage });
    chat.display.push({ kind: 'user', text: firstMessage });
    if (!chat.title || chat.title === '新对话') chat.title = deriveChatTitle(firstMessage);
  }
  const ws = chatWorkspaceInfo(chat);
  const job = Object.assign({}, chat, {
    status: 'running', pending: null, currentAssistant: null,
    workspaceId: ws.id || chat.workspaceId || '',
    workspaceName: ws.name || '',
    workspacePath: ws.path,
    controller: new AbortController(), clients: new Set()
  });
  if (chat.messages.length === 1 && chat.messages[0].role === 'user') {
    job.title = deriveChatTitle(typeof chat.messages[0].content === 'string' ? chat.messages[0].content : '');
  }
  const round = (chat.messages || []).filter((m) => m.role === 'user' && typeof m.content === 'string').length;
  job.opsTrace = opsTraceNew({
    source: 'chat', agent: 'default_agent', title: job.title || '', chatId: job.id,
    round: round || 1, model: job.model, provider: job.providerName,
    workspace: job.workspaceName || ''
  });
  chatJobs.set(job.id, job);
  persistChat(job);
  runChatJob(job).catch((e) => { /* runChatJob 内部已兜底 */ });
  return job;
}

// ---------- HTTP 基础 ----------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1048576) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}
function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  try {
    // ---------- 静态页面 ----------
    if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html' || urlPath === '/fde-workbench.html')) {
      const html = fs.readFileSync(HTML_FILE);
      res.writeHead(200, { 'Content-Type': mime('.html') });
      return res.end(html);
    }

    // ---------- 用量追踪：读取本地 trace（成本与统计 / 应用可观测共用） ----------
    if (req.method === 'GET' && urlPath === '/api/ops/traces') {
      const q = new URL(req.url, 'http://127.0.0.1').searchParams;
      const limit = Math.min(500, Math.max(1, Number(q.get('limit')) || 200));
      return json(res, 200, { traces: opsTraceList(limit), serverTime: new Date().toISOString() });
    }

    // ---------- 一次性迁移：把旧版存在浏览器 localStorage 的配置（含 Key）搬到后端 ----------
    if (req.method === 'POST' && urlPath === '/api/migrate') {
      const body = await readBody(req);
      if (body && Array.isArray(body.providers)) {
        const store = loadStore();
        for (const inc of body.providers) {
          if (!inc || !inc.id) continue;
          const cur = store.providers.find((p) => p.id === inc.id);
          if (cur) {
            if (inc.apiKey) cur.apiKey = inc.apiKey;
            cur.name = inc.name || cur.name;
            cur.baseUrl = inc.baseUrl || cur.baseUrl;
            cur.model = inc.model || cur.model;
            cur.type = inc.type || cur.type;
          } else {
            store.providers.push({
              id: inc.id, name: inc.name || '未命名', type: inc.type || 'relay',
              color: inc.color || 'blue', baseUrl: inc.baseUrl || '',
              modelsUrl: inc.modelsUrl || '', apiKey: inc.apiKey || '',
              model: inc.model || '', effort: inc.effort || 'medium'
            });
          }
        }
        if (body.activeId && store.providers.some((p) => p.id === body.activeId)) store.activeId = body.activeId;
        saveStore(store);
      }
      return json(res, 200, { ok: true });
    }

    // ---------- 供应商列表（脱敏） ----------
    if (req.method === 'GET' && urlPath === '/api/providers') {
      const store = loadStore();
      return json(res, 200, { providers: store.providers.map(sanitize), activeId: store.activeId });
    }

    // ---------- 新增 ----------
    if (req.method === 'POST' && urlPath === '/api/providers') {
      const b = await readBody(req);
      if (!b.name) return json(res, 400, { error: '配置名称为必填项' });
      if (!b.baseUrl && b.type !== 'claude-code') return json(res, 400, { error: '接口地址为必填项' });
      const store = loadStore();
      const p = {
        id: 'p' + Date.now(), name: b.name, type: b.type === 'official' ? 'official' : (b.type === 'claude-code' ? 'claude-code' : 'relay'),
        color: (store.providers.length % 4 === 0 && 'blue') || ['blue', 'indigo', 'green', 'amber'][store.providers.length % 4],
        baseUrl: b.baseUrl || '', modelsUrl: b.modelsUrl || '',
        apiKey: b.apiKey || '', model: b.model || '', effort: b.effort || 'medium'
      };
      store.providers.push(p);
      saveStore(store);
      return json(res, 200, { provider: sanitize(p) });
    }

    // ---------- /api/providers/:id[/models|/test|/enable] ----------
    const m = urlPath.match(/^\/api\/providers\/([^/]+)(?:\/(models|test|enable))?$/);
    if (m) {
      const store = loadStore();
      const p = store.providers.find((x) => x.id === m[1]);
      if (!p) return json(res, 404, { error: '供应商配置不存在' });

      if (req.method === 'PUT' && !m[2]) {
        const b = await readBody(req);
        if (b.name !== undefined) p.name = b.name;
        if (b.type !== undefined) p.type = b.type === 'official' ? 'official' : (b.type === 'claude-code' ? 'claude-code' : 'relay');
        if (b.baseUrl !== undefined) p.baseUrl = b.baseUrl;
        if (b.modelsUrl !== undefined) p.modelsUrl = b.modelsUrl;
        if (b.model !== undefined) p.model = b.model;
        if (b.effort !== undefined) {
          // 只接受该模型支持的档位，超出范围忽略
          if (effortOptionsFor(p.model).indexOf(b.effort) > -1) p.effort = b.effort;
        }
        // 关键：前端不回传 Key（它拿不到），只有用户在输入框里新输入时才带 apiKey 字段
        if (b.apiKey) p.apiKey = b.apiKey;
        saveStore(store);
        return json(res, 200, { provider: sanitize(p) });
      }
      if (req.method === 'DELETE' && !m[2]) {
        if (store.activeId === p.id) return json(res, 400, { error: '正在启用的配置不可删除，请先切换' });
        store.providers = store.providers.filter((x) => x.id !== p.id);
        saveStore(store);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && m[2] === 'enable') {
        store.activeId = p.id;
        saveStore(store);
        return json(res, 200, { ok: true, activeId: store.activeId });
      }
      if (req.method === 'GET' && m[2] === 'models') {
        const r = await listModels(p);
        if (r.ok) {
          // 排序后缓存：能力强的在前，同家族新版本在前
          r.models = sortModels(r.models);
          p.models = r.models;
          if (!p.model && r.models.length) p.model = r.models[0];
          saveStore(store);
        }
        return json(res, r.ok ? 200 : 502, r);
      }
      if (req.method === 'POST' && m[2] === 'test') {
        const r = await listModels(p);
        return json(res, 200, {
          ok: r.ok, latency: r.latency || null,
          count: r.models ? r.models.length : 0,
          error: r.error || null
        });
      }
    }

    // ==================== 学习会话 ====================
    if (urlPath === '/api/sessions') {
      // 列表：内存 job ∪ 磁盘 meta，按 id 降序
      if (req.method === 'GET') {
        const list = [];
        const seen = new Set();
        for (const job of jobs.values()) {
          list.push({
            id: job.id, status: job.status, goal: job.goal, title: '',
            model: job.model, providerName: job.providerName, effort: job.effort,
            chars: job.chars, elapsedSec: Math.round((Date.now() - job.startedAt) / 1000),
            error: job.error || null, fallbackNote: job.fallbackNote || null
          });
          seen.add(job.id);
        }
        try {
          for (const f of fs.readdirSync(SESSIONS_DIR)) {
            const m2 = f.match(/^(\d+)\.json$/);
            if (!m2 || seen.has(m2[1])) continue;
            try { list.push(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'))); } catch (e) { /* 跳过坏文件 */ }
          }
        } catch (e) { /* 目录不存在 */ }
        list.sort((a, b) => (a.id < b.id ? 1 : -1));
        return json(res, 200, { sessions: list });
      }

      // 新建生成任务：同步块内取号 + 登记，立即返回
      if (req.method === 'POST') {
        const body = await readBody(req);
        const goal = String(body.goal || '').trim();
        if (!goal) return json(res, 400, { error: '请先描述学习目标' });
        if (goal.length > 2000) return json(res, 400, { error: '学习目标过长（≤2000 字）' });
        const store = loadStore();
        const p = store.providers.find((x) => x.id === store.activeId);
        if (!p) return json(res, 400, { error: '没有可用的模型供应商' });
        if (p.type !== 'claude-code' && !p.apiKey) return json(res, 400, { error: '当前启用的供应商未配置 API Key，请到设置里补全' });
        const id = nextSessionId();                 // 同步块：取号与登记之间无 await，编号绝不重复
        const controller = new AbortController();
        const job = {
          id: id, goal: goal, status: 'generating', startedAt: Date.now(), chars: 0,
          model: p.model, providerName: p.name, effort: p.effort || 'medium',
          controller: controller, error: null
        };
        jobs.set(id, job);
        job.opsTrace = opsTraceNew({
          source: 'learning', agent: 'learn_agent', title: goal,
          sessionId: id, model: job.model, provider: job.providerName
        });
        const finishOk = (raw, used) => {
          const clean = sanitizeLessonHtml(raw);
          const title = extractTitle(clean, goal);
          const nowIso = new Date().toISOString();
          // 顺序严格：先 html 后 meta；meta 存在 ⇒ 课程完整
          writeAtomic(path.join(SESSIONS_DIR, id + '.html'), clean);
          writeAtomic(path.join(SESSIONS_DIR, id + '.json'), JSON.stringify({
            id: id, title: title, goal: goal, model: used.model, providerName: used.name,
            effort: used.effort || 'medium', createdAt: nowIso, updatedAt: nowIso,
            progress: 0, progressLabel: '', status: 'in_progress'
          }, null, 2));
          jobs.delete(id);
          opsTraceFinish(job.opsTrace, 'success');
        };
        const setFailed = (e) => {
          job.status = 'failed';
          job.error = String((e && e.message) || e);
          opsTraceFinish(job.opsTrace, 'error', job.error);
        };
        const finishFail = (e) => {
          const msg = String((e && e.message) || e);
          // REST 引擎被「仅允许 Claude Code 客户端」的中转拒绝 → 自动切换订阅引擎重试
          let cc = null;
          if (p.type !== 'claude-code' && /only allows Claude Code clients/i.test(msg)) {
            cc = loadStore().providers.find((x) => x.type === 'claude-code');
          }
          if (cc) {
            job.status = 'generating';
            job.error = null;
            job.chars = 0;
            job.providerName = cc.name;
            job.model = cc.model;
            job.effort = cc.effort || 'medium';
            job.fallbackNote = '当前中转仅允许 Claude Code 客户端调用，已自动切换「Claude Code 订阅」引擎重试';
            generateLessonCC(cc, goal, job).then((raw) => finishOk(raw, cc)).catch(setFailed);
          } else {
            setFailed(e);
            if (/only allows Claude Code clients/i.test(msg)) {
              job.error = msg + '｜提示：可在设置里添加「Claude Code 订阅」引擎，用订阅额度生成';
            }
          }
        };
        const runWith = (prov) => {
          const gen = prov.type === 'claude-code' ? generateLessonCC(prov, goal, job) : generateLesson(prov, goal, job);
          gen.then((raw) => finishOk(raw, prov)).catch(finishFail);
        };
        runWith(p);
        return json(res, 200, { session: { id: id, status: 'generating' } });
      }
      return json(res, 404, { error: 'Not Found' });
    }

    // /api/sessions/:id[/lesson]
    const sm = urlPath.match(/^\/api\/sessions\/(\d{3,})(?:\/(lesson))?$/);
    if (sm) {
      const sid = sm[1];
      const job = jobs.get(sid);
      const metaFile = path.join(SESSIONS_DIR, sid + '.json');
      const htmlFile = path.join(SESSIONS_DIR, sid + '.html');

      // 单条状态（轮询用）：job 优先，其次磁盘 meta
      if (req.method === 'GET' && !sm[2]) {
        if (job) {
          return json(res, 200, {
            session: {
              id: job.id, status: job.status, goal: job.goal, title: '',
              model: job.model, providerName: job.providerName, effort: job.effort,
              chars: job.chars, elapsedSec: Math.round((Date.now() - job.startedAt) / 1000),
              error: job.error || null, fallbackNote: job.fallbackNote || null
            }
          });
        }
        try {
          return json(res, 200, { session: JSON.parse(fs.readFileSync(metaFile, 'utf8')) });
        } catch (e) {
          return json(res, 404, { error: '会话不存在' });
        }
      }

      // 课程 HTML：清洗 + 注入桥接，禁缓存
      if (req.method === 'GET' && sm[2] === 'lesson') {
        let html;
        try {
          html = fs.readFileSync(htmlFile, 'utf8');
        } catch (e) {
          return json(res, 404, { error: '课程不存在' });
        }
        const out = injectBridge(sid, html);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:"
        });
        return res.end(out);
      }

      // 更新进度（白名单 + 钳位）
      if (req.method === 'PATCH' && !sm[2]) {
        if (job) return json(res, 400, { error: '会话生成中，不可更新进度' });
        let meta;
        try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (e) {
          return json(res, 404, { error: '会话不存在' });
        }
        const b = await readBody(req);
        if (b.progress !== undefined) meta.progress = Math.max(0, Math.min(100, Math.round(Number(b.progress) || 0)));
        if (b.progressLabel !== undefined) meta.progressLabel = String(b.progressLabel || '').slice(0, 40);
        if (b.status !== undefined) {
          if (b.status !== 'in_progress' && b.status !== 'completed') return json(res, 400, { error: 'status 仅接受 in_progress | completed' });
          meta.status = b.status;
        }
        meta.updatedAt = new Date().toISOString();
        writeAtomic(metaFile, JSON.stringify(meta, null, 2));
        return json(res, 200, { session: meta });
      }

      // 删除：在飞任务中止 + 删文件
      if (req.method === 'DELETE' && !sm[2]) {
        if (job) { try { job.controller.abort(); } catch (e) {} jobs.delete(sid); }
        let existed = false;
        for (const f of [metaFile, htmlFile]) {
          try { fs.unlinkSync(f); existed = true; } catch (e) { /* 不存在 */ }
        }
        return json(res, existed ? 200 : 404, existed ? { ok: true } : { error: '会话不存在' });
      }
    }

    // ==================== 工作区（对话的目录分组） ====================
    if (urlPath === '/api/workspaces') {
      if (req.method === 'GET') return json(res, 200, { workspaces: listWorkspaces() });
      if (req.method === 'POST') {
        const body = await readBody(req);
        const raw = String(body.path || '').trim();
        if (!raw) return json(res, 400, { error: '请选择文件夹' });
        const dir = resolveToolPath(os.homedir(), raw);
        let stat;
        try { stat = fs.statSync(dir); } catch (e) { return json(res, 400, { error: '文件夹不存在：' + dir }); }
        if (!stat.isDirectory()) return json(res, 400, { error: '不是文件夹：' + dir });
        const name = String(body.name || '').trim().slice(0, 60) || path.basename(dir) || dir;
        const ws = createWorkspace({ name: name, dir: dir, kind: 'folder' });
        return json(res, 200, { workspace: Object.assign({}, ws, { path: ws.dir, dir: ws.dir }) });
      }
      return json(res, 404, { error: 'Not Found' });
    }
    const wsm = urlPath.match(/^\/api\/workspaces\/([\w-]+)$/);
    if (wsm) {
      const store = loadWorkspaceStore();
      const ws = store.workspaces.find((w) => w.id === wsm[1]);
      if (!ws) return json(res, 404, { error: '工作区不存在' });
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        const name = String(body.name || '').trim().slice(0, 60);
        if (name) { ws.name = name; saveWorkspaceStore(store); }
        return json(res, 200, { workspace: Object.assign({}, ws, { path: ws.dir, dir: ws.dir }) });
      }
      if (req.method === 'DELETE') {
        // 只移除注册关系，不动磁盘上的文件；原属该工作区的对话会显示为「未分组」
        store.workspaces = store.workspaces.filter((w) => w.id !== wsm[1]);
        saveWorkspaceStore(store);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'Not Found' });
    }

    // 文件夹浏览器：给「新建工作区」的选目录弹窗列子目录
    if (urlPath === '/api/fs/list' && req.method === 'GET') {
      const q = new URL(req.url, 'http://127.0.0.1').searchParams.get('path');
      const dir = resolveToolPath(os.homedir(), q || os.homedir());
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        return json(res, 400, { error: '无法读取目录：' + dir });
      }
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
      const parent = path.dirname(dir);
      return json(res, 200, {
        path: dir,
        parent: parent === dir ? null : parent,
        home: os.homedir(),
        entries: dirs
      });
    }

    // ==================== 对话（通用 Agent） ====================
    if (urlPath === '/api/chats') {
      if (req.method === 'GET') {
        return json(res, 200, { chats: listChats() });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const message = String(body.message || '').trim();
        if (!message) return json(res, 400, { error: '请先输入要发送的内容' });
        if (message.length > 8000) return json(res, 400, { error: '消息过长（≤8000 字）' });
        const store = loadStore();
        const p = store.providers.find((x) => x.id === store.activeId);
        if (!p) return json(res, 400, { error: '没有可用的模型供应商' });
        if (p.type === 'claude-code') return json(res, 400, { error: '对话需要 API 类供应商（官方 / 第三方），请在模型菜单切换' });
        if (!p.apiKey) return json(res, 400, { error: '当前供应商未配置 API Key，请到设置里补全' });
        const id = nextChatId();
        const title = deriveChatTitle(message);
        // 工作区：选了文件夹就用它；没选就为这条新对话自动划分一个临时工作区
        let ws = body.workspaceId ? findWorkspace(String(body.workspaceId)) : null;
        if (body.workspaceId && !ws) return json(res, 400, { error: '工作区不存在，请重新选择' });
        if (!ws) ws = ensureTempWorkspace(id, message);
        const chat = {
          id: id, title: title, model: p.model, providerName: p.name,
          providerId: p.id, effort: p.effort || 'medium',
          goalMode: !!body.goalMode, approvalMode: normalizeApprovalMode(body.approvalMode),
          workspaceId: ws.id,
          createdAt: new Date().toISOString(), messages: [], display: []
        };
        const job = launchChat(chat, message);
        return json(res, 200, { chat: { id: id, status: job.status, workspace: { id: ws.id, name: ws.name, path: ws.dir } } });
      }
      return json(res, 404, { error: 'Not Found' });
    }

    const cm = urlPath.match(/^\/api\/chats\/(\d{3,})(?:\/(messages|stream|approve|stop|config))?$/);
    if (cm) {
      const sid = cm[1];
      const sub = cm[2];
      const job = chatJobs.get(sid);

      // 状态快照：运行中优先，其次磁盘
      if (req.method === 'GET' && !sub) {
        if (job) {
          return json(res, 200, { chat: {
            id: job.id, title: job.title, model: job.model, providerName: job.providerName,
            effort: job.effort, goalMode: job.goalMode, approvalMode: job.approvalMode,
            workspaceId: job.workspaceId || '',
            workspace: { id: job.workspaceId || '', name: job.workspaceName || '', path: job.workspacePath || os.homedir() },
            status: job.status, pending: job.pending, display: job.display,
            createdAt: job.createdAt, updatedAt: new Date().toISOString()
          } });
        }
        const c = loadChat(sid);
        if (!c) return json(res, 404, { error: '对话不存在' });
        return json(res, 200, { chat: Object.assign({}, c, { workspace: chatWorkspaceInfo(c), status: 'idle', pending: null }) });
      }

      // SSE 流：把客户端挂到运行中 job 上接收事件
      if (req.method === 'GET' && sub === 'stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        if (job) {
          job.clients = job.clients || new Set();
          job.clients.add(res);
          req.on('close', () => { if (job.clients) job.clients.delete(res); });
          sseWrite(res, 'snapshot', { status: job.status, pending: job.pending, currentAssistant: job.currentAssistant || null });
          if (job.status === 'idle') { sseWrite(res, 'done', {}); res.end(); }
        } else {
          sseWrite(res, 'snapshot', { status: 'idle', pending: null, currentAssistant: null });
          sseWrite(res, 'done', {});
          res.end();
        }
        return;
      }

      // 追问
      if (req.method === 'POST' && sub === 'messages') {
        if (job) return json(res, 409, { error: '对话正在运行中，请等待本轮完成' });
        const body = await readBody(req);
        const message = String(body.message || '').trim();
        if (!message) return json(res, 400, { error: '请先输入要发送的内容' });
        if (message.length > 8000) return json(res, 400, { error: '消息过长（≤8000 字）' });
        const c = loadChat(sid);
        if (!c) return json(res, 404, { error: '对话不存在' });
        const store = loadStore();
        const p = store.providers.find((x) => x.id === c.providerId) || store.providers.find((x) => x.id === store.activeId);
        if (!p) return json(res, 400, { error: '没有可用的模型供应商' });
        if (p.type === 'claude-code') return json(res, 400, { error: '对话需要 API 类供应商（官方 / 第三方），请切换到已配置 Key 的供应商' });
        if (!p.apiKey) return json(res, 400, { error: '当前供应商未配置 API Key，请到设置里补全' });
        const job2 = launchChat(c, message);
        return json(res, 200, { chat: { id: sid, status: job2.status } });
      }

      // 审批决定
      if (req.method === 'POST' && sub === 'approve') {
        const body = await readBody(req);
        const pa = pendingApprovals.get(String(body.pendingId || ''));
        if (!pa) return json(res, 404, { error: '审批请求不存在或已处理' });
        const decision = body.decision === 'deny' ? 'deny' : 'allow';
        pa.resolve(decision);
        return json(res, 200, { ok: true, decision: decision });
      }

      // 更新对话配置（目标模式 / 审批模式）
      if (req.method === 'POST' && sub === 'config') {
        const body = await readBody(req);
        const updates = {};
        if (body.goalMode !== undefined) updates.goalMode = !!body.goalMode;
        if (body.approvalMode !== undefined) updates.approvalMode = normalizeApprovalMode(body.approvalMode);
        let goalMode, approvalMode;
        if (job) {
          Object.assign(job, updates);
          persistChat(job);
          goalMode = job.goalMode; approvalMode = job.approvalMode;
        } else {
          const c = loadChat(sid);
          if (!c) return json(res, 404, { error: '对话不存在' });
          Object.assign(c, updates);
          writeAtomic(path.join(CHATS_DIR, sid + '.json'), JSON.stringify(c, null, 2));
          goalMode = c.goalMode; approvalMode = c.approvalMode;
        }
        return json(res, 200, { ok: true, goalMode: goalMode, approvalMode: approvalMode });
      }

      // 停止运行中的对话
      if (req.method === 'POST' && sub === 'stop') {
        if (!job) return json(res, 404, { error: '对话未在运行' });
        job.stopped = true;
        try { job.controller.abort(); } catch (e) { /* ignore */ }
        return json(res, 200, { ok: true });
      }

      // 删除
      if (req.method === 'DELETE' && !sub) {
        if (job) { try { job.controller.abort(); } catch (e) { /* ignore */ } chatJobs.delete(sid); }
        let existed = false;
        const f = path.join(CHATS_DIR, sid + '.json');
        try { fs.unlinkSync(f); existed = true; } catch (e) { /* 不存在 */ }
        return json(res, existed ? 200 : 404, existed ? { ok: true } : { error: '对话不存在' });
      }
    }

    json(res, 404, { error: 'Not Found' });
  } catch (e) {
    json(res, 500, { error: String((e && e.message) || e) });
  }
});

opsImportJsonTraces();
backfillChatTraces();

server.listen(PORT, HOST, () => {
  console.log('FDE 工作台本地服务已启动');
  console.log('  地址: http://' + HOST + ':' + PORT);
  console.log('  配置: ' + DATA_FILE + '（含 API Key，权限 0600，勿提交/外传）');
});
