import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

// 监管层：只做规则计数，不做「安全判定」。
// 外部对象（sharebind / teambind 绑定的账号或群）发来的每一条消息都过一遍规则，
// 命中就按对象记一次；滚动窗口内累计到阈值，就通知调用方把那个槽关掉。
// 这里不调模型、不花 token，也不替人做决定——它只负责「有嫌疑就计数」。

export const RULES = [
  {
    label: 'path-escape',
    // 路径穿越、家目录隐藏文件、Windows 绝对路径：要么在读别人不该看的东西，要么想摆脱授权目录
    test: /\.\.\/|\.\.\\|~\/\.|(^|[\s"'`(])[A-Za-z]:[\\/]/,
    hint: '试图访问授权目录之外的路径',
  },
  {
    label: 'credentials',
    // 凭据类关键词带赋值：api key = xxx / 密码：xxx
    test: /(api[\s_-]?key|access[\s_-]?key|secret|token|password|passwd|密码|密钥|cookie)\s*[:=：是为]\s*\S{4,}/i,
    hint: '要凭据或贴凭据',
  },
  {
    label: 'base64-blob',
    // 一大段 base64：常见于把载荷或密钥藏进聊天
    test: /[A-Za-z0-9+/]{200,}={0,2}/,
    hint: '夹带大段 base64',
  },
  {
    label: 'override-instruction',
    // 让模型忽略前文/忽略规则：提示注入的典型开头
    test: /(忽略|无视|跳过|忘记).{0,8}(之前|以上|前面|前面所有|上面的|规则|指令|限制)|disregard\s+(all|previous)|ignore\s+(all\s+)?(previous|above)|system\s*prompt|开发者指令/i,
    hint: '要求忽略既有规则',
  },
  {
    label: 'destructive',
    // 删库、格式化、批量删：这些动作对一个「别人家的助理」来说不该出现
    test: /(删除|删掉|清空|格式化|rm\s+-rf|rmdir\s+\/s|del\s+\/[sq]|drop\s+table|format\s+[a-z]:)/i,
    hint: '包含破坏性动作',
  },
  {
    label: 'oversize',
    // 超长单条：要么在灌上下文，要么在隐藏内容
    test: (text) => String(text ?? '').length > 4000,
    hint: '单条过长',
  },
]

export function inspectText(text) {
  const labels = []
  for (const rule of RULES) {
    let hit = false
    try {
      hit = typeof rule.test === 'function' ? rule.test(text) : rule.test.test(String(text ?? ''))
    } catch {
      hit = false
    }
    if (hit) labels.push(rule.label)
  }
  return { hit: labels.length > 0, labels }
}

function safeJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) ?? {}
  } catch {
    return {}
  }
}

/**
 * 建一个监管实例。
 * - dshHome：状态文件目录（$DSH_HOME）
 * - windowSecs / threshold：滚动窗口与阈值，默认 600 秒 3 次
 * - onTrip(identity, info)：累计到阈值时调用，调用方负责关槽、通知主号
 */
export function createGuard({ dshHome, windowSecs = 600, threshold = 3, log = () => {}, onTrip = () => {} }) {
  const path = join(dshHome, 'dsh-toolkit-guard.json')
  const state = safeJson(path)
  const identities = state.identities && typeof state.identities === 'object' ? state.identities : {}

  const save = () => {
    try {
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify({ identities }, null, 2), 'utf8')
      renameSync(tmp, path)
    } catch (err) {
      log(`[guard] 写状态失败：${err?.message ?? err}`)
    }
  }

  const prune = (rec, now) => {
    const keep = (rec.hits ?? []).filter((t) => Number.isFinite(t) && now - t < windowSecs * 1000)
    rec.hits = keep
    return rec
  }

  const recOf = (identity) => {
    const key = String(identity ?? '')
    if (!identities[key]) identities[key] = { hits: [], blocked: false, updatedAt: 0 }
    return identities[key]
  }

  return {
    path,
    inspect: inspectText,
    stateOf(identity) {
      const rec = recOf(identity)
      prune(rec, Date.now())
      return { hits: rec.hits.length, blocked: rec.blocked === true, hitTimes: rec.hits.slice() }
    },
    isBlocked(identity) {
      return recOf(identity).blocked === true
    },
    /**
     * 记一条消息。命中规则就计数；到阈值就标记 blocked 并回调 onTrip。
     * 返回 { hit, labels, blocked, hits, tripped }。
     */
    note(identity, text) {
      const now = Date.now()
      const rec = prune(recOf(identity), now)
      const verdict = inspectText(text)
      let tripped = false
      if (verdict.hit) {
        rec.hits.push(now)
        rec.updatedAt = now
        log(`[guard] ${identity} 命中 ${verdict.labels.join(',')}（窗口内 ${rec.hits.length}/${threshold}）`)
        if (rec.hits.length >= threshold && !rec.blocked) {
          rec.blocked = true
          tripped = true
          log(`[guard] ${identity} 达到阈值，标记拦截`)
          try {
            onTrip(identity, { labels: verdict.labels, hits: rec.hits.length })
          } catch (err) {
            log(`[guard] onTrip 抛错：${err?.message ?? err}`)
          }
        }
      }
      save()
      return { ...verdict, blocked: rec.blocked === true, hits: rec.hits.length, tripped }
    },
    /** 列出所有有计数或处于封禁状态的对象，按最近更新时间倒序 */
    list() {
      const now = Date.now()
      const out = []
      for (const [identity, rec] of Object.entries(identities)) {
        prune(rec, now)
        if (rec.hits.length || rec.blocked) {
          out.push({ identity, hits: rec.hits.length, blocked: rec.blocked === true, updatedAt: rec.updatedAt ?? 0 })
        }
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt)
    },
    /** 主号看过之后重开：清计数、解拦截 */
    reset(identity) {
      const rec = recOf(identity)
      rec.hits = []
      rec.blocked = false
      rec.updatedAt = Date.now()
      save()
      log(`[guard] ${identity} 计数与拦截已重置`)
    },
  }
}
