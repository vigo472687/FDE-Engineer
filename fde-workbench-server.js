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

const PORT = Number(process.env.FDE_PORT) || 7842;
const HOST = '127.0.0.1';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, '.fde-data');
const DATA_FILE = path.join(DATA_DIR, 'providers.json');
const HTML_FILE = path.join(ROOT, 'fde-workbench.html');

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
  let text = '', stop = '';
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
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
          text += ev.delta.text || '';
          job.chars = text.length;
        } else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) {
          stop = ev.delta.stop_reason;
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
  }
  return { text: text, stopReason: stop };
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
      const out = await callMessages(p, body, job, job.controller.signal);
      text = out.text; stop = out.stopReason; lastBody = body;
      if (!text.trim()) { lastErr = new Error('上游返回空内容'); continue; }
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
      const out2 = await callMessages(p, cont, job, job.controller.signal);
      text += out2.text;
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
      if (message.type === 'result' && message.is_error) {
        throw new Error('Claude Code 返回错误：' + String(message.result || '').slice(0, 200));
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('已取消');
    throw e;
  }
  // 优先取 Write 写出的文件；取不到再退回对话文本
  try {
    return fs.readFileSync(outPath, 'utf8');
  } catch (e) {
    const clean = sanitizeLessonHtml(text);
    if (clean.length > 200) return clean;
    throw new Error('Claude Code 未产出课程文件（若未登录订阅请先在终端 claude /login）');
  }
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
        };
        const setFailed = (e) => {
          job.status = 'failed';
          job.error = String((e && e.message) || e);
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

    json(res, 404, { error: 'Not Found' });
  } catch (e) {
    json(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log('FDE 工作台本地服务已启动');
  console.log('  地址: http://' + HOST + ':' + PORT);
  console.log('  配置: ' + DATA_FILE + '（含 API Key，权限 0600，勿提交/外传）');
});
