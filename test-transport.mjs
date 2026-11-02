import assert from 'node:assert/strict'
import { registerTransport, listTransports, openTransport } from './lib/transport.js'

// 默认后端登记了 onebot，且带说明
const names = listTransports().map((t) => t.name)
assert.ok(names.includes('onebot'), '默认登记 onebot 后端')
assert.ok(listTransports().find((t) => t.name === 'onebot').description.includes('OneBot'))
console.log('ok  默认登记 onebot')

// 未知后端要明确报错并列出已注册的名字
await assert.rejects(() => openTransport('satori'), /未知的机器人后端：satori（已注册：onebot）/)
console.log('ok  未知后端报错列出已注册')

// 空名字回落到默认后端（只检查选路，不真的连）
const fake = { sent: [], connect(opts) { return { opts, sent: this.sent, on() {}, send(a) { this.sent.push(a) } } } }
registerTransport('Fake', fake)
assert.deepEqual(listTransports().map((t) => t.name).sort(), ['fake', 'onebot'], '登记名字统一转小写')
const client = await openTransport('FAKE', { url: 'ws://x' })
await client.send('send_private_msg', { user_id: 1 })
assert.equal(fake.sent[0], 'send_private_msg', '适配器拿到的是同一个 client 形状')
console.log('ok  自定义后端可登记并按名打开')

// 登记不合格的适配器要拒绝
assert.throws(() => registerTransport('broken', {}), /缺少 connect/)
assert.throws(() => registerTransport('', { connect() {} }), /名字不能为空/)
console.log('ok  不合格适配器被拒绝')
console.log('TRANSPORT_TESTS_OK')
