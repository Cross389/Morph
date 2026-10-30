'use strict';

function prettyError(status, bodyText) {
  let msg = '';
  try {
    const j = JSON.parse(bodyText);
    msg = j.error?.message || j.message || j.msg || JSON.stringify(j).slice(0, 300);
  } catch {
    msg = (bodyText || '').slice(0, 300);
  }
  const hint = status === 401 ? '（API Key 无效或未授权）'
    : status === 402 ? '（余额不足）'
      : status === 404 ? '（模型名或接口地址不对）'
        : status === 429 ? '（请求太频繁/额度用尽）' : '';
  return `接口返回 ${status}${hint}：${msg}`;
}

function reasoningParam(r) {
  if (!r || r === 'auto') return null;
  if (r === 'off') return 'minimal';
  return r; // low | medium | high
}

function buildBody(cfg, messages, { stream = true, tools = null } = {}) {
  const body = { model: cfg.model, messages, stream };
  if (cfg.temperature != null && !Number.isNaN(cfg.temperature)) body.temperature = cfg.temperature;
  if (cfg.maxTokens) body.max_tokens = cfg.maxTokens;
  const re = reasoningParam(cfg.reasoning);
  if (re) body.reasoning_effort = re;
  if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
  return body;
}

function endpoint(cfg) {
  return cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
}

async function doFetch(cfg, body, signal) {
  try {
    return await fetch(endpoint(cfg), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      signal: signal || undefined,
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(`连不上接口 ${endpoint(cfg)}：${e.message}（检查网络、地址是否以 /v1 结尾）`);
  }
}

/** 解析响应：兼容 SSE 流与整段 JSON */
async function consume(res, { onDelta, onReasoning }) {
  const contentType = res.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const j = await res.json();
    const choice = j.choices?.[0];
    const content = choice?.message?.content || '';
    if (content && onDelta) onDelta(content);
    return {
      content,
      reasoning: choice?.message?.reasoning_content || '',
      toolCalls: choice?.message?.tool_calls || [],
      usage: j.usage || null,
      finishReason: choice?.finish_reason || 'stop',
      truncated: (choice?.finish_reason || '') === 'length',
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let usage = null;
  let finishReason = null;
  const toolCalls = [];

  const handleChunk = (json) => {
    if (json.usage) usage = json.usage;
    const choice = json.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const d = choice.delta || choice.message || {};
    if (d.content) {
      content += d.content;
      if (onDelta) onDelta(d.content);
    }
    if (d.reasoning_content) {
      reasoning += d.reasoning_content;
      if (onReasoning) onReasoning(d.reasoning_content);
    }
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const i = tc.index ?? 0;
        const slot = (toolCalls[i] = toolCalls[i] || { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { buffer = ''; break; }
        try { handleChunk(JSON.parse(data)); } catch { /* 忽略不完整片段 */ }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('读取流式数据失败：' + e.message);
  }

  const cleanCalls = toolCalls
    .filter((t) => t && t.function && t.function.name)
    .map((t, i) => ({
      id: t.id || `call_${Date.now()}_${i}`,
      type: 'function',
      function: { name: t.function.name, arguments: t.function.arguments || '{}' },
    }));

  return { content, reasoning, toolCalls: cleanCalls, usage, finishReason, truncated: finishReason === 'length' };
}

/**
 * 流式对话。返回 { content, reasoning, toolCalls, usage, finishReason, degraded? }
 * 若模型不支持工具调用，会自动去掉 tools 重试一次，并在结果里标记 degraded。
 */
async function streamChat({ cfg, messages, tools = null, signal, onDelta, onReasoning }) {
  if (!cfg.apiKey) throw new Error('还没有配置 API Key，请先在设置里填写');
  if (!cfg.baseUrl || !cfg.model) throw new Error('请先在设置里填写接口地址和模型名');

  // 逐级降级重试：带推理参数 → 去掉推理参数 → 再去掉工具（兼容不认这些参数的模型）
  const candidates = [buildBody(cfg, messages, { stream: true, tools })];
  if (reasoningParam(cfg.reasoning)) {
    candidates.push(buildBody({ ...cfg, reasoning: 'auto' }, messages, { stream: true, tools }));
  }
  if (tools && tools.length) {
    candidates.push(buildBody({ ...cfg, reasoning: 'auto' }, messages, { stream: true, tools: null }));
  }

  let res = null;
  let used = null;
  let lastError = null;

  for (const body of candidates) {
    res = await doFetch(cfg, body, signal);
    used = body;
    if (res.ok) break;
    lastError = await res.text().catch(() => '');
    if (res.status !== 400 && res.status !== 422) break;
  }

  if (!res || !res.ok) {
    throw new Error(prettyError(res ? res.status : 500, lastError || ''));
  }

  const out = await consume(res, { onDelta, onReasoning });
  if (candidates.length > 1 && used !== candidates[0] && !used.tools) out.degraded = true;
  return out;
}

/** 拉取这个接口 + Key 能用的模型列表 */
async function listModels({ baseUrl, apiKey }) {
  if (!baseUrl) throw new Error('请先填写接口地址');
  const url = baseUrl.replace(/\/+$/, '') + '/models';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(prettyError(res.status, t));
    }
    const j = await res.json().catch(() => null);
    if (!j) throw new Error('接口返回的不是 JSON，可能这个地址不支持 /models');
    const arr = Array.isArray(j) ? j
      : Array.isArray(j.data) ? j.data
        : Array.isArray(j.models) ? j.models
          : [];
    const ids = arr
      .map((m) => (typeof m === 'string' ? m : (m && (m.id || m.name || m.model)) || ''))
      .filter(Boolean)
      .map(String);
    return Array.from(new Set(ids)).sort();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('拉取模型列表超时（20 秒）');
    if (/fetch failed|ENOTFOUND|ECONNREFUSED/i.test(e.message)) {
      throw new Error(`连不上 ${url}：${e.message}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 测试连通性：发一条极短的对话 */async function test({ cfg }) {
  if (!cfg.apiKey) throw new Error('请先填写 API Key');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(endpoint(cfg), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: '你好' }], max_tokens: 16, stream: false }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(prettyError(res.status, t));
    }
    const j = await res.json().catch(() => ({}));
    const reply = j.choices?.[0]?.message?.content || '';
    return { ok: true, model: j.model || cfg.model, reply: String(reply).slice(0, 80) };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('测试超时（30 秒），检查接口地址与网络');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { streamChat, test, listModels, prettyError };
