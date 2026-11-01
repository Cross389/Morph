'use strict';
/**
 * 仅用于开发自测：一个假的 OpenAI 兼容接口。
 * 它会先让模型"调用工具写入文件"，再让它"重载界面"，最后给出一段总结，
 * 用来验证 Morph 的整条自省链路（流式解析 → 工具执行 → 快照 → 界面重载）。
 */
const http = require('node:http');

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function plan(toolCount) {
  const mode = process.env.MORPH_MOCK_MODE || 'write';

  if (mode === 'plugin') {
    if (toolCount === 0) return { tool: { name: 'hello_morph', args: {} } };
    return { content: '插件调用完成 ✅ 我自己写的工具已经能用了。' };
  }

  if (mode === 'exec') {
    if (toolCount === 0) {
      return { tool: { name: 'run_command', args: { command: 'echo morph-exec-ok | Out-File -FilePath (Join-Path $env:TEMP "morph-exec-test.txt") -Encoding utf8' } } };
    }
    return { content: '命令执行完成 ✅ 我拿到了系统执行权限。' };
  }

  if (mode === 'style') {
    // 演示"AI 直接改写界面代码"：两次局部编辑 + 重载
    if (toolCount === 0) {
      return { tool: { name: 'edit_file', args: { path: 'ui/style.css', old_string: '--accent: #7c8cff;', new_string: '--accent: #ff3bd4;' } } };
    }
    if (toolCount === 1) {
      return { tool: { name: 'edit_file', args: { path: 'ui/style.css', old_string: '--bg: #0b0d12;', new_string: '--bg: #150a24;' } } };
    }
    if (toolCount === 2) return { tool: { name: 'reload_ui', args: {} } };
    return { content: '配色换好了：底色改成深紫，强调色改成荧光粉。你现在看到的界面，已经被我直接改过代码了。' };
  }

  if (toolCount === 0) {
    return { tool: { name: 'write_file', args: { path: 'assets/SELFTEST.txt', content: '第一段：write_file 写入 ' + new Date().toISOString() + '\n' } } };
  }
  if (toolCount === 1) {
    return { tool: { name: 'append_file', args: { path: 'assets/SELFTEST.txt', content: '第二段：append_file 追加成功\n' } } };
  }
  if (toolCount === 2) {
    return { tool: { name: 'reload_ui', args: {} } };
  }
  return {
    content: '自测完成 ✅ 我已经在 `assets/SELFTEST.txt` 写入了内容，并且重载了一次界面——你现在看到的这个界面，就是我可以随手改写的地方。',
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function start(port = 0) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      if (req.method === 'GET' && req.url.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: [
            { id: 'mock-model', object: 'model' },
            { id: 'mock-model-pro', object: 'model' },
            { id: 'mock-vision', object: 'model' },
          ],
        }));
        return;
      }
      if (!req.url.includes('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { /* ignore */ }
      const toolCount = (payload.messages || []).filter((m) => m.role === 'tool').length;
      const reply = plan(toolCount);
      const wantStream = payload.stream !== false;

      if (!wantStream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: payload.model || 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content: reply.content || 'ok' }, finish_reason: 'stop' }],
        }));
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      if (reply.tool) {
        await sleep(60);
        sse(res, {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_' + Math.random().toString(36).slice(2, 10),
                type: 'function',
                function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) },
              }],
            },
          }],
        });
        sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        const text = reply.content;
        for (let i = 0; i < text.length; i += 6) {
          sse(res, { choices: [{ index: 0, delta: { content: text.slice(i, i + 6) } }] });
          await sleep(12);
        }
        sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, close: () => server.close() });
    });
  });
}

module.exports = { start };
