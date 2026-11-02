import assert from 'node:assert/strict'
import { createQqBridge, normalizeInbound } from './lib/qq-bridge.js'

// normalizeInbound：私聊、群聊、纯媒体
const priv = normalizeInbound({
  self_id: 10000,
  user_id: 42,
  message_type: 'private',
  message: [{ type: 'text', data: { text: ' 你好 ' } }],
  raw_message: '你好',
})
assert.equal(priv.peer, '42')
assert.equal(priv.peerKind, 'member')
assert.equal(priv.text, '你好')
assert.equal(priv.sender, '42')
assert.equal(priv.selfId, '10000')
console.log('ok  normalizeInbound 私聊')

const group = normalizeInbound(
  { self_id: 10000, user_id: 42, group_id: 888, message_type: 'group', message: [{ type: 'image', data: { file: 'a.png' } }] },
  [{ kind: 'image', path: 'C:/tmp/a.png', bytes: 10 }],
)
assert.equal(group.peer, '888')
assert.equal(group.peerKind, 'group')
assert.equal(group.text, '')
assert.equal(group.media.length, 1, '纯媒体消息也能带出 media')
console.log('ok  normalizeInbound 群聊与纯媒体')

// bridge：订阅、send、deliver、status
const calls = { sent: [], delivered: [], toggled: [] }
const bridge = createQqBridge({
  log: () => {},
  status: () => ({ connected: true, bound: 42 }),
  send: async ({ peer, isGroup, text, quoteId }) => calls.sent.push({ peer, isGroup, text, quoteId }),
  deliver: async (event) => calls.delivered.push(event),
})

const seen = []
const off = bridge.onInbound((msg) => seen.push(msg.text))
bridge.notifyInbound(priv)
bridge.notifyInbound({ ...group, text: '群消息' })
off()
bridge.notifyInbound({ ...priv, text: '不该看到' })
assert.deepEqual(seen, ['你好', '群消息'], '订阅能收到、取消后收不到')
console.log('ok  onInbound 订阅与取消')

assert.throws(() => bridge.onInbound('not a function'), /需要一个函数/)
console.log('ok  onInbound 拒绝非函数')

await bridge.send({ peer: 'group:888', text: 'hi', quoteId: '1' })
assert.deepEqual(calls.sent[0], { peer: '888', isGroup: true, text: 'hi', quoteId: '1' }, 'group: 前缀能识别成熟人还是群')
await bridge.send({ peer: 42, text: 'yo' })
assert.equal(calls.sent[1].isGroup, false)
assert.equal(calls.sent[1].peer, '42')
await assert.rejects(() => bridge.send({ peer: '' }), /需要 peer/)
console.log('ok  send 目标解析与校验')

await bridge.deliver({ message_type: 'private', user_id: 1 })
assert.equal(calls.delivered.length, 1)
assert.equal(calls.delivered[0].__bridgeTrusted, true, '外部事件打标，绕过 QQ 绑定口令闸门')
assert.equal(calls.delivered[0].post_type, 'message', 'deliver 必须补 post_type，否则被 handleMessage 静默丢弃')
await bridge.deliver({ post_type: 'notice', message_type: 'private', user_id: 1 })
assert.equal(calls.delivered[1].post_type, 'notice', '调用方显式传的 post_type 优先')
await assert.rejects(() => bridge.deliver({}), /缺少 message_type/)
await assert.rejects(() => bridge.deliver(null), /需要一个消息事件对象/)
console.log('ok  deliver 校验、转发与打标')

assert.deepEqual(bridge.status(), { name: 'dshToolkitQq', connected: true, bound: 42 })
console.log('ok  status 合并外层状态')

// 订阅者抛错不能打断别人，也要写日志
const errors = []
const b2 = createQqBridge({ log: (m) => errors.push(m), status: () => ({}), send: async () => {}, deliver: async () => {} })
let ok = 0
b2.onInbound(() => { throw new Error('boom') })
b2.onInbound(() => { ok += 1 })
b2.notifyInbound(priv)
assert.equal(ok, 1, '一个订阅者出错不影响其他订阅者')
assert.match(errors[0], /\[bridge\] 订阅者出错：boom/)
console.log('ok  订阅者出错被隔离')
console.log('BRIDGE_TESTS_OK')
