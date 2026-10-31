/**
 * 会话索引：从磁盘读出本机所有可路由的会话（id、标题、最后活动、cwd、深度）。
 *
 * 只读，不碰会话日志正文。数据源两处：
 *   $DSH_HOME/sessions/<cwd-dir>/<sessionId>/session.v4.jsonl.zstd   → 会话 id、最后活动、头部（delegationDepth / cwd）
 *   $DSH_HOME/storages/session_projcache/sessions/<sessionId>.json   → record.rows.title.val 标题
 *   $DSH_HOME/storages/workspace.json                                → global.archivedSessionIds 归档集合
 *
 * qq.js（#list / 路由）与 session-ask.js（跨会话提问）共用这一份实现：
 * 两处各自维护一套遍历与过滤，编号和"能问谁"迟早会漂移。
 */

import { open, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createZstdDecompress } from 'node:zlib'

/** 会话短编号：去掉 session- 前缀取前 8 位。 */
export function shortId(id) {
  return String(id ?? '').replace(/^session-/, '').slice(0, 8)
}

/** 最后活动时间，MM-DD HH:mm。 */
export function fmtTime(ms) {
  if (!ms) return '未知'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 取 zstd 文件解压后的第一行（会话头）。
 *
 * 不能靠帧头算长度：这些会话文件用的是"流式帧"，Frame_Content_Size 字段缺省，
 * 只能边解压边收，拿到第一个换行就停。只喂前 64 KB，避免为一行头读整份日志。
 */
function firstLineOfZstd(buf) {
  return new Promise((resolve) => {
    const decomp = createZstdDecompress()
    let text = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try {
        decomp.destroy()
      } catch {
        /* 忽略 */
      }
      resolve(value)
    }
    decomp.on('data', (chunk) => {
      text += chunk.toString('utf8')
      const nl = text.indexOf('\n')
      if (nl >= 0) finish(text.slice(0, nl))
      else if (text.length > 65536) finish(text.slice(0, 65536))
    })
    decomp.on('error', () => finish(text || null))
    decomp.on('end', () => finish(text || null))
    decomp.end(buf.subarray(0, Math.min(buf.length, 65536)))
    setTimeout(() => finish(text || null), 3000).unref?.()
  })
}

/** 只读文件前 limit 字节（会话日志动辄几十 MB，取头不必整读）。 */
async function readHeadBytes(file, limit) {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(limit)
    const { bytesRead } = await fh.read(buf, 0, limit, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close().catch(() => {})
  }
}

/**
 * @param {object} options
 * @param {string} options.dshHome  DSH_HOME 目录
 * @param {(msg: string) => void} [options.log]  日志回调
 * @param {(cwd: string) => void} [options.onCwd]  读到主会话 cwd 时回调（qq.js 用它给 #new 定工作目录）
 */
export function createSessionIndex({ dshHome, log = () => {}, onCwd = () => {} } = {}) {
  if (!dshHome) throw new Error('createSessionIndex 需要 dshHome')
  const sessionsRoot = join(dshHome, 'sessions')
  const cacheRoot = join(dshHome, 'storages', 'session_projcache', 'sessions')

  // #list / #running 都会取标题，缓存 30 秒，避免同一次渲染反复读盘。
  const titleCache = new Map() // id -> { at, title }
  async function readTitle(id) {
    const hit = titleCache.get(id)
    if (hit && Date.now() - hit.at < 30_000) return hit.title
    try {
      const raw = await readFile(join(cacheRoot, `${id}.json`), 'utf8')
      const title = JSON.parse(raw)?.record?.rows?.title?.val
      const value = typeof title === 'string' ? title : ''
      titleCache.set(id, { at: Date.now(), title: value })
      return value
    } catch {
      titleCache.set(id, { at: Date.now(), title: '' })
      return ''
    }
  }

  const headerCache = new Map() // sessionId -> { mtime, depth, cwd }

  /**
   * 会话头里的 delegationDepth（0 = 主会话，>=1 = 子智能体）与 cwd。
   * 读不到 depth 时返回 null（按主会话处理）；cwd 顺带交给 onCwd。
   */
  async function readHeaderInfo(sessionDir, sessionId, mtime) {
    const cached = headerCache.get(sessionId)
    if (cached && cached.mtime === mtime) {
      if (cached.cwd) onCwd(cached.cwd)
      return cached
    }
    const info = { mtime, depth: null, cwd: '' }
    try {
      // 只要解压后的第一行，读前 64 KB 就够；整读会把几十 MB 的会话日志拉进内存。
      const buf = await readHeadBytes(join(sessionDir, 'session.v4.jsonl.zstd'), 65536)
      const line = await firstLineOfZstd(buf)
      const head = line ? JSON.parse(line) : null
      if (head && typeof head.delegationDepth === 'number') info.depth = head.delegationDepth
      if (head && typeof head.cwd === 'string' && head.cwd) info.cwd = head.cwd
    } catch {
      /* 读不到就按主会话、无 cwd 处理 */
    }
    headerCache.set(sessionId, info)
    if (info.cwd) onCwd(info.cwd)
    return info
  }

  /**
   * 已归档会话 id 集合。
   * 归档状态由界面存在 storages/workspace.json 的 global.archivedSessionIds 里，
   * 里面是 "session-<uuid>"，而会话目录名是裸 uuid，两种都记一份方便比对。
   */
  let archivedCache = { readAt: 0, ids: new Set() }
  let archivedSkipped = 0

  async function readArchivedIds() {
    if (Date.now() - archivedCache.readAt < 3000) return archivedCache.ids
    const ids = new Set()
    try {
      const raw = await readFile(join(dshHome, 'storages', 'workspace.json'), 'utf8')
      const list = JSON.parse(raw)?.global?.archivedSessionIds
      if (Array.isArray(list)) {
        for (const id of list) {
          if (typeof id !== 'string') continue
          ids.add(id)
          if (id.startsWith('session-')) ids.add(id.slice('session-'.length))
        }
      }
    } catch {
      /* 读不到就当没有归档会话 */
    }
    archivedCache = { readAt: Date.now(), ids }
    return ids
  }

  /**
   * 列出会话，按最后活动倒序。
   * limit 传 Infinity 表示取全量（路由表与翻页都基于全量编号）。
   * 跳过子智能体（delegationDepth >= 1）与已归档会话：两者在界面里都是收起的。
   */
  async function listSessions(limit) {
    const out = []
    archivedSkipped = 0
    const archived = await readArchivedIds()
    let projectDirs = []
    try {
      projectDirs = await readdir(sessionsRoot, { withFileTypes: true })
    } catch {
      return out
    }
    for (const project of projectDirs) {
      if (!project.isDirectory()) continue
      const projectDir = join(sessionsRoot, project.name)
      let sessionDirs = []
      try {
        sessionDirs = await readdir(projectDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const session of sessionDirs) {
        if (!session.isDirectory()) continue
        const sessionDir = join(projectDir, session.name)
        let mtime = 0
        try {
          mtime = (await stat(join(sessionDir, 'session.v4.jsonl.zstd'))).mtimeMs
        } catch {
          try {
            mtime = (await stat(sessionDir)).mtimeMs
          } catch {
            mtime = 0
          }
        }
        const { depth, cwd } = await readHeaderInfo(sessionDir, session.name, mtime)
        // 子智能体（delegationDepth >= 1）不进列表；读不到深度时按主会话处理，宁可多列也不漏。
        if (typeof depth === 'number' && depth > 0) continue
        if (archived.has(session.name)) {
          archivedSkipped += 1
          continue
        }
        out.push({
          id: session.name,
          project: project.name.replace(/^--|--$/g, ''),
          mtime,
          depth,
          cwd,
          title: await readTitle(session.name),
        })
      }
    }
    out.sort((a, b) => b.mtime - a.mtime)
    if (!Number.isFinite(limit)) return out
    return out.slice(0, Math.max(1, limit))
  }

  return {
    sessionsRoot,
    cacheRoot,
    readTitle,
    readHeaderInfo,
    readArchivedIds,
    listSessions,
    /** 最近一次 listSessions 跳过的归档会话数（给 #list 的说明行用）。 */
    archivedSkipped: () => archivedSkipped,
  }
}
