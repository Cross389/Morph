'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const frame = $('#frame');
const toastsEl = $('#toasts');
const shell = window.morphShell;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(message, type = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' err' : type === 'ok' ? ' ok' : '');
  el.textContent = message;
  toastsEl.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

function postToFrame(name, payload) {
  try { frame.contentWindow.postMessage({ __morph: 'event', name, payload: payload || {} }, '*'); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 标题栏
// ---------------------------------------------------------------------------
const btnMax = $('#btnMax');

$('#btnMin').onclick = () => shell.call('win.minimize', {}, 'shell');
btnMax.onclick = () => shell.call('win.maximize', {}, 'shell');
$('#btnClose').onclick = () => shell.call('win.close', {}, 'shell');
$('#btnReload').onclick = () => reloadFrame();

// 💾 保存当前版本
$('#tbSave').onclick = async () => {
  const r = await shell.call('snapshots.create', {}, 'shell');
  if (r && r.ok === false) return toast(r.error || '保存失败', 'error');
  toast('已保存：' + ((r.meta && r.meta.label) || ''), 'ok');
  if (!versionsModal.hasAttribute('hidden')) refreshHistory();
};

// 🕘 版本管理
$('#tbVersions').onclick = () => toggleVersions();

// ⚙ 设置（设置界面在 App 内部，跨帧触发）
$('#tbSettings').onclick = () => postToFrame('ui:openSettings', {});
$('#tbPlugins').onclick = () => postToFrame('ui:openPlugins', {});

function refreshMaxIcon() {
  shell.call('win.status', {}, 'shell').then((r) => {
    const max = r && r.maximized;
    btnMax.innerHTML = max
      ? '<svg viewBox="0 0 12 12" width="11" height="11" fill="none"><rect x="2.3" y="3.6" width="6.1" height="6.1" rx="1.1" stroke="currentColor" stroke-width="1.2"/><path d="M4.1 3.6V2.6a.9.9 0 0 1 .9-.9h4a.9.9 0 0 1 .9.9v4a.9.9 0 0 1-.9.9h-1" stroke="currentColor" stroke-width="1.2"/></svg>'
      : '<svg viewBox="0 0 12 12" width="11" height="11" fill="none"><rect x="2.6" y="2.6" width="6.8" height="6.8" rx="1.2" stroke="currentColor" stroke-width="1.2"/></svg>';
  });
}
refreshMaxIcon();

function updateModelChip(s) {
  const tb = $('#tbModel');
  if (!tb || !s) return;
  const conns = Array.isArray(s.connections) ? s.connections : [];
  const active = conns.find((c) => c.id === s.activeId) || conns[0] || null;

  if (!active) {
    tb.textContent = '未配置';
    tb.classList.add('warn');
    tb.title = '还没有配置接口，点 ⚙ 设置';
    return;
  }

  const ready = !!(active.hasKey && active.model);
  tb.textContent = active.name || '未命名接口';
  tb.classList.toggle('warn', !ready);
  tb.title = ready ? `${active.name} · ${active.model}` : '这个接口还没配完（缺 Key 或模型）';
}

// ---------------------------------------------------------------------------
// 界面 iframe 生命周期
// ---------------------------------------------------------------------------
let alive = false;
let aliveTimer = null;

function reloadFrame() {
  alive = false;
  showCrash(false);
  try { frame.src = 'morph://ui/index.html?t=' + Date.now(); } catch (e) { /* ignore */ }
  clearTimeout(aliveTimer);
  aliveTimer = setTimeout(() => { if (!alive) showCrash(true); }, 4000);
}

function onFrameAlive() {
  alive = true;
  clearTimeout(aliveTimer);
  showCrash(false);
}

function showCrash(on) {
  const el = $('#crash');
  if (on) el.removeAttribute('hidden'); else el.setAttribute('hidden', '');
}

document.querySelectorAll('.crash-actions .btn').forEach((btn) => {
  btn.onclick = async () => {
    const act = btn.dataset.act;
    if (act === 'versions') openVersions();
    else if (act === 'reload') reloadFrame();
    else if (act === 'factory') restoreFactory();
  };
});

// ---------------------------------------------------------------------------
// 消息中继：iframe <-> 主进程
// ---------------------------------------------------------------------------
window.addEventListener('message', async (ev) => {
  if (ev.source !== frame.contentWindow) return;
  const d = ev.data;
  if (!d || typeof d !== 'object') return;
  if (d.__morph === 'hello') return onFrameAlive();
  if (d.__morph === 'error') { console.warn('[morph] 界面脚本出错：', d.message); return; }
  if (d.__morph === 'openVersions') return openVersions();
  if (d.__morph !== 'req') return;

  let res;
  try {
    res = await shell.call(d.method, d.args || {}, 'ui');
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  const ok = !(res && res.ok === false);
  try {
    frame.contentWindow.postMessage({ __morph: 'res', id: d.id, ok, data: res, error: res && res.error }, '*');
  } catch (e) { /* ignore */ }
});

// ---------------------------------------------------------------------------
// 主进程事件
// ---------------------------------------------------------------------------
shell.onEvent(({ name, payload }) => {
  if (name === 'ui:reload') return reloadFrame();
  if (name === 'ui:openVersions') return openVersions();
  if (name === 'notify') return toast(payload.message, payload.type);
  if (name === 'win:state') return refreshMaxIcon();
  if (name === 'settings:changed') return updateModelChip(payload);

  // 其余事件透传给界面（AI 流、工具调用等）
  try { frame.contentWindow.postMessage({ __morph: 'event', name, payload }, '*'); } catch (e) { /* ignore */ }
});

// ---------------------------------------------------------------------------
// 版本管理弹窗
// ---------------------------------------------------------------------------
const versionsModal = $('#versionsModal');

function toggleVersions() {
  if (versionsModal.hasAttribute('hidden')) openVersions(); else closeVersions();
}

function openVersions() {
  versionsModal.removeAttribute('hidden');
  refreshHistory();
}

function closeVersions() {
  versionsModal.setAttribute('hidden', '');
}

$('#btnCloseVersions').onclick = closeVersions;
versionsModal.addEventListener('mousedown', (e) => { if (e.target === versionsModal) closeVersions(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !versionsModal.hasAttribute('hidden')) closeVersions(); });

function beginRename(item, id, lab) {
  if (item.querySelector('.rename-input')) return;
  const oldLabel = lab.textContent;
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = oldLabel;
  lab.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== oldLabel) {
      const r = await shell.call('snapshots.rename', { id, label: v }, 'shell');
      if (r && r.ok === false) toast(r.error || '改名失败', 'error');
      else toast('已改名', 'ok', 1500);
    }
    refreshHistory();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

async function refreshHistory() {
  const r = await shell.call('snapshots.list', {}, 'shell');
  const list = (r && r.snapshots) || [];
  const el = $('#histList');
  if (!list.length) {
    el.innerHTML = '<div class="empty">还没有保存过版本。<br>弄到自己满意时，点右下角「保存当前版本」。</div>';
    return;
  }
  el.innerHTML = list.map((s) => `
    <div class="hist-item" data-id="${escapeHtml(s.id)}">
      <div class="meta">
        <div class="lab" data-label title="点一下可以改名">${escapeHtml(s.label || '未命名版本')}</div>
        <div class="ts">${new Date(s.ts).toLocaleString('zh-CN')}</div>
      </div>
      <button class="mini" data-restore title="恢复到这个版本">恢复</button>
      <button class="mini danger" data-del title="删除这个版本">删</button>
    </div>`).join('');

  el.querySelectorAll('.hist-item').forEach((item) => {
    const id = item.dataset.id;
    item.querySelector('[data-restore]').onclick = async () => {
      if (!confirm('恢复到这个版本？当前界面会被直接替换，不会自动备份。')) return;
      const res = await shell.call('snapshots.restore', { id }, 'shell');
      if (res && res.ok === false) return toast(res.error || '恢复失败', 'error');
      toast('已恢复，界面即将刷新', 'ok');
      closeVersions();
    };
    item.querySelector('[data-del]').onclick = async () => {
      if (!confirm('删除这个版本？删掉就找不回来了。')) return;
      const res = await shell.call('snapshots.remove', { id }, 'shell');
      if (res && res.ok === false) return toast(res.error || '删除失败', 'error');
      toast('已删除', 'ok');
      refreshHistory();
    };
    const lab = item.querySelector('[data-label]');
    lab.onclick = () => beginRename(item, id, lab);
  });
}

$('#btnSaveVer').onclick = async () => {
  const r = await shell.call('snapshots.create', {}, 'shell');
  if (r && r.ok === false) return toast(r.error || '保存失败', 'error');
  toast('已保存：' + ((r.meta && r.meta.label) || ''), 'ok');
  refreshHistory();
};

$('#btnFactory').onclick = () => restoreFactory();

async function restoreFactory() {
  if (!confirm('恢复到「出厂基线」？当前界面会被直接覆盖，不会自动备份。')) return;
  const res = await shell.call('ui.reset', {}, 'shell');
  if (res && res.ok === false) return toast(res.error || '恢复失败', 'error');
  toast('已恢复出厂界面', 'ok');
  closeVersions();
}

$('#btnLock').onclick = async () => {
  if (!confirm('把当前界面锁定为新的「出厂基线」？\n\n之后每次「恢复出厂」都会回到现在的样子，而且 AI 永远改不动这份基线。')) return;
  const res = await shell.call('master.setFromCurrent', {}, 'shell');
  if (res && res.ok === false) return toast(res.error || '设置失败', 'error');
  toast('已锁定为出厂基线', 'ok');
};

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
(async function boot() {
  try {
    const info = await shell.call('app.info', {}, 'shell');
    if (info && info.safeMode) {
      const left = document.querySelector('.tb-left');
      if (left && !document.querySelector('.badge')) {
        const b = document.createElement('span');
        b.className = 'badge safe';
        b.textContent = '安全模式';
        left.appendChild(b);
      }
    }
    const s = await shell.call('settings.get', {}, 'shell');
    if (s && s.settings) updateModelChip(s.settings);
  } catch (e) { /* ignore */ }

  setTimeout(() => { if (!alive) showCrash(true); }, 4000);
})();
