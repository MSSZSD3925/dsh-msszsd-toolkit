# 适配 dsh-qq-link（最小接口）

目标：让 dsh-qq-link 的 QQ 消息进 dsh-msszsd-toolkit 的会话，回话也由它发出去；dsh-qq-link 自己那套「建会话 + followup」关掉，避免两边各回一遍。

## 它是什么

`Yuuyuko-uu/dsh-qq-link`（764 KB、纯 JS）不连 WebSocket，而是定时轮询 OneBot 11 HTTP 的 `get_friend_msg_history` / `get_group_msg_history`（默认 `127.0.0.1:3000`），把私聊与群消息塞进它自己建的会话，回话走 `send_private_msg` / `send_group_msg`。

## 两步接入

1. 把 `adapter.mjs` 复制到 dsh-qq-link 的 `lib/` 下。
2. 在它的 `lib/host.js` 里插两行。

### 入站（QQ → 我们）

在「QQ → DSH」的入口函数里、调用 `agent.followup(...)` 之前插入：

```js
const 桥 = 桥接()            // 模块级缓存 installBridge(ctx) 的结果
if (桥.active) {
  await 桥.deliver(event, { isGroup })   // event 是 OneBot11 原始事件，isGroup 从轮询参数来
  return                                  // 不要再 followup，也不要再写它自己的历史
}
```

`deliver` 会把事件规范化成 `{ post_type:'message', message_type, sub_type, self_id, user_id, group_id?, message, raw_message, sender, message_id }`，其中 `sub_type` 必填（私聊 `friend`/`group`、群 `normal`），缺了会被我们那边整条丢弃。

### 出站（我们 → QQ）

它的发送函数里，把 `send_private_msg` / `send_group_msg` 的调用换成：

```js
const { action, params } = toSendParams({ peer, isGroup, text, quoteId })
// 直接用本插件已有的 OneBot 客户端调 action/params；或交给我们的 send
await 桥.send({ peer, isGroup, text, quoteId })
```

`桥.send` 会按 `peer` 与 `isGroup` 选私聊/群动作并带上引用段。

## 不需要改的

- 它建出来的会话、它自己的路由表、它的面板：桥接通后都不再参与消息流，留着不影响。
- 它的配置、OneBot 地址、重连：照旧由它管，我们只借用事件与发送。

## 边界

- 桥只在宿主里有 `dshToolkitQq` 时生效；没有就原样退回它自己的行为（`installBridge` 返回 `active:false`）。
- 双向都走我们的绑定号、白名单、槽授权与监管；dsh-qq-link 那边不要绕过。
- 同一个 NapCat 被两边同时轮询/连接时，日志里同一条消息会出现两次。用我们的 `#bind <口令>` 把本插件限定在一个号上，剩下的交给 dsh-qq-link。

## 自测

```bash
node test-adapter.mjs
```

覆盖：群/私聊规范化、缺字段报错、发送参数与引用段、无服务时不接管、有服务时接管。
