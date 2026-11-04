/**
 * dsh-msszsd-toolkit：会话看护 —— 面对 DSH 的那一半。
 *
 * 逻辑全在 session-watch-scan.js（纯 node，可单测）；这里只做三件事：
 *   1. 配置 schema（cordis.patch.yml 里的 session_watch 段）
 *   2. 定时器：插件加载 3 秒后扫一次，之后按 interval_secs 扫
 *   3. 详情页端点：GET 读状态、POST {action:'scan'|'open'}
 *
 * 判定与产物说明见 session-watch-scan.js 头部注释。
 */
import z from '@deepseek-ai/schemastery'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { reportDir, scanSessions } from './session-watch-scan.js'

export const Config = z.object({
  enabled: z.boolean().default(true).description('总开关；关掉后不扫描、也不干活'),
  dir: z.string().default('').description('报告目录，留空 = $DSH_HOME/dsh-session-watch'),
  scan_on_start: z.boolean().default(true).description('插件加载后扫一次（等 3 秒，避开启动高峰）'),
  interval_secs: z.number().default(900).description('定时扫描间隔（秒），最小 60'),
  max_age_days: z.number().default(14).description('只扫最近这些天动过的会话，0 = 不限'),
  tail_bytes: z.number().default(4194304).description('每个会话日志只读尾部这么多字节'),
  max_rows: z.number().default(8).description('卡片上最多列几条异常'),
  open_command: z.string().default('').description('打开目录用的命令，留空 = explorer.exe'),
})

const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function sendJson(res, status, body) {
  try {
    res.writeHead(status, headers)
    res.end(JSON.stringify(body))
  } catch {
    /* 客户端已断开 */
  }
}

/** 命令在不在：绝对路径或带分隔符的查文件，裸名字查 PATH（Windows 补 .exe）。 */
function resolveCommand(cmd) {
  const name = String(cmd || '').trim()
  if (!name) return ''
  const hasSep = name.includes('/') || name.includes(String.fromCharCode(92))
  const exts = ['']
  if (process.platform === 'win32' && !/\.[a-z0-9]+$/i.test(name)) exts.push('.exe', '.cmd', '.bat')
  if (hasSep) {
    for (const ext of exts) if (existsSync(name + ext)) return name + ext
    return ''
  }
  const dirs = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return ''
}

/** 用资源管理器打开目录或选中文件；失败不抛，返回 ok:false 让卡片显示路径兜底。 */
export function openInExplorer(target, config = {}) {
  const raw = String(config?.open_command || '').trim() || 'explorer.exe'
  const found = resolveCommand(raw)
  if (!found) return { ok: false, target, reason: `找不到要执行的程序：${raw}（可以在配置里改 open_command）` }
  const sep = String.fromCharCode(92)
  const isFile = existsSync(target) && !String(target).endsWith(sep) && !String(target).endsWith('/')
  const args = /explorer(\.exe)?$/i.test(found) && isFile ? [`/select,${target}`] : [target]
  try {
    const child = spawn(found, args, { detached: true, stdio: 'ignore', windowsHide: false })
    // spawn 的失败是异步 'error' 事件，不接这个监听会让整个宿主进程崩掉
    child.on('error', () => {})
    child.unref()
    return { ok: true, target, command: `${found} ${args.join(' ')}` }
  } catch (err) {
    return { ok: false, target, reason: err instanceof Error ? err.message : String(err) }
  }
}

export function registerRoutes(root, options = {}) {
  const prefix = options.prefix || '/dsh-toolkit'
  const dir = options.dir
  const state = options.state || {}
  const isOn = typeof options.isOn === 'function' ? options.isOn : () => true
  const runScan = typeof options.runScan === 'function' ? options.runScan : () => null
  const files = { report: join(dir, 'report.md'), latest: join(dir, 'latest.json'), events: join(dir, 'events.jsonl') }
  const path = `${prefix}/session-watch`
  const snapshotBody = (extra = {}) => ({
    ok: true,
    enabled: isOn('session_watch') !== false,
    dir,
    files,
    state: { at: state.at || 0, counts: state.counts || null, error: state.error || '' },
    ...extra,
  })
  root.inject(['webServer'], (ctx) => {
    let off
    try {
      off = ctx.webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => {
          if (!req || (req.method !== 'GET' && req.method !== 'POST')) return sendJson(res, 405, { ok: false, reason: 'method-not-allowed' })
          if (req.method === 'GET') {
            if (isOn('session_watch') === false) return sendJson(res, 200, snapshotBody({ reason: '会话看护在插件详情页被关掉了' }))
            return sendJson(res, 200, snapshotBody())
          }
          let body = ''
          req.on('data', (chunk) => {
            body += chunk
            if (body.length > 4096) req.destroy()
          })
          req.on('error', () => {})
          req.on('end', () => {
            let payload = {}
            try {
              payload = body ? JSON.parse(body) : {}
            } catch {
              return sendJson(res, 200, { ok: false, reason: '请求体不是合法 JSON' })
            }
            if (isOn('session_watch') === false) return sendJson(res, 200, snapshotBody({ ok: false, reason: '会话看护在插件详情页被关掉了' }))
            const action = String(payload?.action || '')
            if (action === 'open') {
              const target = String(payload?.target || 'dir')
              const map = { dir, report: files.report, latest: files.latest, events: files.events }
              return sendJson(res, 200, snapshotBody({ opened: openInExplorer(map[target] || dir, options.config) }))
            }
            if (action === 'scan') {
              const out = runScan()
              return sendJson(
                res,
                200,
                snapshotBody({
                  scanned: out ? { generatedAt: out.generatedAt, counts: out.counts, rows: out.rows || [] } : null,
                }),
              )
            }
            return sendJson(res, 200, { ok: false, reason: `未知动作：${action || '（空）'}` })
          })
        },
      })
    } catch (err) {
      root.logger?.warn?.(`[session-watch] 路由注册失败 ${path}: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    ctx.effect?.(() => () => {
      try {
        off?.()
      } catch {
        /* ignore */
      }
    })
  })
}

/**
 * @param ctx cordis 上下文
 * @param config Config 解析后的 session_watch 段
 * @param deps {{ isOn?: (name:string)=>boolean, log?: (line:string)=>void, prefix?: string }}
 */
export function apply(ctx, config, deps = {}) {
  const cfg = config || {}
  const dir = reportDir(cfg)
  const isOn = typeof deps.isOn === 'function' ? deps.isOn : () => true
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const state = { at: 0, counts: null, error: '' }
  const last = { rows: [] }

  const runScan = () => {
    if (isOn('session_watch') === false) return null
    try {
      const out = scanSessions({ dir, maxAgeDays: cfg.max_age_days, tailBytes: cfg.tail_bytes, maxRows: cfg.max_rows })
      state.at = out.generatedAt
      state.counts = out.counts
      state.error = ''
      last.rows = out.rows || []
      const total = out.counts.gone + out.counts.interrupted + out.counts.unfinished
      log(
        `[session-watch] 扫描完成：${out.counts.sessions} 个会话，异常 ${total} 条（消失 ${out.counts.gone} / 中断 ${out.counts.interrupted} / 未收尾 ${out.counts.unfinished}）-> ${dir}`,
      )
      return out
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err)
      log(`[session-watch] 扫描失败：${state.error}`)
      return null
    }
  }

  registerRoutes(ctx, { prefix: deps.prefix || '/dsh-toolkit', dir, state, isOn, runScan, config: cfg })

  const timers = []
  if (cfg.enabled !== false && cfg.scan_on_start !== false) {
    const t = setTimeout(runScan, 3000)
    t.unref?.()
    timers.push(t)
  }
  if (cfg.enabled !== false) {
    const every = Math.max(60, Number(cfg.interval_secs) || 900) * 1000
    const timer = setInterval(runScan, every)
    timer.unref?.()
    timers.push(timer)
  }
  ctx.effect?.(() => () => {
    for (const t of timers) {
      clearTimeout(t)
      clearInterval(t)
    }
  })
  return { runScan, dir, state }
}
