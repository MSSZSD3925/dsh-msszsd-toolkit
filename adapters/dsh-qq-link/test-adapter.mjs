import { strict as assert } from 'node:assert'
import { installBridge, toBridgeEvent, toSendParams } from './adapter.mjs'

// 群消息规范化
{
  const ev = toBridgeEvent(
    { self_id: 2980000000, user_id: 392593439, group_id: 1127790800, message: [{ type: 'text', data: { text: '目录里有什么' } }], raw_message: '目录里有什么', message_id: 11 },
    { isGroup: true },
  )
  assert.equal(ev.post_type, 'message')
  assert.equal(ev.message_type, 'group')
  assert.equal(ev.group_id, '1127790800')
  assert.equal(ev.user_id, '392593439')
  assert.equal(ev.sub_type, 'normal')
  console.log('ok  群消息转成 bridge 形状')
}

// 私聊缺 user_id 要直接报错
{
  assert.throws(() => toBridgeEvent({ group_id: 1 }, { isGroup: false }), /user_id/)
  assert.throws(() => toBridgeEvent({ user_id: 1 }, { isGroup: true }), /group_id/)
  console.log('ok  缺字段直接报错，不做猜测')
}

// 发送参数
{
  const priv = toSendParams({ peer: '392593439', text: 'hi' })
  assert.equal(priv.action, 'send_private_msg')
  assert.equal(priv.params.user_id, '392593439')
  const grp = toSendParams({ peer: '1127790800', isGroup: true, text: 'hi', quoteId: '99' })
  assert.equal(grp.action, 'send_group_msg')
  assert.equal(grp.params.group_id, '1127790800')
  assert.equal(grp.params.message[0].type, 'reply')
  assert.equal(grp.params.message[1].data.text, 'hi')
  console.log('ok  发送参数与引用段正确')
}

// 没有服务时保持原行为
{
  const off = installBridge({ get: () => undefined })
  assert.equal(off.active, false)
  console.log('ok  没有 dshToolkitQq 时不动原插件')
}

// 有服务时接管
{
  const got = []
  const fake = { deliver: (e) => got.push(e), send: () => {} }
  const on = installBridge({ get: (n) => (n === 'dshToolkitQq' ? fake : undefined) })
  assert.equal(on.active, true)
  on.deliver({ user_id: 42, message: [], raw_message: 'x' })
  assert.equal(got.length, 1)
  assert.equal(got[0].message_type, 'private')
  console.log('ok  有服务时接管并把消息交出去')
}

console.log('ADAPTER_OK')
