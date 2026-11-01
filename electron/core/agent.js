'use strict';
const ai = require('./ai');
const settings = require('./settings');
const tools = require('./tools');

const BRIDGE_DOC = `
app.info()                                 -> {version, api, userDir, platform, safeMode, electron, chrome, node}
app.openExternal(url)                      -> 用系统浏览器打开链接
settings.get()                             -> 公开设置：{connections:[{id,name,baseUrl,model,models,hasKey,keyTail}], activeId, temperature, maxTokens, reasoning, permissions, agentEnabled}
settings.save(patch)                       -> 只改标量：temperature / maxTokens / reasoning / systemPrompt / agentEnabled / permissions
settings.activate({id, model})             -> 切换接口 / 模型并持久化
settings.saveAll(connections)              -> 整表保存接口（apiKey 留空表示不修改）
settings.models({baseUrl, apiKey, id})     -> 拉取该接口的模型列表
settings.test({id, patch})                 -> 测试接口连通性
ai.chat({messages, system, requestId, onDelta})            -> 纯对话，返回文本（失败会 reject）
ai.agent({messages, system, requestId, onDelta, onTool})   -> 带工具（可改本软件），返回文本（失败会 reject）
ai.abort(requestId)                        -> 中止
ai.lastReply()                             -> 上一次助手回复（只在发送中途重载后用它补回）
kv.get(k, default) / kv.set(k,v) / kv.all() / kv.del(k)    -> 持久化键值（单值 ≤4MB）
files.list(path) / files.read(path) / files.write(path, content)
snapshots.list() / snapshots.create(label) / snapshots.rename(id,label) / snapshots.restore(id)
plugins.list() / plugins.setEnabled(file, enabled) / plugins.remove(file) / plugins.reload()
ui.reload() / ui.reset()
notify(msg, type)
on(name, fn) / off(name, fn)               -> 订阅事件：ai:delta / ai:reasoning / ai:tool / ai:done / ai:error / settings:changed / ui:reload
`;

function buildSystemPrompt({ mode = 'agent', extra = '' } = {}) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const head = mode === 'agent' ? `你是 Morph 的「造物主」。

Morph 是一个可以被 AI 改写的 Windows 桌面程序：它最初只有一个 AI 对话窗口，但你可以直接修改它自己的网页代码，从而改变它的外观、布局、交互与功能——这是这个软件存在的意义。用户跟你说话的界面，就是你可以随手重写的界面。

## 运行环境
- 主界面是一个真实的网页，通过自定义协议 morph://ui/ 从数据目录加载，入口为 ui/index.html
- 完全离线运行：禁止依赖 CDN、外链字体、外链脚本（图片可以用内联 SVG 或 data URI）
- 程序会自动注入桥接对象 window.morph，这是界面与内核之间唯一的通道

## 文件地图（相对程序数据目录）
ui/index.html        界面入口（必须保留）
ui/style.css         界面样式
ui/app.js            界面逻辑
ui/*.js|*.css|*.html 可以任意拆分新的文件
shell/override.css   覆盖程序外壳（标题栏/侧栏）的样式，可选
data/kv.json         持久化数据（请通过 morph.kv 读写，不要直接改这个文件）
notes/PROJECT.md     你的项目笔记：每次大改后更新，记录当前界面结构、设计规范、未完成事项
docs/BRIDGE.md       桥接 API 完整说明
plugins/             插件工具（完全权限下加载，每个 .js 导出一个工具）

## 桥接 API（window.morph，全部返回 Promise）
${BRIDGE_DOC}
## 硬性规则
1. 先看再改：动手前用 list_files / read_file 搞清楚现状，不要凭空猜代码。
2. 不要破坏 window.morph 相关调用，否则界面会与内核失联。
3. 改了 ui/ 下任何文件后，必须调用 reload_ui 让其生效（界面会刷新，会话记录由 ui 自己持久化）。
4. 不要自动存版本：只有用户明确说「先存一版 / 备份一下」时才用 snapshot_create。用户自己保存过的版本可以用 snapshot_list 查看、snapshot_restore 恢复。
5. 设计标准要高：现代、克制、有呼吸感；跟随现有风格（出厂是白底朴素，不要无故大改配色），统一圆角/间距；不堆砌特效。改造时保留聊天核心能力，除非用户明确要求改成别的东西。
6. 中文界面、中文回答。
7. 绝不读取、输出或试探 API Key；settings 里只能看到 hasKey。
8. 不要写 settings.json，不要碰 snapshots 目录（用对应工具）；master/ 是锁定的出厂基线，读写都会被拒绝，别去试。
9. 用户只是闲聊时正常聊天，不要为了改而改。
10. 回答简短：说清改了什么、怎么用，不要粘贴整份代码。
11. 长内容分段写：一次调用的输出有硬上限，超了会在半截被截断，工具参数直接损坏。写超过约 150 行 / 10000 字符的文件时，必须分段：
    - 第一段用 write_file（整体覆盖）
    - 后续每段（建议 100~150 行）用 append_file 追加
    - 全部写完用 read_file 看结尾，确认没有缺尾巴
12. 写小改动优先 edit_file（只替换一段），它几乎不可能被截断。
13. 找代码用 find_files / search_files，看大文件用 read_file 的 offset/limit，不要靠 list_files 把目录整个猜一遍。
` : `你是 Morph 内置的 AI 助手，运行在用户的 Windows 桌面上。
回答用中文，简洁、直接、有信息量。你可以帮用户做任何日常问答与写作任务。
${extra}`;

  const full = settings.isFull();
  const perm = full
    ? `## 权限：完全权限（已开启）
- 可以执行系统命令：run_command（PowerShell），能读写整台电脑上的任意文件
- 可以给自己加工具：把插件写到 plugins/xxx.js（module.exports = {name, description, parameters, run(args, ctx)}），再调用 plugins_reload 注册，立刻可用
- 执行删除、覆盖、装包、改系统设置这类不可逆操作前，先用一句话跟用户确认
- 不要读取或外泄 API Key；settings.json / snapshots/ / master/ 依旧不可访问`
    : `## 权限：沙箱（默认）
- 只能读写程序数据目录里的界面代码，不能执行系统命令
- 如果用户想要新能力，可以告诉他：在设置里打开「完全权限」后你就能执行命令、并给自己写插件`;

  return head + `\n${perm}\n\n## 当前状态\n- 时间：${now}\n- 对话通道：${mode === 'agent' ? '桌面主界面' : '普通对话'}\n`;
}

/**
 * 带工具的自省循环。
 * opts: { cfg, messages, system, channel, emit, reloadUi, recordWrite, signal }
 */
async function run({ cfg, messages, system, channel = 'ui', emit, reloadUi, recordWrite, signal, maxSteps = 0 }) {
  // 优先级：调用方显式传入 > 设置里的 maxSteps > 出厂 40
  const stepLimit = Math.max(1, Number(maxSteps) || Number(cfg && cfg.maxSteps) || 40);
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });
  for (const m of messages) {
    if (!m || !m.role || m.role === 'system') continue;
    if (m.role === 'tool') continue;
    // content 既可能是字符串，也可能是 [ {type:'text'}, {type:'image_url'} ] 这种多模态数组
    const hasText = typeof m.content === 'string' && m.content.trim();
    const hasParts = Array.isArray(m.content) && m.content.length > 0;
    if (!hasText && !hasParts) continue;
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }

  const toolLog = [];
  let lastText = '';
  const ctx = {
    channel,
    reloadUi,
    recordWrite,
    onTool: (e) => emit && emit('ai:tool', e),
  };

  for (let step = 0; step < stepLimit; step++) {
    if (signal?.aborted) throw Object.assign(new Error('已中止'), { name: 'AbortError' });

    const res = await ai.streamChat({
      cfg,
      messages: msgs,
      tools: tools.list(),
      signal,
      onDelta: (t) => emit && emit('ai:delta', { text: t }),
      onReasoning: (t) => emit && emit('ai:reasoning', { text: t }),
    });

    if (res.content) lastText = res.content;

    if (!res.toolCalls.length) {
      let text = res.content || lastText;
      if (res.degraded) {
        text = '> ⚠️ 当前模型不支持工具调用（function calling），这一轮只做了普通对话，**没有改动任何文件**。换成支持工具调用的模型（如 deepseek-chat / glm-4 / qwen-plus）我才能改这个程序。\n\n' + text;
      }
      if (res.truncated) {
        text += '\n\n_（这条回复撞到了「单次最大 token」的上限被截断。可以让它说「继续」，或者让它把长文件拆成分段写入。）_';
      }
      return { text, reasoning: res.reasoning, usage: res.usage, tools: toolLog, steps: step + 1 };
    }

    msgs.push({ role: 'assistant', content: res.content || '', tool_calls: res.toolCalls });

    for (const call of res.toolCalls) {
      const name = call.function.name;
      let argsPreview = call.function.arguments || '';
      let resultText = '';
      let ok = true;
      try {
        const parsed = JSON.parse(argsPreview || '{}');
        argsPreview = JSON.stringify(parsed).slice(0, 240);
      } catch { /* keep raw */ }
      emit && emit('ai:tool', { phase: 'start', name, args: argsPreview });

      try {
        const out = await tools.execute(name, call.function.arguments, ctx);
        resultText = JSON.stringify(out);
      } catch (e) {
        ok = false;
        resultText = JSON.stringify({ ok: false, error: e.message });
      }

      if (resultText.length > 20000) resultText = resultText.slice(0, 20000) + '... (结果过长已截断)';
      toolLog.push({ name, ok, args: argsPreview, result: resultText.slice(0, 600) });
      emit && emit('ai:tool', { phase: 'result', name, ok, args: argsPreview, result: resultText.slice(0, 600) });

      msgs.push({ role: 'tool', tool_call_id: call.id, content: resultText });
    }
  }

  return { text: lastText + '\n\n_（已达到单轮工具调用上限，如果还没改完，请再发一句「继续」）_', tools: toolLog, steps: stepLimit };
}

module.exports = { run, buildSystemPrompt, BRIDGE_DOC };
