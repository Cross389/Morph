'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { PATHS } = require('./paths');
const fsx = require('./fsx');

/** 版本完全由用户手动保存，程序不做任何自动备份 */
const MAX_SNAPSHOTS = 200;

function pad(n) { return String(n).padStart(2, '0'); }

function newId() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function defaultLabel(ts = new Date()) {
  return `版本 ${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())}`;
}

function metaPath(id) { return path.join(PATHS.snapshots, id, 'meta.json'); }

function readMeta(id) {
  try { return JSON.parse(fs.readFileSync(metaPath(id), 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function list() {
  let ids = [];
  try { ids = fs.readdirSync(PATHS.snapshots); } catch { return []; }
  const out = [];
  for (const id of ids) {
    const meta = readMeta(id);
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

function uniqueLabel(base) {
  const taken = new Set(list().map((m) => m.label));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} (${i})`)) i += 1;
  return `${base} (${i})`;
}

async function create({ label = '', channel = 'shell' } = {}) {
  const id = newId();
  const dir = path.join(PATHS.snapshots, id);
  await fsp.mkdir(dir, { recursive: true });

  await fsx.copyDir(PATHS.ui, path.join(dir, 'ui'));
  if (fs.existsSync(PATHS.shell)) {
    await fsx.copyDir(PATHS.shell, path.join(dir, 'shell'));
  }

  const meta = {
    id,
    ts: new Date().toISOString(),
    label: uniqueLabel(String(label || '').trim() || defaultLabel()),
    channel,
  };
  await fsp.writeFile(metaPath(id), JSON.stringify(meta, null, 2), 'utf8');
  await prune();
  return meta;
}

async function rename(id, label) {
  const meta = readMeta(id);
  if (!meta) throw new Error('找不到这个版本：' + id);
  const next = String(label || '').trim();
  if (!next) throw new Error('名字不能为空');
  meta.label = next.slice(0, 80);
  await fsp.writeFile(metaPath(id), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

async function remove(id) {
  const meta = readMeta(id);
  if (!meta) throw new Error('找不到这个版本：' + id);
  await fsp.rm(path.join(PATHS.snapshots, id), { recursive: true, force: true });
  return { removed: id, label: meta.label };
}

async function prune() {
  const all = list();
  for (const meta of all.slice(MAX_SNAPSHOTS)) {
    await fsp.rm(path.join(PATHS.snapshots, meta.id), { recursive: true, force: true });
  }
}

/**
 * 恢复：只覆盖界面代码（ui/ 与 shell/）。
 * 不碰 data/kv.json —— 聊天记录、待办这类数据不该因为回退界面而丢失。
 * 也不做任何自动备份：存不存版本完全由用户决定。
 */
async function restore(id) {
  const dir = path.join(PATHS.snapshots, id);
  if (!fs.existsSync(metaPath(id))) throw new Error('找不到这个版本：' + id);
  await fsp.rm(PATHS.ui, { recursive: true, force: true });
  await fsx.copyDir(path.join(dir, 'ui'), PATHS.ui);
  const shellSrc = path.join(dir, 'shell');
  if (fs.existsSync(shellSrc)) {
    await fsp.rm(PATHS.shell, { recursive: true, force: true });
    await fsx.copyDir(shellSrc, PATHS.shell);
  }
  return { restored: id, meta: readMeta(id) };
}

module.exports = { list, create, rename, remove, restore, MAX_SNAPSHOTS };
