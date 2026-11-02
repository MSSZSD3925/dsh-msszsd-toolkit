/**
 * dsh-toolkit:toggles —— 运行期开关（模块 + 子功能）。
 *
 * 为什么单独一个文件：模块的 `enabled` 只在 apply() 时读配置，改一次要重启；
 * 插件详情页上的开关必须是「点一下立刻生效」的，所以状态放在 DSH 进程之外、
 * 由各模块在真正干活前读一次（带缓存），改文件就改行为。
 *
 * 文件：$DSH_HOME/dsh-toolkit-toggles.json
 *   新形状 { "qq": { "enabled": true, "sub": { "inbound_media": false } }, ... }
 *   旧形状 { "qq": true, "session_ask": false } 仍然认：布尔值当 enabled，
 *   子功能缺键 = 开。缺整个模块 = 开，所以删掉文件等于全开。
 */
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './local-config.js'

/** 模块与子功能的元数据：卡片按这个渲染，服务端按这个校验 */
export const MODULE_META = [
  {
    name: 'qq',
    label: 'QQ 远程驾驶',
    desc: '从 QQ 收消息、发通知与文件；关掉后消息不再进入 DSH，三个 QQ 工具也会拒绝调用。',
    subs: [
      { key: 'inbound_media', label: '入站媒体', desc: '把 QQ 里的图片、语音、文件下载到本机再注入会话；关掉只留文字提示。' },
      { key: 'forward_merge', label: '长回复合并转发', desc: '回复超过切分线时用合并转发一次发出；关掉退回逐条发送。' },
      { key: 'sticker', label: '表情与图片', desc: '#img / #sticker 与 qq_send_image：把本机图片、动图当表情发出去。' },
      { key: 'tools', label: '互动工具', desc: 'qq_poke / qq_like / qq_reply / qq_recall 这四个工具。' },
      {
        key: 'share_slot',
        label: '分享槽（只读问答）',
        desc: '让外部账号或群读授权目录并回答；关掉后分享槽命令与消息一律拒绝。',
        danger: true,
      },
      {
        key: 'dual_key',
        label: '双权限令牌（读写一条）',
        desc: '#keynew both <读目录> [git 目录]：一条令牌同时能读目录、能在隔离工作区改文件。关掉后这条命令不可用。',
        danger: true,
      },
      {
        key: 'share_ai_only',
        label: '分享槽仅 AI 可用',
        desc: '打开后 QQ 侧不能再通过分享槽提问，只能用 AI 侧（桥 / 请求入口）。默认关。',
        defaultOff: true,
        danger: true,
      },
      {
        key: 'team_slot',
        label: '团队槽（隔离工作区改文件）',
        desc: '让外部账号在 git worktree 里改文件、提交到临时分支；关掉后团队槽命令与消息一律拒绝。',
        danger: true,
      },
      {
        key: 'team_ai_only',
        label: '团队槽仅 AI 可用',
        desc: '打开后 QQ 侧不能再通过团队槽提改动请求，只能用 AI 侧。默认关。',
        defaultOff: true,
        danger: true,
      },
      {
        key: 'adapter_dsh',
        label: 'DSH 插件适配',
        desc: '插件详情页「DSH 插件适配」那一栏：生成提示词、可另起会话让别的 DSH 插件接 dshToolkitQq；关掉后只剩测试。',
        danger: true,
      },
      {
        key: 'adapter_im',
        label: '通讯软件插件适配',
        desc: '插件详情页「通讯软件插件适配」那一栏：生成协议层（transport）接入提示词；关掉后只剩测试。',
        danger: true,
      },
    ],
  },
  {
    name: 'session_ask',
    label: '跨会话提问',
    desc: '向本机另一个会话问一句并取回回答；关掉后四个 session_ask* 工具都不再工作。',
    subs: [{ key: 'context_guard', label: '上下文守卫', desc: '目标上下文超过守卫线时额外要一次人工确认，防止提问触发压缩。' }],
  },
  {
    name: 'pause',
    label: '暂停按钮',
    desc: '界面左下角的暂停：在下一个步进边界停住等你补话。',
    subs: [],
  },
  {
    name: 'restart',
    label: '重启 DSH',
    desc: '由计划任务在进程树之外杀掉再拉起；关掉后 restart 类请求直接拒绝。',
    subs: [{ key: 'auto_resume', label: '重启后自动续跑', desc: '重启完成后自动叫醒刚才在跑的会话继续做。' }],
  },
  {
    name: 'peak',
    label: '贵时段纪律',
    desc: '工作日高峰时段把纪律段注入系统提示；关掉后不再注入。',
    subs: [],
  },
]

export const MODULES = MODULE_META.map((m) => m.name)
const CACHE_MS = 1500

let cache = { at: 0, value: null, mtime: '0:0' }

export function togglesPath() {
  return join(dshHome(), 'dsh-toolkit-toggles.json')
}

const subKeys = (name) => MODULE_META.find((m) => m.name === name)?.subs.map((s) => s.key) ?? []

function normalize(raw) {
  const out = {}
  for (const meta of MODULE_META) {
    const node = raw?.[meta.name]
    if (typeof node === 'boolean') {
      out[meta.name] = { enabled: node, sub: {} }
      continue
    }
    const enabled = node?.enabled !== false
    const sub = {}
    // 旧版本把两个槽合成一个 qq.slots 开关，这里给它拆开：旧键关了就等于两个都关
    const legacySlots = node?.sub?.slots
    for (const s of meta.subs) {
      const own = node?.sub?.[s.key]
      if (own === undefined && legacySlots !== undefined && (s.key === 'share_slot' || s.key === 'team_slot')) {
        sub[s.key] = legacySlots !== false
      } else {
        sub[s.key] = s.defaultOff ? own === true : own !== false
      }
    }
    out[meta.name] = { enabled, sub }
  }
  return out
}

function readFileState() {
  try {
    return normalize(JSON.parse(readFileSync(togglesPath(), 'utf8')))
  } catch {
    return null
  }
}

/** 当前开关表（规范化后的嵌套形状）。1.5 秒缓存 + mtime 变化立即失效。 */
export function readToggles() {
  // 用纳秒 mtime 做键：毫秒精度下连续两次写入（比如测试里立刻改写文件）会撞成同一时间戳，
  // 缓存就会一直返回旧值，表现为「改了开关不生效」。
  let mtime = '0:0'
  try {
    const st = statSync(togglesPath(), { bigint: true })
    mtime = `${st.mtimeNs}:${st.size}`
  } catch {
    mtime = '0:0'
  }
  if (cache.value && mtime === cache.mtime) return cache.value
  const value = readFileState() ?? normalize(null)
  cache = { at: Date.now(), value, mtime }
  return value
}

/** 某个模块（可选某个子功能）现在开没开。未知名字一律当作开，避免拼错就把功能禁掉。 */
export function isOn(name, sub) {
  const key = String(name ?? '')
  if (!MODULES.includes(key)) return true
  const node = readToggles()[key]
  if (node.enabled === false) return false
  if (!sub) return true
  const sk = String(sub)
  if (!subKeys(key).includes(sk)) return true
  return node.sub[sk] !== false
}

/** 写一个开关（sub 省略时写模块级）。立即落盘并清缓存，返回写入后的完整开关表。 */
export function setToggle(name, value, sub) {
  const key = String(name ?? '')
  if (!MODULES.includes(key)) throw new Error(`未知模块：${key}（可用：${MODULES.join(' / ')}）`)
  const next = normalize(readToggles())
  if (sub) {
    const sk = String(sub)
    if (!subKeys(key).includes(sk)) throw new Error(`未知子功能：${key}.${sk}`)
    next[key].sub[sk] = value !== false
  } else {
    next[key].enabled = value !== false
  }
  const path = togglesPath()
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
  cache = { at: 0, value: next, mtime: '0:0' }
  return next
}

const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function snapshot() {
  return { ok: true, modules: readToggles(), meta: MODULE_META, path: togglesPath() }
}

/** JSON 端点小工具：只接受 POST 改状态 */
export function jsonRoute(ctx, path, handler) {
  const off = ctx.webServer.register({ kind: 'exact', path, handler })
  return off
}

export function readJsonBody(req, res, done) {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
    if (body.length > 8192) req.destroy()
  })
  req.on('end', () => done(body))
  req.on('error', () => {
    try {
      res.writeHead(400, headers)
      res.end(JSON.stringify({ ok: false, reason: 'bad-request' }))
    } catch {
      /* ignore */
    }
  })
}

/**
 * 给插件详情页上的开关卡注册端点：
 *   GET  <prefix>/toggles  -> { ok, modules, meta, path }
 *   POST <prefix>/toggles  body: { name, value, sub? } -> 同上
 */
export function registerRoutes(root, prefix = '/dsh-toolkit') {
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
      readJsonBody(req, res, (body) => {
        try {
          const payload = body ? JSON.parse(body) : {}
          const name = String(payload?.name ?? '')
          const value = payload?.value !== false
          const sub = payload?.sub ? String(payload.sub) : ''
          setToggle(name, value, sub)
          res.writeHead(200, headers)
          res.end(JSON.stringify(snapshot()))
        } catch (err) {
          res.writeHead(400, headers)
          res.end(JSON.stringify({ ok: false, reason: String(err?.message ?? err) }))
        }
      })
    })
  })
}
