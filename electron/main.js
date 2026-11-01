'use strict';
const { app, BrowserWindow, protocol, ipcMain, shell: electronShell, Menu, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// 固定的数据目录：%APPDATA%\Morph
// ---------------------------------------------------------------------------
app.setPath('userData', path.join(app.getPath('appData'), 'Morph'));

const SELFTEST = process.argv.includes('--selftest');
if (SELFTEST) {
  // 自测使用独立的临时数据目录，绝不碰用户真实数据
  app.setPath('userData', path.join(app.getPath('temp'), 'morph-selftest'));
}
// 可选：--user-data=D:\某个目录  指定独立数据目录（便携/多套配置）
const USER_DATA_ARG = process.argv.find((a) => a.startsWith('--user-data='));
if (USER_DATA_ARG) {
  app.setPath('userData', path.resolve(USER_DATA_ARG.split('=').slice(1).join('=')));
}

const { PATHS, ensureDirs } = require('./core/paths');
const fsx = require('./core/fsx');
const settings = require('./core/settings');
const snapshots = require('./core/snapshots');
const ai = require('./core/ai');
const agent = require('./core/agent');
const { seed, captureMasterFromCurrent } = require('./core/seed');
const plugins = require('./core/plugins');

const SAFE_MODE = process.argv.includes('--safe-mode');
const SHOT_ARG = process.argv.find((a) => a.startsWith('--screenshot'));
const DEV = process.argv.includes('--dev');

let mainWindow = null;
const runtimes = new Map(); // requestId -> AbortController

// ---------------------------------------------------------------------------
// 自定义协议 morph://shell/... 与 morph://ui/...
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([{
  scheme: 'morph',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function injectBridge(html) {
  const tag = '<script src="/__morph.js"></script>';
  if (html.includes('__morph.js')) return html;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}\n</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (m) => `${m}\n${tag}`);
  return tag + html;
}

function registerProtocol() {
  protocol.handle('morph', async (request) => {
    try {
      const url = new URL(request.url);
      const host = url.hostname;
      let p = decodeURIComponent(url.pathname);
      if (!p || p === '/') p = '/index.html';

      if (host === 'ui' && p === '/__morph.js') {
        const js = await fsp.readFile(PATHS.bridgeScript, 'utf8');
        return new Response(js, { headers: { 'content-type': MIME['.js'], 'cache-control': 'no-store' } });
      }

      const base = host === 'shell' ? PATHS.renderer
        : host === 'ui' ? PATHS.ui
          : host === 'user-shell' ? (SAFE_MODE ? null : PATHS.shell)
            : null;
      if (!base) return new Response('unknown host', { status: 404 });

      const absBase = path.resolve(base);
      const file = path.resolve(absBase, '.' + p);
      if (file !== absBase && !file.startsWith(absBase + path.sep)) {
        return new Response('forbidden', { status: 403 });
      }
      const ext = path.extname(file).toLowerCase();
      const headers = { 'cache-control': 'no-store', 'content-type': MIME[ext] || 'application/octet-stream' };

      if (ext === '.html') {
        const html = await fsp.readFile(file, 'utf8');
        return new Response(host === 'ui' ? injectBridge(html) : html, { headers });
      }
      const buf = await fsp.readFile(file);
      return new Response(buf, { headers });
    } catch (e) {
      return new Response(`/* 加载失败：${e.message} */`, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  });
}

// ---------------------------------------------------------------------------
// 事件推送
// ---------------------------------------------------------------------------
function emitEvent(name, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('morph:event', { name, payload });
  }
}

// ---------------------------------------------------------------------------
// 键值存储
// ---------------------------------------------------------------------------
function kvAll() {
  try { return JSON.parse(fs.readFileSync(path.join(PATHS.data, 'kv.json'), 'utf8')); } catch { return {}; }
}
function kvSet(key, value) {
  const all = kvAll();
  const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (size > 4 * 1024 * 1024) throw new Error('单个值太大（>4MB），请改用文件');
  all[key] = value;
  fs.mkdirSync(PATHS.data, { recursive: true });
  fs.writeFileSync(path.join(PATHS.data, 'kv.json'), JSON.stringify(all, null, 2), 'utf8');
  return { ok: true, bytes: size };
}

function lastReplyPath() { return path.join(PATHS.data, 'last-reply.json'); }
function saveLastReply(channel, data) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(lastReplyPath(), 'utf8')); } catch { all = {}; }
  all[channel] = { ...data, ts: Date.now() };
  fs.mkdirSync(PATHS.data, { recursive: true });
  fs.writeFileSync(lastReplyPath(), JSON.stringify(all, null, 2), 'utf8');
}
function readLastReply(channel) {
  try { return JSON.parse(fs.readFileSync(lastReplyPath(), 'utf8'))[channel] || null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// AI 调度
// ---------------------------------------------------------------------------
async function runAi(args, channel) {
  const cfg = settings.aiConfig();
  if (!cfg.apiKey) {
    return { ok: false, error: '还没有配置 API Key。点右上角 ⚙ 设置，把 API Key 填进去就能用了。' };
  }
  if (!cfg.baseUrl || !cfg.model) {
    return { ok: false, error: '接口地址或模型名为空，请在设置里补全。' };
  }

  const rid = args.requestId || crypto.randomUUID();
  const mode = args.mode === 'chat' ? 'chat' : 'agent';
  const controller = new AbortController();
  runtimes.set(rid, controller);

  const emit = (name, payload) => emitEvent(name, { requestId: rid, channel, ...payload });



  // 改动期间不立刻重载：等这一轮回答输出完再刷新，避免把回复弄丢
  let pendingReload = false;
  let uiChanged = false;
  const recordWrite = (p) => { if (/^(ui|shell)\//.test(String(p || ''))) uiChanged = true; };
  const reloadUi = async () => {
    pendingReload = true;
    return '界面会在本轮回答结束后自动重载';
  };

  const messages = Array.isArray(args.messages) ? args.messages : [];
  const system = args.system || agent.buildSystemPrompt({ mode });

  try {
    if (mode === 'agent') {
      const result = await agent.run({
        cfg, messages, system, channel, emit, reloadUi, recordWrite, signal: controller.signal,
      });
      if (result.text) saveLastReply(channel, { text: result.text, tools: (result.tools || []).slice(-8) });
      emit('ai:done', { text: result.text, tools: result.tools, usage: result.usage });
      if (pendingReload || uiChanged) setTimeout(() => emitEvent('ui:reload', { reason: 'ai' }), 700);
      return { ok: true, requestId: rid, text: result.text, tools: result.tools, usage: result.usage };
    }

    const res = await ai.streamChat({
      cfg, messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
      onDelta: (t) => emit('ai:delta', { text: t }),
      onReasoning: (t) => emit('ai:reasoning', { text: t }),
      signal: controller.signal,
    });
    if (res.content) saveLastReply(channel, { text: res.content, tools: [] });
    emit('ai:done', { text: res.content, usage: res.usage });
    return { ok: true, requestId: rid, text: res.content, usage: res.usage };
  } catch (e) {
    if (e.name === 'AbortError') {
      emit('ai:error', { message: '已停止生成', aborted: true });
      return { ok: false, error: '已停止生成', aborted: true };
    }
    emit('ai:error', { message: e.message });
    return { ok: false, error: e.message };
  } finally {
    runtimes.delete(rid);
  }
}

// ---------------------------------------------------------------------------
// 统一调用分发
// ---------------------------------------------------------------------------
async function dispatch(method, args, channel) {
  const isShell = channel === 'shell';
  switch (method) {
    case 'app.info':
      return {
        ok: true,
        version: app.getVersion(),
        api: 2,
        userDir: PATHS.root,
        platform: process.platform,
        safeMode: SAFE_MODE,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      };
    case 'settings.models': {
      const baseUrl = String(args.baseUrl || settings.aiConfig().baseUrl || '').trim();
      const typed = typeof args.apiKey === 'string' && args.apiKey.trim() ? args.apiKey.trim() : '';
      const stored = args.id ? settings.keyOf(args.id) : settings.aiConfig().apiKey;
      const apiKey = typed || stored;
      try {
        return { ok: true, models: await ai.listModels({ baseUrl, apiKey }) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    case 'settings.activate':
      return { ok: true, settings: settings.activate(args) };
    case 'settings.saveAll':
      return { ok: true, settings: settings.saveAll(Array.isArray(args.connections) ? args.connections : []) };
    case 'settings.remove':
      return { ok: true, settings: settings.remove(args.id) };
    case 'app.openExternal':
      if (typeof args.url === 'string' && /^https?:\/\//i.test(args.url)) await electronShell.openExternal(args.url);
      return { ok: true };

    case 'settings.get':
      return { ok: true, settings: settings.get() };
    case 'settings.set': {
      const s = settings.set(args.patch || {});
      fsx.setFullAccess(settings.isFull());
      emitEvent('settings:changed', s);
      return { ok: true, settings: s };
    }
    case 'plugins.reload': {
      try { return { ok: true, ...plugins.load() }; } catch (e) { return { ok: false, error: e.message }; }
    }
    case 'plugins.list':
      return { ok: true, plugins: plugins.list() };
    case 'plugins.setEnabled': {
      try { return { ok: true, plugins: plugins.setEnabled(args.file, args.enabled) }; } catch (e) { return { ok: false, error: e.message }; }
    }
    case 'plugins.remove': {
      try { return { ok: true, plugins: plugins.remove(args.file) }; } catch (e) { return { ok: false, error: e.message }; }
    }
    case 'settings.test': {
      const patch = args.patch || {};
      const base = settings.aiConfig();
      const cfg = { ...base, ...patch };
      if (!patch.apiKey) {
        cfg.apiKey = (args.id && settings.keyOf(args.id)) || base.apiKey;
      }
      try { return { ok: true, result: await ai.test({ cfg }) }; } catch (e) { return { ok: false, error: e.message }; }
    }

    case 'ai.run': return await runAi(args, channel);
    case 'ai.abort': {
      const c = runtimes.get(args.requestId);
      if (c) c.abort();
      return { ok: true, aborted: !!c };
    }
    case 'ai.lastReply': return { ok: true, reply: readLastReply(channel) };

    case 'kv.get': return { ok: true, value: kvAll()[args.key] ?? null };
    case 'kv.all': return { ok: true, value: kvAll() };
    case 'kv.set': return kvSet(args.key, args.value ?? null);
    case 'kv.del': {
      const all = kvAll();
      delete all[args.key];
      fs.writeFileSync(path.join(PATHS.data, 'kv.json'), JSON.stringify(all, null, 2), 'utf8');
      return { ok: true };
    }

    case 'files.list': return { ok: true, items: await fsx.list(args.path || '.', Number(args.depth ?? 2)) };
    case 'files.read': return { ok: true, content: await fsx.read(args.path) };
    case 'files.write': return { ok: true, ...(await fsx.write(args.path, args.content ?? '')) };

    case 'snapshots.list': return { ok: true, snapshots: snapshots.list() };
    case 'snapshots.create': return { ok: true, meta: await snapshots.create({ label: args.label || '', channel }) };
    case 'snapshots.rename': return { ok: true, meta: await snapshots.rename(args.id, args.label) };
    case 'snapshots.remove': return { ok: true, ...(await snapshots.remove(args.id)) };
    case 'snapshots.restore': {
      const r = await snapshots.restore(args.id);
      setTimeout(() => emitEvent('ui:reload', { reason: 'restore' }), 150);
      return { ok: true, ...r };
    }
    case 'master.setFromCurrent': {
      if (!isShell) return { ok: false, error: '只有外壳面板可以修改出厂基线' };
      await captureMasterFromCurrent();
      return { ok: true };
    }
    case 'ui.reload': {
      setTimeout(() => emitEvent('ui:reload', { reason: 'manual' }), 60);
      return { ok: true };
    }
    case 'ui.reset': {
      if (!isShell) return { ok: false, error: '只有外壳可以恢复默认界面' };
      await seed({ resetUi: true });
      setTimeout(() => emitEvent('ui:reload', { reason: 'reset' }), 150);
      return { ok: true };
    }
    case 'ui.safeMode': {
      if (!isShell) return { ok: false, error: '只有外壳可以进入安全模式' };
      await seed({ resetUi: true });
      setTimeout(() => emitEvent('ui:reload', { reason: 'safe' }), 150);
      return { ok: true };
    }

    case 'notify':
      emitEvent('notify', { message: args.message, type: args.type || 'info' });
      return { ok: true };

    case 'win.minimize': if (isShell) mainWindow.minimize(); return { ok: true };
    case 'win.maximize': if (isShell) mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); return { ok: true };
    case 'win.close': if (isShell) mainWindow.close(); return { ok: true };
    case 'win.devtools': if (isShell) mainWindow.webContents.toggleDevTools(); return { ok: true };
    case 'win.openDir':
      if (isShell) await electronShell.openPath(PATHS.root);
      return { ok: true };
    case 'win.status': {
      const [w, h] = mainWindow.getSize();
      return { ok: true, maximized: mainWindow.isMaximized(), width: w, height: h, focused: mainWindow.isFocused() };
    }

    default:
      return { ok: false, error: '未知方法：' + method };
  }
}

ipcMain.handle('morph:call', async (_event, payload) => {
  const { method, args, channel } = payload || {};
  try {
    return await dispatch(method, args || {}, channel === 'ui' ? 'ui' : 'shell');
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1340,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: '#0a0c11',
    title: 'Morph',
    icon: path.join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-shell.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webviewTag: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadURL('morph://shell/shell.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
    if (process.argv.includes('--open-panel')) setTimeout(() => emitEvent('ui:openVersions', {}), 1600);
    if (process.argv.includes('--open-versions')) setTimeout(() => emitEvent('ui:openVersions', {}), 1600);
  });

  if (SELFTEST) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        require('./dev/selftest')
          .run({ app, win: mainWindow, settings, snapshots, PATHS, shotPath: path.join(process.cwd(), 'shots', 'selftest-chat.png') })
          .catch((e) => { console.error('[selftest] crash', e); app.exit(1); });
      }, 900);
    });
  }

  // 快捷键：Ctrl+Shift+M 打开版本管理；F12 开发者工具；Ctrl+R 重载界面
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (ctrl && input.shift && input.key.toLowerCase() === 'm') {
      event.preventDefault();
      emitEvent('ui:openVersions', {});
    } else if (ctrl && input.key.toLowerCase() === 'r') {
      event.preventDefault();
      emitEvent('ui:reload', { reason: 'keyboard' });
    } else if (input.key === 'F12') {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.on('maximize', () => emitEvent('win:state', { maximized: true }));
  mainWindow.on('unmaximize', () => emitEvent('win:state', { maximized: false }));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    ensureDirs();
    try {
      fsx.setFullAccess(settings.isFull());
      plugins.load();
    } catch { /* ignore */ }

    await seed({ resetUi: SAFE_MODE });
    registerProtocol();
    createWindow();

    if (SHOT_ARG) {
      const out = SHOT_ARG.includes('=') ? SHOT_ARG.split('=')[1] : path.join(process.cwd(), 'screenshot.png');
      const delay = Number(process.env.MORPH_SHOT_DELAY || 4200);
      setTimeout(async () => {
        try {
          const shellJs = process.env.MORPH_SHOT_SHELL_JS;
          if (shellJs) {
            await mainWindow.webContents.executeJavaScript(shellJs).catch((e) => console.error('SHELLJS_FAIL:' + e.message));
            await new Promise((r) => setTimeout(r, 700));
          }
          const uiJs = process.env.MORPH_SHOT_UI_JS;
          if (uiJs) {
            const fr = mainWindow.webContents.mainFrame.frames.find((f) => String(f.url).startsWith('morph://ui'));
            if (fr) await fr.executeJavaScript(uiJs).catch((e) => console.error('UIJS_FAIL:' + e.message));
            await new Promise((r) => setTimeout(r, 800));
          }
          const img = await mainWindow.webContents.capturePage();
          fs.writeFileSync(out, img.toPNG());
          console.log('SCREENSHOT_OK:' + out);
        } catch (e) {
          console.error('SCREENSHOT_FAIL:' + e.message);
        } finally {
          app.exit(0);
        }
      }, delay);
    }
  });

  app.on('window-all-closed', () => app.quit());
}
