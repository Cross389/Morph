/* Morph 界面桥接层 —— 由主进程在加载 ui/*.html 时自动注入，任何界面都能直接用 window.morph */
(function () {
  if (window.morph) return;

  var pending = new Map();
  var listeners = new Map();
  var seq = 0;
  var overlayShownAt = 0;

  function post(type, data) {
    try { parent.postMessage(Object.assign({ __morph: type }, data), '*'); } catch (e) { /* ignore */ }
  }

  function call(method, args, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      var ms = (timeoutMs === undefined) ? 180000 : timeoutMs;
      var timer = ms > 0 ? setTimeout(function () {
        if (pending.has(id)) { pending.delete(id); reject(new Error('调用超时：' + method)); }
      }, ms) : null;
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      post('req', { id: id, method: method, args: args || {} });
    });
  }

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || typeof d !== 'object') return;
    if (d.__morph === 'res') {
      var p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      clearTimeout(p.timer);
      if (d.ok) p.resolve(d.data);
      else if (d.data && typeof d.data === 'object') p.resolve(d.data); // 失败也把 {ok:false,error} 交给界面，让界面自己提示，而不是变成全局报错浮条
      else { var err = new Error(d.error || '调用失败'); err.morphError = true; p.reject(err); }
    } else if (d.__morph === 'event') {
      var arr = listeners.get(d.name);
      if (!arr) return;
      for (var i = 0; i < arr.length; i++) {
        try { arr[i](d.payload); } catch (e) { console.error('[morph] 事件处理出错', d.name, e); }
      }
    }
  });

  function on(name, fn) {
    var arr = listeners.get(name) || [];
    arr.push(fn);
    listeners.set(name, arr);
    return function () { off(name, fn); };
  }
  function off(name, fn) {
    var arr = listeners.get(name) || [];
    var i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }

  function rid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function runStream(method, opts) {
    var requestId = opts.requestId || rid();
    var offs = [];
    if (opts.onDelta) offs.push(on('ai:delta', function (d) { if (d.requestId === requestId) opts.onDelta(d.text, d); }));
    if (opts.onReasoning) offs.push(on('ai:reasoning', function (d) { if (d.requestId === requestId) opts.onReasoning(d.text, d); }));
    if (opts.onTool) offs.push(on('ai:tool', function (d) { if (d.requestId === requestId) opts.onTool(d, d); }));

    if (opts.signal && opts.signal.addEventListener) {
      opts.signal.addEventListener('abort', function () { call('ai.abort', { requestId: requestId }).catch(function () {}); });
    }

    var promise = call(method, {
      messages: opts.messages,
      system: opts.system,
      mode: opts.mode,
      requestId: requestId,
    }, 0).then(function (r) {
      if (r && r.ok === false) throw new Error(r.error || '调用失败');
      return r;
    }).finally(function () { offs.forEach(function (f) { f(); }); });

    promise.requestId = requestId;
    return promise;
  }

  // ---- 出错时的兜底浮层：界面脚本炸了也能把助手叫出来 --------------------
  function showOverlay(message) {
    var now = Date.now();
    if (now - overlayShownAt < 2500) return;
    overlayShownAt = now;
    post('error', { message: String(message || '未知错误').slice(0, 500) });

    var el = document.getElementById('__morph_error__');
    if (!el) {
      el = document.createElement('div');
      el.id = '__morph_error__';
      el.setAttribute('style', [
        'position:fixed', 'z-index:2147483647', 'left:16px', 'bottom:16px',
        'width:max-content', 'max-width:min(680px, calc(100vw - 32px))',
        'display:flex', 'gap:10px', 'align-items:center',
        'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
        'color:#fde8e8', 'background:rgba(52,16,20,.96)', 'border:1px solid rgba(255,99,99,.45)',
        'border-radius:14px', 'padding:11px 12px 11px 14px', 'backdrop-filter:blur(12px)',
        'box-shadow:0 12px 40px rgba(0,0,0,.55)',
      ].join(';'));
      document.documentElement.appendChild(el);
    }
    el.innerHTML = '';
    var txt = document.createElement('div');
    txt.style.flex = '1';
    txt.style.minWidth = '0';
    txt.style.overflow = 'hidden';
    txt.textContent = '界面脚本出错：' + String(message || '').slice(0, 120);
    var ver = document.createElement('button');
    ver.textContent = '版本管理';
    ver.setAttribute('style', 'flex:none;border:1px solid rgba(255,255,255,.22);border-radius:9px;padding:7px 11px;cursor:pointer;background:rgba(255,255,255,.06);color:#ffe4e4;font:600 12px/1 inherit');
    ver.onclick = function () { post('openVersions', {}); };
    var btn = document.createElement('button');
    btn.textContent = '重新加载';
    btn.setAttribute('style', 'flex:none;border:0;border-radius:9px;padding:7px 12px;cursor:pointer;background:#ff5a5f;color:#fff;font:600 12px/1 inherit');
    btn.onclick = function () { location.reload(); };
    var close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('style', 'flex:none;border:0;background:transparent;color:#f8b4b4;font-size:18px;cursor:pointer;padding:0 4px');
    close.onclick = function () { el.remove(); };
    el.appendChild(txt);
    el.appendChild(ver);
    el.appendChild(btn);
    el.appendChild(close);
  }

  window.addEventListener('error', function (e) { showOverlay(e.message || (e.error && e.error.message)); });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    showOverlay((r && (r.message || r.toString())) || 'Promise 未捕获错误');
  });
  // 来自外部（外壳）的错误通知
  on('ui:error', function (d) { showOverlay(d && d.message); });

  var morph = {
    version: '1.0',
    call: call,
    on: on,
    off: off,

    app: {
      info: function () { return call('app.info'); },
      openExternal: function (url) { return call('app.openExternal', { url: url }); },
    },

    settings: {
      get: function () { return call('settings.get'); },
      save: function (patch) { return call('settings.set', { patch: patch }); },
      test: function (patch) { return call('settings.test', { patch: patch }); },
      models: function (p) { return call('settings.models', p || {}); },
      activate: function (o) { return call('settings.activate', o || {}); },
      saveAll: function (connections) { return call('settings.saveAll', { connections: connections || [] }); },
      remove: function (id) { return call('settings.remove', { id: id }); },
    },

    ai: {
      chat: function (o) { return runStream('ai.run', Object.assign({ mode: 'chat' }, o)); },
      agent: function (o) { return runStream('ai.run', Object.assign({ mode: 'agent' }, o)); },
      abort: function (requestId) { return call('ai.abort', { requestId: requestId }); },
      lastReply: function () { return call('ai.lastReply').then(function (r) { return r && r.reply; }); },
    },

    kv: {
      get: function (key, dflt) {
        return call('kv.get', { key: key }).then(function (r) {
          var v = r ? r.value : null;
          return v === null || v === undefined ? dflt : v;
        });
      },
      set: function (key, value) { return call('kv.set', { key: key, value: value }); },
      all: function () { return call('kv.all').then(function (r) { return (r && r.value) || {}; }); },
      del: function (key) { return call('kv.del', { key: key }); },
    },

    files: {
      list: function (p) { return call('files.list', { path: p || '.' }); },
      read: function (p) { return call('files.read', { path: p }).then(function (r) { return r && r.content; }); },
      write: function (p, c) { return call('files.write', { path: p, content: c }); },
    },

    snapshots: {
      list: function () { return call('snapshots.list').then(function (r) { return (r && r.snapshots) || []; }); },
      create: function (label) { return call('snapshots.create', { label: label }); },
      rename: function (id, label) { return call('snapshots.rename', { id: id, label: label }); },
      remove: function (id) { return call('snapshots.remove', { id: id }); },
      restore: function (id) { return call('snapshots.restore', { id: id }); },
    },

    plugins: {
      list: function () { return call('plugins.list').then(function (r) { return (r && r.plugins) || []; }); },
      setEnabled: function (file, enabled) { return call('plugins.setEnabled', { file: file, enabled: enabled }); },
      remove: function (file) { return call('plugins.remove', { file: file }); },
      reload: function () { return call('plugins.reload'); },
    },

    ui: {
      reload: function () { return call('ui.reload'); },
      reset: function () { return call('ui.reset'); },
    },

    notify: function (message, type) { return call('notify', { message: message, type: type || 'info' }); },
  };

  Object.defineProperty(window, 'morph', { value: morph, writable: false, configurable: false });

  // 告诉外壳：界面已经活了
  function hello() { setTimeout(function () { post('hello', { href: location.href }); }, 0); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hello);
  else hello();
})();
