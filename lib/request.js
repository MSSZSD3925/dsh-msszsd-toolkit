/**
 * 把「请求」做成结构化入口：上级 bot（或任何别的插件）不用冒充群成员说话，
 * 只需要带令牌发一条请求，拿回结果。
 *
 *   POST /dsh-toolkit/request
 *   { token, kind: 'ask' | 'change', text, from, confirm? }
 *
 * - ask    走分享令牌的只读路径（slots.answerShare），返回总结后的文本。
 * - change 走团队令牌的隔离工作区：第一次只回「待确认」与确认码，确认后
 *          才把要求交给上层注入的 applyChange（由 qq.js 提供，负责起会话、
 *          提交到临时分支），返回 diff 摘要；不做自动合并。
 *
 * 所有拒绝都返回 { ok:false, reason }，错误文案面向调用方，不暴露内部堆栈。
 */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CONFIRM_TTL = 5 * 60 * 1000

function randCode(len = 6) {
  let out = ''
  for (let i = 0; i < len; i += 1) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  return out
}

/**
 * 读请求体。
 * toggles.js 的 readJsonBody 是 (req, res, done) 回调式；当成 Promise 调用会让 done
 * 为 undefined，异常在 IncomingMessage 的 'end' 监听里抛出，直接带走宿主进程。
 * 这里用 Promise 版，所有异常都转成 reject，事件回调里不再抛。
 */
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let failed = false
    const fail = (err) => {
      if (failed) return
      failed = true
      reject(err)
    }
    req.on('data', (chunk) => {
      if (failed) return
      size += chunk.length
      if (size > limit) {
        fail(new Error('请求体太大（上限 1 MB）'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (failed) return
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        fail(new Error('请求体不是合法 JSON'))
      }
      return undefined
    })
    req.on('error', (err) => fail(err))
  })
}

function parsePeer(from) {
  const raw = String(from ?? '').trim()
  const m = /^(group|member):([0-9]{4,20})$/.exec(raw)
  if (!m) return null
  return { peer: m[2], peerKind: m[1] }
}

export function createRequests({ slots, log = () => {}, applyChange }) {
  const pending = new Map()

  function sweep() {
    const now = Date.now()
    for (const [code, item] of pending) if (item.expiresAt <= now) pending.delete(code)
  }

  async function handle({ token, kind, text, from, confirm } = {}) {
    sweep()
    const who = parsePeer(from)
    if (!who) throw new Error('from 必须是 group:<群号> 或 member:<QQ号>')
    const body = String(text ?? '').trim()
    if (!body) throw new Error('请求内容不能为空')
    if (body.length > 4000) throw new Error('请求内容太长（上限 4000 字）')

    const k = String(kind ?? '').trim()
    if (k !== 'ask' && k !== 'change') throw new Error("kind 只能是 'ask' 或 'change'")

    const grant = slots.grantForPeer(who.peer, k === 'ask' ? 'share' : 'team')
    if (!grant) {
      throw new Error(
        k === 'ask'
          ? '这个对象没有绑定分享令牌（要主号发 #keynew share <目录> 再 #bind）'
          : '这个对象没有绑定团队令牌（要主号发 #keynew team <git 目录> 再 #bind）',
      )
    }
    if (token && String(token) !== grant.token) {
      throw new Error(`令牌与绑定对象不符：这个对象绑的是 ${grant.token}`)
    }

    if (k === 'ask') {
      const res = await slots.answerShare({ peer: who.peer, question: body })
      if (res?.refused) return { ok: false, status: 'rejected', reason: res.refused }
      log(`[request] ask ${who.peerKind}:${who.peer} 令牌 ${grant.token}，${res?.files ?? 0} 个文件`)
      return { ok: true, status: 'answered', token: grant.token, text: res?.text ?? '', files: res?.files ?? 0 }
    }

    if (!confirm) {
      const code = randCode()
      pending.set(code, {
        token: grant.token,
        peer: who.peer,
        text: body,
        expiresAt: Date.now() + CONFIRM_TTL,
      })
      log(`[request] change ${who.peerKind}:${who.peer} 待确认，码 ${code}`)
      return {
        ok: true,
        status: 'need-confirm',
        token: grant.token,
        confirm: code,
        expiresAt: new Date(Date.now() + CONFIRM_TTL).toISOString(),
        message: '改动会先进隔离工作区、提交到临时分支，不会直接合回。把确认码交给人确认后再发一次。',
      }
    }

    const want = String(confirm).trim().toUpperCase()
    const item = pending.get(want)
    if (!item) throw new Error('确认码不对或已过期')
    if (item.peer !== who.peer || item.token !== grant.token) throw new Error('确认码不属于这个对象')
    pending.delete(want)

    if (typeof applyChange !== 'function') return { ok: false, status: 'unsupported', reason: '本进程没有接上团队执行器' }
    const res = await applyChange({ grant, text: item.text, from: from, peer: who.peer })
    log(`[request] change ${who.peerKind}:${who.peer} 已提交 ${res?.branch ?? ''}`)
    return { ok: true, status: 'diff', token: grant.token, ...res }
  }

  function makeHandler() {
    return async function handler(req, res) {
      const send = (code, obj) => {
        try {
          const body = JSON.stringify(obj)
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
          res.end(body)
        } catch (err) {
          log(`[request] 回包失败：${err?.message ?? err}`)
        }
      }
      if (req.method !== 'POST') return send(405, { ok: false, reason: '只接受 POST' })
      let payload = {}
      try {
        payload = await readBody(req)
      } catch (err) {
        return send(400, { ok: false, reason: String(err?.message ?? err) })
      }
      try {
        const out = await handle(payload ?? {})
        return send(out.ok === false ? 400 : 200, out)
      } catch (err) {
        log(`[request] 拒绝：${err?.message ?? err}`)
        return send(400, { ok: false, reason: String(err?.message ?? err) })
      }
    }
  }

  return { handle, makeHandler, pendingCount: () => pending.size }
}

export function registerRoutes(root, { prefix = '/dsh-toolkit', requests, isOn = () => true, log = () => {} } = {}) {
  const path = `${prefix}/request`
  root.inject(['webServer'], (ctx) => {
    const route = requests.makeHandler()
    const off = ctx.webServer.register({
      kind: 'exact',
      path,
      handler: (req, res) => {
        if (!isOn('qq')) {
          const body = JSON.stringify({ ok: false, reason: 'QQ 模块已在插件详情页关掉' })
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
          res.end(body)
          return
        }
        return route(req, res)
      },
    })
    log(`[request] 已注册 ${path}`)
    ctx.effect?.(() => () => off?.())
  })
}
