// 机器人后端适配器（transport）。
//
// 当前架构只假设一件事：有一个「收消息 / 发 OneBot 动作」的对象。
// 适配器把这件事抽象成四个方法，换个后端只要新写一个文件、登记一次：
//
//   connect({ url, token, log, reconnection }) -> client
//   client.on('message', (event) => {})        收到的消息事件（OneBot 11 形状）
//   client.on('meta_event', (event) => {})     心跳等元事件（可选，用来记 self_id）
//   client.send(action, params)                发一个 OneBot 动作，返回 Promise
//   client.close?.()                           摘掉时断开（可选）
//
// event 至少要带 message_type、user_id 或 group_id、message、raw_message、self_id。
// action 至少要支持 send_private_msg、send_group_msg；其余能力按需实现，未实现时抛错即可。

import { connect as connectOneBot } from 'onebot.js'

const adapters = new Map()

export function registerTransport(name, adapter) {
  const key = String(name ?? '').trim().toLowerCase()
  if (!key) throw new Error('适配器名字不能为空')
  if (!adapter || typeof adapter.connect !== 'function') throw new Error(`适配器 ${key} 缺少 connect()`)
  adapters.set(key, adapter)
  return key
}

export function listTransports() {
  return [...adapters.keys()].map((name) => ({ name, description: adapters.get(name).description ?? '' }))
}

export async function openTransport(name, opts = {}) {
  const key = String(name ?? '').trim().toLowerCase() || 'onebot'
  const adapter = adapters.get(key)
  if (!adapter) {
    const known = [...adapters.keys()].join(', ') || '(空)'
    throw new Error(`未知的机器人后端：${key}（已注册：${known}）`)
  }
  return adapter.connect(opts)
}

// 默认后端：OneBot 11 正向 WebSocket。NapCat、Lagrange、LuckyLilliaBot 等都走这条路。
registerTransport('onebot', {
  description: 'OneBot 11 正向 WebSocket（NapCat / Lagrange / LuckyLilliaBot 等）',
  connect: ({ url, token, log, reconnection }) =>
    connectOneBot({ baseUrl: url, accessToken: token, log, reconnection }),
})
