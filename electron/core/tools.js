'use strict';
const path = require('node:path');
const fsp = require('node:fs/promises');
const fsx = require('./fsx');
const exec = require('./exec');
const plugins = require('./plugins');
const settings = require('./settings');
const snapshots = require('./snapshots');

function j(v) { return JSON.stringify(v); }

const SKIP_DIRS = new Set([
  'node_modules', '.git',
  'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'blob_storage', 'Local Storage', 'Session Storage', 'Network', 'Dictionaries',
  'Shared Dictionary', 'SharedStorage', 'Crashpad',
]);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|woff2?|ttf|otf|exe|dll|asar|zip|7z|rar|gz|tar|mp3|wav|mp4|mov|webm|pdf|gguf|bin|dat|db|sqlite)$/i;

/** 把 glob 转成正则；不含 / 的模式按文件名匹配，含 / 的按相对路径匹配 */
function globToRegExp(glob) {
  const g = String(glob || '*').replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i += 1; if (g[i + 1] === '/') i += 1; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.indexOf(c) >= 0) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$', 'i');
}

/** 在数据目录里递归遍历；遇到受保护目录/跳过目录时自动绕开。visit 返回 true 表示提前结束 */
async function walkFiles(relPath, visit, maxEntries = 20000) {
  const baseRel = String(relPath || '.').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  const startAbs = fsx.toAbs(relPath || '.');
  let count = 0;
  async function rec(abs, rel) {
    if (count >= maxEntries) return true;
    let entries;
    try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (count >= maxEntries) return true;
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        try { fsx.toAbs(childRel); } catch { continue; }
        if (await rec(childAbs, childRel)) return true;
      } else if (e.isFile()) {
        try { fsx.toAbs(childRel); } catch { continue; } // settings.json / snapshots / master 依然对工具不可见
        count += 1;
        if (await visit(childRel, childAbs, e.name)) return true;
      }
    }
    return false;
  }
  await rec(startAbs, baseRel === '.' ? '' : baseRel);
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出程序数据目录中的文件树。path 相对 user 根目录（例如 "."、"ui"），depth 默认 2。动手改之前先用它看清楚有什么。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径，默认 "."' },
          depth: { type: 'number', description: '递归深度，默认 2，最大 4' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取一个文本文件。默认读全文（超过 120000 字符会截断）；大文件可以用 offset/limit 按行读，返回内容带行号。修改前必须先读，不要凭记忆猜文件内容。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径，例如 ui/app.js' },
          offset: { type: 'number', description: '起始行号，从 1 开始；省略表示从头读' },
          limit: { type: 'number', description: '最多读多少行；省略表示读到结尾' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: '按 glob 查找文件，例如 "**/*.js"、"ui/*.css"、"*.json"；不含 / 的模式按文件名匹配。比 list_files 更适合在大目录里定位文件。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob 模式，例如 **/*.css' },
          path: { type: 'string', description: '在哪个目录下找，默认 "."' },
          maxResults: { type: 'number', description: '最多返回多少条，默认 200' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: '在文本文件里按正则搜索内容，返回命中的文件、行号和该行文本。查函数名、DOM id、报错信息时用它，不要逐个 read_file。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式，例如 "function send|morph\\.ai\\.agent"' },
          path: { type: 'string', description: '在哪个目录下搜，默认 "."' },
          glob: { type: 'string', description: '只搜匹配这个 glob 的文件，例如 "*.js"' },
          caseSensitive: { type: 'boolean', description: '是否区分大小写，默认 false' },
          maxResults: { type: 'number', description: '最多返回多少条命中，默认 50' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入（覆盖）一个文本文件，父目录会自动创建。适合新建文件或整文件重写。小改动请用 edit_file。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径，例如 ui/style.css' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_file',
      description: '在文件末尾追加内容。写长文件时用：先 write_file 写第一段，再用 append_file 逐段往后接，避免一次输出过长被截断。文件不存在时会自动创建。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径，例如 ui/app.js' },
          content: { type: 'string', description: '要追加的这段内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '把文件中的一段原文替换成新内容（精确匹配，含缩进与换行）。适合局部修改，比整文件重写更安全。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string', description: '要替换的原文本，必须与文件中完全一致' },
          new_string: { type: 'string', description: '替换后的文本' },
          replace_all: { type: 'boolean', description: '是否替换所有匹配，默认 false' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: '删除文件或目录。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reload_ui',
      description: '让界面重新加载，使 ui/ 目录下的改动立即生效。每次改完 ui 文件后必须调用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'snapshot_create',
      description: '把当前界面保存成一个版本。只有在用户明确要求「存一版 / 备份一下」时才用，程序不会自动备份。',
      parameters: { type: 'object', properties: { label: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'snapshot_list',
      description: '列出用户保存过的所有版本（名称与时间）。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'snapshot_restore',
      description: '把界面恢复到用户保存过的某个版本。',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_settings',
      description: '读取应用设置（不含 API Key 明文，只有 hasKey/keyTail）。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_settings',
      description: '修改应用设置，只接受 JSON 字符串，例如 {"temperature":0.4,"reasoning":"high"}。可改 temperature / maxTokens / reasoning(auto|off|low|medium|high) / systemPrompt / agentEnabled。接口地址、API Key、模型选择不在这里。',
      parameters: { type: 'object', properties: { patch: { type: 'string', description: 'JSON 字符串' } }, required: ['patch'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在系统上执行一条命令（Windows 用 PowerShell）。可读写任意文件、运行程序、装包。仅在「完全权限」模式下可用；执行前先确认用户确实要这么做，避免破坏性操作。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          cwd: { type: 'string', description: '工作目录，默认用户主目录' },
          timeout: { type: 'number', description: '超时毫秒，默认 120000' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plugins_reload',
      description: '重新加载 plugins/ 目录里的自定义工具。往 %APPDATA%\\Morph\\plugins\\xxx.js 写完一个插件后调用它，就能立刻使用新工具。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '抓取网页/接口内容（文本最多 60KB）。默认 GET；可以传 method/headers/body 发 POST 或带鉴权的请求，用于查资料或调 API。只支持 http/https。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整 http(s) 地址' },
          method: { type: 'string', description: 'GET / POST / PUT / DELETE 等，默认 GET' },
          headers: { type: 'object', description: '附加请求头，例如 {"Authorization":"Bearer ..."}' },
          body: { type: 'string', description: '请求体；对象会被 JSON.stringify' },
        },
        required: ['url'],
      },
    },
  },
];

async function fetchUrl(url, opts = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http/https');
  const method = String(opts.method || 'GET').toUpperCase();
  const headers = { 'User-Agent': 'Morph/0.2', ...(opts.headers && typeof opts.headers === 'object' ? opts.headers : {}) };
  let body;
  if (opts.body !== undefined && opts.body !== null && method !== 'GET' && method !== 'HEAD') {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    const contentType = res.headers.get('content-type') || '';
    const raw = await res.text();
    const text = raw.slice(0, 60000);
    let json = null;
    if (contentType.includes('json')) { try { json = JSON.parse(raw); } catch { /* ignore */ } }
    return { status: res.status, contentType, text, json };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('抓取超时（30 秒）');
    throw new Error('抓取失败：' + e.message);
  } finally { clearTimeout(timer); }
}

/**
 * 执行一个工具调用。
 * ctx: { channel, recordWrite(path), reloadUi() }
 */
async function execute(name, rawArgs, ctx) {
  let args = {};
  if (rawArgs) {
    if (typeof rawArgs === 'string') {
      try { args = JSON.parse(rawArgs); } catch { throw new Error('工具参数不是合法 JSON（最常见原因：这次输出太长被 token 上限截断）。请把内容拆小：先用 write_file 写第一段，再用 append_file 分几次追加。原文片段：' + rawArgs.slice(0, 200)); }
    } else args = rawArgs;
  }


  if (plugins.has(name)) {
    const out = await plugins.execute(name, args);
    return { ok: true, plugin: name, result: out };
  }

  switch (name) {
    case 'list_files': {
      const items = await fsx.list(args.path || '.', Math.min(4, Number(args.depth ?? 2)));
      const text = items.map((i) => (i.type === 'dir' ? i.path : `${i.path}  (${i.size}B)`)).join('\n');
      return { ok: true, count: items.length, tree: text || '(空)' };
    }
    case 'read_file': {
      const text = await fsx.read(args.path);
      const offset = Math.max(1, Number(args.offset) || 1);
      const limit = Math.max(0, Number(args.limit) || 0);
      if (offset === 1 && !limit) {
        return { ok: true, path: args.path, content: text.length > 120000 ? text.slice(0, 120000) + '\n...(已截断)' : text };
      }
      const lines = text.split(/\r?\n/);
      const from = Math.min(offset, lines.length + 1);
      const to = limit ? Math.min(lines.length, from + limit - 1) : lines.length;
      const body = lines.slice(from - 1, to).map((l, i) => `${from + i}| ${l}`).join('\n');
      return { ok: true, path: args.path, totalLines: lines.length, from, to, content: body };
    }
    case 'find_files': {
      const rx = globToRegExp(args.pattern || '*');
      const byBasename = !String(args.pattern || '').includes('/');
      const max = Math.max(1, Math.min(2000, Number(args.maxResults) || 200));
      const out = [];
      await walkFiles(args.path || '.', async (rel, abs, name) => {
        const target = byBasename ? name : rel;
        if (!rx.test(target)) return false;
        let size = 0;
        try { size = (await fsp.stat(abs)).size; } catch { return false; }
        out.push({ path: rel, size });
        return out.length >= max;
      });
      return { ok: true, count: out.length, files: out };
    }
    case 'search_files': {
      const flags = args.caseSensitive ? '' : 'i';
      let rx;
      try { rx = new RegExp(String(args.pattern || ''), flags); } catch (e) { throw new Error('正则不合法：' + e.message); }
      const globRx = args.glob ? globToRegExp(args.glob) : null;
      const globByBasename = args.glob && !String(args.glob).includes('/');
      const max = Math.max(1, Math.min(500, Number(args.maxResults) || 50));
      const out = [];
      await walkFiles(args.path || '.', async (rel, abs, name) => {
        if (globRx && !globRx.test(globByBasename ? name : rel)) return false;
        if (BINARY_EXT.test(name)) return false;
        let size = 0;
        try { size = (await fsp.stat(abs)).size; } catch { return false; }
        if (size > 1.5 * 1024 * 1024) return false;
        let text = '';
        try { text = await fsp.readFile(abs, 'utf8'); } catch { return false; }
        if (text.indexOf('\u0000') >= 0) return false;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (rx.test(lines[i])) {
            out.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 240) });
            if (out.length >= max) return true;
          }
        }
        return false;
      });
      return { ok: true, count: out.length, matches: out };
    }
    case 'write_file':
      if (ctx.recordWrite) ctx.recordWrite(args.path);
      return { ok: true, ...(await fsx.write(args.path, args.content ?? '')) };
    case 'append_file': {
      if (ctx.recordWrite) ctx.recordWrite(args.path);
      let cur = '';
      try { cur = await fsx.read(args.path); } catch { cur = ''; }
      const next = cur + (args.content ?? '');
      const r = await fsx.write(args.path, next);
      return { ok: true, ...r, mode: 'append', total: next.length };
    }
    case 'edit_file':
      if (ctx.recordWrite) ctx.recordWrite(args.path);
      return { ok: true, ...(await fsx.edit(args.path, args.old_string, args.new_string, !!args.replace_all)) };
    case 'delete_file':
      if (ctx.recordWrite) ctx.recordWrite(args.path);
      return { ok: true, ...(await fsx.remove(args.path)) };
    case 'reload_ui': {
      const r = await ctx.reloadUi();
      return { ok: true, reloaded: true, note: r };
    }
    case 'snapshot_create': {
      const meta = await snapshots.create({ label: args.label || '', channel: ctx.channel });
      return { ok: true, ...meta };
    }
    case 'snapshot_list': {
      return { ok: true, snapshots: snapshots.list().slice(0, 20) };
    }
    case 'snapshot_restore': {
      const r = await snapshots.restore(args.id);
      await ctx.reloadUi();
      return { ok: true, ...r, note: '界面已恢复并重新加载' };
    }
    case 'get_settings':
      return { ok: true, settings: settings.get() };
    case 'update_settings': {
      let patch = args.patch;
      if (typeof patch === 'string') { try { patch = JSON.parse(patch); } catch { throw new Error('patch 不是合法 JSON'); } }
      delete patch.apiKey;
      return { ok: true, settings: settings.set(patch) };
    }
    case 'run_command': {
      if (!settings.isFull()) throw new Error('「完全权限」没开启：请先在设置里打开，我才能执行系统命令');
      const r = await exec.run({ command: args.command, cwd: args.cwd, timeout: args.timeout });
      return { ok: true, ...r };
    }
    case 'plugins_reload': {
      if (!settings.isFull()) throw new Error('「完全权限」没开启：插件只能在完全权限下加载');
      const r = plugins.load();
      return { ok: true, plugins: r.loaded, errors: r.errors };
    }
    case 'fetch_url':
      return { ok: true, ...(await fetchUrl(args.url, args)) };
    default:
      throw new Error('未知工具：' + name);
  }
}

/** 当前可用的工具清单（随权限与插件动态变化） */
function list() {
  const out = TOOLS.slice();
  if (!settings.isFull()) {
    // 沙箱模式下把 run_command / plugins_reload 也藏起来
    const hidden = new Set(['run_command', 'plugins_reload']);
    return out.filter((t) => !hidden.has(t.function.name));
  }
  return out.concat(plugins.defs());
}

module.exports = { TOOLS, list, execute, plugins, toolNames: TOOLS.map((t) => t.function.name) };
