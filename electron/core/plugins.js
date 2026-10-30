'use strict';
/**
 * 插件系统：%APPDATA%\Morph\plugins\*.js
 *
 * 每个插件导出：
 *   module.exports = {
 *     name: 'my_tool',
 *     description: '这个工具做什么',
 *     parameters: { type:'object', properties:{...} },
 *     run: async (args, ctx) => ({ ... })
 *   };
 *
 * 开关状态存在 data/plugins.json：{ "xxx.js": { enabled: false } }
 */
const fs = require('node:fs');
const path = require('node:path');
const { PATHS } = require('./paths');
const fsx = require('./fsx');
const exec = require('./exec');

const dir = () => path.join(PATHS.root, 'plugins');
const stateFile = () => path.join(PATHS.data, 'plugins.json');

let all = [];      // 所有插件的元信息（含被禁用的）
let loaded = [];   // 真正可用的（启用且无错误）

function readStates() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}

function writeStates(s) {
  fs.mkdirSync(PATHS.data, { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2), 'utf8');
}

function ctxFor() {
  return {
    fs: {
      list: (p, d) => fsx.list(p, d),
      read: (p) => fsx.read(p),
      write: (p, c) => fsx.write(p, c),
      remove: (p) => fsx.remove(p),
    },
    exec: (command, opts) => exec.run({ command, ...(opts || {}) }),
    fetch: async (url, opts) => {
      const res = await fetch(url, opts);
      const text = await res.text();
      return { status: res.status, text: text.slice(0, 60000) };
    },
    kv: {
      get: (k, d) => {
        try { return JSON.parse(fs.readFileSync(path.join(PATHS.data, 'kv.json'), 'utf8'))[k] ?? d; } catch { return d; }
      },
      set: (k, v) => {
        let s = {};
        try { s = JSON.parse(fs.readFileSync(path.join(PATHS.data, 'kv.json'), 'utf8')); } catch { s = {}; }
        s[k] = v;
        fs.writeFileSync(path.join(PATHS.data, 'kv.json'), JSON.stringify(s, null, 2), 'utf8');
        return true;
      },
    },
    paths: { root: PATHS.root, data: PATHS.data, ui: PATHS.ui, plugins: dir() },
    log: (...a) => console.log('[plugin]', ...a),
  };
}

function load() {
  all = [];
  loaded = [];
  const states = readStates();
  let files = [];
  try {
    fs.mkdirSync(dir(), { recursive: true });
    files = fs.readdirSync(dir()).filter((f) => f.endsWith('.js'));
  } catch (e) {
    return { loaded: [], errors: [e.message], all: [] };
  }

  const errors = [];
  for (const f of files) {
    const full = path.join(dir(), f);
    const entry = {
      file: f,
      name: f.replace(/\.js$/, ''),
      description: '',
      enabled: states[f] && states[f].enabled === false ? false : true,
      ok: true,
      error: '',
    };

    try {
      delete require.cache[require.resolve(full)];
      const mod = require(full);
      if (!mod || !mod.name || typeof mod.run !== 'function') {
        entry.ok = false;
        entry.error = '缺少 name 或 run()';
      } else {
        entry.name = String(mod.name);
        entry.description = String(mod.description || '');
        if (entry.enabled) {
          loaded.push({
            file: f,
            name: entry.name,
            description: entry.description,
            parameters: mod.parameters || { type: 'object', properties: {} },
            run: mod.run,
          });
        }
      }
    } catch (e) {
      entry.ok = false;
      entry.error = e.message;
    }

    if (!entry.ok) errors.push(`${f}: ${entry.error}`);
    all.push(entry);
  }

  return { loaded: loaded.map((p) => p.name), errors, all: list() };
}

function list() {
  return all.map((p) => ({ ...p }));
}

function defs() {
  return loaded.map((p) => ({
    type: 'function',
    function: { name: p.name, description: p.description, parameters: p.parameters },
  }));
}

function has(name) {
  return loaded.some((p) => p.name === name);
}

async function execute(name, args) {
  const p = loaded.find((x) => x.name === name);
  if (!p) throw new Error('没有这个插件工具：' + name);
  return await p.run(args || {}, ctxFor());
}

function setEnabled(file, enabled) {
  const states = readStates();
  states[file] = { enabled: !!enabled };
  writeStates(states);
  load();
  return list();
}

function remove(file) {
  const full = path.join(dir(), path.basename(file));
  try { fs.unlinkSync(full); } catch (e) { throw new Error('删除失败：' + e.message); }
  const states = readStates();
  delete states[file];
  writeStates(states);
  load();
  return list();
}

module.exports = { load, list, defs, has, execute, setEnabled, remove, dir };
