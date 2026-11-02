// 用本地 http 服务器模拟 webServer，验证适配路由的处理器形状（res.writeHead/end）没问题。
import http from 'node:http'
import assert from 'node:assert/strict'
import { registerRoutes } from './lib/adapter.js'

const handlers = new Map()
const root = {
  inject(_deps, fn) {
    fn({
      webServer: {
        register({ path, handler }) {
          handlers.set(path, handler)
          return () => handlers.delete(path)
        },
      },
      effect() {},
    })
  },
}

const ctx = { get: () => undefined }
registerRoutes(root, { prefix: '/dsh-toolkit', ctx, log: () => {} })

const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  const fn = handlers.get(path)
  if (!fn) {
    res.writeHead(404).end()
    return
  }
  fn(req, res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const g = await fetch(`${base}/dsh-toolkit/adapter/prompt?kind=im&plugin=AstrBot`, {
  signal: AbortSignal.timeout(5000),
})
const gj = await g.json()
assert.equal(gj.ok, true, 'GET prompt 应 ok')
assert.equal(gj.kind, 'im')
assert.ok(gj.chars > 1000)
console.log('ok  GET prompt 返回提示词，', gj.chars, '字')

const t = await fetch(`${base}/dsh-toolkit/adapter/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'im', plugin: 'AstrBot', test: true }),
  signal: AbortSignal.timeout(5000),
})
const tj = await t.json()
assert.equal(tj.ok, true, 'test 模式应 ok')
assert.equal(tj.test, true)
assert.equal(tj.sessionId, undefined, 'test 模式不建会话')
console.log('ok  POST test:true 只回提示词，不建会话')

const bad = await fetch(`${base}/dsh-toolkit/adapter/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'nope', plugin: 'x' }),
  signal: AbortSignal.timeout(5000),
})
const bj = await bad.json()
assert.equal(bj.ok, false)
assert.match(bj.reason, /类型只能是/)
console.log('ok  非法 kind 被拒')

const ph = await fetch(`${base}/dsh-toolkit/adapter/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'dsh', plugin: '这也是一个测试请求', test: true }),
  signal: AbortSignal.timeout(5000),
})
const pj = await ph.json()
assert.equal(pj.ok, false)
assert.match(pj.reason, /占位符/)
console.log('ok  占位符名字被拒')

server.close()
console.log('ROUTE_SHAPE_OK')
