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
    hasKey: !!p.apiKey, keyTail: p.apiKey ? p.apiKey.slice(-4) : ''
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
      if (!b.name || !b.baseUrl) return json(res, 400, { error: '名称与接口地址为必填项' });
      const store = loadStore();
      const p = {
        id: 'p' + Date.now(), name: b.name, type: b.type === 'official' ? 'official' : 'relay',
        color: (store.providers.length % 4 === 0 && 'blue') || ['blue', 'indigo', 'green', 'amber'][store.providers.length % 4],
        baseUrl: b.baseUrl, modelsUrl: b.modelsUrl || '',
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
        if (b.type !== undefined) p.type = b.type === 'official' ? 'official' : 'relay';
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
