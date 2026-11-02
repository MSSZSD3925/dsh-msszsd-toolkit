/**
 * dsh-toolkit:sticker-dir —— 表情目录的运行期设置。
 *
 * 优先级：$DSH_HOME/dsh-toolkit-stickers.json 里的 dir
 *        > 插件配置里的 qq.sticker_dir
 *        > $DSH_HOME/dsh-toolkit-stickers
 * 运行期可改（#stickerpath / 插件详情页），不写回插件配置，避免动 link 安装的仓库文件。
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './local-config.js'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

export function settingsPath() {
  return join(dshHome(), 'dsh-toolkit-stickers.json')
}

export function readStickerDir() {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    const dir = String(parsed?.dir ?? '').trim()
    return dir
  } catch {
    return ''
  }
}

export function writeStickerDir(dir) {
  const path = settingsPath()
  const tmp = `${path}.tmp`
  const value = String(dir ?? '').trim()
  writeFileSync(tmp, `${JSON.stringify({ dir: value }, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
  return value
}

/** 实际生效的表情目录：运行期设置 > 配置 > 默认 */
export function resolveStickerDir(configValue, fallbackDefault) {
  const runtime = readStickerDir()
  if (runtime) return runtime
  const configured = String(configValue ?? '').trim()
  if (configured) return configured
  return fallbackDefault
}

function countImages(dir, depth = 3) {
  let n = 0
  let walk = (d, level) => {
    let entries = []
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (level < depth) walk(p, level + 1)
        continue
      }
      const dot = e.name.lastIndexOf('.')
      if (dot > 0 && IMAGE_EXT.has(e.name.slice(dot).toLowerCase())) n += 1
    }
  }
  walk(dir, 1)
  return n
}

/** 当前生效目录 + 是否存在 + 图片数，给卡片与 #stickerpath 用 */
export function stickerInfo(configValue, fallbackDefault) {
  const dir = resolveStickerDir(configValue, fallbackDefault)
  const exists = dir ? existsSync(dir) : false
  let isDir = false
  try {
    isDir = exists && statSync(dir).isDirectory()
  } catch {
    isDir = false
  }
  return { dir, exists: isDir, source: readStickerDir() ? 'runtime' : String(configValue ?? '').trim() ? 'config' : 'default', count: isDir ? countImages(dir) : 0 }
}

/**
 * 给插件详情页注册端点：
 *   GET  /dsh-toolkit/stickers  -> { ok, dir, exists, source, count, fallback }
 *   POST /dsh-toolkit/stickers  body: { dir } -> 同上（空字符串 = 恢复默认）
 */
export function registerRoutes(root, prefix = '/dsh-toolkit', configValue = '', fallbackDefault = '') {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  const info = () => ({ ok: true, ...stickerInfo(configValue, fallbackDefault), fallback: fallbackDefault })
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
        root.logger?.warn?.(`[stickers] 路由注册失败 ${path}: ${err?.message ?? err}`)
      }
    }
    route(`${prefix}/stickers`, (req, res) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        res.writeHead(200, headers)
        res.end(JSON.stringify(info()))
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
        if (body.length > 8192) req.destroy()
      })
      req.on('end', () => {
        try {
          const payload = body ? JSON.parse(body) : {}
          const raw = String(payload?.dir ?? '').trim()
          if (raw && (!existsSync(raw) || !statSync(raw).isDirectory())) {
            res.writeHead(400, headers)
            res.end(JSON.stringify({ ok: false, reason: `目录不存在：${raw}` }))
            return
          }
          writeStickerDir(raw)
          res.writeHead(200, headers)
          res.end(JSON.stringify(info()))
        } catch (err) {
          res.writeHead(400, headers)
          res.end(JSON.stringify({ ok: false, reason: String(err?.message ?? err) }))
        }
      })
    })
  })
}
