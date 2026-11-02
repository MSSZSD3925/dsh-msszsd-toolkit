// 端到端：一个假的 OneBot 11 服务端 + 真实的 transport/onebot.js，证明线上形状。
//
// 为什么要有这个文件：test-transport.mjs 只验证登记表，test-bridge.mjs 只用假
// 对象验证参数校验，两者都没碰过真正的 WebSocket。所以「一条消息能进来、一条
// send_private_msg 能出去」一直没有证据，只剩注释。这里在本地起一个最小
// OneBot 11 服务端（握手 + 文本帧，几十行，不依赖 ws 包），用生产代码路径
// openTransport('onebot') 连上去，逐条断言。
//
// 不需要 QQ 号，也不需要 NapCat：这是协议层自测，不是「打通了」。

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { openTransport } from './lib/transport.js'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 组一个服务端 → 客户端的帧（不掩码）。 */
function frame(data, opcode = 0x1) {
  const payload = Buffer.from(data, 'utf8')
  const len = payload.length
  let head
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len])
  } else if (len < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x80 | opcode
    head[1] = 126
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([head, payload])
}

/** 最小 OneBot 11 正向 WS 服务端：记下握手 URL 与收到的动作，按动作名回 OneBot 11 形状的响应。 */
function startOneBot11() {
  const state = { handshakeUrls: [], actions: [], sockets: new Set(), closings: [] }
  const server = createServer((_, res) => {
    res.writeHead(426).end()
  })

  const respond = (sock, request) => {
    const action = String(request.action ?? '')
    let body
    if (action === 'send_private_msg') body = { status: 'ok', retcode: 0, data: { message_id: 4242 } }
    else if (action === 'send_group_msg') body = { status: 'ok', retcode: 0, data: { message_id: 4243 } }
    else if (action === 'get_status') body = { status: 'ok', retcode: 0, data: { online: true, good: true } }
    // 没实现的动作：真实实现端通常回 retcode 1404/1400，客户端必须按失败处理
    else body = { status: 'failed', retcode: 1404, data: null, message: `unsupported action: ${action}` }
    sock.write(frame(JSON.stringify({ ...body, echo: request.echo ?? null })))
  }
  server.on('upgrade', (req, socket) => {
    state.handshakeUrls.push(String(req.url ?? ''))
    const key = String(req.headers['sec-websocket-key'] ?? '')
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    const head = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + accept,
      '',
      '',
    ].join('\r\n')
    socket.write(head)
    state.sockets.add(socket)
    state.closings.push(new Promise((resolve) => socket.once('close', resolve)))
    socket.on('error', () => state.sockets.delete(socket))

    let buf = Buffer.alloc(0)
    const drain = () => {
      for (;;) {
        if (buf.length < 2) return
        const opcode = buf[0] & 0x0f
        const masked = (buf[1] & 0x80) !== 0
        let len = buf[1] & 0x7f
        let off = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          off = 4
        } else if (len === 127) {
          if (buf.length < 10) return
          len = Number(buf.readBigUInt64BE(2))
          off = 10
        }
        const maskLen = masked ? 4 : 0
        if (buf.length < off + maskLen + len) return
        const mask = masked ? buf.subarray(off, off + 4) : null
        off += maskLen
        const payload = Buffer.from(buf.subarray(off, off + len))
        if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
        buf = buf.subarray(off + len)

        if (opcode === 0x8) {
          try {
            socket.end()
          } catch {
            /* 对端已关 */
          }
          return
        }
        if (opcode === 0x9) {
          socket.write(frame('', 0xa))
          continue
        }
        if (opcode === 0x1 || opcode === 0x2) {
          let request = null
          try {
            request = JSON.parse(payload.toString('utf8'))
          } catch {
            continue
          }
          state.actions.push(request)
          respond(socket, request)
        }
      }
    }
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      drain()
    })
  })

  return {
    state,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      return `ws://127.0.0.1:${port}`
    },
    /** 往所有连上来的客户端推一条事件（模拟 NapCat 那边发来的消息）。 */
    push(event) {
      for (const sock of state.sockets) sock.write(frame(JSON.stringify(event)))
    },
    async close() {
      for (const sock of state.sockets) {
        try {
          sock.destroy()
        } catch {
          /* 已关 */
        }
      }
      await Promise.all(state.closings)
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等一个条件成立；超时就失败，避免测试挂死。 */
async function waitFor(check, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await delay(20)
  }
  throw new Error(`等不到：${what}`)
}

const server = startOneBot11()
const url = await server.listen()
const token = 'S3KRET-do-not-leak'
const logs = []
// 与 qq.js 的 clientLog 同形：onebot.js 只调 info/warn/error/debug
const log = {
  info: (m) => logs.push(['info', String(m)]),
  warn: (m) => logs.push(['warn', String(m)]),
  error: (m) => logs.push(['error', String(m)]),
  debug: (m) => logs.push(['debug', String(m)]),
}

const client = await openTransport('onebot', {
  url,
  token,
  log,
  reconnection: { enable: false, attempts: 1, delay: 100 },
})
console.log('ok  默认后端连通本地 OneBot 11 服务端')

// ── 入站：数组形状（不写 message_format，最常见）────────────────────────────
const inbound = []
client.on('message', (event) => inbound.push(event))
server.push({
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend', // 没有 sub_type 时 onebot.js 会直接丢弃这条事件（只在 warn 里留一句）
  self_id: 10000,
  user_id: 392593439,
  message_id: 777,
  sender: { user_id: 392593439, nickname: '测试' },
  message: [{ type: 'text', data: { text: '在吗' } }],
  raw_message: '在吗',
})
await waitFor(() => inbound.length === 1, '入站消息事件')
const got = inbound[0]
assert.equal(got.post_type, 'message', 'handleMessage 的第一道门')
assert.equal(got.message_type, 'private')
assert.equal(Number(got.user_id), 392593439, '数字 id 能直接 Number()')
assert.equal(String(got.self_id), '10000', 'self_id 供群消息判断 @')
assert.equal(got.message_id, 777)
assert.deepEqual(got.message, [{ type: 'text', data: { text: '在吗' } }])
assert.equal(got.raw_message, '在吗')
console.log('ok  入站事件字段齐全，可直接喂给 handleMessage')

// ── 入站：CQ 字符串形状（message_format:'string'）────────────────────────────
server.push({
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  self_id: 10000,
  group_id: 888,
  user_id: 392593439,
  message_id: 778,
  message_format: 'string',
  sender: { user_id: 392593439, nickname: '测试' },
  message: '[CQ:at,qq=10000] 你好',
  raw_message: '[CQ:at,qq=10000] 你好',
})
await waitFor(() => inbound.length === 2, '群消息事件')
const group = inbound[1]
assert.equal(group.message_type, 'group')
assert.equal(Number(group.group_id), 888, '数字 group_id 能直接 Number()')
assert.ok(Array.isArray(group.message), 'CQ 字符串必须转成分段数组，否则 handleMessage 读不到 at')
assert.equal(group.message[0].type, 'at')
assert.equal(String(group.message[0].data.qq), '10000', '群消息靠 at.qq === self_id 判断被 @')
console.log('ok  CQ 字符串入站被转成分段数组，群消息可判 @')

// ── 出站：send_private_msg 真发出去 ─────────────────────────────────────────
const sent = await client.send('send_private_msg', { user_id: 392593439, message: '收到' })
await waitFor(() => server.state.actions.some((a) => a.action === 'send_private_msg'), '服务端收到 send_private_msg')
const req = server.state.actions.find((a) => a.action === 'send_private_msg')
assert.deepEqual(req.params, { user_id: 392593439, message: '收到' }, 'params 原样透传')
assert.ok(req.echo, '请求带 echo，服务端才能把响应配回去')
assert.equal(sent.message_id, 4242, 'sendRaw 的返回值就是 data，调用点要读 message_id')
console.log('ok  send_private_msg 出站，服务端收到 action/params/echo，返回 message_id=4242')

// ── 出站：参数错误与不支持的动作必须 reject，而不是挂死 ─────────────────────
let unsupported = null
try {
  await client.send('set_group_ban', { group_id: 888, user_id: 392593439, duration: 60 })
} catch (error) {
  unsupported = error
}
assert.ok(unsupported, '不支持的动作必须抛错：qq.js 的调用点靠 catch 退化成文字')
assert.equal(unsupported.action, 'set_group_ban', 'err.action 指明是哪个动作')
assert.equal(unsupported.response?.retcode, 1404, 'err.response 保留原始信封')
assert.match(String(unsupported.message), /retcode=1404/, '错误消息带 retcode')
console.log('ok  不支持的动作 reject 且带 action/response/message')

// ── 存活探针 get_status ────────────────────────────────────────────────────
const status = await client.send('get_status', {})
assert.equal(status.online, true)
console.log('ok  get_status 探针可用，看门狗的存活判定有真实依据')

// ── token 落点（这条是"已知缺陷"的证据，不是期望行为）──────────────────────
assert.ok(
  server.state.handshakeUrls.some((u) => u.includes('access_token=')),
  'onebot.js 把 token 拼在 WS query 里',
)
for (const [level, line] of logs) {
  assert.ok(!line.includes(token), `日志不得含 token，实际 [${level}] ${line}`)
}
console.log('ok  token 只在握手 URL 里，日志干净')

client.disconnect?.()
await server.close()
console.log('E2E_ONEBOT_OK')
