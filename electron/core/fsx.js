'use strict';
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { PATHS } = require('./paths');

const DENY = new Set(['settings.json']);

/** 完全权限模式：允许访问数据目录以外的绝对路径 */
let fullAccess = false;
function setFullAccess(v) { fullAccess = !!v; }
function isFullAccess() { return fullAccess; }

/** 即使在完全权限下，这几样东西也不允许碰 */
function assertProtected(abs) {
  const rootAbs = path.resolve(PATHS.root);
  const inside = abs === rootAbs || abs.startsWith(rootAbs + path.sep);
  if (!inside) return;
  const r = path.relative(rootAbs, abs).split(path.sep).join('/');
  if (/(^|\/)settings\.json/i.test(r)) {
    throw new Error('settings.json 里存着加密后的 API Key，任何模式下都不给工具读');
  }
  if (/(^|\/)snapshots(\/|$)/.test(r)) throw new Error('snapshots 目录只读，请用版本工具');
  if (/(^|\/)master(\/|$)/.test(r)) throw new Error('master/ 是锁定的出厂基线，不能通过工具访问');
}

function resolveUnder(base, rel) {
  const b = path.resolve(base);
  const target = path.resolve(b, rel || '.');
  if (target !== b && !target.startsWith(b + path.sep)) {
    throw new Error(`路径越界，只允许访问程序数据目录内部：${rel}`);
  }
  return target;
}

/** AI / 界面对文件的统一入口，全部限制在 userData 内 */
function toAbs(rel) {
  const raw = String(rel || '.');
  const looksAbs = path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw);
  if (fullAccess && looksAbs) {
    const abs = path.resolve(raw);
    assertProtected(abs);
    return abs;
  }
  const clean = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  if (DENY.has(clean) || /(^|\/)settings\.json/i.test(clean)) {
    throw new Error('settings.json（含备份）受保护（其中含有加密后的 API Key），请用 settings 工具');
  }
  if (/(^|\/)master(\/|$)/.test(clean)) {
    throw new Error('master/ 是锁定的出厂基线，只能通过外壳面板的「设为出厂默认」来更新');
  }
  if (/(^|\/)snapshots(\/|$)/.test(clean)) {
    throw new Error('snapshots 目录只读，请用 snapshot 工具');
  }
  return resolveUnder(PATHS.root, clean);
}

function rel(abs) {
  const r = path.relative(PATHS.root, abs);
  if (r.startsWith('..')) return abs.split(path.sep).join('/');
  return r.split(path.sep).join('/');
}

async function list(dir = '.', depth = 3) {
  const abs = toAbs(dir);
  const out = [];
  async function walk(cur, d) {
    let entries;
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'snapshots' && cur === PATHS.root) continue;
      if (e.name === 'master' && cur === PATHS.root) continue;
      if (/^settings\.json/i.test(e.name) && cur === PATHS.root) continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        out.push({ path: rel(full) + '/', type: 'dir' });
        if (d > 0) await walk(full, d - 1);
      } else {
        let size = 0;
        try { size = (await fsp.stat(full)).size; } catch { /* ignore */ }
        out.push({ path: rel(full), type: 'file', size });
      }
    }
  }
  await walk(abs, depth);
  return out;
}

async function read(relPath) {
  const abs = toAbs(relPath);
  const st = await fsp.stat(abs);
  if (st.isDirectory()) throw new Error('这是目录，不是文件');
  if (st.size > 2 * 1024 * 1024) throw new Error('文件过大（>2MB），请用别的方式处理');
  return await fsp.readFile(abs, 'utf8');
}

async function write(relPath, content) {
  const abs = toAbs(relPath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = abs + '.tmp-' + Date.now();
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, abs);
  return { path: rel(abs), bytes: Buffer.byteLength(content, 'utf8') };
}

async function edit(relPath, oldStr, newStr, replaceAll = false) {
  const cur = await read(relPath);
  if (!cur.includes(oldStr)) {
    throw new Error('没有找到要替换的原文，请先用 read 确认内容（注意空白与换行必须完全一致）');
  }
  const next = replaceAll ? cur.split(oldStr).join(newStr) : cur.replace(oldStr, () => newStr);
  await write(relPath, next);
  return { path: relPath, replaced: replaceAll ? 'all' : 1 };
}

async function remove(relPath) {
  const abs = toAbs(relPath);
  await fsp.rm(abs, { recursive: true, force: true });
  return { removed: rel(abs) };
}

async function copyDir(src, dest, { only = null } = {}) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    if (only && !only.includes(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else { await fsp.mkdir(path.dirname(d), { recursive: true }); await fsp.copyFile(s, d); }
  }
}

module.exports = { toAbs, rel, list, read, write, edit, remove, copyDir, resolveUnder, setFullAccess, isFullAccess };
