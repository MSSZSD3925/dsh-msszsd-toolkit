/**
 * dsh-toolkit:toggles —— 运行期开关。
 *
 * 为什么单独一个文件：模块的 `enabled` 只在 apply() 时读配置，改一次要重启；
 * 插件详情页上的开关必须是「点一下立刻生效」的，所以状态放在 DSH 进程之外、
 * 由各模块在真正干活前读一次（带缓存），改文件就改行为。
 *
 * 文件：$DSH_HOME/dsh-toolkit-toggles.json
 *   形状 { "qq": true, "session_ask": true, "pause": true, "restart": true, "peak": true }
 *   缺键 = 开（关掉才写 false），所以老配置、删文件都等于全开。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './local-config.js'

const MODULES = ['qq', 'session_ask', 'pause', 'restart', 'peak']
const CACHE_MS = 1500

let cache = { at: 0, value: null, mtime: -1 }

function togglesPath() {
  return join(dshHome(), 'dsh-toolkit-toggles.json')
}

function readFileState(path) {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    const out = {}
    for (const name of MODULES) out[name] = parsed?.[name] !== false
    return out
  } catch {
    return null
  }
}

/** 当前开关表；读不到文件就是全开。1.5 秒缓存，避免每次注入都摸磁盘。 */
export function readToggles() {
  const now = Date.now()
  if (cache.value && now - cache.at < CACHE_MS) return cache.value
  const value = readFileState(togglesPath()) ?? Object.fromEntries(MODULES.map((name) => [name, true]))
  cache = { at: now, value, mtime: now }
  return value
}

/** 某个模块现在开没开。未知名字一律当作开，避免拼错就把功能禁掉。 */
export function isOn(name) {
  const key = String(name ?? '')
  if (!MODULES.includes(key)) return true
  return readToggles()[key] !== false
}

/** 写一个开关。立即落盘并清缓存，返回写入后的完整开关表。 */
export function setToggle(name, value) {
  const key = String(name ?? '')
  if (!MODULES.includes(key)) throw new Error(`未知模块：${key}（可用：${MODULES.join(' / ')}）`)
  const next = { ...readToggles(), [key]: value !== false }
  const path = togglesPath()
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
  cache = { at: 0, value: next, mtime: 0 }
  return next
}

export { MODULES, togglesPath }

/**
 * 给插件详情页上的开关卡注册两个端点（同一份状态，卡片用 fetch 读写）：
 *   GET  <prefix>/toggles  -> { ok, modules: { name: bool }, path }
 *   POST <prefix>/toggles  body: { name, value } -> 同上
 * 只接受 POST 改状态（和 pause 一样，避免别的网页用 GET 链接就点到）。
 */
export function registerRoutes(root, prefix = '/dsh-toolkit') {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  const snapshot = () => ({ ok: true, modules: readToggles(), path: togglesPath() })
  root.inject(['webServer'], (ctx) => {
    const route = (path, handler) => {
      try {
        const off = ctx.webServer.register({ kind: 'exact', path, handler })
        ctx.effect?.(() => () => {
          try {
            off?.()
          } catch {
            /* ignore */
          }
        })
      } catch (err) {
        root.logger?.warn?.(`[toggles] 路由注册失败 ${path}: ${err?.message ?? err}`)
      }
    }
    route(`${prefix}/toggles`, (req, res) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        res.writeHead(200, headers)
        res.end(JSON.stringify(snapshot()))
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, headers)
        res.end(JSON.stringify({ ok: false, reason: 'method-not-allowed' }))
        return
      }
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 4096) req.destroy()
      })
      req.on('end', () => {
        try {
          const payload = body ? JSON.parse(body) : {}
          const name = String(payload?.name ?? '')
          const value = payload?.value !== false
          res.writeHead(200, headers)
          res.end(JSON.stringify({ ...snapshot(), modules: setToggle(name, value) }))
        } catch (err) {
          res.writeHead(400, headers)
          res.end(JSON.stringify({ ok: false, reason: String(err?.message ?? err) }))
        }
      })
    })
  })
}

