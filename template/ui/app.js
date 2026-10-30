'use strict';

/* =========================================================================
   Morph 出厂界面（多接口版）
   - 支持同时配置多个「接口 + Key」
   - 输入框上方可以快速切换模型 / 推理强度
   ========================================================================= */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const REASON_LABEL = { auto: '自动', off: '关', low: '低', medium: '中', high: '高' };

const state = {
  info: null,
  settings: null,
  messages: [],
  sessions: [],
  activeId: '',
  busy: false,
  rid: null,
};

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function md(src) {
  if (!src) return '';
  const blocks = [];
  let s = esc(src);

  s = s.replace(/```[a-zA-Z0-9+-]*\n?([\s\S]*?)```/g, (_m, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000B${blocks.length - 1}\u0000`;
  });

  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  s = s.replace(/^#{1,4}\s+(.*)$/gm, '<h3>$1</h3>');
  s = s.replace(/^(?:[-*])\s+(.*)$/gm, '<li>$1</li>');
  s = s.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');

  const restore = (str) => str.replace(/\u0000B(\d+)\u0000/g, (_m, i) => blocks[i]);

  s = s.split(/\n{2,}/).map((p) => {
    if (/^\s*<(pre|h3|li|ul|blockquote)/.test(p)) return restore(p);
    return `<p>${restore(p).replace(/\n/g, '<br>')}</p>`;
  }).join('');

  s = s.replace(/(?:<li>[\s\S]*?<\/li>\s*)+/g, (m) => `<ul>${m}</ul>`);
  return s;
}

function toast(message, type = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' err' : type === 'ok' ? ' ok' : '');
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s, transform .2s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 240);
  }, ms);
}

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

// 界面自己出错时留一点现场，方便事后查（最多 20 条，写在 kv 的 ui:errors 里）
function logClientError(kind, message) {
  try {
    morph.kv.get('ui:errors', []).then((list) => {
      const arr = Array.isArray(list) ? list : [];
      arr.push({ kind, message: String(message || '').slice(0, 400), ts: Date.now() });
      morph.kv.set('ui:errors', arr.slice(-20)).catch(() => {});
    }).catch(() => {});
  } catch (e) { /* ignore */ }
}
window.addEventListener('error', (e) => logClientError('error', e.message));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  logClientError('rejection', (r && (r.message || r.toString())) || 'unknown');
});

// ---------------------------------------------------------------------------
// 当前接口
// ---------------------------------------------------------------------------
function currentConn() {
  const s = state.settings;
  if (!s || !Array.isArray(s.connections) || !s.connections.length) return null;
  return s.connections.find((c) => c.id === s.activeId) || s.connections[0];
}

function hasUsable() {
  const c = currentConn();
  return !!(c && c.hasKey && c.model);
}

function connLabel(c) {
  if (!c) return '未配置接口';
  return c.name + (c.model ? ' · ' + c.model : '');
}

function updatePills() {
  const c = currentConn();
  const pill = $('#modelPill');
  const txt = $('#modelPillText');
  const reason = $('#reasonPillText');
  if (txt) txt.textContent = hasUsable() ? connLabel(c) : (c ? '未选模型' : '未配置接口');
  if (pill) pill.classList.toggle('warn', !hasUsable());
  if (reason) reason.textContent = REASON_LABEL[(state.settings && state.settings.reasoning) || 'auto'] || '自动';
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
const streamEl = $('#stream');
let nearBottom = true;

streamEl.addEventListener('scroll', () => {
  nearBottom = streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight < 140;
});

function scrollBottom(force = false) {
  if (force || nearBottom) {
    requestAnimationFrame(() => { streamEl.scrollTop = streamEl.scrollHeight; });
  }
}

function heroHtml() {
  const cards = [
    ['换个风格', '把整个界面改成赛博朋克霓虹风：深紫底、荧光粉强调色，再来点扫描线质感'],
    ['加个功能', '加一个便签面板：能新建、勾选完成、删除待办，数据保存在本地'],
    ['重排布局', '把聊天改成左边会话列表、右边对话区，整体更像一个专业的聊天客户端'],
    ['做成工具', '把它改造成一个番茄钟：25 分钟专注 / 5 分钟休息，有环形进度和提示音'],
  ];
  return `<div class="hero">
    <div class="orb"></div>
    <h1>你好，我是 Morph</h1>
    <p>这个程序现在只是一个 AI 对话框。但你可以直接告诉我你想让它变成什么样——我有权限改它自己的代码。</p>
    <div class="cards">
      ${cards.map(([k, v]) => `<div class="card" data-prompt="${esc(v)}"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('')}
    </div>
  </div>`;
}

function setupHtml() {
  const c = currentConn();
  const need = !c ? '还没有配置接口' : (!c.hasKey ? '这个接口还没有 API Key' : '还没有选择模型');
  return `<div class="setup">
    <h2>${need}</h2>
    <p>Morph 自己不带模型，你用自己的 Key。可以同时添加多个接口（DeepSeek、Kimi、智谱、通义、OpenAI、本机 Ollama……），之后在输入框上方随时切换。</p>
    <div class="row"><button class="btn primary" id="btnSetupKey">去配置</button></div>
    <div class="note">Key 只保存在这台电脑上</div>
  </div>`;
}

function canContinue(text) {
  return !!text && (text.includes('已达到单轮工具调用上限') || text.includes('被截断'));
}

function messageHtml(m, i) {
  if (m.role === 'user') {
    return `<div class="msg me"><div class="bubble-me">${esc(m.content)}</div></div>`;
  }
  const tools = (m.tools || []).map((t) =>
    `<span class="tool${t.running ? ' run' : ''}${t.ok === false ? ' bad' : ''}">${esc(t.name)}</span>`).join('');
  let body;
  if (m.streaming && !m.content) body = '<div class="typing"><i></i><i></i><i></i></div>';
  else body = md(m.content);
  return `<div class="msg ai" data-i="${i}">
    <div class="avatar"></div>
    <div class="body">
      <div class="who">MORPH</div>
      ${tools ? `<div class="tool-row">${tools}</div>` : ''}
      <div class="content">${body}</div>
      ${canContinue(m.content) ? '<button class="cont-btn" data-continue="1">继续</button>' : ''}
    </div>
  </div>`;
}

function render() {
  if (!state.settings) return;

  if (!hasUsable()) {
    streamEl.innerHTML = setupHtml();
    const b = $('#btnSetupKey');
    if (b) b.onclick = openSettings;
    return;
  }

  if (!state.messages.length) {
    streamEl.innerHTML = heroHtml();
    $$('.card', streamEl).forEach((c) => { c.onclick = () => send(c.dataset.prompt); });
    return;
  }

  streamEl.innerHTML = state.messages.map((m, i) => messageHtml(m, i)).join('');
  $$('.cont-btn', streamEl).forEach((b) => { b.onclick = () => send('继续'); });
  scrollBottom();
}

function updateLive(i) {
  const m = state.messages[i];
  if (!m) return;
  const node = streamEl.querySelector(`.msg[data-i="${i}"]`);
  if (!node) return render();
  const content = node.querySelector('.content');
  if (content) content.innerHTML = m.content ? md(m.content) : '<div class="typing"><i></i><i></i><i></i></div>';
  const toolRow = node.querySelector('.tool-row');
  if (toolRow) {
    toolRow.innerHTML = (m.tools || []).map((t) =>
      `<span class="tool${t.running ? ' run' : ''}${t.ok === false ? ' bad' : ''}">${esc(t.name)}</span>`).join('');
  }
  // 撞到步数/token 上限时给一个「继续」按钮
  const bodyWrap = node.querySelector('.body');
  let contBtn = bodyWrap ? bodyWrap.querySelector('.cont-btn') : null;
  if (canContinue(m.content) && bodyWrap && !contBtn) {
    contBtn = document.createElement('button');
    contBtn.className = 'cont-btn';
    contBtn.textContent = '继续';
    contBtn.onclick = () => send('继续');
    bodyWrap.appendChild(contBtn);
  } else if (!canContinue(m.content) && contBtn) {
    contBtn.remove();
  }
  scrollBottom();
}

// ---------------------------------------------------------------------------
// 发送
// ---------------------------------------------------------------------------
const inputEl = $('#input');
const sendBtn = $('#btnSend');
const composerEl = $('#composer');

function anyModalOpen() {
  return !!document.querySelector('.modal:not([hidden])');
}

/** 把键盘焦点放回输入框：生成结束、点空白处、窗口重新获得焦点时都调它 */
function focusComposer() {
  if (!inputEl || document.hidden || anyModalOpen()) return;
  try { inputEl.focus({ preventScroll: true }); } catch (e) { inputEl.focus(); }
}

window.addEventListener('focus', () => setTimeout(focusComposer, 30));
if (composerEl) {
  composerEl.addEventListener('mousedown', (e) => {
    if (e.target === composerEl) { e.preventDefault(); focusComposer(); }
  });
}

function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(200, inputEl.scrollHeight) + 'px';
}

function setSending(busy) {
  state.busy = busy;
  sendBtn.classList.toggle('stop', busy);
  sendBtn.title = busy ? '停止' : '发送';
  sendBtn.innerHTML = busy
    ? '<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor"><rect x="6" y="6" width="8" height="8" rx="1.6"/></svg>'
    : '<svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10h11M11 5.5 15.5 10 11 14.5"/></svg>';
}

async function send(prefill) {
  if (state.busy) return;
  if (!state.settings) return;
  if (!hasUsable()) { openSettings(); toast('先把接口和模型配好', 'error'); return; }

  const text = (prefill != null ? prefill : inputEl.value).trim();
  if (!text) return;

  // 会话被删光时，发消息前自动建一个
  if (!state.activeId || !currentSession()) await newSession();

  inputEl.value = '';
  autoGrow();

  const agentOn = $('#agentToggle').checked && state.settings.agentEnabled !== false;

  state.messages.push({ role: 'user', content: text, ts: Date.now() });
  const asst = { role: 'assistant', content: '', tools: [], ts: Date.now(), streaming: true };
  state.messages.push(asst);
  const idx = state.messages.length - 1;

  const history = state.messages
    .slice(0, -1)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-30)
    .map((m) => ({ role: m.role, content: m.content }));

  state.rid = uuid();
  setSending(true);
  closePicker();
  render();
  scrollBottom(true);
  persist(text);
  markInflight();

  try {
    const opts = {
      messages: history,
      requestId: state.rid,
      onDelta(t) { asst.content += t; updateLive(idx); },
      onTool(t) {
        if (t.phase === 'start') asst.tools.push({ name: t.name, running: true });
        else {
          for (let i = asst.tools.length - 1; i >= 0; i--) {
            if (asst.tools[i].running) { asst.tools[i].running = false; asst.tools[i].ok = t.ok; break; }
          }
        }
        updateLive(idx);
      },
    };
    const res = agentOn ? await morph.ai.agent(opts) : await morph.ai.chat(opts);

    if (res && res.ok === false) {
      asst.content = (asst.content ? asst.content + '\n\n' : '') + '**出错了：** ' + res.error;
    } else if (res && res.text && !asst.content) {
      asst.content = res.text;
    }
    if (res && Array.isArray(res.tools)) asst.tools = res.tools.map((t) => ({ name: t.name, ok: t.ok }));
  } catch (e) {
    asst.content = (asst.content ? asst.content + '\n\n' : '') + '**出错了：** ' + (e.message || e);
    // 桥接层超时/出错时，主进程可能还在后台跑；主动中止，避免它继续改文件
    if (state.rid) morph.ai.abort(state.rid).catch(() => {});
  } finally {
    asst.streaming = false;
    asst.ts = Date.now();
    state.rid = null;
    setSending(false);
    updateLive(idx);
    persist();
    clearInflight();
    nearBottom = true;
    scrollBottom(true);
    focusComposer();
  }
}

function persist(firstText) {
  const data = state.messages.slice(-60).map((m) => ({
    role: m.role, content: m.content || '', tools: m.tools || [], ts: m.ts || 0,
  }));
  if (state.activeId) morph.kv.set('ui:chat:' + state.activeId, data).catch(() => {});
  touchSession(firstText);
}

/** 记录「这一轮正在生成」：界面若中途被重载，只有它能证明最后一条回复属于哪个会话 */
function markInflight() {
  morph.kv.set('ui:inflight', { sid: state.activeId, rid: state.rid, at: Date.now() }).catch(() => {});
}

function clearInflight() {
  morph.kv.del('ui:inflight').catch(() => {});
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------
function sessionTitleFrom(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.slice(0, 24) || '新会话';
}

function currentSession() {
  return state.sessions.find((s) => s.id === state.activeId) || null;
}

async function saveSessions() {
  await morph.kv.set('ui:sessions', state.sessions).catch(() => {});
  await morph.kv.set('ui:active', state.activeId).catch(() => {});
}

function touchSession(firstText) {
  const s = currentSession();
  if (!s) return;
  s.ts = Date.now();
  if (firstText && (!s.title || s.title === '新会话')) s.title = sessionTitleFrom(firstText);
  saveSessions();
  renderSide();
}

function renderSide() {
  const el = $('#sideList');
  if (!el) return;
  const list = state.sessions.slice().sort((a, b) => b.ts - a.ts);
  if (!list.length) {
    el.innerHTML = '<div class="side-empty">还没有会话</div>';
    return;
  }
  el.innerHTML = list.map((s) => `
    <div class="side-item${s.id === state.activeId ? ' on' : ''}" data-id="${esc(s.id)}">
      <span class="t" title="双击可改名">${esc(s.title || '新会话')}</span>
      <button class="x" data-del title="删除会话">✕</button>
    </div>`).join('');

  $$('.side-item', el).forEach((item) => {
    const id = item.dataset.id;
    item.onclick = (e) => {
      if (e.target.dataset && e.target.dataset.del !== undefined) return;
      switchSession(id);
    };
    item.querySelector('[data-del]').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('删除这个会话？消息会一起删掉。')) return;
      await deleteSession(id);
    };
    const t = item.querySelector('.t');
    t.ondblclick = (e) => { e.stopPropagation(); beginRenameSession(item, id, t); };
  });
}

function beginRenameSession(item, id, labelEl) {
  if (item.querySelector('.side-rename')) return;
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  const old = s.title;
  const input = document.createElement('input');
  input.className = 'side-rename';
  input.value = old;
  labelEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v) { s.title = v.slice(0, 40); await saveSessions(); }
    renderSide();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

async function switchSession(id) {
  if (state.busy || id === state.activeId) return;
  state.activeId = id;
  const saved = await morph.kv.get('ui:chat:' + id, []);
  state.messages = Array.isArray(saved)
    ? saved.filter((m) => !(m.role === 'assistant' && !m.content))
    : [];
  await saveSessions();
  renderSide();
  render();
  scrollBottom(true);
}

async function newSession() {
  if (state.busy) return;
  const id = uuid();
  state.sessions.push({ id, title: '新会话', ts: Date.now() });
  state.activeId = id;
  state.messages = [];
  await saveSessions();
  renderSide();
  render();
  inputEl.focus();
}

async function deleteSession(id) {
  if (state.busy) return;
  await morph.kv.del('ui:chat:' + id).catch(() => {});
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.activeId === id) {
    const next = state.sessions.slice().sort((a, b) => b.ts - a.ts)[0];
    if (next) {
      state.activeId = next.id;
      const saved = await morph.kv.get('ui:chat:' + next.id, []);
      state.messages = Array.isArray(saved) ? saved.filter((m) => !(m.role === 'assistant' && !m.content)) : [];
    } else {
      state.activeId = '';
      state.messages = [];
    }
  }
  await saveSessions();
  renderSide();
  render();
}

$('#btnNewChat').onclick = () => newSession();

sendBtn.onclick = () => {
  if (state.busy) { morph.ai.abort(state.rid); return; }
  send();
};

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (state.busy) { toast('正在生成中，点右下角停止可以中断', 'info', 1600); return; }
    send();
  }
});
inputEl.addEventListener('input', autoGrow);

// ---------------------------------------------------------------------------
// 模型 / 推理 快速选择器
// ---------------------------------------------------------------------------
const picker = $('#picker');

function togglePicker() {
  if (picker.hasAttribute('hidden')) openPicker(); else closePicker();
}

function openPicker() {
  renderPicker();
  picker.removeAttribute('hidden');
}

function closePicker() {
  picker.setAttribute('hidden', '');
}

function renderPicker() {
  const s = state.settings;
  const list = $('#pickerList');
  if (!s || !s.connections.length) {
    list.innerHTML = '<div class="picker-empty">还没有配置接口</div>';
  } else {
    list.innerHTML = s.connections.map((c) => {
      const models = (c.models && c.models.length) ? c.models : (c.model ? [c.model] : []);
      const items = models.map((m) => `
        <button type="button" class="picker-item${c.id === s.activeId && m === c.model ? ' on' : ''}"
          data-cid="${esc(c.id)}" data-model="${esc(m)}">${esc(m)}</button>`).join('');
      return `<div class="picker-group">
        <div class="picker-gname">${esc(c.name)}${c.hasKey ? '' : ' · 未配置 Key'}</div>
        <div class="picker-models">${items || '<span class="picker-empty">还没有拉取模型</span>'}</div>
      </div>`;
    }).join('');
  }

  $$('.picker-item', list).forEach((btn) => {
    btn.onclick = () => selectModel(btn.dataset.cid, btn.dataset.model);
  });
  syncReason();
}

function syncReason() {
  const cur = (state.settings && state.settings.reasoning) || 'auto';
  $$('#pickerReason button').forEach((b) => b.classList.toggle('on', b.dataset.v === cur));
  $$('#fReason button').forEach((b) => b.classList.toggle('on', b.dataset.v === cur));
}

async function selectModel(cid, model) {
  const r = await morph.settings.activate({ id: cid, model });
  if (r && r.ok === false) return toast(r.error || '切换失败', 'error');
  if (r && r.settings) state.settings = r.settings;
  updatePills();
  closePicker();
  toast('已切换到 ' + model, 'ok', 1600);
  render();
}

async function setReason(v) {
  const r = await morph.settings.save({ reasoning: v });
  if (r && r.ok === false) return toast(r.error || '保存失败', 'error');
  if (r && r.settings) state.settings = r.settings;
  updatePills();
  syncReason();
  toast('推理强度：' + REASON_LABEL[v], 'ok', 1400);
}

$('#modelPill').onclick = (e) => { e.stopPropagation(); togglePicker(); };
$('#reasonPill').onclick = (e) => { e.stopPropagation(); togglePicker(); };
$('#pickerManage').onclick = (e) => { e.stopPropagation(); closePicker(); openSettings(); };
$$('#pickerReason button').forEach((b) => {
  b.onclick = (e) => { e.stopPropagation(); setReason(b.dataset.v); };
});
picker.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => { if (!picker.hasAttribute('hidden')) closePicker(); });

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------
const pluginsModal = $('#pluginsModal');

function closePlugins() { pluginsModal.setAttribute('hidden', ''); focusComposer(); }

async function openPlugins() {
  pluginsModal.removeAttribute('hidden');
  await renderPlugins();
}

async function renderPlugins() {
  const listEl = $('#pluginList');
  let items = [];
  try { items = await morph.plugins.list(); } catch (e) { items = []; }

  if (!items.length) {
    listEl.innerHTML = '<div class="tip" style="padding:10px 0">还没有插件。让 AI 写一个，比如「给我做个能查天气的工具」。</div>';
    $('#pluginHint').textContent = '0 个插件';
    return;
  }

  listEl.innerHTML = items.map((p) => `
    <div class="conn" data-file="${esc(p.file)}">
      <div class="conn-head">
        <span class="conn-name">${esc(p.name)}${p.ok === false ? ' ⚠' : ''}</span>
        <span class="plugin-actions">
          <label class="switch" title="${p.enabled ? '已启用' : '已禁用'}">
            <input type="checkbox" data-toggle ${p.enabled ? 'checked' : ''} />
            <span class="track"><span class="knob"></span></span>
          </label>
          <button class="mini danger" data-del>删</button>
        </span>
      </div>
      <div class="conn-tip">${esc(p.description || '（没有写简介）')}</div>
      <div class="conn-tip"><code>${esc(p.file)}</code>${p.ok === false ? ' · 加载失败：' + esc(p.error) : ''}</div>
    </div>`).join('');

  $('#pluginHint').textContent = items.length + ' 个插件，' + items.filter((p) => p.enabled).length + ' 个已启用';

  $$('.conn', listEl).forEach((card) => {
    const file = card.dataset.file;
    card.querySelector('[data-toggle]').onchange = async (e) => {
      const r = await morph.plugins.setEnabled(file, e.target.checked);
      if (r && r.ok === false) return toast(r.error || '切换失败', 'error');
      toast(e.target.checked ? '已启用 ' + file : '已禁用 ' + file, 'ok', 1500);
      renderPlugins();
    };
    card.querySelector('[data-del]').onclick = async () => {
      if (!confirm('删除插件 ' + file + '？文件会被删掉。')) return;
      const r = await morph.plugins.remove(file);
      if (r && r.ok === false) return toast(r.error || '删除失败', 'error');
      toast('已删除', 'ok', 1500);
      renderPlugins();
    };
  });
}

$$('[data-close-plugins]').forEach((b) => { b.onclick = closePlugins; });
pluginsModal.addEventListener('mousedown', (e) => { if (e.target === pluginsModal) closePlugins(); });
$('#btnReloadPlugins').onclick = async () => {
  const r = await morph.plugins.reload();
  if (r && r.ok === false) return toast(r.error || '重载失败', 'error');
  toast('已重新加载插件', 'ok', 1500);
  renderPlugins();
};
morph.on('ui:openPlugins', () => { try { openPlugins(); } catch (e) { /* ignore */ } });

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
const settingsModal = $('#settingsModal');

function openSettings() {
  fillSettingsForm();
  settingsModal.removeAttribute('hidden');
}

function closeModal(el) { el.setAttribute('hidden', ''); focusComposer(); }

function connCardHtml(c) {
  const id = c.id || '';
  const models = (c.models || []).map((m) => `<option value="${esc(m)}"></option>`).join('');
  const keyPh = c.hasKey ? `已保存（末尾 ${c.keyTail}），留空则不修改` : 'sk-...';
  return `<div class="conn" data-id="${esc(id)}" data-models="${esc(JSON.stringify(c.models || []))}">
    <div class="conn-head">
      <span class="conn-name">${esc(c.name || '新接口')}</span>
      <button class="mini danger" type="button" data-act="del" title="删除这个接口">删</button>
    </div>
    <div class="conn-grid">
      <label class="cf"><span>名称</span><input data-f="name" value="${esc(c.name || '')}" placeholder="例如 DeepSeek" /></label>
      <label class="cf"><span>地址</span><input data-f="baseUrl" value="${esc(c.baseUrl || '')}" placeholder="https://api.deepseek.com/v1" spellcheck="false" /></label>
      <label class="cf"><span>Key</span><input data-f="apiKey" type="password" placeholder="${esc(keyPh)}" spellcheck="false" autocomplete="off" /></label>
      <label class="cf"><span>模型</span><input data-f="model" value="${esc(c.model || '')}" list="dl-${esc(id)}" placeholder="deepseek-flash" spellcheck="false" /><datalist id="dl-${esc(id)}">${models}</datalist></label>
    </div>
    <div class="conn-actions">
      <button class="mini" type="button" data-act="fetch">拉取模型</button>
      <button class="mini" type="button" data-act="test">测试</button>
      <span class="conn-tip" data-tip></span>
    </div>
  </div>`;
}

function fillSettingsForm() {
  const s = state.settings || {};
  const list = $('#connList');

  if (!s.connections || !s.connections.length) {
    list.innerHTML = connCardHtml({ id: '', name: '新接口', baseUrl: '', model: '', models: [] });
  } else {
    list.innerHTML = s.connections.map(connCardHtml).join('');
  }

  bindConnCards();

  $('#fTemp').value = s.temperature ?? 0.35;
  $('#fMaxTokens').value = s.maxTokens ?? 8192;
  $('#fSystem').value = s.systemPrompt || '';
  syncReason();
  syncPerm();
  updateConnCount();
}

function syncPerm() {
  const cur = (state.settings && state.settings.permissions) || 'sandbox';
  $$('#fPerm button').forEach((b) => b.classList.toggle('on', b.dataset.v === cur));
  const hint = $('#permHint');
  if (hint) hint.textContent = cur === 'full' ? '完全权限' : '沙箱';
}

function updateConnCount() {
  const n = $$('.conn').length;
  $('#connCount').textContent = n ? `${n} 个接口` : '还没有接口';
}

function bindConnCards() {
  $$('.conn').forEach((el) => {
    const get = (f) => el.querySelector(`[data-f="${f}"]`);
    const setTip = (msg) => { const t = el.querySelector('[data-tip]'); if (t) t.textContent = msg; };

    const nameInput = get('name');
    if (nameInput) {
      nameInput.addEventListener('input', () => {
        const t = el.querySelector('.conn-name');
        if (t) t.textContent = nameInput.value.trim() || '新接口';
      });
    }

    el.querySelector('[data-act="del"]').onclick = () => {
      if (!confirm('删除这个接口？保存后生效。')) return;
      el.remove();
      updateConnCount();
    };

    el.querySelector('[data-act="fetch"]').onclick = async () => {
      const baseUrl = get('baseUrl').value.trim();
      const apiKey = get('apiKey').value.trim();
      const id = el.dataset.id || '';
      if (!baseUrl) return setTip('先填接口地址');
      setTip('拉取中…');
      try {
        const r = await morph.settings.models({ baseUrl, apiKey: apiKey || undefined, id });
        if (!r || r.ok === false) return setTip('失败：' + ((r && r.error) || '未知错误'));
        const models = r.models || [];
        el.dataset.models = JSON.stringify(models);
        const dl = el.querySelector('datalist');
        if (dl) dl.innerHTML = models.map((m) => `<option value="${esc(m)}"></option>`).join('');
        const modelInput = get('model');
        if (modelInput && !modelInput.value.trim() && models.length === 1) modelInput.value = models[0];
        setTip(models.length ? `已拉取 ${models.length} 个模型` : '接口返回空列表，可直接手填模型名');
      } catch (e) {
        setTip('失败：' + (e && e.message ? e.message : e));
      }
    };

    el.querySelector('[data-act="test"]').onclick = async () => {
      const baseUrl = get('baseUrl').value.trim();
      const model = get('model').value.trim();
      const apiKey = get('apiKey').value.trim();
      const id = el.dataset.id || '';
      if (!baseUrl || !model) return setTip('先填地址和模型');
      setTip('测试中…');
      try {
        const r = await morph.settings.test({ id, patch: { baseUrl, model, apiKey: apiKey || undefined } });
        setTip(r && r.ok ? `连接正常 · ${(r.result && r.result.model) || model}` : '失败：' + ((r && r.error) || '未知错误'));
      } catch (e) {
        setTip('失败：' + (e && e.message ? e.message : e));
      }
    };
  });
}

function collectConnections() {
  return $$('.conn').map((el) => {
    const get = (f) => el.querySelector(`[data-f="${f}"]`);
    let models = [];
    try { models = JSON.parse(el.dataset.models || '[]'); } catch { models = []; }
    return {
      id: el.dataset.id || undefined,
      name: get('name').value.trim(),
      baseUrl: get('baseUrl').value.trim(),
      apiKey: get('apiKey').value.trim(),
      model: get('model').value.trim(),
      models,
    };
  }).filter((c) => c.baseUrl || c.id);
}

$('#btnAddConn').onclick = () => {
  const list = $('#connList');
  const div = document.createElement('div');
  div.innerHTML = connCardHtml({ id: '', name: '', baseUrl: '', model: '', models: [] });
  list.appendChild(div.firstElementChild);
  bindConnCards();
  updateConnCount();
};

$$('#fReason button').forEach((b) => { b.onclick = () => setReason(b.dataset.v); });

$$('#fPerm button').forEach((b) => {
  b.onclick = async () => {
    const v = b.dataset.v;
    const cur = (state.settings && state.settings.permissions) || 'sandbox';
    if (v === cur) return;
    if (v === 'full') {
      const ok = confirm('开启「完全权限」后，AI 可以：\n\n· 执行任意系统命令（PowerShell）\n· 读写这台电脑上任意文件\n· 给自己写插件并加载\n\n它有可能误删文件或改坏系统。确定开启？');
      if (!ok) return;
    }
    const r = await morph.settings.save({ permissions: v });
    if (r && r.ok === false) return toast(r.error || '保存失败', 'error');
    if (r && r.settings) state.settings = r.settings;
    syncPerm();
    toast(v === 'full' ? '已开启完全权限' : '已切回沙箱模式', v === 'full' ? 'error' : 'ok', 2500);
  };
});

$('#btnSaveSettings').onclick = async () => {
  const conns = collectConnections();
  const saved = await morph.settings.saveAll(conns);
  if (saved && saved.ok === false) {
    const msg = String(saved.error || '保存失败');
    if (msg.includes('未知方法')) return toast('程序版本不匹配：请完全退出并重新打开 Morph', 'error', 6000);
    return toast(msg, 'error');
  }

  const r = await morph.settings.save({
    temperature: Number($('#fTemp').value) || 0,
    maxTokens: Number($('#fMaxTokens').value) || 8192,
    systemPrompt: $('#fSystem').value,
  });
  if (r && r.ok === false) return toast(r.error || '保存失败', 'error');

  if (r && r.settings) state.settings = r.settings;
  else { const got = await morph.settings.get(); state.settings = got.settings || got; }

  updatePills();
  closeModal(settingsModal);
  toast('已保存', 'ok', 1600);
  render();
};

$$('[data-close]').forEach((b) => {
  b.onclick = () => closeModal(settingsModal);
});
settingsModal.addEventListener('mousedown', (e) => { if (e.target === settingsModal) closeModal(settingsModal); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeModal(settingsModal); closePlugins(); closePicker(); }
});

// 外壳（Windows 标题栏）的 ⚙ 通过事件打开设置
morph.on('ui:openSettings', () => { try { openSettings(); } catch (e) { /* ignore */ } });

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
async function syncLastReply(inflight) {
  try {
    const last = await morph.ai.lastReply();
    if (!last || !last.text || !inflight || !state.activeId) return;
    const lastMsg = state.messages[state.messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'user') return;
    // 只接受「这次发送开始之后」产生、且比本地最后一条更新的回复，
    // 绝不把别的会话（或很久以前）的回复灌进当前会话。
    const ts = Number(last.ts) || 0;
    if (ts < (Number(inflight.at) || 0) - 5000) return;
    if (ts <= (Number(lastMsg.ts) || 0)) return;
    if (state.messages.some((m) => m.role === 'assistant' && (m.ts || 0) >= ts)) return;
    state.messages.push({
      role: 'assistant',
      content: last.text,
      ts,
      tools: (last.tools || []).map((t) => ({ name: t.name, ok: t.ok })),
    });
    await clearInflight();
    persist();
    render();
    scrollBottom(true);
  } catch (e) { /* ignore */ }
}

function showMismatchBanner() {
  if (document.getElementById('__mismatch')) return;
  const el = document.createElement('div');
  el.id = '__mismatch';
  el.textContent = '⚠ 程序版本不匹配：界面是新的，但正在运行的后端是旧版。请完全退出 Morph 再重新打开。';
  el.setAttribute('style', [
    'position:fixed', 'left:50%', 'top:10px', 'transform:translateX(-50%)',
    'z-index:9999', 'max-width:80vw', 'text-align:center',
    'background:rgba(120,40,20,.95)', 'color:#ffd9c9',
    'border:1px solid rgba(255,140,90,.5)', 'border-radius:12px',
    'padding:10px 16px', 'font:500 12.5px/1.5 var(--font)',
    'box-shadow:0 12px 30px rgba(0,0,0,.5)',
  ].join(';'));
  document.body.appendChild(el);
}

(async function boot() {
  try {
    state.info = await morph.app.info();
    if (!state.info || state.info.api !== 2) showMismatchBanner();
  } catch (e) { /* ignore */ }

  try {
    const r = await morph.settings.get();
    state.settings = (r && r.settings) || r;
    $('#agentToggle').checked = state.settings.agentEnabled !== false;
    updatePills();
  } catch (e) { /* ignore */ }

  try {
    const migrated = await morph.kv.get('ui:migrated', false);
    let list = await morph.kv.get('ui:sessions', []);
    if (!Array.isArray(list)) list = [];

    // 旧的单会话记录（ui:chat）只在升级后的第一次启动里迁移一次，迁完立刻把旧键删掉。
    // 否则「删光会话」后重启，会从 ui:chat 里再长出来一条。
    if (!list.length && !migrated) {
      const legacy = await morph.kv.get('ui:chat', []);
      if (Array.isArray(legacy) && legacy.length) {
        const firstUser = legacy.find((m) => m.role === 'user');
        const id = uuid();
        list = [{ id, title: firstUser ? sessionTitleFrom(firstUser.content) : '默认会话', ts: Date.now() }];
        await morph.kv.set('ui:chat:' + id, legacy.filter((m) => !(m.role === 'assistant' && !m.content)));
      }
    }
    if (!migrated) {
      await morph.kv.set('ui:migrated', true).catch(() => {});
      await morph.kv.del('ui:chat').catch(() => {});
    }

    if (list.length) {
      const act = await morph.kv.get('ui:active', '');
      state.activeId = list.some((s) => s.id === act) ? act : list[0].id;
      const saved = await morph.kv.get('ui:chat:' + state.activeId, []);
      if (Array.isArray(saved)) {
        state.messages = saved.filter((m) => !(m.role === 'assistant' && !m.content));
      }
    } else {
      // 用户把会话全删了：保持空列表，不自动造会话（下次发消息时再建）
      state.activeId = '';
      state.messages = [];
    }

    state.sessions = list;
    await saveSessions();
    renderSide();
  } catch (e) { /* ignore */ }

  // 只有「发送中途界面被重载」才需要补回最后一条回复；
  // 平时绝不拿 last-reply 往回灌，否则已删会话的内容会复活。
  const inflight = await morph.kv.get('ui:inflight', null).catch(() => null);
  const inflightFresh = !!(inflight && Number(inflight.at) && (Date.now() - Number(inflight.at) < 15 * 60 * 1000));
  if (inflight && !inflightFresh) {
    // 超过 15 分钟的痕迹只可能是上次异常退出留下的，清掉
    await clearInflight();
  } else if (inflight && inflight.sid && inflight.sid === state.activeId) {
    await syncLastReply(inflight);
    let polls = 0;
    const poll = setInterval(async () => {
      polls += 1;
      await syncLastReply(inflight);
      if (polls >= 6) {
        clearInterval(poll);
        await clearInflight();
      }
    }, 1500);
  } else if (inflight) {
    // 指向的会话已经不存在了，这条痕迹没有意义
    await clearInflight();
  }

  render();
  scrollBottom(true);
  autoGrow();
  setTimeout(() => focusComposer(), 120);

  $('#agentToggle').addEventListener('change', (e) => {
    morph.settings.save({ agentEnabled: e.target.checked }).catch(() => {});
    toast(e.target.checked ? '已开启：AI 可以改动本软件' : '已关闭：AI 只能聊天', 'info', 2000);
  });
})();
