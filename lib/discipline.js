/**
 * dsh-toolkit:discipline —— 强纪律：给「花 token 的功能」设置允许时段。
 *
 * 开关卡片上的「强纪律」一节：打开后，每个被登记的目标（模块或子功能）只有在自己
 * 的允许时段里才可用；时段外 isOn() 一律返回 false，各模块原有的闸门会直接拒绝，
 * 不需要在每个功能里再写一遍判断。
 *
 * 文件：$DSH_HOME/dsh-toolkit-discipline.json
 *   { "enabled": true, "rules": [ { "id", "label", "target", "from", "to", "days", "enabled" } ] }
 *   target: "session_ask" / "qq.tools" / "restart" / "*"（* = 整个插件）
 *   days:   ISO 周一到周日 1..7，空数组 = 每天
 *   from/to: "HH:MM"；from 大于 to 表示跨夜（如 22:00 → 06:00）
 *
 * 自扩展：给一段自然语言描述（「每天 9 点到 18 点才允许跨会话提问」），
 * parseRule() 解析成规则；解析不出来的交给 llm 再试一次（可选）。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './local-config.js'

export const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

/** 可以被强纪律管住的目标：module 或 module.sub */
export const TARGETS = [
  { key: '*', label: '整个插件' },
  { key: 'session_ask', label: '跨会话提问（整块）' },
  { key: 'session_ask.context_guard', label: '跨会话提问 · 上下文守卫' },
  { key: 'qq', label: 'QQ 远程驾驶（整块）' },
  { key: 'qq.tools', label: 'QQ 互动工具（poke/like/撤回/回复）' },
  { key: 'qq.inbound_media', label: 'QQ 入站媒体下载' },
  { key: 'qq.sticker', label: 'QQ 表情与图片' },
  { key: 'qq.share_slot', label: '分享槽' },
  { key: 'qq.team_slot', label: '团队槽' },
  { key: 'qq.adapter_dsh', label: 'DSH 插件适配会话' },
  { key: 'qq.adapter_im', label: '通讯软件插件适配会话' },
  { key: 'restart', label: '重启 DSH' },
  { key: 'pause', label: '暂停按钮' },
  { key: 'peak', label: '贵时段纪律' },
]

export function disciplinePath() {
  return join(dshHome(), 'dsh-toolkit-discipline.json')
}

function isObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

/** "HH:MM" -> 分钟；非法返回 null */
export function parseClock(text) {
  const m = String(text ?? '').match(/^\s*(\d{1,2})\s*[:：]\s*(\d{1,2})\s*$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null
  return h * 60 + min
}

export function fmtClock(minutes) {
  const total = ((Number(minutes) % 1440) + 1440) % 1440
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function normalizeRule(raw) {
  if (!isObject(raw)) return null
  const target = String(raw.target ?? '').trim()
  if (!target || !TARGETS.some((t) => t.key === target)) return null
  const from = parseClock(raw.from)
  const to = parseClock(raw.to)
  if (from === null || to === null) return null
  const days = Array.isArray(raw.days)
    ? raw.days.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
    : []
  const label = String(raw.label ?? '').trim().slice(0, 60) || TARGETS.find((t) => t.key === target)?.label || target
  return {
    id: String(raw.id ?? '').trim() || `${target}-${from}-${to}-${days.join('')}`,
    label,
    target,
    from: fmtClock(from),
    to: fmtClock(to),
    days: [...new Set(days)].sort((a, b) => a - b),
    enabled: raw.enabled !== false,
  }
}

function normalizeState(raw) {
  const rules = []
  if (Array.isArray(raw?.rules)) {
    for (const r of raw.rules) {
      const rule = normalizeRule(r)
      if (rule) rules.push(rule)
    }
  }
  return { enabled: raw?.enabled === true, rules, updatedAt: Number(raw?.updatedAt) || 0 }
}

export function readDiscipline() {
  try {
    return normalizeState(JSON.parse(readFileSync(disciplinePath(), 'utf8')))
  } catch {
    return normalizeState(null)
  }
}

export function writeDiscipline(next) {
  const state = normalizeState(next)
  state.updatedAt = Date.now()
  const path = disciplinePath()
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
  return state
}

export function setDisciplineEnabled(value) {
  const state = readDiscipline()
  return writeDiscipline({ ...state, enabled: value === true })
}

function windowOf(rule) {
  return {
    from: parseClock(rule.from),
    to: parseClock(rule.to),
  }
}

/** 规则在某个时刻是否落在允许时段内 */
export function ruleAllows(rule, at = new Date()) {
  const { from, to } = windowOf(rule)
  if (from === null || to === null) return true
  const wd = at.getDay() === 0 ? 7 : at.getDay()
  if (Array.isArray(rule.days) && rule.days.length > 0 && !rule.days.includes(wd)) return false
  const now = at.getHours() * 60 + at.getMinutes()
  if (from === to) return true
  if (from < to) return now >= from && now < to
  // 跨夜：22:00 -> 06:00
  return now >= from || now < to
}

/** 目标 name[.sub] 现在被强纪律允许吗。没开强纪律、或没有规则 → 允许。 */
export function disciplineAllows(name, sub, at = new Date()) {
  const state = readDiscipline()
  if (!state.enabled) return true
  const targets = []
  if (name) targets.push(String(name))
  if (name && sub) targets.push(`${name}.${sub}`)
  targets.push('*')
  const relevant = state.rules.filter((r) => r.enabled && targets.includes(r.target))
  if (relevant.length === 0) return true
  // 同一目标多条规则时取并集：任意一条允许就算允许
  return relevant.some((r) => ruleAllows(r, at))
}

/** 被强纪律挡住时给出人能看懂的说明；没挡住返回空串 */
export function disciplineBlockedReason(name, sub, at = new Date()) {
  if (disciplineAllows(name, sub, at)) return ''
  const state = readDiscipline()
  const targets = [String(name ?? ''), name && sub ? `${name}.${sub}` : '', '*'].filter(Boolean)
  const relevant = state.rules.filter((r) => r.enabled && targets.includes(r.target))
  const parts = relevant.map((r) => `${r.label}（${r.from}-${r.to}${r.days.length ? ' ' + r.days.map((d) => DAY_NAMES[d - 1]).join(' ') : ' 每天'}）`)
  return `强纪律：现在不在允许时段，${parts.join('；') || '规则未命中'}`
}

/** 当前时刻所有目标的开关状态，给卡片显示用 */
export function disciplineStatus(at = new Date()) {
  const state = readDiscipline()
  const now = at.getHours() * 60 + at.getMinutes()
  return {
    ok: true,
    enabled: state.enabled,
    now: fmtClock(now),
    weekday: DAY_NAMES[(at.getDay() === 0 ? 7 : at.getDay()) - 1],
    path: disciplinePath(),
    targets: TARGETS,
    rules: state.rules.map((r) => ({ ...r, allowed: state.enabled ? ruleAllows(r, at) : true })),
  }
}

const DAY_WORDS = [
  ['周一', 1], ['周二', 2], ['周三', 3], ['周四', 4], ['周五', 5], ['周六', 6], ['周日', 7], ['周天', 7],
  ['星期一', 1], ['星期二', 2], ['星期三', 3], ['星期四', 4], ['星期五', 5], ['星期六', 6], ['星期日', 7], ['星期天', 7],
]

function dayList(text) {
  if (/工作日|上班|周一至周五|周一到周五|工作日期间/.test(text)) return [1, 2, 3, 4, 5]
  if (/周末|周六日|双休/.test(text)) return [6, 7]
  if (/每天|天天|每日|不限/.test(text)) return []
  const hit = DAY_WORDS.find(([w]) => text.includes(w))
  return hit ? [hit[1]] : []
}

function targetOf(text) {
  if (/整个插件|全部功能|所有功能|整块/.test(text)) return '*'
  if (/跨会话|session.?ask|提问/.test(text)) return 'session_ask'
  if (/上下文守卫|压缩守卫/.test(text)) return 'session_ask.context_guard'
  if (/互动工具|poke|点赞|撤回|引用回复/.test(text)) return 'qq.tools'
  if (/入站媒体|下载图片|媒体/.test(text)) return 'qq.inbound_media'
  if (/表情|贴图|sticker/.test(text)) return 'qq.sticker'
  if (/分享槽|只读问答/.test(text)) return 'qq.share_slot'
  if (/团队槽|隔离工作区/.test(text)) return 'qq.team_slot'
  if (/适配|adapter/.test(text)) return /通讯|im|机器人框架/.test(text) ? 'qq.adapter_im' : 'qq.adapter_dsh'
  if (/重启|restart/.test(text)) return 'restart'
  if (/暂停|pause/.test(text)) return 'pause'
  if (/贵时段|peak/.test(text)) return 'peak'
  if (/qq|QQ/.test(text)) return 'qq'
  return 'session_ask'
}

/** 把一句中文描述解析成规则草案；解析不出来就抛错（由调用方决定要不要交给 llm） */
export function parseRule(text) {
  const raw = String(text ?? '').trim()
  if (!raw) throw new Error('先写一句描述，比如「每天 9:00 到 18:00 才允许跨会话提问」')
  if (raw.length > 300) throw new Error('描述太长（最多 300 字）')
  const m = raw.match(/(\d{1,2})\s*[:：点时]\s*(\d{1,2})?\s*(?:到|至|-|~|—|直到)\s*(\d{1,2})\s*[:：点时]\s*(\d{1,2})?/)
  if (!m) {
    // 「全天 / 整日」等价于 00:00 到 00:00（首尾相同 = 一整天都允许）
    if (/全天|整日|一整天/.test(raw)) {
      return { label: raw.length > 40 ? `${raw.slice(0, 40)}…` : raw, target: targetOf(raw), from: '00:00', to: '00:00', days: dayList(raw) }
    }
    throw new Error('没找到时段，请写成「9:00 到 18:00」或「9 点到 18 点」，也可以用「全天」')
  }
  const fromMin = parseClock(`${m[1]}:${m[2] ?? '00'}`)
  const toMin = parseClock(`${m[3]}:${m[4] ?? '00'}`)
  if (fromMin === null || toMin === null) throw new Error('时段不合法，请用 24 小时制，如 09:00 到 18:00')
  const from = fmtClock(fromMin)
  const to = fmtClock(toMin)
  return {
    label: raw.length > 40 ? `${raw.slice(0, 40)}…` : raw,
    target: targetOf(raw),
    from,
    to,
    days: dayList(raw),
  }
}

export function addRule(draft) {
  const rule = normalizeRule({ ...draft, id: draft?.id ?? `rule-${Date.now().toString(36)}` })
  if (!rule) throw new Error('规则不合法：target / from / to 必填且格式正确')
  const state = readDiscipline()
  const rules = state.rules.filter((r) => r.id !== rule.id).concat(rule)
  return writeDiscipline({ ...state, rules })
}

export function removeRule(id) {
  const state = readDiscipline()
  const key = String(id ?? '')
  const rules = state.rules.filter((r) => r.id !== key)
  if (rules.length === state.rules.length) throw new Error(`没有这条规则：${key}`)
  return writeDiscipline({ ...state, rules })
}

export function setRuleEnabled(id, value) {
  const state = readDiscipline()
  const key = String(id ?? '')
  let found = false
  const rules = state.rules.map((r) => {
    if (r.id !== key) return r
    found = true
    return { ...r, enabled: value !== false }
  })
  if (!found) throw new Error(`没有这条规则：${key}`)
  return writeDiscipline({ ...state, rules })
}

const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function send(res, code, payload) {
  res.writeHead(code, headers)
  res.end(JSON.stringify(payload))
}

function readBody(req, res, done) {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
    if (body.length > 16384) req.destroy()
  })
  req.on('end', () => done(body))
  req.on('error', () => {
    try {
      send(res, 400, { ok: false, reason: 'bad-request' })
    } catch {
      /* ignore */
    }
  })
}

export function registerRoutes(root, { prefix = '/dsh-toolkit', log = () => {} } = {}) {
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
        log(`[discipline] 路由注册失败 ${path}: ${err?.message ?? err}`)
      }
    }

    route(`${prefix}/discipline`, (req, res) => {
      if (req.method === 'GET' || req.method === 'HEAD') return send(res, 200, disciplineStatus())
      if (req.method !== 'POST') return send(res, 405, { ok: false, reason: 'method-not-allowed' })
      readBody(req, res, (body) => {
        try {
          const payload = body ? JSON.parse(body) : {}
          const action = String(payload?.action ?? '')
          if (action === 'enable') return send(res, 200, { ...setDisciplineEnabled(payload?.value !== false), ...disciplineStatus() })
          if (action === 'remove') return send(res, 200, { ok: true, ...removeRule(payload?.id), ...disciplineStatus() })
          if (action === 'toggle') return send(res, 200, { ok: true, ...setRuleEnabled(payload?.id, payload?.value !== false), ...disciplineStatus() })
          if (action === 'rule') return send(res, 200, { ok: true, ...addRule(payload?.rule), ...disciplineStatus() })
          if (action === 'parse') {
            const draft = parseRule(payload?.description)
            return send(res, 200, { ok: true, draft, ...disciplineStatus() })
          }
          if (action === 'parse-add') {
            const draft = parseRule(payload?.description)
            return send(res, 200, { ok: true, draft, ...addRule(draft), ...disciplineStatus() })
          }
          return send(res, 400, { ok: false, reason: `未知动作：${action || '(空)'}` })
        } catch (err) {
          return send(res, 400, { ok: false, reason: String(err?.message ?? err) })
        }
      })
    })

    log('[discipline] 已注册 /dsh-toolkit/discipline')
  })
}
