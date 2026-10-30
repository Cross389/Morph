'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeStorage } = require('electron');
const { PATHS } = require('./paths');

/**
 * 多接口模型：
 * connections: [{ id, name, baseUrl, apiKeyEnc, model, models[] }]
 * activeId   : 当前在用哪个接口
 * reasoning  : auto | off | low | medium | high
 */
const DEFAULTS = {
  connections: [],
  activeId: '',
  temperature: 0.35,
  maxTokens: 8192,
  reasoning: 'auto',
  permissions: 'sandbox',
  systemPrompt: '',
  agentEnabled: true,
};

const SCALARS = new Set(['temperature', 'maxTokens', 'reasoning', 'systemPrompt', 'agentEnabled', 'permissions']);
const REASONING = new Set(['auto', 'off', 'low', 'medium', 'high']);

let cache = null;

function encryptKey(plain) {
  if (!plain) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'dpapi:' + safeStorage.encryptString(plain).toString('base64');
    }
  } catch { /* fallthrough */ }
  return 'b64:' + Buffer.from(plain, 'utf8').toString('base64');
}

function decryptKey(stored) {
  if (!stored) return '';
  try {
    if (stored.startsWith('dpapi:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(6), 'base64'));
    }
    if (stored.startsWith('b64:')) return Buffer.from(stored.slice(4), 'base64').toString('utf8');
  } catch { /* ignore */ }
  return '';
}

function newId() {
  return 'c_' + crypto.randomBytes(4).toString('hex');
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return '我的接口'; }
}

/** 规范化：老版本单接口结构 → 多接口 */
function normalize(raw) {
  if (Array.isArray(raw.connections)) {
    return { ...DEFAULTS, ...raw, connections: raw.connections };
  }
  const out = { ...DEFAULTS, ...raw, connections: [] };
  if (raw.baseUrl) {
    const id = newId();
    out.connections = [{
      id,
      name: hostOf(raw.baseUrl),
      baseUrl: raw.baseUrl,
      apiKeyEnc: raw.apiKeyEnc || '',
      model: raw.model || '',
      models: [],
    }];
    out.activeId = id;
  }
  delete out.baseUrl;
  delete out.apiKeyEnc;
  delete out.model;
  delete out.provider;
  delete out.autoSnapshot;
  return out;
}

function load() {
  if (cache) return cache;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(PATHS.settings, 'utf8').replace(/^\uFEFF/, ''));
  } catch { raw = {}; }
  cache = normalize(raw);
  if (!Array.isArray(cache.connections)) cache.connections = [];
  if (!cache.activeId || !cache.connections.some((c) => c.id === cache.activeId)) {
    cache.activeId = cache.connections[0] ? cache.connections[0].id : '';
  }
  if (!REASONING.has(cache.reasoning)) cache.reasoning = 'auto';
  if (cache.permissions !== 'full') cache.permissions = 'sandbox';
  return cache;
}

function save() {
  fs.mkdirSync(path.dirname(PATHS.settings), { recursive: true });
  fs.writeFileSync(PATHS.settings, JSON.stringify(cache, null, 2), 'utf8');
}

function active() {
  const s = load();
  return s.connections.find((c) => c.id === s.activeId) || s.connections[0] || null;
}

/** 给界面看的：绝不含明文 Key */
function publicView() {
  const s = load();
  return {
    connections: s.connections.map((c) => {
      const key = decryptKey(c.apiKeyEnc);
      return {
        id: c.id,
        name: c.name || hostOf(c.baseUrl),
        baseUrl: c.baseUrl || '',
        model: c.model || '',
        models: Array.isArray(c.models) ? c.models : [],
        hasKey: !!key,
        keyTail: key ? key.slice(-4) : '',
      };
    }),
    activeId: s.activeId,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    reasoning: s.reasoning,
    permissions: s.permissions,
    systemPrompt: s.systemPrompt,
    agentEnabled: s.agentEnabled,
  };
}

/** 主进程内部用 */
function aiConfig() {
  const s = load();
  const c = active();
  return {
    connectionId: c ? c.id : '',
    name: c ? c.name : '',
    baseUrl: c ? String(c.baseUrl || '').replace(/\/+$/, '') : '',
    apiKey: c ? decryptKey(c.apiKeyEnc) : '',
    model: c ? (c.model || '') : '',
    temperature: Number(s.temperature ?? 0.35),
    maxTokens: Number(s.maxTokens ?? 8192),
    reasoning: s.reasoning || 'auto',
    systemPrompt: s.systemPrompt || '',
  };
}

/** 某个连接解密后的 Key（拉模型、测试连接用） */
function keyOf(id) {
  const c = load().connections.find((x) => x.id === id);
  return c ? decryptKey(c.apiKeyEnc) : '';
}

function connOf(id) {
  return load().connections.find((x) => x.id === id) || null;
}

/** 标量设置 */
function set(patch = {}) {
  load();
  for (const [k, v] of Object.entries(patch)) {
    if (!SCALARS.has(k)) continue;
    if (k === 'temperature') cache[k] = Math.max(0, Math.min(2, Number(v)));
    else if (k === 'maxTokens') cache[k] = Math.max(64, Math.min(64000, Number(v)));
    else if (k === 'reasoning') cache[k] = REASONING.has(v) ? v : 'auto';
    else if (k === 'agentEnabled') cache[k] = !!v;
    else if (k === 'permissions') cache[k] = v === 'full' ? 'full' : 'sandbox';
    else cache[k] = String(v ?? '');
  }
  save();
  return publicView();
}

/** 切换当前接口 / 模型 */
function activate({ id, model } = {}) {
  const s = load();
  const c = id ? s.connections.find((x) => x.id === id) : active();
  if (c) {
    s.activeId = c.id;
    if (model) c.model = String(model).trim();
  }
  save();
  return publicView();
}

/**
 * 一次性保存整个连接列表（设置页「保存」用）。
 * incoming: [{ id?, name, baseUrl, apiKey?, model, models? }]
 * apiKey 为空表示「不修改已保存的 Key」。
 */
function saveAll(incoming = []) {
  const s = load();
  const prev = new Map(s.connections.map((c) => [c.id, c]));
  const next = [];

  for (const raw of incoming) {
    const baseUrl = String(raw.baseUrl || '').trim();
    const model = String(raw.model || '').trim();
    if (!baseUrl && !raw.id) continue;

    let conn = raw.id ? prev.get(raw.id) : null;
    if (!conn) {
      conn = { id: newId(), apiKeyEnc: '' };
    }
    conn.name = String(raw.name || '').trim() || hostOf(baseUrl);
    conn.baseUrl = baseUrl;
    conn.model = model;
    if (Array.isArray(raw.models)) conn.models = raw.models.slice(0, 500);
    if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) {
      conn.apiKeyEnc = encryptKey(raw.apiKey.trim());
    }
    if (!raw.id && !conn.apiKeyEnc) conn.apiKeyEnc = '';
    next.push(conn);
  }

  s.connections = next;
  if (!s.connections.some((c) => c.id === s.activeId)) {
    s.activeId = s.connections[0] ? s.connections[0].id : '';
  }
  save();
  return publicView();
}

function remove(id) {
  const s = load();
  s.connections = s.connections.filter((c) => c.id !== id);
  if (!s.connections.some((c) => c.id === s.activeId)) {
    s.activeId = s.connections[0] ? s.connections[0].id : '';
  }
  save();
  return publicView();
}

function isFull() {
  return load().permissions === 'full';
}

module.exports = {
  isFull,
  DEFAULTS,
  load,
  save,
  get: publicView,
  publicView,
  aiConfig,
  set,
  activate,
  saveAll,
  remove,
  keyOf,
  connOf,
  hostOf,
  encryptKey,
  decryptKey,
};
