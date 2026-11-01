'use strict';
/**
 * 端到端自测（开发用）
 * 启动假 AI → 写入设置 → 通过界面发一句话 → 等 AI 改完文件 → 截图 → 校验。
 * 用法：electron . --selftest
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const mockAi = require('./mock-ai');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findUiFrame(win, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const frames = win.webContents.mainFrame.frames;
    const f = frames.find((fr) => String(fr.url).startsWith('morph://ui'));
    if (f) return f;
    await sleep(200);
  }
  return null;
}

async function run({ app, win, settings, snapshots, PATHS, shotPath }) {
  const outShot = process.env.MORPH_SHOT || shotPath;
  const prompt = process.env.MORPH_PROMPT || '帮我改一下界面，随便做点小改动';
  const log = [];
  const say = (m) => { log.push(m); console.log('[selftest] ' + m); };

  try {
    const mock = await mockAi.start();
    say('mock AI 已启动，端口 ' + mock.port);

    settings.saveAll([{
      name: 'Mock',
      baseUrl: `http://127.0.0.1:${mock.port}/v1`,
      apiKey: 'mock-key-for-test',
      model: 'mock-model',
      models: ['mock-model'],
    }]);
    settings.set({
      temperature: 0.2,
      maxTokens: 512,
      agentEnabled: true,
      permissions: process.env.MORPH_FULL === '1' ? 'full' : 'sandbox',
    });
    say('设置已写入（假接口）');

    // 版本改为全手动：自测前先自己存一个基线
    const baseline = await snapshots.create({ label: '自测基线' });
    say('已手动保存基线版本：' + baseline.label);

    if (process.env.MORPH_MOCK_MODE === 'plugin') {
      const dirp = path.join(PATHS.root, 'plugins');
      fs.mkdirSync(dirp, { recursive: true });
      fs.writeFileSync(path.join(dirp, 'hello.js'), [
        "'use strict';",
        "module.exports = {",
        "  name: 'hello_morph',",
        "  description: '自测用插件：写一个文件证明自己被调用',",
        "  parameters: { type: 'object', properties: {} },",
        "  run: async (args, ctx) => { ctx.fs.write('assets/PLUGIN.txt', 'plugin-ok'); return { ok: true }; },",
        "};",
      ].join('\n'), 'utf8');
      const r = require('../core/plugins').load();
      say('插件加载结果: ' + JSON.stringify(r));
    }

    const frame0 = await findUiFrame(win);
    if (!frame0) throw new Error('没有找到 iframe');
    say('已找到界面 frame：' + frame0.url);

    // 设置是刚写进去的，让界面重载一次以便读到新配置
    await frame0.executeJavaScript('location.reload()').catch(() => {});
    await sleep(2000);

    const frame = await findUiFrame(win);
    say('界面已重载：' + (frame ? frame.url : '丢失'));
    if (!frame) throw new Error('重载后找不到 frame');

    await sleep(1200);
    const probe = await frame.executeJavaScript('JSON.stringify({ready: !!document.querySelector("#input"), setup: !!document.querySelector("#btnSetupKey")})');
    say('界面状态：' + probe);

    const sent = await frame.executeJavaScript(`(function(){
      const i = document.querySelector('#input');
      const b = document.querySelector('#btnSend');
      if (!i || !b) return 'no-ui';
      i.value = ${JSON.stringify(prompt)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      b.click();
      return 'sent';
    })()`);
    say('发送结果：' + sent);

    let state = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 40000) {
      await sleep(500);
      state = JSON.parse(await frame.executeJavaScript(`(function(){
        const busy = !!document.querySelector('.send.stop');
        const nodes = document.querySelectorAll('.msg.ai');
        const last = nodes[nodes.length - 1];
        const tools = last ? Array.from(last.querySelectorAll('.tool')).map(function(t){return t.textContent}) : [];
        return JSON.stringify({
          busy: busy,
          count: nodes.length,
          text: last ? (last.querySelector('.content') || {}).innerText || '' : '',
          tools: tools
        });
      })()`));
      if (!state.busy && state.text) break;
    }

    say('最终界面状态：' + JSON.stringify(state));

    const filePath = path.join(PATHS.assets, 'SELFTEST.txt');
    const fileOk = fs.existsSync(filePath);
    const fileText = fileOk ? fs.readFileSync(filePath, 'utf8') : '';
    say('工具写文件：' + (fileOk ? '成功 -> ' + fileText.slice(0, 60) : '失败'));

    if (process.env.MORPH_MOCK_MODE === 'exec') {
      const execFile = path.join(os.tmpdir(), 'morph-exec-test.txt');
      say('run_command 结果: ' + (fs.existsSync(execFile) ? '成功 -> ' + fs.readFileSync(execFile, 'utf8').trim() : '没有生成文件'));
    }

    if (process.env.MORPH_MOCK_MODE === 'plugin') {
      const pf = path.join(PATHS.assets, 'PLUGIN.txt');
      say('插件执行结果: ' + (fs.existsSync(pf) ? '成功 -> ' + fs.readFileSync(pf, 'utf8') : '没有生成文件'));
    }

    const snaps = snapshots.list();
    say('快照数量：' + snaps.length + (snaps[0] ? '（最新：' + snaps[0].label + '）' : ''));

    await sleep(2500);
    if (outShot) {
      const img = await win.webContents.capturePage();
      await fsp.mkdir(path.dirname(outShot), { recursive: true });
      fs.writeFileSync(outShot, img.toPNG());
      say('截图：' + outShot);
    }

    // 回滚测试：把界面还原到快照，确认样式确实退回去了
    let colorBefore = null;
    let colorAfter = null;
    if (process.env.MORPH_MOCK_MODE === 'style' && snaps[0]) {
      const f = await findUiFrame(win);
      colorBefore = await f.executeJavaScript('getComputedStyle(document.body).backgroundColor');
      say('改动后的背景色：' + colorBefore);

      await snapshots.restore(snaps[0].id);
      await sleep(1200);
      const f2 = await findUiFrame(win);
      if (f2) await f2.executeJavaScript('location.reload()').catch(() => {});
      await sleep(1600);
      const f3 = await findUiFrame(win);
      colorAfter = await f3.executeJavaScript('getComputedStyle(document.body).backgroundColor');
      say('回滚后的背景色：' + colorAfter);
      say('回滚' + (colorAfter !== colorBefore ? '成功' : '失败'));
    }

    say('RESULT ' + JSON.stringify({
      uiText: state && state.text,
      tools: state && state.tools,
      fileOk,
      snapshots: snaps.length,
      colorBefore,
      colorAfter,
    }));

    mock.close();
  } catch (e) {
    say('失败：' + e.message);
  } finally {
    await sleep(400);
    app.exit(0);
  }
}

module.exports = { run };
