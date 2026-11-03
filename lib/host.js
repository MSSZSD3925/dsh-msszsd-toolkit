/**
 * dsh-toolkit:host —— 群接待。
 *
 * 用途：让一个群在「有人 @ 它或带前缀」时，把消息交给该群自己的一个长期会话，
 * 由会话里的 AI 决定读不读设计、改不改文件、说不说话。插件这边不再替它写固定台词。
 *
 * 状态：$DSH_HOME/dsh-toolkit-host.json
 *   { "groups": { "<群号>": { "sessionId": "session-…", "since": 1793…, "personaSent": true } } }
 * 人设：$DSH_HOME/dsh-toolkit-host-persona.md
 *   第一次用到时按 lib/host-persona.js 里的 DEFAULT_HOST_PERSONA 写出来，
 *   之后用户可以自己改；#hostpersona reset 恢复默认。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_HOST_PERSONA } from './host-persona.js'

export function createHost({ dshHome, log = () => {} }) {
  const statePath = join(dshHome, 'dsh-toolkit-host.json')
  const personaPath = join(dshHome, 'dsh-toolkit-host-persona.md')

  function read() {
    try {
      const j = JSON.parse(readFileSync(statePath, 'utf8'))
      const groups = j && typeof j.groups === 'object' && j.groups ? j.groups : {}
      return { groups }
    } catch {
      return { groups: {} }
    }
  }

  function write(state) {
    try {
      mkdirSync(dirname(statePath), { recursive: true })
      const tmp = `${statePath}.tmp`
      writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
      renameSync(tmp, statePath)
    } catch (err) {
      log(`[host] 写状态失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function ensurePersona() {
    try {
      if (existsSync(personaPath)) return
      mkdirSync(dirname(personaPath), { recursive: true })
      writeFileSync(personaPath, DEFAULT_HOST_PERSONA.trim() + '\n', 'utf8')
      log(`[host] 已写出默认人设 ${personaPath}`)
    } catch (err) {
      log(`[host] 写人设失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function persona() {
    ensurePersona()
    try {
      const text = readFileSync(personaPath, 'utf8').trim()
      if (text) return text
    } catch {
      /* 读不到就用内置的 */
    }
    return DEFAULT_HOST_PERSONA
  }

  function isEnabled(gid) {
    return Boolean(read().groups[String(gid)])
  }

  function entry(gid) {
    return read().groups[String(gid)] ?? null
  }

  function enable(gid) {
    const state = read()
    const key = String(gid)
    if (state.groups[key]) return { created: false, entry: state.groups[key] }
    state.groups[key] = { sessionId: '', since: Date.now(), personaSent: false }
    write(state)
    log(`[host] 群 ${key} 开启接待`)
    return { created: true, entry: state.groups[key] }
  }

  function disable(gid) {
    const state = read()
    const key = String(gid)
    const had = Boolean(state.groups[key])
    if (had) {
      delete state.groups[key]
      write(state)
      log(`[host] 群 ${key} 关闭接待（会话保留）`)
    }
    return { removed: had }
  }

  function setSession(gid, sessionId) {
    const state = read()
    const key = String(gid)
    if (!state.groups[key]) return false
    state.groups[key].sessionId = String(sessionId)
    write(state)
    return true
  }

  function markPersonaSent(gid) {
    const state = read()
    const key = String(gid)
    if (!state.groups[key]) return false
    state.groups[key].personaSent = true
    write(state)
    return true
  }

  function resetPersona() {
    try {
      mkdirSync(dirname(personaPath), { recursive: true })
      writeFileSync(personaPath, DEFAULT_HOST_PERSONA.trim() + '\n', 'utf8')
      return true
    } catch (err) {
      log(`[host] 重置人设失败：${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  function listText() {
    const state = read()
    const ids = Object.keys(state.groups)
    if (!ids.length) return '还没有开启接待的群。在群里发 #hoston 开启（只有主号能发）。'
    const lines = ['开启接待的群：']
    ids.forEach((gid, i) => {
      const g = state.groups[gid]
      const sid = g.sessionId ? g.sessionId.replace(/^session-/, '').slice(0, 8) : '（还没有建会话）'
      const since = g.since ? new Date(g.since).toLocaleString('zh-CN', { hour12: false }) : ''
      lines.push(`${i + 1}. 群 ${gid}  会话 ${sid}  自 ${since}`)
    })
    lines.push(`人设文件：${personaPath}`)
    return lines.join('\n')
  }

  return {
    statePath,
    personaPath,
    isEnabled,
    entry,
    enable,
    disable,
    setSession,
    markPersonaSent,
    persona,
    resetPersona,
    listText,
  }
}
