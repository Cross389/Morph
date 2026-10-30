# Morph 桥接 API

界面运行在 `morph://ui/` 下，程序会自动注入 `window.morph`，它是界面与内核之间**唯一**的通道。

所有方法返回 Promise。普通调用失败时返回 `{ok:false, error}`（不会抛异常）；`ai.chat` / `ai.agent` 失败时 **reject**，要用 `try/catch`。参数里的 `content` 既可以是字符串，也可以是 `[{type:'text', text}, {type:'image_url', image_url:{url}}]` 这种多模态数组（图片需要视觉模型）。

```js
const info = await morph.app.info();
```

---

## app

| 方法 | 说明 |
| --- | --- |
| `morph.app.info()` | `{version, api, userDir, platform, safeMode, electron, chrome, node}` |
| `morph.app.openExternal(url)` | 用系统默认浏览器打开 http(s) 链接 |

## settings（多接口）

| 方法 | 说明 |
| --- | --- |
| `morph.settings.get()` | `{settings:{connections:[{id,name,baseUrl,model,models,hasKey,keyTail}], activeId, temperature, maxTokens, reasoning, permissions, systemPrompt, agentEnabled}}` |
| `morph.settings.save(patch)` | 只改标量：`temperature`(0–2) / `maxTokens`(64–64000) / `reasoning`(auto\|off\|low\|medium\|high) / `systemPrompt` / `agentEnabled` / `permissions`(sandbox\|full) |
| `morph.settings.activate({id, model})` | 切换当前接口 / 模型并持久化 |
| `morph.settings.saveAll(connections)` | 整表保存接口；`apiKey` 留空表示不修改已存的 Key |
| `morph.settings.remove(id)` | 删除接口 |
| `morph.settings.models({baseUrl, apiKey, id})` | 向该接口拉取模型列表：`{ok, models}` |
| `morph.settings.test({id, patch})` | 测试连通性：`{ok, result:{model, reply}}` 或 `{ok:false, error}` |

> 永远拿不到 API Key 明文，只有 `hasKey` 和 `keyTail`。

## ai

| 方法 | 说明 |
| --- | --- |
| `morph.ai.chat({messages, system?, requestId?, onDelta?, onReasoning?})` | 纯对话 |
| `morph.ai.agent({messages, system?, requestId?, onDelta?, onTool?})` | **带工具**：AI 可以读写本程序的文件、重载界面、回滚快照 |
| `morph.ai.abort(requestId)` | 中止一次生成 |
| `morph.ai.lastReply()` | 上一次助手回复 `{text, tools, ts, sid}`；只在「发送中途界面被重载」后用它补回 |

`messages` 是 `[{role:'user'|'assistant', content}]`，图片用多模态数组。
两个方法都返回 `{ok, requestId, text, tools, usage}`；流式文字通过 `onDelta(text)` 拿到。

## kv（持久化键值）

```js
await morph.kv.set('todo', [{ id: 1, text: '写代码', done: false }]);
const todo = await morph.kv.get('todo', []);
await morph.kv.del('todo');
const all = await morph.kv.all();
```

单个值上限 4MB；更大的数据请用 `files`。

## files（受限于程序数据目录）

```js
await morph.files.list('assets');      // [{path, type, size}]
await morph.files.read('notes/a.md');  // 字符串（>2MB 会被拒绝）
await morph.files.write('assets/x.json', '{}');
```

`settings.json`、`snapshots/`、`master/` 不可访问。

## snapshots（版本与回滚）

```js
const list = await morph.snapshots.list();   // [{id, ts, label, channel}]
await morph.snapshots.create('我的快照');
await morph.snapshots.rename(id, '新名字');
await morph.snapshots.remove(id);
await morph.snapshots.restore(id);           // 只覆盖 ui/ 与 shell/，不动 data/kv.json
```

版本完全手动保存，程序**不会**自动备份。

## plugins

```js
await morph.plugins.list();                   // [{file, name, description, enabled, ok, error}]
await morph.plugins.setEnabled(file, true);
await morph.plugins.remove(file);
await morph.plugins.reload();                 // 重新扫描 plugins/*.js
```

## ui

```js
await morph.ui.reload();   // 重新加载当前界面（改完 ui 文件后调用）
await morph.ui.reset();    // 恢复成出厂基线（不会自动备份）
```

## 事件

```js
const off = morph.on('ai:delta', (e) => console.log(e.text));
off(); // 取消订阅
```

可用事件：`ai:delta`、`ai:reasoning`、`ai:tool`（`{phase, name, ok}`）、`ai:done`、`ai:error`、`settings:changed`、`ui:reload`、`ui:openVersions`。

## 其它

```js
morph.notify('保存成功', 'ok');   // 弹出外壳提示条
morph.call('任意方法', {...});    // 底层调用
```
