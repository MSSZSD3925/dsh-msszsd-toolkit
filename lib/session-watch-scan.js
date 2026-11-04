/**
 * 会话看护的纯逻辑部分（不依赖 cordis / schemastery，可直接用 node 跑测试）。
 *
 * 只做三件事：列出磁盘上的会话目录、读日志尾部与 projcache、把结果写成四份产物。
 * 面向 DSH 的那一半（配置 schema、webServer 路由、定时器）在 session-watch.js。
 *
 * 为什么读尾部要按帧切：会话日志是数千个 zstd 帧顺序拼接的，
 * node 的 zstdDecompressSync 只解第一帧，直接解整段会得到「文件只有 244 字节」的假象。
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { dshHome } from './local-config.js'

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const DAY = 24 * 60 * 60 * 1000

export function iso(t) {
  const n = Number(t)
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : ''
}

export function shortId(id) {
  const s = String(id || '').replace(/^session-/, '')
  return s.length > 8 ? s.slice(0, 8) : s
}

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 在尾部窗口里找出所有 zstd 帧起点，并从后往前逐帧解码，凑够 want 条事件。 */
export function readTailEvents(file, tailBytes, want = 12) {
  const st = statSync(file)
  const start = Math.max(0, st.size - Math.max(0, Number(tailBytes) || 0))
  const len = st.size - start
  if (len <= 0) return { events: [], size: st.size, mtimeMs: st.mtimeMs, torn: false }
  const fd = openSync(file, 'r')
  const buf = Buffer.alloc(len)
  try {
    readSync(fd, buf, 0, len, start)
  } finally {
    closeSync(fd)
  }
  const offs = []
  for (let i = 0; i + 3 < buf.length; i += 1) {
    if (
      buf[i] === ZSTD_MAGIC[0] &&
      buf[i + 1] === ZSTD_MAGIC[1] &&
      buf[i + 2] === ZSTD_MAGIC[2] &&
      buf[i + 3] === ZSTD_MAGIC[3]
    ) {
      offs.push(i)
    }
  }
  const events = []
  let torn = false
  for (let k = offs.length - 1; k >= 0 && events.length < want; k -= 1) {
    const s = offs[k]
    const e = k + 1 < offs.length ? offs[k + 1] : buf.length
    if (e - s < 8) continue
    let text
    try {
      text = zstdDecompressSync(buf.subarray(s, e)).toString('utf8')
    } catch {
      // 半帧（进程被杀在写帧途中）或误命中的魔术字节：跳过继续往前
      if (k === offs.length - 1) torn = true
      continue
    }
    const parsed = []
    let ok = true
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        parsed.push(JSON.parse(line))
      } catch {
        ok = false
        break
      }
    }
    if (!ok || parsed.length === 0) continue
    for (let i = parsed.length - 1; i >= 0; i -= 1) events.unshift(parsed[i])
  }
  return { events: events.slice(-want), size: st.size, mtimeMs: st.mtimeMs, torn }
}

/** projcache 里的标题、开轮状态、轮次统计；没有这条记录就返回 null。 */
export function readProjcache(id) {
  const p = join(dshHome(), 'storages', 'session_projcache', 'sessions', `${id}.json`)
  if (!existsSync(p)) return null
  const doc = readJson(p)
  const rec = doc?.record
  if (!rec) return null
  const rows = rec.rows || {}
  const val = (key) => (rows[key] && typeof rows[key] === 'object' && 'val' in rows[key] ? rows[key].val : undefined)
  const listMeta = val('sessionListMetadata')
  const stats = val('sessionStats')
  const boundary = val('turnBoundary')
  return {
    title: typeof val('title') === 'string' ? val('title') : '',
    blank: listMeta?.blank === true,
    lastPromptAt: Number(listMeta?.lastPromptAt) || 0,
    openStep: stats && Number.isFinite(Number(stats.openStep)) ? Number(stats.openStep) : null,
    turns: stats && Number.isFinite(Number(stats.turns)) ? Number(stats.turns) : null,
    lastTurn: boundary && Number.isFinite(Number(boundary.lastTurn)) ? Number(boundary.lastTurn) : null,
    preset: typeof val('agentPreset') === 'string' ? val('agentPreset') : '',
    cwd: typeof rec?.identity?.cwd === 'string' ? rec.identity.cwd : '',
    updatedAt: Number(rec?.updatedAt) || 0,
  }
}

/** 宿主侧「可列集合」= 各 workspace 的 sessionIds；archived 单独一份。 */
export function readWorkspaceSets() {
  const out = { listable: new Set(), archived: new Set(), pinned: new Set(), workspaces: [] }
  const doc = readJson(join(dshHome(), 'storages', 'workspace.json'))
  if (!doc) return out
  const tables = doc?.tables?.workspaces || {}
  for (const [wid, w] of Object.entries(tables)) {
    out.workspaces.push({ id: wid, path: w?.path ?? '', title: w?.title ?? '' })
    for (const sid of w?.sessionIds ?? []) out.listable.add(String(sid))
  }
  for (const sid of doc?.global?.archivedSessionIds ?? []) out.archived.add(String(sid))
  for (const sid of doc?.global?.pinnedSessionIds ?? []) out.pinned.add(String(sid))
  return out
}

/** $DSH_HOME/sessions/<cwdKey>/<sessionId>/session.v4.jsonl.zstd；sessions-hidden 是 toolkit 自己藏的，不算。 */
export function listSessionFiles() {
  const root = join(dshHome(), 'sessions')
  const out = []
  if (!existsSync(root)) return out
  let keys = []
  try {
    keys = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const key of keys) {
    if (!key.isDirectory() || key.name === 'sessions-hidden') continue
    const bucket = join(root, key.name)
    let ids = []
    try {
      ids = readdirSync(bucket, { withFileTypes: true })
    } catch {
      continue
    }
    for (const idDir of ids) {
      if (!idDir.isDirectory()) continue
      const file = join(bucket, idDir.name, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      out.push({ id: idDir.name, file, bucket: key.name })
    }
  }
  return out
}

export function briefEvent(ev) {
  const data = ev?.data || {}
  switch (ev?.type) {
    case 'turn/end': {
      const kind = data?.reason?.kind ?? ''
      const inner = data?.reason?.reason?.kind ?? ''
      return `turn ${data?.turn ?? '?'} 结束：${kind}${inner ? `（${inner}）` : ''}`
    }
    case 'turn/start':
      return `turn ${data?.turn ?? '?'} 开始`
    case 'user/message':
      return '用户消息'
    case 'assistant/message':
      return '助手回复'
    case 'tool/call':
      return `调用工具 ${data?.name ?? data?.tool ?? ''}`.trim()
    case 'step/end':
      return `第 ${data?.step ?? '?'} 步结束`
    default:
      return ''
  }
}

export function reportDir(config) {
  const custom = typeof config?.dir === 'string' ? config.dir.trim() : ''
  return custom || join(dshHome(), 'dsh-session-watch')
}

function rowOf(file, info, sets, prev) {
  const { events, size, mtimeMs, torn } = info
  const last = events.length > 0 ? events[events.length - 1] : null
  const reason = last?.type === 'turn/end' ? last?.data?.reason : null
  const aborted = reason?.kind === 'aborted'
  const disposed = aborted && reason?.reason?.kind === 'disposed'
  const listable = sets.listable.has(file.id)
  const archived = sets.archived.has(file.id)
  // 「轮次开着」不看 projcache 的 openStep（它对没开轮的会话也可能是 0），只看日志尾部：
  // 最后一条不是 turn/end，说明这一轮写到一半就停了（进程被杀，或者现在还活着在跑）。
  const tailOpen = !!last && last.type !== 'turn/end'
  const before = prev?.[file.id]
  return {
    id: file.id,
    shortId: shortId(file.id),
    title: file.pc?.title || '',
    cwd: file.pc?.cwd || '',
    bucket: file.bucket,
    logPath: file.file,
    logBytes: size,
    mtime: iso(mtimeMs),
    ageHours: Math.round(((Date.now() - mtimeMs) / 3600000) * 10) / 10,
    turns: file.pc?.turns ?? null,
    openStep: file.pc?.openStep ?? null,
    tailOpen,
    hasProjcache: !!file.pc,
    blank: file.pc?.blank === true,
    listable,
    archived,
    wasListable: before?.listable === true,
    torn,
    aborted,
    disposed,
    last: last ? { type: last.type, at: iso(last.time), reason: reason ? JSON.stringify(reason) : '', brief: briefEvent(last) } : null,
    recent: events.slice(-3).map((ev) => ({ at: iso(ev.time), type: ev.type, brief: briefEvent(ev) })),
  }
}

function card(row, kind) {
  const lines = [
    `- 标题：${row.title || '（没有标题）'}`,
    `- 会话：${row.id}`,
    `- 目录：${row.cwd || '（无）'}`,
    `- 日志：${row.logPath}（${row.logBytes} 字节，${row.mtime} 最后写入）`,
    `- 注册：${row.archived ? '已归档（列表里默认不显示）' : row.listable ? '在宿主列表里' : '不在宿主列表里'}${row.hasProjcache ? '' : '，缺 projcache'} ${row.pinned ? '· 已置顶' : ''}`.trimEnd(),
    `- 轮次：${row.turns ?? '?'} 轮，最后一条事件是 ${row.last?.type || '?'}${row.tailOpen ? '（这一轮还没收尾）' : ''}`,
  ]
  if (kind === 'gone') lines.push('- 判定：上一次扫描时它还在列表里，这次不在，而且不是归档')
  if (kind === 'interrupted') {
    lines.push(
      `- 判定：日志尾部是被中断的轮次结束（${row.last?.reason || ''}）${
        row.disposed ? '，reason=disposed，通常是重启或插件重载把这一轮就地 dispose' : ''
      }`,
    )
  }
  if (kind === 'unfinished') lines.push('- 判定：日志尾部不是 turn/end，这一轮写到一半就停了（进程被杀，或者它现在还活着在跑）')
  lines.push('- 最后 3 条事件：')
  if (row.recent.length === 0) lines.push('  - （读不到事件）')
  for (const ev of row.recent) lines.push(`  - ${ev.at} ${ev.type}${ev.brief ? ` — ${ev.brief}` : ''}`)
  return lines.join('\n')
}

/**
 * 扫一遍并把四份产物写出来（report.md / latest.json / index.json / events.jsonl）。
 * @returns {{generatedAt:number, counts:object, anomalies:Array, sessions:Array, dir:string, files:object}}
 */
export function scanSessions(options = {}) {
  const now = Date.now()
  const dir = options.dir || join(dshHome(), 'dsh-session-watch')
  const maxAgeDays = Number.isFinite(Number(options.maxAgeDays)) ? Number(options.maxAgeDays) : 14
  const tailBytes = Number.isFinite(Number(options.tailBytes)) ? Number(options.tailBytes) : 4 * 1024 * 1024
  const maxRows = Number.isFinite(Number(options.maxRows)) ? Math.max(1, Number(options.maxRows)) : 8

  mkdirSync(dir, { recursive: true })
  const sets = readWorkspaceSets()
  const prevDoc = readJson(join(dir, 'index.json'))
  const prev = prevDoc && typeof prevDoc.map === 'object' && prevDoc.map ? prevDoc.map : {}

  const sessions = []
  for (const file of listSessionFiles()) {
    let info
    try {
      info = readTailEvents(file.file, tailBytes, 12)
    } catch {
      continue
    }
    const ageDays = (now - info.mtimeMs) / DAY
    const projcache = readProjcache(file.id)
    const wasListable = prev?.[file.id]?.listable === true
    const fresh = maxAgeDays <= 0 || ageDays <= maxAgeDays
    const interesting = fresh || wasListable || sets.listable.has(file.id)
    if (!interesting) continue
    sessions.push(rowOf({ ...file, pc: projcache }, info, sets, prev))
  }

  sessions.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))

  const anomalies = []
  for (const row of sessions) {
    if (!row.listable && !row.archived && row.wasListable) anomalies.push({ kind: 'gone', at: row.mtime, row })
    if (row.aborted) anomalies.push({ kind: 'interrupted', at: row.mtime, row })
    // 只有最近的才值得报：老会话停在半路是历史，不是现在的问题
    if (row.tailOpen && row.ageHours <= 24) anomalies.push({ kind: 'unfinished', at: row.mtime, row })
  }
  anomalies.sort((a, b) => String(b.at).localeCompare(String(a.at)))

  const counts = {
    sessions: sessions.length,
    listable: sessions.filter((s) => s.listable).length,
    gone: anomalies.filter((a) => a.kind === 'gone').length,
    interrupted: anomalies.filter((a) => a.kind === 'interrupted').length,
    unfinished: anomalies.filter((a) => a.kind === 'unfinished').length,
  }

  const files = {
    report: join(dir, 'report.md'),
    latest: join(dir, 'latest.json'),
    events: join(dir, 'events.jsonl'),
    index: join(dir, 'index.json'),
  }

  const snapshot = {
    ok: true,
    generatedAt: now,
    sessionsRoot: join(dshHome(), 'sessions'),
    workspaces: sets.workspaces,
    counts,
    anomalies: anomalies.map((a) => ({
      kind: a.kind,
      at: a.at,
      id: a.row.id,
      shortId: a.row.shortId,
      title: a.row.title,
      cwd: a.row.cwd,
      logPath: a.row.logPath,
      logBytes: a.row.logBytes,
      listable: a.row.listable,
      archived: a.row.archived,
      openStep: a.row.openStep,
      tailOpen: a.row.tailOpen,
      last: a.row.last,
      recent: a.row.recent,
    })),
    sessions: sessions.map((row) => ({ ...row })),
  }
  writeFileSync(files.latest, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')

  const indexMap = {}
  for (const row of sessions) indexMap[row.id] = { listable: row.listable, archived: row.archived, title: row.title, mtime: row.mtime }

  // events.jsonl 只追加这次新出现的异常，避免每次扫描重复堆同一件事
  const prevEvents = Array.isArray(prevDoc?.events) ? prevDoc.events : []
  const seenKeys = new Set(prevEvents.map((e) => e.key))
  const newEvents = []
  for (const a of anomalies) {
    const key = `${a.kind}:${a.row.id}:${a.row.last?.at || a.row.mtime}`
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    newEvents.push({ key, at: iso(now), kind: a.kind, sessionId: a.row.id, shortId: a.row.shortId, title: a.row.title, logPath: a.row.logPath, lastEvent: a.row.last })
  }
  if (newEvents.length > 0) appendFileSync(files.events, `${newEvents.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8')
  writeFileSync(files.index, `${JSON.stringify({ at: now, map: indexMap, events: [...prevEvents, ...newEvents].slice(-500) }, null, 2)}\n`, 'utf8')

  const md = []
  md.push('# 会话看护报告')
  md.push('')
  md.push(`生成时间：${new Date(now).toISOString()}（本机时间 ${new Date(now).toLocaleString()}）`)
  md.push(`扫描会话：${counts.sessions} 个，其中在宿主可列集合里 ${counts.listable} 个`)
  md.push('')
  md.push(
    '判定基准：宿主会话列表 = workspace.json 各 workspace 的 sessionIds 减去 global.archivedSessionIds。子智能体会话本来就不进这个集合，所以只有「上次在、这次不在」才算消失。',
  )
  md.push('')
  const groups = [
    ['gone', '一、上次在列表里、这次不在（真正的「消失」）'],
    ['interrupted', '二、尾部是被中断的轮次（重启或插件重载把这一轮就地 dispose）'],
    ['unfinished', '三、日志尾部不是 turn/end（这一轮写到一半就停了）'],
  ]
  for (const [kind, heading] of groups) {
    const list = anomalies.filter((a) => a.kind === kind)
    md.push(`## ${heading}`)
    md.push('')
    if (list.length === 0) md.push('（没有）')
    for (const a of list) {
      md.push(`### ${a.row.title || '（没有标题）'} · ${a.row.shortId}`)
      md.push('')
      md.push(card(a.row, kind))
      md.push('')
    }
    if (list.length === 0) md.push('')
  }
  md.push('## 附：全部扫描到的会话')
  md.push('')
  md.push('| 会话 | 标题 | 轮次 | 开轮 | 在列表 | 归档 | 最后写入 |')
  md.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const row of sessions.slice(0, 200)) {
    md.push(
      `| ${row.shortId} | ${(row.title || '').replace(/\|/g, '/')} | ${row.turns ?? ''} | ${row.openStep ?? ''} | ${row.listable ? '是' : '否'} | ${
        row.archived ? '是' : '否'
      } | ${row.mtime} |`,
    )
  }
  md.push('')
  md.push('报告目录里还有 latest.json（完整快照，脚本可读）与 events.jsonl（每次扫描新增的异常）。')
  writeFileSync(files.report, `${md.join('\n')}\n`, 'utf8')

  return { ...snapshot, dir, files, maxRows, rows: anomalies.slice(0, maxRows) }
}
