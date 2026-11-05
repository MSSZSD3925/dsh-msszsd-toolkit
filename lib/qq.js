/**
 * dsh-qq-router —— 用 QQ 远程驾驶【本 profile 里已经存在的会话】。
 *
 * 与 dsh-1bot 的根本区别：
 *   dsh-1bot 是独立 profile（onebot）里的适配器，每条 QQ 聊天新建一个自己的会话，
 *   而且把会话藏在 $DSH_HOME/sessions-hidden —— 因为一份会话日志只能有一个写入者，
 *   跨进程写就损坏。所以它永远够不到 desktop profile 里你正在用的会话。
 *   本插件跑在 desktop profile【同一个进程】里，因此：
 *     ctx.agents.get(id) 拿到的是 UI 正在用的那个 agent 实例，
 *     往它里面 followup 一条 source.kind='user' 的消息，就等于你在电脑前打字。
 *
 * 调用方式全部照抄 dsh-1bot（它在本机 DSH 版本上跑通）：
 *   - 连接：  connect({ baseUrl, accessToken, log, reconnection })
 *   - 事件：  client.on('message', (event) => …)
 *   - 发送：  client.send('send_private_msg', { user_id, message: [{type:'text',data:{text}}] })
 *   - 驱动：  agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
 *   - 工具：  ctx.tools.register(defineTool({ … }))
 *
 * 路由表来源（只读，不碰会话日志）：
 *   $DSH_HOME/sessions/<cwd-dir>/<sessionId>/session.v4.jsonl.zstd   → 会话 id 与最后活动
 *   $DSH_HOME/storages/session_projcache/sessions/<sessionId>.json   → record.rows.title.val 标题
 */
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { appendFile, copyFile, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir, networkInterfaces, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import { createConnection, createServer as createNetServer } from 'node:net'
import { createSocket as createUdpSocket } from 'node:dgram'
import { createZstdDecompress } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { openTransport } from './transport.js'
import { createQqBridge, normalizeInbound } from './qq-bridge.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createAgentBoot, isRunningAgent } from './agent-boot.js'
import { createGuard } from './guard.js'
import { createRequests } from './request.js'
import { resolveStickerDir, readStickerDir, writeStickerDir, stickerInfo } from './sticker-dir.js'
import { createSlots } from './slots.js'
import { createHost } from './host.js'
import { createSessionIndex, shortId } from './session-index.js'
import { isOn, subValue } from './toggles.js'
import { resolveResumeAgentOptions } from './restart.js'

export const name = 'dsh-toolkit:qq'

/** 先等这些服务就绪再 apply（与 dsh-1bot 同形）。 */
export const inject = ['tools', 'agents', 'sessions']

export const Config = z.object({
  enabled: z.boolean().default(true).description('启用桥接'),
  transport: z.string().default('onebot').description('机器人后端：onebot = OneBot 11 正向 WebSocket；要接别的协议在 lib/transport.js 里登记一个适配器再改这里'),
  ws_url: z.string().default('ws://127.0.0.1:3001').description('NapCat 正向 WebSocket 地址'),
  access_token: z.string().default('').description('OneBot access token（可选）'),
  allow_users: z.array(z.number()).default([]).description('允许发远程指令的 QQ 号白名单；空 = 谁都进不来'),
  prefix: z.string().default('#').description('指令前缀'),
  default_session: z.string().default('').description('没写路由时进哪个会话；留空则必须显式写路由'),
  workspace: z.string().default('')
    .description('QQ 新建会话时用的工作目录；留空则沿用最近一个主会话记录的 cwd，再没有就不写 cwd'),
  aliases: z.array(z.string()).default([]).description('路由别名，形如 "mod=session-xxxx"'),
  list_limit: z.number().default(12).description('#list 列出多少个会话'),
  route_ttl_secs: z.number().default(1800).description('#list 的编号有效多久（秒）'),
  reply_chunk_size: z.number().default(4000).description('单条 QQ 消息最大字数'),
  forward_merge: z.boolean().default(true)
    .description('回复会被拆成两条以上时，用合并转发一次发出（失败自动退回逐条发送）'),
  forward_name: z.string().default('DSH').description('合并转发里每条消息的显示名'),
  forward_pull_min_chars: z.number().default(1000)
    .description('用 #msg / #last 读回会话内容时，超过这个字数就打包成合并转发；0 表示只在需要切分时才合并'),
  inbound_media: z.boolean().default(true)
    .description('把 QQ 发来的图片、文件、语音下载到本机，路径写进注入正文（关掉就只留占位、不下载）'),
  media_dir: z.string().default('').description('入站媒体保存目录，留空用 $DSH_HOME/dsh-toolkit-media'),
  sticker_dir: z.string().default('').description('表情目录：把 png/jpg/gif 放进去，QQ 里发 #sticker 取用；留空用 $DSH_HOME/dsh-toolkit-stickers'),
  bind_token: z.string().default('').description('绑定口令：非空时，只有用 #bind <口令> 绑定的那个 QQ 号会被服务，其他号静默忽略（方便同一个 NapCat 上别的插件服务其他号与群聊）；留空 = 只按 allow_users 白名单'),
  slots_enabled: z.boolean().default(true).description('分享槽 / 团队槽：允许主号生成一次性密钥，把只读或受限的入口交给别的号或群'),
  bill_script: z.string().default('')
    .description('账单脚本（.cmd/.ps1 绝对路径）：QQ 驱动的回合结束后由宿主跑一次，把最后一行单独发出去；留空不追加'),
  bill_auto: z.boolean().default(true).description('回合结束后自动把 bill_script 的输出单独发一条消息（不占模型上下文）'),

  silence_notice: z.boolean().default(true).description('一轮结束但模型没调 onebot_send 时，回一条提示'),
  hint: z.string().default('').description('注入时的说明模板，可用 {qq} 与 {text}；留空用内置模板'),
  napcat_path: z.string().default('D:\\Program Files\\NapCatQQ Desktop\\NapCatQQ-Desktop.exe')
    .description('#start 在 NapCat 没起来时拉起它用的可执行文件路径'),
  start_wait_secs: z.number().default(90).description('#start 拉起 NapCat 后最多等多少秒'),
  napcat_autostart: z.boolean().default(false)
    .description('NapCat 没在听时由看门狗主动拉起它；关掉（默认）后只等它自己起来，不再弹窗口'),
  dsh_exe: z.string().default('D:\\DSH\\DeepSeek Harness.exe')
    .description('DSH 桌面端可执行文件路径；qq_waker 安装的启动任务与登录自启都指向它'),
  pair_link_autosend: z.boolean().default(true)
    .description('连上 QQ 后自动把一个新的手机配对链接发到白名单'),
  pair_link_address: z.string().default('')
    .description('取配对链接时请求的局域网地址；留空由远程插件按 publicBaseUrl/局域网自行选择'),
  link_proxy_port: z.number().default(62566)
    .description('远程链接用的本机代理端口：监听所有网卡，转发到 DSH Web'),
  link_public_host: z.string().default('')
    .description('链接里写的地址：IP、host:port，或 https:// 开头的完整地址；留空自动挑本机局域网 IP'),
  approval_remote: z.boolean().default(true)
    .description('把审批请求（approval/request）推送到 QQ，可用 #y / #n 远程决定'),
  approval_timeout_secs: z.number().default(300)
    .description('QQ 侧最多等多少秒；超时就把这条审批整条交回界面卡片'),
  questions_remote: z.boolean().default(true)
    .description('把提问（ask_user_question）推送到 QQ，可用 #answer 远程回答'),
  question_timeout_secs: z.number().default(1800)
    .description('QQ 侧最多等多少秒；超时就把提问交回界面（之后迟到的 #answer 仍会交给模型）'),
  progress_secs: z.number().default(0)
    .description('启动后自动推送会话进度的间隔秒数（0 = 关闭；也可以用 #progress 开/关）'),
})

const CHUNK_DELAY_MS = 300

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 把 OneBot 消息体渲染成纯文本（text 段保留，其余段降级为 [type k=v]）。 */
function messageToText(message) {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  return message
    .map((seg) => {
      if (!seg || !seg.type) return ''
      if (seg.type === 'text') return String(seg.data?.text ?? '')
      if (seg.type === 'at') return `@${seg.data?.qq ?? ''}`
      const kv = Object.entries(seg.data ?? {})
        .map(([k, v]) => ` ${k}=${String(v)}`)
        .join('')
      return `[${seg.type}${kv}]`
    })
    .join('')
}

function chunk(text, maxChars) {
  if (!(maxChars > 0) || text.length <= maxChars) return [text]
  const out = []
  for (let i = 0; i < text.length; i += maxChars) out.push(text.slice(i, i + maxChars))
  return out
}

// 助手消息的内容数组里除了正文，可能还有思维链、工具调用之类的 part。
// QQ 那头发出去的是纯文本，思维链混进来既难看又泄露过程，所以统一在这里过滤。
const REASONING_PART_TYPES = new Set(['reasoning', 'thinking', 'analysis', 'thought', 'chain_of_thought', 'trace'])

/** 去掉 <details>…</details>（GUI 折叠思维链的写法）与 <thinking>…</thinking> 块。 */
function stripReasoningBlocks(text) {
  return String(text ?? '')
    .replace(/<details[^>]*>[\s\S]*?<\/details>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim()
}

/** 从一条消息对象里抠出正文，兼容几种可能的形状。 */
function pickText(message) {
  const c = message?.content ?? message?.text ?? message?.message?.content
  if (typeof c === 'string') return stripReasoningBlocks(c)
  if (Array.isArray(c)) {
    return stripReasoningBlocks(
      c
        .filter((part) => part && !REASONING_PART_TYPES.has(String(part.type ?? '').toLowerCase()))
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .join(''),
    )
  }
  return ''
}

/** 去掉注入时加的 QQ 说明段，只留用户原话。 */
function stripHint(text) {
  if (!text.startsWith('[来自 QQ ')) return text
  const end = text.indexOf(']\n\n')
  return end >= 0 ? text.slice(end + 3).trim() : text
}

/**
 * 读一个 agent 的最近消息。last 是最后一条有正文的消息（不分角色），
 * lastAssistant 是最后一条助手回复，lastUser 是用户自己发的最后一条；
 * 都读不到时 shape 带诊断信息。
 * 数据源是会话事件日志（session.log）：只有 assistant/message 与 user/message
 * 两类事件的 data.message 里才有正文 —— 依据 @deepseek-ai/dsh-agent-preset-registry
 * 的事件类型描述，不再猜字段名。
 */
function readLatest(agent) {
  const session = agent?.session
  const log = session?.log ?? session?.eventsSnapshot
  const list = Array.isArray(log) ? log : null
  if (!list) {
    return {
      last: '',
      lastAssistant: '',
      lastUser: '',
      shape: 'session=[' + Object.keys(session ?? {}).join(',') + '] log=' + typeof log,
    }
  }
  const rows = []
  for (const ev of list) {
    const type = ev?.type
    if (type !== 'assistant/message' && type !== 'user/message') continue
    // assistant/message 的正文在 data.message 里，user/message 的正文直接就是 data，
    // 两者结构不同（见 dsh-agent-preset-registry 的事件类型描述），所以要分开取。
    const text = pickText(ev?.data?.message ?? ev?.data)
    if (text) rows.push({ text: stripHint(text), role: type === 'assistant/message' ? 'assistant' : 'user' })
  }
  const last = rows.length ? rows[rows.length - 1].text : ''
  const asst = [...rows].reverse().find((r) => r.role === 'assistant')
  const user = [...rows].reverse().find((r) => r.role === 'user')
  return {
    last,
    lastAssistant: asst ? asst.text : '',
    lastUser: user ? user.text : '',
    shape: 'events=' + list.length + ' msgs=' + rows.length + ' roles=[' + [...new Set(rows.map((r) => r.role))].join(',') + ']',
  }
}

/**
 * 取最近一轮的报错原文（没有就返回空串）。
 *
 * 一轮在提示词组装阶段失败时，会话里一条助手消息都不会新增；这时兜底逻辑若照常
 * 回「最新助手回复」，发回去的是上一轮的旧内容，看起来就像"取错了会话"。
 * 所以先看最后一条 turn/end 的 reason：kind=error 就把错误原文报回去。
 */
function lastTurnError(agent) {
  const session = agent?.session
  const list = session?.log ?? session?.eventsSnapshot
  if (!Array.isArray(list)) return ''
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const ev = list[i]
    if (ev?.type !== 'turn/end') continue
    const reason = ev?.data?.reason
    if (reason?.kind !== 'error') return ''
    return String(reason?.error?.message ?? '未知错误')
  }
  return ''
}

/** 日志超过 maxBytes 就滚成 .1（只留一份旧的），免得一个文件涨到几十 MB。 */
function rotateLog(file, maxBytes = 2 * 1024 * 1024) {
  try {
    if (statSync(file).size < maxBytes) return
    renameSync(file, `${file}.1`)
  } catch {
    /* 文件不存在或改名失败都无所谓 */
  }
}

export function apply(ctx, config, hooks = {}) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const logPath = join(dshHome, 'dsh-qq-router.log')
  const log = (message) => {
    try {
      rotateLog(logPath)
      // 日志写入是 fire-and-forget，必须自带 catch：目录只读或磁盘满时不能把 DSH 带崩
      void appendFile(logPath, `${new Date().toISOString()} ${message}\n`).catch(() => {})
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  log(`[apply] enter enabled=${config.enabled} prefix=${JSON.stringify(config.prefix)} allow=${JSON.stringify(config.allow_users)}`)
  if (!config.enabled) {
    log('[apply] disabled by config')
    return
  }

  // cordis 要求先注入才能取服务；用动态注入而不是写进 inject，
  // 这样 webserver 不在时插件照常加载，只是配对链接功能不可用。
  let webServerRef = null
  // 当前 web 端口。桌面端主进程的 hostUrl 只在启动那一次赋值（main.js `hostUrl = ready.url`），
  // webserver 一旦重建换了端口，渲染层每个 RPC 都会 Failed to fetch，界面看着像"卡住"。
  // 这里记下端口、漂移时告警；本机代理改成每次请求现取端口，跟着一起走。
  let webPortNow = 0
  let webPortBaseline = false

  /** 每次 webServer 注入都会走到这里，包括服务重建后的重放。 */
  function observeWebPort(port) {
    if (!port) return
    const prev = webPortNow
    webPortNow = port
    // 每次 apply 的第一次注入只作基准：整体 reload 或重启后端口本来就可能变，不算漂移。
    // 真正会踩坑的是「同一次运行内 webserver 被重建」——那正是配置保存触发的场景。
    if (!webPortBaseline) {
      webPortBaseline = true
      return
    }
    if (prev === port) return
    log(`[drift] web 端口漂移 ${prev} -> ${port}：桌面端 hostUrl 不跟随，需重启客户端`)
    void notifyPortDrift(prev, port)
  }

  /** 端口漂移只记日志。QQ 通道能不能用取决于 allow_users 配没配对，配不上就静默。 */
  function notifyPortDrift(fromPort, toPort) {
    log(`[drift] 需完整重启客户端（刷新窗口无效）：${fromPort} -> ${toPort}`)
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (inner) => {
        try {
          webServerRef = inner.webServer ?? null
          const p = webServerRef && typeof webServerRef.port === 'number' ? webServerRef.port : 0
          log(`[pair] webServer 已注入，端口 ${p || '未知'}`)
          observeWebPort(p)
        } catch (err) {
          // 回调是异步触发的，外层那个 try 兜不住这里，异常必须自己吃掉
          log(`[pair] webServer 回调异常: ${err instanceof Error ? err.message : String(err)}`)
        }
      })
    } catch (err) {
      log(`[pair] webServer 注入失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  const llm = ctx.get('llm')
  const defaultModel = ctx.get('agentDefaultModel')
  if (!agents) log('[apply] WARN: 拿不到 agents 服务')

  const prefix = String(config.prefix ?? '#')
  const allow = new Set((config.allow_users ?? []).map((n) => Number(n)))

  // 监管层：分享/团队槽的每条外部消息都过一遍规则，命中计数，到阈值自动关槽。
  let slotsRef = null
  const guard = createGuard({
    dshHome,
    log,
    onTrip: (identity, info) => {
      log(`[guard] ${identity} 命中 ${info.labels.join(',')}，窗口内第 ${info.hits} 次，自动关闭`) 
      const slot = identity.startsWith('share:') ? 'share' : identity.startsWith('team:') ? 'team' : ''
      if (slot) slotsRef?.kick(slot)
      if (boundQq) {
        const who = identity.startsWith('share:') ? '分享槽' : identity.startsWith('team:') ? '团队槽' : identity
        sendText(boundQq, `监管层：${who}的对象连续命中危险内容（${info.labels.join('、')}），已自动关闭这个槽。\n查看：${prefix}sharelist\n恢复：${prefix}guardreset`).catch(() => {})
      }
    },
  })
  const slots = createSlots({ dshHome, log, llm, defaultModel, guard })
  slotsRef = slots
  // 群接待：每个群一个长期会话，说不说话、动不动手都由会话里的 AI 决定。
  const host = createHost({ dshHome, log })

  // 群接待的会话只给「回话 + 授权槽」这些工具。文件读写、shell、GUI 一律不给：
  // 接待要读设计就走分享槽（只读授权目录），要改就走团队槽（隔离工作区 + 提交）。
  // 用全局 guard 而不是建会话时 restrict —— 重启后是 resume 进来的，restrict 只对新建生效。
  // 群接待写文件的三种状态：off 禁止 / commit 只走 team_edit 进临时分支 / direct 直接写
  function hostWriteMode() {
    const raw = String(subValue('qq', 'group_host_write') ?? 'commit')
    return raw === 'off' || raw === 'direct' ? raw : 'commit'
  }
  const HOST_TOOL_BASE = ['onebot_send', 'qq_reply', 'knowledge_search', 'knowledge_list', 'read', 'read_image']
  const HOST_TOOL_QQ = ['qq_poke', 'qq_like', 'qq_recall', 'qq_send_image']
  const HOST_TOOL_OWNER = ['session_ask', 'session_ask_list']
  function hostToolAllowed(gid, name) {
    if (HOST_TOOL_BASE.includes(name)) return true
    if (isOn('qq', 'tools') && HOST_TOOL_QQ.includes(name)) return true
    // 读分享槽与改团队槽不要求「槽能力作为工具」总开关：在群接待里这是唯一通路。
    if (name === 'share_read') return Boolean(slots.grantForPeer(gid, 'share'))
    if (name === 'team_edit') return hostWriteMode() !== 'off' && Boolean(slots.grantForPeer(gid, 'team'))
    if (HOST_TOOL_OWNER.includes(name)) return true
    return false
  }
  try {
    ctx.tools.guard((exec) => {
      const sid = String(exec?.agent?.id ?? '')
      if (!sid) return undefined
      const gid = host.groupOfSession(sid)
      if (!gid) return undefined
      // 主号亲自发起的这一轮：不设限，跟普通会话一样能跑命令行、读写文件。
      if (host.triggerOfSession(sid) === 'owner') return undefined
      const name = String(exec?.name ?? '')
      const mode = hostWriteMode()
      // 「直写」等于把普通会话的全权限交给群接待，放行一切（界面上这一项要二次确认）
      if (mode === 'direct') return undefined
      if (name === 'team_edit' && mode === 'off') {
        log(`[host] 群 ${gid} 的会话要调 team_edit，但写入被设为禁止`)
        return '群接待的「可改文件」被设成了禁止（插件详情页 → QQ → 群接待）；要让它改，请主号改成「提交」或「直写」'
      }
      if (hostToolAllowed(gid, name)) return undefined
      log(`[host] 群 ${gid} 的会话要调 ${name}，已拦下（群友触发，只给回话与授权槽工具）`)
      return `这一轮是群友触发的，只开放 QQ 回话与授权槽工具，${name} 不可用；主号自己发消息时不受限制（群接待可改文件＝${mode === 'off' ? '禁止' : '提交'}）`
    })
  } catch (err) {
    log(`[host] 工具闸门注册失败：${err instanceof Error ? err.message : String(err)}`)
  }

  // 给别的 DSH 插件用的桥：deliver 把外部消息送进同一条管线，send 用我们的通道说话。
  let bridge = null

  // ── 远程审批 ──────────────────────────────────────────────────────────────
  // approval/request 是 waterfall：谁先返回结果就算谁的。桌面端的 answerer 一旦接管
  // 就进去等点击，QQ 这边再也看不到这条审批 —— 所以本监听器必须 prepend 抢在最前。
  // 但抢到后不能把界面卡死：立刻 next() 把下游放出去，界面卡片照常弹，
  // 两边并行等，谁先给出有效结果用谁的；超时就把决定权整条交回下游。
  const approvals = new Map() // code -> { resolve, timer, label }
  let approvalSeq = 0
  const APPROVAL_YES = ['y', 'yes', 'allow', 'ok', '允许', '同意', '批准']
  const APPROVAL_NO = ['n', 'no', 'deny', 'reject', '拒绝', '否决', '不准']

  // 提权开关：sid -> { agent, sid, at, qq }。本轮内审批一律自动放行，回合结束撤销。
  const ESCALATE_WORDS = ['escalate', '提权']
  const escalations = new Map()
  let escalatePending = null

  function nextApprovalCode() {
    approvalSeq = (approvalSeq + 1) % 10000
    let code = String(approvalSeq).padStart(4, '0')
    while (approvals.has(code)) {
      approvalSeq = (approvalSeq + 1) % 10000
      code = String(approvalSeq).padStart(4, '0')
    }
    return code
  }

  /** 审批原因：优先本地化文案（displayReason），退回日志里的英文 reason。 */
  function approvalReasonText(req) {
    const display = req?.displayReason
    if (display && typeof display === 'object') {
      const zh = display.zh ?? display['zh-CN'] ?? display['zh-Hans']
      if (typeof zh === 'string' && zh.trim()) return zh.trim()
      if (typeof display.en === 'string' && display.en.trim()) return display.en.trim()
    }
    return typeof req?.reason === 'string' ? req.reason.trim() : ''
  }

  function approvalSessionText(req) {
    const session = req?.agent?.session
    const id = typeof session?.id === 'string' ? session.id : ''
    const title = typeof session?.title === 'string' ? session.title : ''
    return { id, title }
  }

  function approvalNoticeText(code, req, secs) {
    const { id, title } = approvalSessionText(req)
    const lines = [`【远程审批 ${code}】${req?.toolName ?? '工具'} 想执行一个需要授权的操作`]
    if (id) lines.push(`会话 ${shortId(id)}${title ? ' 「' + title + '」' : ''}`)
    const reason = approvalReasonText(req)
    if (reason) lines.push(`原因：${reason}`)
    lines.push(`本轮内全部放行：发 ${prefix}escalate 再 ${prefix}escalate confirm（需二次确认，回合结束自动恢复）。`)
    lines.push(`${secs} 秒内回 ${prefix}y ${code} 允许，或 ${prefix}n ${code} 拒绝。`)
    lines.push('不回也行：界面上的卡片照旧可以点。')
    return lines.join('\n')
  }

  /** 结算一条待审批；编号不存在时返回 false。 */
  function settleApproval(code, outcome) {
    const entry = approvals.get(code)
    if (!entry) return false
    approvals.delete(code)
    try {
      clearTimeout(entry.timer)
    } catch {
      /* 忽略 */
    }
    entry.resolve({ code, outcome })
    return true
  }

  /** 只有一条待审批时，允许省略编号。 */
  function currentApprovalCode() {
    if (approvals.size === 1) return [...approvals.keys()][0]
    return null
  }

  async function tellApproval(qq, text) {
    try {
      await sendText(qq, text)
    } catch (err) {
      log(`[approval] 发送失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 审批应答方。返回 allowed-once / rejected 表示 QQ 侧已决定；
   * 其余情况一律把决定权交回下游 answerer。
   */
  async function answerApproval(req, next) {
    let downstream
    try {
      downstream = Promise.resolve(next())
    } catch (err) {
      log(`[approval] 下游抛错: ${err instanceof Error ? err.message : String(err)}`)
      return 'unavailable'
    }
    if (!config.approval_remote) return downstream
    if (!bot || allow.size === 0) return downstream

    const secs = Number(config.approval_timeout_secs) || 300
    const code = nextApprovalCode()
    const { id } = approvalSessionText(req)

    // 提权生效期间：这条会话的审批直接按 allowed-once 放行，不再打扰人。
    if (id && escalations.has(id)) {
      log(`[escalate] ${id} 自动放行 ${req?.toolName ?? '工具'}`)
      void downstream.catch(() => {})
      void (async () => {
        for (const uid of allow) {
          await tellApproval(
            uid,
            `【提权生效】${code} ${req?.toolName ?? '工具'} 已自动允许（${shortId(id)} 本轮内不再逐条问）。`,
          )
        }
      })()
      return 'allowed-once'
    }
    let resolveDecided = () => {}
    const decided = new Promise((resolve) => {
      resolveDecided = resolve
    })
    const entry = {
      resolve: resolveDecided,
      timer: null,
      sid: id,
      label: `${req?.toolName ?? '工具'} ${id ? shortId(id) : ''}`.trim(),
    }
    approvals.set(code, entry)

    const clearEntry = () => {
      approvals.delete(code)
      try {
        clearTimeout(entry.timer)
      } catch {
        /* 忽略 */
      }
      if (req?.signal) {
        try {
          req.signal.removeEventListener('abort', onAbort)
        } catch {
          /* 忽略 */
        }
      }
    }
    // 请求被取消（用户关了回合、工具超时）时不再等 QQ，也不要留悬挂的待审批。
    const onAbort = () => resolveDecided({ code, outcome: 'aborted' })
    if (req?.signal) {
      try {
        req.signal.addEventListener('abort', onAbort, { once: true })
      } catch {
        /* 忽略 */
      }
    }

    entry.timer = setTimeout(() => resolveDecided({ code, outcome: 'timeout' }), secs * 1000)
    if (typeof entry.timer?.unref === 'function') entry.timer.unref()

    // 下游只有给出真实结果才参与竞争；unavailable 说明没人在看界面，继续等 QQ。
    const fromDownstream = downstream.then(
      (outcome) =>
        new Promise((resolve) => {
          if (outcome && outcome !== 'unavailable') resolve({ code, outcome })
        }),
      () =>
        new Promise(() => {
          /* 下游失败不参与竞争：交给 QQ 决定或超时交还 */
        }),
    )

    void (async () => {
      for (const uid of allow) {
        await tellApproval(uid, approvalNoticeText(code, req, secs))
      }
    })()

    const first = await Promise.race([decided, fromDownstream])
    clearEntry()
    if (first.outcome === 'timeout' || first.outcome === 'aborted') {
      log(`[approval] ${code} ${first.outcome}，交回界面`)
      return downstream
    }
    log(`[approval] ${code} 由 QQ 决定: ${first.outcome}`)
    const reply = first.outcome === 'allowed-once' ? `已允许 ${code}。` : `已拒绝 ${code}。`
    void (async () => {
      for (const uid of allow) await tellApproval(uid, reply)
    })()
    return first.outcome
  }

  if (typeof ctx.on === 'function') {
    try {
      ctx.on(
        'approval/request',
        (req, next) =>
          answerApproval(req, next).catch((err) => {
            log(`[approval] 应答异常: ${err instanceof Error ? err.message : String(err)}`)
            return 'unavailable'
          }),
        { prepend: true, global: true },
      )
      log('[approval] 已挂 approval/request（prepend），远程审批就绪')
    } catch (err) {
      log(`[approval] 挂载失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    log('[approval] ctx.on 不存在，远程审批未挂')
  }

  // ── 远程提问 ──────────────────────────────────────────────────────────────
  // user-questions/request 与 approval/request 是同一套 waterfall：谁先给出结果算谁的。
  // 桌面端那张提问卡片只是一个 answerer，它一接管就进去等点击，QQ 这边再也看不到这条提问。
  // 所以策略与远程审批一致：prepend 抢在最前，把问题同步发到 QQ，同时把请求原样交给下游
  // （界面卡片照常弹），两边并行等，谁先答听谁的。
  //
  // 与审批不同的两处：
  //   · 这里的返回值就是答案本身 { answers: [{id, selected, custom?}] }，没有「我不处理」
  //     这种占位值 —— 拿不出答案时只能把下游的结果原样交回去（下游没人接会自己按
  //     NO_PROVIDER 收场，askTimed 据此把这一轮放成 pending）。
  //   · 提问有时间上限（工具默认 120 秒）。超时后问题在投影里变成「继续」状态，
  //     这时迟到的 QQ 回答改走 userQuestions.answer() 补投，不再经过 waterfall。
  const asks = new Map() // code -> { code, callId, agent, sessionId, list, submit, askedAt, timer, signal, onAbort }
  let askSeq = 0

  function nextAskCode() {
    askSeq = (askSeq + 1) % 10000
    let code = 'Q' + String(askSeq).padStart(4, '0')
    while (asks.has(code)) {
      askSeq = (askSeq + 1) % 10000
      code = 'Q' + String(askSeq).padStart(4, '0')
    }
    return code
  }

  function clipText(text, max) {
    const s = String(text ?? '').trim()
    return s.length > max ? s.slice(0, max - 1) + '…' : s
  }

  /** 这条提问该发给谁：优先发给把该会话当默认路由的 QQ，没有就发给整个白名单。 */
  function askTargets(sessionId) {
    const owners = []
    for (const [qq, sid] of sticky) if (sid === sessionId) owners.push(qq)
    return owners.length ? owners : [...allow]
  }

  async function tellAsk(qq, text) {
    try {
      await sendText(qq, text)
    } catch (err) {
      log(`[ask] 发送失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function askNoticeText(code, sessionId, title, list, secs) {
    const lines = [
      `【远程提问 ${code}】会话 ${shortId(sessionId)}${title ? ' 「' + clipText(title, 30) + '」' : ''} 等你回答 ${list.length} 个问题`,
      `电脑上的卡片也能答，谁先答听谁的；${secs} 秒内没回答就交回界面。`,
    ]
    list.forEach((q, i) => {
      const options = Array.isArray(q.options) ? q.options : []
      lines.push('')
      lines.push(`Q${i + 1}${q.header ? '[' + clipText(q.header, 12) + '] ' : ' '}${clipText(q.question, 400)}`)
      if (q.detail) lines.push(clipText(q.detail, 400))
      options.forEach((option, j) => {
        lines.push(`  ${j + 1}) ${clipText(option?.label, 100)}${option?.description ? ' —— ' + clipText(option.description, 120) : ''}`)
      })
      if (!options.length) lines.push('  （没有选项，直接写文字）')
      else lines.push(`  （${q.multiSelect ? '多选，可用逗号写多个' : '单选'}）`)
    })
    lines.push('')
    const firstOptions = Array.isArray(list[0]?.options) ? list[0].options : []
    lines.push(
      list.length > 1
        ? `回复：${prefix}answer ${code} 1:2 2:1,3    「题号:选项号」，多题用空格隔开，某题不答就写「题号:」`
        : firstOptions.length
          ? `回复：${prefix}answer ${code} 2   （选项号）；想写自己的话就直接写：${prefix}answer ${code} 就这样办`
          : `回复：${prefix}answer ${code} 你的回答`,
    )
    return lines.join('\n')
  }

  /** 把「1:2 2:1,3」这种回答记号切成 [{no, text}]；没有题号时整段当一段。 */
  function parseAskSpec(spec) {
    const norm = String(spec ?? '')
      .replace(/：/g, ':')
      .replace(/；/g, ';')
      .replace(/，/g, ',')
      .trim()
    const marks = []
    const re = /(\d+)\s*:/g
    let hit = re.exec(norm)
    while (hit) {
      marks.push({ no: Number(hit[1]), start: hit.index, end: re.lastIndex })
      hit = re.exec(norm)
    }
    if (!marks.length) return [{ no: null, text: norm }]
    return marks.map((mark, i) => {
      const stop = i + 1 < marks.length ? marks[i + 1].start : norm.length
      return { no: mark.no, text: norm.slice(mark.end, stop).trim() }
    })
  }

  /** 把 QQ 上的一句话翻成 ask() 认的答案数组：每道题恰好一条，没答的给空选择。 */
  function buildAskAnswers(list, spec) {
    let segments = parseAskSpec(spec)
    if (segments.length === 1 && segments[0].no === null && list.length > 1) {
      segments = segments[0].text.split(/[\s;]+/).filter(Boolean).map((text) => ({ no: null, text }))
    }
    const slots = new Array(list.length).fill(null)
    for (const segment of segments) {
      if (segment.no === null) {
        if (list.length === 1) {
          slots[0] = segment
          continue
        }
        const free = slots.findIndex((slot) => slot === null)
        if (free < 0) throw new Error(`只有 ${list.length} 个问题，多出来一段：${clipText(segment.text, 20)}`)
        slots[free] = segment
        continue
      }
      if (!(segment.no >= 1 && segment.no <= list.length)) {
        throw new Error(`没有第 ${segment.no} 题（共 ${list.length} 题）`)
      }
      if (slots[segment.no - 1]) throw new Error(`第 ${segment.no} 题写了两遍`)
      slots[segment.no - 1] = segment
    }
    const answers = list.map((question, i) => {
      const segment = slots[i]
      if (!segment || !segment.text) return { id: question.id, selected: [] }
      const options = Array.isArray(question.options) ? question.options : []
      if (options.length && /^[\d\s,]+$/.test(segment.text)) {
        const picked = []
        for (const raw of segment.text.split(',').map((s) => s.trim()).filter(Boolean)) {
          const n = Number(raw)
          if (!(n >= 1 && n <= options.length)) {
            throw new Error(`第 ${i + 1} 题只有 ${options.length} 个选项，没有 ${n} 号`)
          }
          const label = String(options[n - 1]?.label ?? '')
          if (label && !picked.includes(label)) picked.push(label)
        }
        if (!picked.length) throw new Error(`第 ${i + 1} 题没读出选项号`)
        if (!question.multiSelect && picked.length > 1) throw new Error(`第 ${i + 1} 题是单选，只能选一个`)
        return { id: question.id, selected: picked }
      }
      return { id: question.id, selected: [], custom: segment.text }
    })
    if (!answers.some((answer) => answer.selected.length || answer.custom !== undefined)) {
      throw new Error('没读出任何回答')
    }
    return answers
  }

  function askUsage(code, count) {
    return count > 1 ? `${prefix}answer ${code} 1:2 2:1,3` : `${prefix}answer ${code} 2`
  }

  /** 清掉一条待答记录的定时器/监听器；表里的条目由调用方决定要不要删。 */
  function releaseAsk(entry) {
    if (!entry) return
    if (entry.timer) {
      try {
        clearTimeout(entry.timer)
      } catch {
        /* 忽略 */
      }
      entry.timer = null
    }
    if (entry.signal && entry.onAbort) {
      try {
        entry.signal.removeEventListener('abort', entry.onAbort)
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 提问应答方：QQ 先答就用 QQ 的，其余情况把决定权原样交回下游。 */
  async function mirrorAsk(req, next) {
    const downstream = Promise.resolve().then(() => next())
    if (!config.questions_remote) return downstream
    if (!bot || allow.size === 0) return downstream

    const agent = req?.agent
    const callId = req?.wait?.callId
    const list = Array.isArray(req?.questions) ? req.questions : []
    if (!agent || !callId || !list.length) return downstream
    const sessionId = String(agent?.session?.header?.id ?? agent?.id ?? '')

    // 老条目顺手清一清，别让表无限长。
    const cutoff = Date.now() - 2 * 60 * 60 * 1000
    for (const [code, entry] of asks) {
      if (entry.askedAt && entry.askedAt < cutoff) {
        // 先结束它的 decided，再删：question_timeout_secs 超过 2 小时时，
        // 直接删表会让 Promise.race 永远等不到结果，那一轮提问就挂死了。
        try {
          entry.expire?.()
        } catch {
          /* 忽略 */
        }
        releaseAsk(entry)
        asks.delete(code)
      }
    }

    const secs = Number(config.question_timeout_secs) || 1800
    const code = nextAskCode()
    let resolveDecided = () => {}
    const decided = new Promise((resolve) => {
      resolveDecided = resolve
    })
    const entry = {
      code,
      callId,
      agent,
      sessionId,
      list,
      askedAt: Date.now(),
      timer: null,
      signal: req?.signal ?? null,
      onAbort: null,
      submit: (answers) => resolveDecided({ outcome: 'answered', answers }),
      expire: () => resolveDecided({ outcome: 'timeout' }),
    }
    asks.set(code, entry)

    entry.onAbort = () => resolveDecided({ outcome: 'aborted' })
    if (entry.signal) {
      try {
        if (entry.signal.aborted) entry.onAbort()
        else entry.signal.addEventListener('abort', entry.onAbort, { once: true })
      } catch {
        /* 忽略 */
      }
    }
    entry.timer = setTimeout(() => resolveDecided({ outcome: 'timeout' }), secs * 1000)
    if (typeof entry.timer?.unref === 'function') entry.timer.unref()

    // 下游只有真的给出答案才参与竞争；失败（没人接）就不参与，安静等 QQ。
    const fromDownstream = downstream.then(
      (value) => ({ outcome: 'downstream', value }),
      () =>
        new Promise(() => {
          /* 下游没人接：继续等 QQ 或超时 */
        }),
    )

    void (async () => {
      try {
        const title = await readTitle(sessionId)
        const text = askNoticeText(code, sessionId, title, list, secs)
        for (const uid of askTargets(sessionId)) await tellAsk(uid, text)
        log(`[ask] ${code} 已同步到 QQ（${sessionId}，${list.length} 题）`)
      } catch (err) {
        log(`[ask] ${code} 通知失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    })()

    const first = await Promise.race([decided, fromDownstream])
    releaseAsk(entry)
    entry.submit = null

    if (first.outcome === 'answered') {
      asks.delete(code)
      log(`[ask] ${code} 由 QQ 回答`)
      void (async () => {
        for (const uid of askTargets(sessionId)) await tellAsk(uid, `已在 QQ 提交 ${code} 的答案。`)
      })()
      return { answers: first.answers }
    }
    if (first.outcome === 'downstream') {
      asks.delete(code)
      log(`[ask] ${code} 已在界面回答`)
      void (async () => {
        for (const uid of askTargets(sessionId)) await tellAsk(uid, `提问 ${code} 已经在电脑上回答过了。`)
      })()
      return first.value
    }
    // 超时或被取消：条目留着，迟到的 #答 走 userQuestions.answer() 补投。
    log(`[ask] ${code} ${first.outcome}，交回界面`)
    return downstream
  }

  if (typeof ctx.on === 'function') {
    try {
      ctx.on(
        'user-questions/request',
        (req, next) =>
          mirrorAsk(req, next).catch((err) => {
            log(`[ask] 应答异常: ${err instanceof Error ? err.message : String(err)}`)
            throw err
          }),
        { prepend: true, global: true },
      )
      log('[ask] 已挂 user-questions/request（prepend），远程提问就绪')
    } catch (err) {
      log(`[ask] 挂载失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    log('[ask] ctx.on 不存在，远程提问未挂')
  }

  /** 这条提问还在投影里等着吗（已在界面答过/被取消的就没必要再答）。 */
  function askStillOpen(entry) {
    try {
      const projections = ctx.get?.('sessionProjections')
      const view = projections?.stateOf?.(entry.agent?.session, 'userQuestions')
      const active = view?.questions?.active
      if (!Array.isArray(active)) return true
      return active.some((item) => item.callId === entry.callId)
    } catch {
      return true
    }
  }

  /** #答：把 QQ 上的回答交给那条提问（前台还在等就直接交，等过了就补投）。 */
  async function answerAskFromQq(qq, rest) {
    for (const [code, entry] of asks) {
      if (askStillOpen(entry)) {
        entry.projected = true
        continue
      }
      // 插件自己发起的提问（如 #testask）没有 tool/call 投影记录，查不到不等于已经结束
      if (!entry.projected) continue
      releaseAsk(entry)
      asks.delete(code)
    }
    const pending = [...asks.values()]
    if (!pending.length) {
      await sendText(qq, `现在没有等你回答的提问。（${prefix}ap 看审批，${prefix}running 看在跑的会话）`)
      return
    }

    const words = String(rest ?? '').trim().split(/\s+/).filter(Boolean)
    let code = null
    if (words.length && /^q\d+$/i.test(words[0])) code = words.shift().toUpperCase()
    const entry = code ? asks.get(code) : pending.length === 1 ? pending[0] : null
    if (!entry) {
      const rows = pending.map((item) => `${item.code}  ${shortId(item.sessionId)}  ${item.list.length} 题`)
      await sendText(
        qq,
        [
          code ? `没有 ${code} 这个提问。` : `有 ${pending.length} 个待回答的提问，得带编号。`,
          '等你回答的提问：',
          ...rows,
          '',
          `回复：${prefix}answer <编号> ` + (pending[0].list.length > 1 ? '1:2 2:1,3' : '2'),
        ].join('\n'),
      )
      return
    }

    const spec = words.join(' ').trim()
    if (!spec) {
      await sendText(qq, `用法：${askUsage(entry.code, entry.list.length)}；也可以直接写文字当自定义回答。`)
      return
    }

    let answers
    try {
      answers = buildAskAnswers(entry.list, spec)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await sendText(qq, `这句回答没看懂：${message}\n\n用法：${askUsage(entry.code, entry.list.length)}`)
      return
    }

    const summary = answers
      .map((answer, i) => `${i + 1}) ${answer.custom !== undefined ? answer.custom : answer.selected.length ? answer.selected.join('、') : '（跳过）'}`)
      .join('\n')

    if (typeof entry.submit === 'function') {
      const submit = entry.submit
      entry.submit = null
      asks.delete(entry.code)
      releaseAsk(entry)
      log(`[ask] ${entry.code} 由 QQ 回答: ${summary.replace(/\n/g, ' | ')}`)
      submit(answers)
      await sendText(qq, `已提交答案给 ${shortId(entry.sessionId)}：\n${summary}`)
      return
    }

    // 前台等待已经结束（超时/取消/界面已答）：走迟到回答通道补投给模型。
    const service = ctx.get?.('userQuestions')
    if (!service || typeof service.answer !== 'function') {
      await sendText(qq, '这条提问的前台等待已经结束，而且拿不到 userQuestions 服务，答不上了。')
      return
    }
    let ok = false
    try {
      ok = Boolean(await service.answer(entry.agent, entry.callId, { answers }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`[ask] ${entry.code} 补投失败: ${message}`)
      await sendText(qq, `提交失败：${message}`)
      return
    }
    asks.delete(entry.code)
    releaseAsk(entry)
    await sendText(
      qq,
      ok
        ? `已把答案补交给 ${shortId(entry.sessionId)}（前台等待早结束了，作为迟到回答进入模型）：\n${summary}`
        : `这条提问已经不在等待（超时太久 / 已在电脑上答过 / 被取消），答案没交出去：\n${summary}`,
    )
  }

  /**
   * #testask：不借任何会话，插件直接发一条多选提问，端到端验证 QQ 提问通路。
   * 走的是和模型调 ask_user_question 完全相同的 waterfall，区别只是发起方是插件自己。
   */
  async function testAskOnce(qq) {
    const service = ctx.get?.('userQuestions')
    if (!service || typeof service.ask !== 'function') {
      await sendText(qq, '拿不到 userQuestions 服务，测不了（这个 profile 可能没装提问服务）。')
      return
    }
    const live = liveSessions()
    if (!live.length) {
      await sendText(qq, '现在没有任何活着的会话 agent，提问需要一个活的 agent 承载：先跟某个会话说句话再来试。')
      return
    }
    // 优先用这个 QQ 的默认路由，其次随便挑一个活着的（ask 要求是运行时根 agent）。
    const roots = typeof agents.roots === 'function' ? agents.roots() : []
    const pool = roots.length ? live.filter((item) => roots.includes(item.agent)) : live
    const usable = pool.length ? pool : live
    const current = sticky.get(qq) ?? config.default_session ?? ''
    const want = current ? (await resolveRoute(current).catch(() => null)) ?? current : ''
    const target = usable.find((item) => item.sid === want) ?? usable[0]

    const callId = `qqtest-${Date.now().toString(36)}`
    const questions = [
      {
        id: 'qq_test',
        header: '自检',
        question: 'QQ 远程提问自检：下面几个里，你最想给远程 QQ 再加哪些能力？',
        detail: '多选，选几个都行。这条提问由插件直接发起，不经过任何模型。',
        multiSelect: true,
        options: [
          { label: '图片/文件回传', description: '把截图、生成的文档直接发到 QQ' },
          { label: '语音回答', description: '在 QQ 发语音就能回答提问' },
          { label: '会话进度推送', description: '定时把在跑会话的进展推到 QQ' },
        ],
      },
    ]
    await sendText(qq, `开始自检（${shortId(target.sid)}）：这就发一条多选提问，按提示回 ${prefix}answer 即可。`)
    void (async () => {
      try {
        const result = await service.ask({ questions, agent: target.agent, wait: { callId } })
        const answers = Array.isArray(result?.answers) ? result.answers : []
        const text = answers
          .map((answer) => `${answer.id}: ${(answer.selected ?? []).join('、') || '（跳过）'}${answer.custom !== undefined ? ' / ' + answer.custom : ''}`)
          .join('\n')
        log(`[ask] 自检完成 ${callId}: ${text.replace(/\n/g, ' | ')}`)
        await sendText(qq, `自检完成，收到的答案：\n${text}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log(`[ask] 自检失败 ${callId}: ${message}`)
        await sendText(qq, `自检没走完：${message}`)
      }
    })()
  }

  // ── 出站文件 / 图片 ──────────────────────────────────────────────────────
  function expandHome(p) {
    const raw = String(p ?? '')
      .trim()
      .replace(/^["']|["']$/g, '')
    if (!raw) return ''
    if (raw === '~') return homedir()
    const tilde = raw.slice(0, 2); if (tilde === '~' + String.fromCharCode(92) || tilde === '~/') return join(homedir(), raw.slice(2))
    return raw
  }

  /** 凭据类文件的出站闸门：命中的一律不往 QQ 发，防止一次提示注入就把密钥寄出去。 */
  const SENSITIVE_FILE_PATTERNS = [
    [/(^|[\\/])\.credentials(\.[^\\/]*)?$/i, '.credentials'],
    [/(^|[\\/])\.ssh([\\/]|$)/i, '.ssh 目录'],
    [/(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, 'SSH 私钥'],
    [/(^|[\\/])\.env(\.[^\\/]*)?$/i, '.env'],
    [/\.(pem|key|pfx|p12|kdbx)$/i, '密钥文件'],
    [/(^|[\\/])\.git-credentials$/i, 'git 凭据'],
  ]
  function sensitiveFileReason(target) {
    const text = String(target ?? '')
    for (const [pattern, label] of SENSITIVE_FILE_PATTERNS) {
      if (pattern.test(text)) return label
    }
    return ''
  }

  /** 把本机文件/图片发到 QQ（走 NapCat 的 upload_private_file）。 */
  async function sendFileTo(userId, pathText, caption) {
    const target = expandHome(pathText)
    if (!target) throw new Error('没给文件路径')
    if (!existsSync(target)) throw new Error(`文件不存在：${target}`)
    const info = statSync(target)
    if (!info.isFile()) throw new Error(`这不是文件：${target}`)
    const blocked = sensitiveFileReason(target)
    if (blocked) throw new Error(`不发送凭据类文件（${blocked}）：${target}`)
    if (info.size > 100 * 1024 * 1024) {
      throw new Error(`文件太大（${(info.size / 1048576).toFixed(1)} MB，上限 100 MB）`)
    }
    if (caption && String(caption).trim()) await sendText(userId, String(caption).trim())
    const segs = target.split('/')
    let name = segs[segs.length - 1]
    const cut = name.lastIndexOf(String.fromCharCode(92))
    if (cut >= 0) name = name.slice(cut + 1)
    if (!name) name = 'file'
    try {
      await sendRaw('upload_private_file', { user_id: userId, file: target, name })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`发送失败（NapCat 需要支持 upload_private_file）：${message}`)
    }
    log(`[file] -> ${userId} ${name} (${info.size} bytes)`)
    return { name, size: info.size }
  }

  const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

  /** 把本机图片/动图当表情发出去：QQ 里直接显示成图片，不是文件卡片。 */
  async function sendImageTo(userId, pathText, caption, options = {}) {
    const group = options.group === true
    const target = expandHome(pathText)
    if (!target) throw new Error('没给图片路径')
    if (!existsSync(target)) throw new Error(`图片不存在：${target}`)
    const info = statSync(target)
    if (!info.isFile()) throw new Error(`这不是文件：${target}`)
    const dot = target.lastIndexOf('.')
    const ext = dot >= 0 ? target.slice(dot).toLowerCase() : ''
    if (!IMAGE_EXT.has(ext)) {
      throw new Error(`只支持图片与动图（${[...IMAGE_EXT].join(' ')}），收到 ${ext || '无扩展名'}`)
    }
    const blocked = sensitiveFileReason(target)
    if (blocked) throw new Error(`不发送凭据类文件（${blocked}）：${target}`)
    if (info.size > 10 * 1024 * 1024) {
      throw new Error(`图片太大（${(info.size / 1048576).toFixed(1)} MB，上限 10 MB）`)
    }
    const base = target.replace(/\\/g, '/').replace(/^\/+/, '')
    const text = String(caption ?? '').trim()
    const build = (uri) => {
      const message = [{ type: 'image', data: { file: uri } }]
      if (text) message.push({ type: 'text', data: { text } })
      return message
    }
    const payload = (uri) => (group ? { group_id: userId, message: build(uri) } : { user_id: userId, message: build(uri) })
    const action = group ? 'send_group_msg' : 'send_private_msg'
    try {
      await sendRaw(action, payload('file:///' + base))
    } catch (first) {
      // 中文或空格路径在部分 OneBot 实现里要百分号编码，失败后换编码再试一次
      try {
        await sendRaw(action, payload('file:///' + encodeURI(base)))
      } catch (second) {
        const msg = second instanceof Error ? second.message : String(second)
        throw new Error(`发送图片失败：${msg}`)
      }
    }
    log(`[img] -> ${group ? 'group:' : ''}${userId} ${target} (${info.size} bytes)`)
    const parts = target.split(/[\\/]/)
    return { name: parts[parts.length - 1] || 'image', size: info.size }
  }

  /** 表情目录：把 png / jpg / gif 丢进去，手机上用 #sticker <名字> 发。 */
  function stickerRoot() {
    const fallback = join(dshHome, 'dsh-toolkit-stickers')
    const dir = resolveStickerDir(config.sticker_dir, fallback)
    return expandHome(dir) || dir
  }

  // 把表情目录告诉会话里的 AI：它自己想不到去 ls 一个它不知道的目录。
  // 2063 张的目录 readdir 一次不便宜，缓存 60 秒。
  let stickerHintCache = { at: 0, text: '' }
  function stickerHint() {
    const now = Date.now()
    if (now - stickerHintCache.at < 60000) return stickerHintCache.text
    let text = ''
    try {
      const root = stickerRoot()
      const count = Number(stickerInfo(config.sticker_dir, join(dshHome, 'dsh-toolkit-stickers')).count ?? 0)
      if (count > 0) {
        text =
          `[表情包] 本机表情目录 ${root}（${count} 张，可能有子目录）。` +
          `要发表情就调 qq_send_image，path 传这个目录下的绝对路径；` +
          `不确定文件名就先 ls 一次再挑，别凭印象编路径，也别把整个目录贴进正文。`
      }
    } catch {
      text = ''
    }
    stickerHintCache = { at: now, text }
    return text
  }

  async function stickerNames() {
    const root = stickerRoot()
    let names = []
    try {
      names = await readdir(root)
    } catch {
      return null
    }
    const out = []
    const walk = async (dir, rel, depth) => {
      let entries = []
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const abs = join(dir, entry.name)
        const relPath = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (depth < 3) await walk(abs, relPath, depth + 1)
          continue
        }
        if (!IMAGE_EXT.has(entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase())) continue
        out.push({ name: entry.name, rel: relPath, path: abs })
      }
    }
    await walk(root, '', 0)
    return out.sort((a, b) => a.rel.localeCompare(b.rel))
  }

  async function stickerFromQq(qq, rest) {
    const want = String(rest ?? '').trim()
    const items = await stickerNames()
    if (items === null) {
      await sendText(qq, `还没有表情目录：${stickerRoot()}\n把 png / jpg / gif 丢进去，再用 ${prefix}sticker <名字> 发。`)
      return
    }
    if (!items.length) {
      await sendText(qq, `表情目录是空的：${stickerRoot()}`)
      return
    }
    if (!want) {
      const shown = items.slice(0, 30).map((item, i) => `${i + 1}. ${item.rel}`)
      await sendText(
        qq,
        [
          `表情目录（共 ${items.length} 个）：${stickerRoot()}`,
          ...shown,
          items.length > 30 ? '只列前 30 个，也可以直接用名字搜。' : '',
          `发 ${prefix}sticker <编号或名字> 就发过去。`,
        ]
          .filter(Boolean)
          .join('\n'),
      )
      return
    }
    const byIndex = /^\d+$/.test(want) ? items[Number(want) - 1] : null
    const lower = want.toLowerCase()
    const hit = byIndex || items.find((item) => item.rel.toLowerCase().includes(lower))
    if (!hit) {
      await sendText(qq, `没找到「${want}」，发 ${prefix}sticker 看列表。`)
      return
    }
    try {
      const { size } = await sendImageTo(qq, hit.path)
      log(`[sticker] -> ${qq} ${hit.rel} (${size} bytes)`)
    } catch (err) {
      await sendText(qq, `发不出去：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function fileFromQq(qq, rest) {
    const spec = String(rest ?? '').trim()
    if (!spec) {
      await sendText(qq, `用法：${prefix}file <本地文件路径>\n例：${prefix}file D:\shot.png\n支持图片和普通文件，上限 100 MB。`)
      return
    }
    try {
      const { name, size } = await sendFileTo(qq, spec)
      await sendText(qq, `已发送 ${name}（${(size / 1024).toFixed(1)} KB）。`)
    } catch (err) {
      await sendText(qq, `发不出去：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── 会话进度推送 ────────────────────────────────────────────────────────
  let progressTimer = null
  let progressSecs = 0

  async function progressLines() {
    const live = liveSessions().filter((item) => item.running)
    if (!live.length) return ['现在没有在跑的会话。']
    const out = []
    for (const item of live) {
      let title = ''
      try {
        title = await readTitle(item.sid)
      } catch {
        title = ''
      }
      let latest = ''
      try {
        // readLatest 返回 { last, lastAssistant, lastUser, shape }，不能直接 String()
        const info = readLatest(item.agent)
        latest = clipText(String(info?.lastAssistant || info?.last || '').replace(/\s+/g, ' ').trim(), 120)
      } catch {
        latest = ''
      }
      if (!latest) latest = '（这一轮还没有输出）'
      const head = shortId(item.sid) + (title ? ` 「${clipText(title, 24)}」` : '')
      out.push(`${head}\n  ${latest}`)
    }
    return out
  }

  async function pushProgress(prefixText) {
    if (!bot) return
    const body = [prefixText, ...(await progressLines())].filter(Boolean).join('\n')
    for (const uid of allow) await sendText(uid, body)
  }

  function stopProgress() {
    if (progressTimer) clearInterval(progressTimer)
    progressTimer = null
    progressSecs = 0
  }

  function startProgress(secs) {
    stopProgress()
    progressSecs = secs
    progressTimer = setInterval(() => {
      pushProgress(`【进度推送 · 每 ${secs} 秒】`).catch((err) => {
        log(`[progress] 推送失败: ${err instanceof Error ? err.message : String(err)}`)
      })
    }, secs * 1000)
    if (typeof progressTimer?.unref === 'function') progressTimer.unref()
    log(`[progress] 已开启，每 ${secs} 秒推送一次`)
  }

  async function progressFromQq(qq, rest) {
    const word = String(rest ?? '').trim().toLowerCase()
    if (!word) {
      await sendText(
        qq,
        [
          `进度推送：${progressSecs ? `每 ${progressSecs} 秒一次` : '当前关闭'}`,
          `用法：${prefix}progress 30 开启（10–3600 秒）；${prefix}progress off 关闭；${prefix}progress now 立刻看一次`,
        ].join('\n'),
      )
      return
    }
    if (word === 'off' || word === 'stop' || word === '0' || word === '关') {
      stopProgress()
      await sendText(qq, '进度推送已关闭。')
      return
    }
    const secs = Number(word)
    if (!Number.isFinite(secs) || secs <= 0) {
      await pushProgress('【进度快照】')
      return
    }
    const clamped = Math.max(10, Math.min(3600, Math.round(secs)))
    startProgress(clamped)
    await sendText(qq, `已开启：每 ${clamped} 秒把在跑会话的最新输出推到 QQ（${prefix}progress off 关掉）。`)
  }

  const aliasMap = new Map()
  for (const entry of config.aliases ?? []) {
    const i = String(entry).indexOf('=')
    if (i > 0) aliasMap.set(String(entry).slice(0, i).trim(), String(entry).slice(i + 1).trim())
  }


  // ── 路由表 ────────────────────────────────────────────────────────────────
  let bot = null
  let table = { builtAt: 0, byIndex: new Map(), byShort: new Map(), items: [] }
  const sticky = new Map() // qq -> sessionId（#set 设定的默认会话）
  // qq -> 最近一次真正注入过的会话。不用 sticky：前缀路由（#1 …）不会改 sticky，
  // 但用户显然是想接着刚才那个会话聊，纯媒体消息（只发图不发字）必须跟到那里去。
  // 这个也要落盘：不落盘的话重启后第一张图又会退回到旧的 sticky 会话。
  const lastRoute = new Map()
  // qq -> 这个用户最近一条消息的 message_id（qq_reply 默认引用它）。
  // 同样落盘：重启后默认引用仍然指向真正的上一条，而不是靠调用方猜 id。
  const lastInId = new Map()
  // message_id -> 处理时间：同一事件被本通道和桥各送来一次时只算一次。
  const handledIds = new Map()
  // 绑定账号：bind_token 非空时，只有这个号的消息会被处理（见 handleMessage）。
  let boundQq = 0
  const statePath = join(dshHome, 'dsh-qq-router-state.json')
  try {
    const saved = JSON.parse(readFileSync(statePath, 'utf8')) ?? {}
    // 默认会话与「最近聊过的会话」故意不恢复：每次重启都清空，第一句话必然先提示
    // 选定默认会话，不会悄悄落进重启前那个会话。入站 message_id 仍然恢复，
    // 因为 qq_reply 的默认引用要指向真正的上一条。
    for (const [k, v] of Object.entries(saved.lastIn ?? {})) {
      if (v !== undefined && v !== null && String(v)) lastInId.set(Number(k), String(v))
    }
    const bound = Number(saved.boundQq) || 0
    if (bound) {
      boundQq = bound
      log(`[state] 绑定账号 ${boundQq}（重启保留）`)
    }
    log('[state] 路由已重置（重启不恢复默认会话），先发 #list 选一个')
  } catch {
    /* 首次运行没有状态文件 */
  }
  const persistSticky = () => {
    try {
      writeFileSync(
        statePath,
        JSON.stringify({ lastIn: Object.fromEntries(lastInId), boundQq }, null, 2),
      )
    } catch (err) {
      log(`[state] 写入失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const pendingTurns = new Map() // qq -> 待回话的轮次数
  // qq -> 模型主动发出过多少条（单调递增）；每次 inject 记一个快照，
  // 轮末比快照就能知道"这一轮有没有主动回话"，连发两条消息也不会互相清掉标记。
  const sentCount = new Map()
  const injectMark = new Map()
  let lastOutId = '' // 最近一条发出去的消息 id（qq_recall 默认撤回它）
  let unbindAllAt = 0 // #unbind all 的确认窗口起点
  let keydelAllAt = 0 // #keydel all 的确认窗口起点

  // 会话索引与 session-ask 共用一份实现（session-index.js）：两处各自遍历与过滤，
  // 「#list 的编号」和「能被问的会话」迟早会漂移。
  let knownCwd = '' // 最近一次从会话头里读到的 cwd，供 #new 建会话时沿用
  const index = createSessionIndex({
    dshHome,
    log,
    onCwd: (cwd) => {
      knownCwd = cwd
    },
  })
  const { readTitle, readHeaderInfo, listSessions } = index


  async function refreshTable() {
    // 路由表按全量建，编号才与 #list 翻页显示的一致
    const items = await listSessions(Infinity)
    const byIndex = new Map()
    const byShort = new Map()
    items.forEach((item, i) => {
      byIndex.set(String(i + 1), item.id)
      byShort.set(shortId(item.id), item.id)
    })
    table = { builtAt: Date.now(), byIndex, byShort, items }
    log(`[table] built ${items.length} sessions`)
    return table
  }

  async function tableFresh() {
    const ttl = (Number(config.route_ttl_secs) || 1800) * 1000
    if (!table.items.length || Date.now() - table.builtAt > ttl) await refreshTable()
    return table
  }

  /** 解析一个路由记号：别名 / #list 编号 / 短 id / 完整 id / 前缀匹配。 */
  async function resolveRoute(token) {
    const t = String(token ?? '').trim()
    if (!t) return config.default_session || null
    if (aliasMap.has(t)) return aliasMap.get(t)
    if (t === 'default' || t === '默认') return config.default_session || null
    const tab = await tableFresh()
    if (tab.byIndex.has(t)) return tab.byIndex.get(t)
    if (tab.byShort.has(t)) return tab.byShort.get(t)
    if (/^[A-Za-z0-9-]{6,}$/.test(t)) {
      const all = await listSessions(200)
      const hit =
        all.find((x) => x.id === t) ||
        all.find((x) => shortId(x.id) === t) ||
        all.find((x) => x.id.startsWith(t))
      if (hit) return hit.id
    }
    return null
  }

  function fmtTime(ms) {
    if (!ms) return '未知'
    const d = new Date(ms)
    const p = (n) => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  async function renderTable(page = 1) {
    const tab = await refreshTable()
    const all = tab.items
    if (!all.length) return '没找到任何会话。'
    const pageSize = Math.max(1, Number(config.list_limit) || 12)
    const pages = Math.max(1, Math.ceil(all.length / pageSize))
    const current = Math.min(Math.max(1, Math.floor(Number(page)) || 1), pages)
    const start = (current - 1) * pageSize
    const lines = all.slice(start, start + pageSize).map((item, offset) => {
      const title = item.title || '(无标题)'
      return `${start + offset + 1}) ${title}\n     ${shortId(item.id)} · ${fmtTime(item.mtime)}`
    })
    return [
      `可用会话（共 ${all.length} 个，已排除子智能体${index.archivedSkipped() ? `与 ${index.archivedSkipped()} 个已归档会话` : ''}；第 ${current}/${pages} 页）：`,
      ...lines,
      '',
      current < pages ? `${prefix}list ${current + 1}  看下一页` : `${prefix}list 1  回到第一页`,
      `用法：${prefix}<编号|别名|短id> 要说的内容`,
      `例：${prefix}2 继续把编码那个问题修完`,
    ].join('\n')
  }

  function helpText() {
    return [
      'QQ → DSH 远程驾驶',
      `${prefix}list [页码]  列出会话与路由（已排除子智能体和已归档会话；编号会随活动变，别名和短 id 才稳）`,
      `${prefix}new        新建一个对话并设为默认路由`,
      `${prefix}check      新建对话做一次自检，结论发回 QQ`,
      `${prefix}restart [秒] 重启 DSH（默认 20 秒后）；有对话在跑时先等它们跑完，会回一份清单`,
      `${prefix}restart force  不等待立刻重启（要再发 ${prefix}restart confirm 二次确认）`,
      `${prefix}restart cancel  取消推迟中的重启`,
      `${prefix}set <路由>   设定默认会话（重启 DSH 后重置，要重新选）`,
      `${prefix}start      查两者状态；NapCat 没起来就拉起它并等登录`,
      `${prefix}link       取一个手机能打开的网页链接（局域网/隧道，本次运行有效）`,
      `${prefix}ap         列出等你决定的审批（工具要授权的操作）`,
      `${prefix}y <编号>   允许这条审批；${prefix}n <编号> 拒绝（只有一条时可省编号）`,
      `${prefix}escalate [路由]  本轮提权：当轮所有审批自动允许，回合结束恢复原权限（要再发 ${prefix}escalate confirm）`,
      `${prefix}answer <编号> 1:2  回答提问（ask_user_question 会同步到 QQ；也可以直接写文字）`,
      `${prefix}file <路径>    把本机文件/图片发到 QQ`,
      `${prefix}img <路径>     把本机图片/动图当表情直接显示（png/jpg/gif/webp/bmp）`,
      `${prefix}sticker [名字]  从表情目录挑一个发出去（不带参数列出目录）`,
      `${prefix}bind <口令>  绑定这个 QQ 号（配置了 bind_token 时，只有绑定号的消息会进 DSH）`,
      `${prefix}unbind    列出绑定，按编号逐条解绑（self 要口令）`,
      '—— 群接待（host）：一个群一个长期会话，由它自己决定说什么 ——',
      `${prefix}hoston [群号]  开启群接待（在那个群里发可以省掉群号）：被 @ 或带前缀的消息交给该群自己的会话，读资料、改文件、回话都由 AI 决定`,
      `${prefix}hostoff [群号]  关闭接待，会话保留（重开还能接着聊）`,
      `${prefix}hostlist    看哪些群开了接待、各用哪个会话`,
      `${prefix}hostpersona [reset]  看人设文件路径与内容；reset 恢复默认人设`,
      '—— 令牌（key）：一个令牌绑一个目录，可以并存多个 ——',
      `${prefix}keynew share <目录>  新建分享令牌（等价 ${prefix}sharekey <目录>）`,
      `${prefix}keylink [对象] [编号] [read|write|both|off]  查看/调整某个对象已绑定的 key 权限`,
      `${prefix}keynew team <git 目录>  新建团队令牌，同时建隔离工作区（等价 ${prefix}teamkey <git 目录>）`,
      `${prefix}keylist    列出所有令牌：类型、目录/工作区、绑定对象、监管计数`,
      `${prefix}keyunbind <令牌|all>  解绑令牌（团队令牌只解绑人，工作区留着）`,
      `${prefix}keykick <令牌|all>  踢掉绑定对象，令牌本身保留`,
      `${prefix}keydel <令牌|all>  删除令牌（all 要再发一次 all confirm；团队令牌要先 #gitdrop 工作区、处理完未合并改动）`,
      '—— 分享槽（share）：只读问答 ——',
      `${prefix}read <问题>  绑定对象问一句（分享槽只回这个前缀，别的消息不理）`,
      `${prefix}shareopen <目录> / ${prefix}shareconfirm <码>  走旧的目录确认流程生成分享令牌`,
      '—— 团队槽（team）：隔离工作区里改文件 ——',
      `${prefix}edit <要求>  绑定对象提一条改动要求（团队槽只回这个前缀，别的消息不理）`,
      `${prefix}teamopen <git 目录> / ${prefix}teamconfirm <码>  走旧的确认流程生成团队令牌`,
      '—— 改动（git）：临时分支上的提交 ——',
      `${prefix}gitlist [令牌] / ${prefix}gitdiff [令牌]  列出临时分支上的改动（带编号）、看未提交的 diff`,
      `${prefix}gitmerge [编号] [令牌] / ${prefix}gitdiscard <编号…|all> [令牌]  合并某条、丢掉不要的改动`,
      `${prefix}gitdrop [令牌]  只删隔离工作目录，改动留在分支上等你挑选`,
      `${prefix}guardreset [对象]  清监管计数（不带参数清全部）`,
      `旧名 ${prefix}sharelist / ${prefix}tokendel / ${prefix}shareunbind / ${prefix}teamunbind / ${prefix}sharekick / ${prefix}teamkick 仍可用`,
      `${prefix}progress [秒|off]  定时推送在跑会话的最新输出`,
      `${prefix}stop [路由]  停掉正在输出的会话（同客户端停止按钮；只有一个在跑时可省路由）`,
      `${prefix}testask    自检：让插件自己发一个多选提问（测 ${prefix}answer 用）`,
      `${prefix}<路由> 内容   把内容注入指定会话`,
      `${prefix}内容        注入默认会话`,
      '直接发内容（不带前缀）也是进默认会话；没设默认会话时会先提示你选',
      `${prefix}running    列出正在运行的会话`,
      `${prefix}msg [路由]    该会话最新的一条助手回复`,
      `${prefix}last [路由]   该会话里你自己发的最后一条`,
      `${prefix}status     连接状态与当前路由`,
      '',
      '消息会作为「你本人发送的普通消息」注入目标会话，',
      '电脑上那个会话照常继续，UI 里也显示成你发的。',
      '模型回话靠它主动调 onebot_send；没调的话插件会把该会话最新回复自动带回。',
      '',
      '命令打错（比如 #lisy）或编号写错时，只回这份用法，不会把错字发给 AI。',
    ].join('\n')
  }

  /** 没有默认会话时的统一提示：普通消息与纯媒体消息都用这一份。 */
  function noRouteHint() {
    return [
      '还没选定默认会话，这条消息没有发出去。',
      `先发 ${prefix}list 看编号，再发 ${prefix}set <编号> 选定；`,
      '设好之后直接说话就会进它，不用再写前缀。重启 DSH 后要重新选一次。',
    ].join('\n')
  }

  /** 命令词表：用于给打错的命令找最接近的那个。 */
  const COMMAND_WORDS = [
    'list', 'new', 'check', 'set', 'use', 'link', 'pin', 'ap', 'y', 'n',
    'start', 'running', 'msg', 'last', 'status', 'help', 'restart',
    'answer', 'ans', 'stop', 'file', 'progress', 'testask', 'escalate', 'bind', 'unbind', 'shareunbind', 'teamunbind',
    'keynew', 'keylist', 'keyunbind', 'keykick', 'keydel', 'keylink', 'sharekey', 'teamkey', 'gitlist', 'gitdiff', 'gitmerge', 'gitdiscard', 'gitdrop', 'guardreset', 'read', 'edit',
  ]

  function editDistance(a, b) {
    const m = a.length
    const n = b.length
    if (!m) return n
    if (!n) return m
    let prev = Array.from({ length: n + 1 }, (_, j) => j)
    for (let i = 1; i <= m; i += 1) {
      const cur = [i]
      for (let j = 1; j <= n; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      }
      prev = cur
    }
    return prev[n]
  }

  /**
   * 给打错的命令找最接近的命令名；差太远或本来就是它自己就返回 null。
   * 只认纯 ASCII 词，中文内容不参与匹配。
   */
  function nearestCommand(word) {
    const w = word.toLowerCase()
    let best = null
    let bestD = Infinity
    for (const c of COMMAND_WORDS) {
      const d = editDistance(w, c)
      if (d < bestD) {
        bestD = d
        best = c
      }
    }
    if (best !== w && bestD <= 2) return best
    return null
  }

  // ── 出站 ──────────────────────────────────────────────────────────────────
  async function sendRaw(action, params) {
    if (!bot) throw new Error('OneBot 未连接')
    if (typeof bot.send === 'function') return bot.send(action, params)
    if (typeof bot[action] === 'function') return bot[action](params)
    throw new Error('OneBot 客户端没有可用的发送方法')
  }

  /** 把拆好的几段包成一条合并转发送出（OneBot 11 的 send_private_forward_msg）。 */
  async function sendForward(userId, parts) {
    const nickname = String(config.forward_name ?? 'DSH').trim() || 'DSH'
    const uin = String(lastSelfId || '0')
    const messages = parts.map((text) => ({
      type: 'node',
      data: {
        name: nickname,
        uin,
        content: [{ type: 'text', data: { text } }],
      },
    }))
    await sendRaw('send_private_forward_msg', { user_id: userId, messages })
  }

  async function sendText(userId, text, options = {}) {
    const body = String(text ?? '')
    if (!body.trim()) return
    const max = Number(config.reply_chunk_size) || 4000
    const parts = chunk(body, max)
    // 会被拆成两条以上、或者调用方要求读回类内容走卡片时，包成合并转发：
    // 一次点开、不会刷屏；失败就退回逐条发。
    if (config.forward_merge !== false && isOn('qq', 'forward_merge') && (parts.length > 1 || options.forceForward === true)) {
      try {
        await sendForward(userId, parts)
        log(`[send] -> ${userId} (${body.length} chars, ${parts.length} part(s), 合并转发)`)
        return
      } catch (err) {
        log(`[send] 合并转发失败，退回逐条发送：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    for (let i = 0; i < parts.length; i += 1) {
      const sent = await sendRaw('send_private_msg', {
        user_id: userId,
        message: [{ type: 'text', data: { text: parts[i] } }],
      })
      const mid = sent?.message_id ?? sent?.data?.message_id
      if (mid) lastOutId = String(mid)
      if (i < parts.length - 1) await delay(CHUNK_DELAY_MS)
    }
    log(`[send] -> ${userId} (${body.length} chars, ${parts.length} part(s))`)
  }

  /** 给白名单里所有用户广播一条纯文本；QQ 没连上就静默跳过（延后重启的通知用它）。 */
  async function broadcast(text) {
    if (!bot) return false
    const body = String(text ?? '')
    if (!body.trim()) return false
    let sent = 0
    for (const uid of allow) {
      try {
        await sendText(uid, body)
        sent += 1
      } catch (err) {
        log(`[broadcast] -> ${uid} 失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return sent > 0
  }

  // ── 入站媒体 ──────────────────────────────────────────────────────────────
  // QQ 发来的图片/文件/语音在事件里只是段描述：图片给 file 名或 url，文件给 file_id，
  // 语音给 file。NapCat 和 DSH 同机，先用 OneBot 的取文件接口拿本地路径，拿不到再按 url 下载，
  // 统一存到 $DSH_HOME/dsh-toolkit-media，把路径写进注入正文，模型就能用 read_image / read 直接看。
  function mediaRoot() {
    const custom = String(config.media_dir ?? '').trim()
    return custom || join(dshHome, 'dsh-toolkit-media')
  }

  function safeFileName(name, fallback) {
    const base = String(name ?? '').split(/[\\/]/).pop() || fallback
    const cleaned = base.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(-80)
    return cleaned || fallback
  }

  async function downloadToFile(url, target) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, buf)
    return buf.length
  }

  async function copyLocalToFile(from, target) {
    if (!from || !existsSync(from)) return 0
    await mkdir(dirname(target), { recursive: true })
    await copyFile(from, target)
    return statSync(target).size
  }

  /** 把一条媒体段落到本机，返回 { kind, name, path, bytes }；失败返回 null。 */
  async function saveInboundMedia(uid, seg, seq) {
    const kind = String(seg?.type ?? '')
    if (!['image', 'record', 'file', 'video'].includes(kind)) return null
    const data = seg.data ?? {}
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const ext = kind === 'image' ? '.png' : kind === 'record' ? '.mp3' : kind === 'video' ? '.mp4' : ''
    const name = safeFileName(data.file_name ?? data.name ?? data.file, `media${ext}`)
    const target = join(mediaRoot(), `${stamp}-${seq}-${name}`)
    const attempts = []
    if (kind === 'image') attempts.push(() => sendRaw('get_image', { file: data.file }))
    if (kind === 'record') attempts.push(() => sendRaw('get_record', { file: data.file, out_format: 'mp3' }))
    if (kind === 'file') attempts.push(() => sendRaw('get_private_file_url', { file_id: data.file_id, user_id: uid }))
    if (data.url) attempts.push(() => Promise.resolve({ url: data.url }))
    if (typeof data.file === 'string' && data.file) attempts.push(() => Promise.resolve({ file: data.file }))
    for (const attempt of attempts) {
      let info = null
      try {
        info = await attempt()
      } catch (err) {
        log(`[media] 取 ${kind} 失败：${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      try {
        if (info?.base64) {
          const buf = Buffer.from(String(info.base64).replace(/^base64:\/\//, ''), 'base64')
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, buf)
          if (buf.length > 0) return { kind, name, path: target, bytes: buf.length }
          continue
        }
        const local = info?.file ?? info?.path
        if (local) {
          const bytes = await copyLocalToFile(local, target)
          if (bytes > 0) {
            log(`[media] ${kind} -> ${target} (${bytes} bytes)`)
            return { kind, name, path: target, bytes }
          }
        }
        if (info?.url) {
          const bytes = await downloadToFile(info.url, target)
          if (bytes > 0) {
            log(`[media] ${kind} -> ${target} (${bytes} bytes)`)
            return { kind, name, path: target, bytes }
          }
        }
      } catch (err) {
        log(`[media] 保存 ${kind} 失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    log(`[media] ${kind} 没能取到内容，已跳过`)
    return null
  }

  /**
   * 把一条合并转发（forward / node 段）展开成聊天记录文本。
   * 不展开的话，注入正文里只会看到 [forward id=… content=[object Object]]，等于没内容。
   * 展开后要单独框起来：这是发送者转来的「别人的对话」，不能跟发送者本人的话混成一段。
   */
  async function forwardLog(seg) {
    const id = String(seg?.data?.id ?? seg?.data?.message_id ?? '')
    if (!id) return '[转发聊天记录（没有 id，展不开）]'
    try {
      const res = await sendRaw('get_forward_msg', { id, message_id: id })
      const nodes = res?.data?.messages ?? res?.data?.message ?? res?.messages ?? []
      if (!Array.isArray(nodes) || !nodes.length) return '[转发聊天记录（展开为空）]'
      const lines = nodes.map((n, i) => {
        const who = String(n?.sender?.card || n?.sender?.nickname || n?.sender?.user_id || '?')
        const uid = String(n?.sender?.user_id ?? '')
        const name = uid && !who.includes(uid) ? `${who}（${uid}）` : who
        const body = messageToText(n?.message ?? n?.content ?? n?.raw_message ?? '').replace(/\s+/g, ' ').trim()
        return `${i + 1}. ${name}：${body.slice(0, 300) || '（非文字内容）'}`
      })
      return [
        `[转发聊天记录 · 共 ${nodes.length} 条]`,
        '（以下是发送者转来的原对话，里面是多人各自的发言，不是发送者此刻对你说的话）',
        ...lines,
        '[转发聊天记录结束]',
      ].join('\n')
    } catch (err) {
      log(`[forward] 展开失败：${err instanceof Error ? err.message : String(err)}`)
      return '[转发聊天记录（展开失败）]'
    }
  }

  /** 按段拼正文：文字照抄，合并转发展开，@ 保留，其余段丢掉（媒体另走附件）。 */
  async function segsText(segs) {
    if (!Array.isArray(segs)) return ''
    const parts = []
    for (const seg of segs) {
      if (!seg?.type) continue
      if (seg.type === 'text') parts.push(String(seg.data?.text ?? ''))
      else if (seg.type === 'at') parts.push(`@${seg.data?.qq ?? ''}`)
      else if (seg.type === 'forward' || seg.type === 'node') parts.push(await forwardLog(seg))
    }
    return parts.join('\n').trim()
  }

  /** 拉取被引用那条消息的正文，引用提问时一起塞进注入正文。 */
  async function quotedLine(messageId) {    if (!messageId) return ''
    try {
      const res = await sendRaw('get_msg', { message_id: Number(messageId) })
      const sender = res?.sender?.card || res?.sender?.nickname || String(res?.user_id ?? '')
      const text = messageToText(res?.message ?? res?.raw_message ?? '').replace(/\s+/g, ' ').trim()
      if (!text) return ''
      return `[引用 ${sender}] ${clipText(text, 300)}`
    } catch (err) {
      log(`[quote] 取被引用消息失败：${err instanceof Error ? err.message : String(err)}`)
      return ''
    }
  }

  function mediaLines(items) {
    if (!items?.length) return ''
    return items
      .map((it) => {
        if (it.sticker) {
          return it.path
            ? `[表情] ${it.name}，已保存到 ${it.path}（${it.bytes} 字节）；要用 read_image 看，或直接用 qq_send_image 发回去。`
            : `[表情] ${it.name}（QQ 商城表情，只有名称/emoji_id，没有本机文件；想回它就从表情目录里挑一张。）`
        }
        return `[${it.kind}] 已保存到 ${it.path}（${it.bytes} 字节）；图片用 read_image 读，文本文件用 read。`
      })
      .join('\n')
  }

  const STICKER_KINDS = ['mface', 'marketface', 'face']
  const MEDIA_KINDS = ['image', 'record', 'file', 'video', ...STICKER_KINDS]

  /** 表情段：能拿到 url/文件就落盘，拿不到也回一条「是什么表情」的说明。 */
  async function saveSticker(seg, seq) {
    const data = seg?.data ?? {}
    const label = String(data.summary ?? data.face_text ?? data.name ?? data.emoji_id ?? data.id ?? '未知表情').trim()
    const idPart = data.emoji_id || data.id ? ` emoji_id=${data.emoji_id ?? data.id}` : ''
    const saved = await saveInboundMedia(0, { type: data.url || data.file ? 'image' : 'face', data }, seq)
    if (saved) return { kind: 'sticker', sticker: true, name: `${label}${idPart}`, path: saved.path, bytes: saved.bytes }
    return { kind: 'sticker', sticker: true, name: `${label}${idPart}`, path: '', bytes: 0 }
  }

  /** 把入站媒体与引用拼成附加在注入正文后面的说明段。 */
  async function attachmentFor(uid, mediaSegs, replySeg) {
    const items = []
    const mediaOn = config.inbound_media !== false && isOn('qq', 'inbound_media')
    for (let i = 0; mediaOn && i < (mediaSegs?.length ?? 0); i += 1) {
      const seg = mediaSegs[i]
      const isSticker = STICKER_KINDS.includes(String(seg?.type ?? ''))
      const saved = isSticker ? await saveSticker(seg, i + 1) : await saveInboundMedia(uid, seg, i + 1)
      if (saved) items.push(saved)
    }
    const quote = replySeg ? await quotedLine(replySeg.data?.id) : ''
    return [quote, mediaLines(items)].filter(Boolean).join('\n')
  }

  // ── 注入 ──────────────────────────────────────────────────────────────────
  function buildHint(qq, text) {
    const custom = String(config.hint ?? '')
    const extra = stickerHint()
    if (custom.trim()) {
      const rendered = custom.split('{qq}').join(String(qq)).split('{text}').join(text)
      return extra ? `${rendered}\n\n${extra}` : rendered
    }
    return (
      `[来自 QQ ${qq} 的远程指令，已注入到本会话；它与你在本机收到的消息等价，请照常推进工作。` +
      `如需回复这位用户，调用 onebot_send，target 用 private:${qq}；` +
      `不要在正文里解释这条说明，也不要复述本段。]\n\n` +
      text +
      (extra ? `\n\n${extra}` : '')
    )
  }

  // 拿一个已有会话的 agent：内存里活着直接用，没活着按界面当前模型 resume。
  // 实现与 session-ask.js 共用（agent-boot.js），避免两条路径的恢复参数出现分叉。
  const { acquireAgent, composePresetSetup } = createAgentBoot({ ctx, agents, log })

  async function inject(qq, sessionId, text) {
    const handle = await acquireAgent(sessionId)
    const agent = handle?.agent ?? handle
    if (!agent || typeof agent.followup !== 'function') {
      throw new Error(`拿到的句柄没有 followup 方法（session ${sessionId}）`)
    }
    pendingTurns.set(qq, (pendingTurns.get(qq) ?? 0) + 1)
    injectMark.set(qq, sentCount.get(qq) ?? 0)
    try {
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: buildHint(qq, text) }],
          source: { kind: 'user' },
        }),
      )
    } catch (err) {
      // followup 同步抛错时这一轮根本没开始，计数要退回去，否则 #status 的待回话轮次永久偏高
      const leftNow = (pendingTurns.get(qq) ?? 1) - 1
      if (leftNow > 0) {
        pendingTurns.set(qq, leftNow)
      } else {
        pendingTurns.delete(qq)
        injectMark.delete(qq)
      }
      throw err
    }
    log(`[inject] ${qq} -> ${sessionId}: ${text.slice(0, 120)}`)
    lastRoute.set(qq, sessionId)
    persistSticky()

    // 后台等这一轮跑完：落盘 + 必要时提示“没有回话”。
    void (async () => {
      try {
        if (typeof agent.whenIdle === 'function') await agent.whenIdle()
        if (sessions && typeof sessions.flush === 'function' && agent.session) {
          await sessions.flush(agent.session)
        }
        const left = (pendingTurns.get(qq) ?? 1) - 1
        if (left <= 0) {
          pendingTurns.delete(qq)
          if (config.silence_notice && (sentCount.get(qq) ?? 0) === (injectMark.get(qq) ?? 0)) {
            // 模型这一轮没主动调 onebot_send：先把该会话最新的一条助手回复回给用户。
            // 但如果这一轮是报错结束的，会话里没有新助手消息，回旧回复会让人以为取错了会话，
            // 所以改为把错误原文报回去。
            const err = lastTurnError(agent)
            const latest = readLatest(agent)
            const body = latest.lastAssistant || latest.last
            if (err) {
              await sendText(qq, `【${shortId(sessionId)}】这一轮报错：${err}`)
              log(`[turn] ${shortId(sessionId)} 报错结束：${err}`)
            } else if (body) {
              await sendText(qq, `【${shortId(sessionId)}】${body}`, { forceForward: readbackForce(body) })
            } else {
              await sendText(qq, `（${prefix}${shortId(sessionId)} 这一轮结束，模型未调用 onebot_send，也没读到会话正文。诊断：${latest.shape}）`)
              log(`[latest] 读不到正文: ${latest.shape}`)
            }
          }
          injectMark.delete(qq)
          await billAfter(qq, false)
        } else {
          pendingTurns.set(qq, left)
        }
      } catch (err) {
        log(`[turn] 等待结束出错: ${err instanceof Error ? err.message : String(err)}`)
      }
    })()
  }

  /**
   * 读回会话内容（#msg / #last / 模型没主动发消息时的补发）时要不要直接走合并转发。
   * 这类内容本来就是「把别人的一段话搬给你看」，长文用卡片比刷屏好读；
   * 阈值单独可配，设 0 就退回「只在需要切分时合并」。
   */
  function readbackForce(text) {
    const raw = Number(config.forward_pull_min_chars)
    const limit = Number.isFinite(raw) ? raw : 1000
    return limit > 0 && String(text ?? '').length >= limit
  }

  /** 取会话最新消息回给用户。which = 'msg'（最新助手回复）| 'last'（最后一条消息，不分角色）。 */
  async function pullLatest(qq, which, routeToken) {
    const target = routeToken ? await resolveRoute(routeToken) : sticky.get(qq) ?? config.default_session
    if (!target) {
      await sendText(qq, `用法：${prefix}msg <路由> 或 ${prefix}<路由> msg（先发 ${prefix}list 看编号）`)
      return
    }
    const resolved = (await resolveRoute(target).catch(() => null)) ?? target
    try {
      const handle = await acquireAgent(resolved)
      const latest = readLatest(handle?.agent ?? handle)
      // msg = 最新助手回复；last = 该会话里用户自己发的最后一条
      const text = which === 'msg' ? latest.lastAssistant || latest.last : latest.lastUser
      if (text) {
        await sendText(qq, `【${shortId(resolved)}】${text}`, { forceForward: readbackForce(text) })
      } else {
        await sendText(
          qq,
          which === 'msg'
            ? `这个会话还没有助手回复（${latest.shape}）`
            : `这个会话里没有你发过的消息（${latest.shape}）`,
        )
        log(`[latest] ${resolved} ${which} ${latest.shape}`)
      }
    } catch (err) {
      await sendText(qq, `读取失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── 入站 ──────────────────────────────────────────────────────────────────
  /**
   * 与 GUI 建会话一致地建一个新会话：一定要带模型选择、工作目录、预设挂载。
   *
   * 少带 agentOptions 的后果就是本插件之前的 bug：新建会话的 provider/model 为空，
   * 第一轮组装提示词时 {{model}} 取不到值，整轮直接报错，用户看到的就是"收不到回复"。
   * 没有 cwd 则会话不落在任何工作区，文件类工具的沙箱没有基准目录；没有 setup
   * 则默认预设（工具集与系统提示）不会挂到这个 agent 上。
   */
  async function createSessionForQq(cwdOverride) {
    const agentOptions = await resolveResumeAgentOptions({ ctx, agents }, log)
    if (!agentOptions) {
      throw new Error('拿不到可用的模型选择，无法新建会话（先在 DSH 界面里选好模型再试）')
    }
    const cwd =
      String(cwdOverride ?? '').trim() || String(config.workspace ?? '').trim() || knownCwd || (await scanRecentCwd())
    const preset = await composePresetSetup()
    const sid = `session-${randomUUID()}`
    log(
      `[new] 模型 ${agentOptions.provider}/${agentOptions.model}，cwd=${cwd || '(未指定)'}` +
        (preset ? `，预设 ${preset.agentPreset}` : '，无预设'),
    )
    await agents.create({
      sessionId: SessionId(sid),
      agentOptions,
      ...(cwd || preset
        ? { meta: { ...(cwd ? { cwd } : {}), ...(preset ? { agentPreset: preset.agentPreset } : {}) } }
        : {}),
      ...(preset ? { setup: preset.setup } : {}),
    })
    return sid
  }

  /** 还没有任何 #list 之前，直接扫最近的几个会话头，拿一个 cwd 当默认工作目录。 */
  async function scanRecentCwd() {
    try {
      const items = await listSessions(5)
      knownCwd = items.find((x) => x.cwd)?.cwd ?? knownCwd
    } catch {
      /* 读不到就不写 cwd */
    }
    return knownCwd
  }

  /** 新建一个空会话，并把它设成该 QQ 的默认路由。 */
  async function newSession(qq) {
    const sid = await createSessionForQq()
    await refreshTable()
    sticky.set(qq, sid)
    persistSticky()
    const idx = [...table.byIndex.entries()].find(([, v]) => v === sid)?.[0] ?? '?'
    log(`[new] ${qq} -> ${sid}（编号 ${idx}）`)
    return { sid, idx }
  }

  const CHECK_PROMPT = [
    '这是通过 QQ 触发的一次自检。请检查本机 dsh-qq-router 插件是否正常工作，最后用 onebot_send 把结论发回 QQ。',
    '要查的东西：',
    '1) 插件日志 ~/.dsh/dsh-qq-router.log 最近 50 行，有没有 "处理失败" 或其它报错。',
    '2) 唤醒器日志 ~/.dsh/dsh-waker.log 最近 20 行，以及 ~/.dsh/qq-router-heartbeat 是否存在、多少秒前更新。',
    `3) NapCat 的 OneBot 端口 ${napcatPort()} 是否在听（用 pwsh 查 Get-NetTCPConnection -LocalPort ${napcatPort()}）。`,
    '4) 配置一致性：~/.dsh/profiles/desktop/cordis.patch.yml 里 dsh-qq-router 的键，与 lib/index.js 里 Config schema 的键是否完全一致。',
    '5) 结论用一句话说清：正常 / 哪一环坏了 / 建议怎么修。回复简短，不要贴大段日志。',
  ].join('\n')

  async function startNewSession(qq, note) {
    try {
      const { sid, idx } = await newSession(qq)
      await sendText(qq, `已新建对话 ${shortId(sid)}（编号 ${idx}），已设为你的默认路由。\n直接发内容就行。`)
      if (note && note.trim()) await inject(qq, sid, note.trim())
    } catch (err) {
      await sendText(qq, `新建对话失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function runCheck(qq, extra) {
    try {
      const { sid, idx } = await newSession(qq)
      await sendText(qq, `已开新对话 ${shortId(sid)}（编号 ${idx}）做排查，结果会发回 QQ。`)
      const text = extra && extra.trim() ? `${CHECK_PROMPT}\n\n额外要求：${extra.trim()}` : CHECK_PROMPT
      await inject(qq, sid, text)
    } catch (err) {
      await sendText(qq, `自检失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 重启 DSH：真正的动作由计划任务在进程树之外执行，见 restart.js。
   * 默认不打断别的对话：有任务在跑就推迟到它们全部结束，并回一份清单；
   * 要立刻重启必须两步：`#restart force` → 回清单 → `#restart confirm`（2 分钟内有效）。
   */
  const restartPending = new Map()
  const RESTART_CONFIRM_TTL_MS = 2 * 60 * 1000

  function pendingRestartFor(qq) {
    const hit = restartPending.get(qq)
    if (!hit) return null
    if (Date.now() - hit.at > RESTART_CONFIRM_TTL_MS) {
      restartPending.delete(qq)
      return null
    }
    return hit
  }

  function busyText(busy) {
    return (busy ?? [])
      .map((item) => `${item.short}  ${item.title || '(无标题)'}${item.task ? `  任务：${item.task}` : ''}`)
      .join('\n')
  }

  async function restartViaTask(qq, rest) {
    if (typeof hooks.restart !== 'function') {
      await sendText(qq, '重启能力没接上：装的是拆分版插件，没有 restart 那一半。')
      return
    }
    const args = String(rest ?? '').trim().split(/\s+/).filter(Boolean)
    const head = (args[0] ?? '').toLowerCase()

    if (head === 'cancel') {
      const cancelled = typeof hooks.cancelDeferred === 'function' ? hooks.cancelDeferred() : false
      restartPending.delete(qq)
      await sendText(qq, cancelled ? '已取消推迟中的重启，其他对话照常跑。' : '现在没有推迟中的重启。')
      return
    }

    if (head === 'force') {
      const busy = typeof hooks.listBusy === 'function' ? hooks.listBusy() : []
      if (!busy.length) {
        // 没有别的任务在跑，其实不用确认
        const secs = Number(args[1]) > 0 ? Number(args[1]) : undefined
        try {
          const r = await hooks.restart(secs, `来自 QQ 的 ${prefix}restart force`)
          await sendText(qq, `没有别的任务在跑，直接排程：${r.delaySecs} 秒后重启（${r.scheduledAt}）。`)
        } catch (err) {
          await sendText(qq, `重启排程失败：${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      restartPending.set(qq, { at: Date.now(), delaySecs: Number(args[1]) > 0 ? Number(args[1]) : undefined })
      await sendText(
        qq,
        [
          `现在有 ${busy.length} 个对话在跑，强制重启会打断它们：`,
          busyText(busy),
          '',
          `确实要强制重启，2 分钟内再发一次：${prefix}restart confirm`,
          `不重启就发 ${prefix}restart cancel。`,
        ].join('\n'),
      )
      return
    }

    if (head === 'confirm') {
      const pending = pendingRestartFor(qq)
      if (!pending) {
        await sendText(qq, `没有待确认的强制重启（或已超过 2 分钟）。先发 ${prefix}restart force 看清单。`)
        return
      }
      restartPending.delete(qq)
      try {
        const r = await hooks.restart(pending.delaySecs, `来自 QQ 的 ${prefix}restart confirm`, { force: true })
        await sendText(
          qq,
          `已确认强制重启：${r.delaySecs} 秒后 DSH 重启（${r.scheduledAt}）。\n` +
            '正在跑的任务会被打断；NapCat 会跟着重连，' +
            `20～40 秒后发 ${prefix}start 确认。`,
        )
      } catch (err) {
        await sendText(qq, `强制重启失败：${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    // 默认路径：不打断别的对话，有任务就推迟
    const secs = Number(args[0]) > 0 ? Number(args[0]) : undefined
    try {
      const r = await hooks.restart(secs, `来自 QQ 的 ${prefix}restart`)
      if (r?.deferred) {
        const rows = busyText(r.busy)
        await sendText(
          qq,
          [
            `有 ${r.busy?.length ?? 0} 个对话正在跑，重启已推迟到它们全部结束之后（每 2 秒检查一次）：`,
            rows,
            '',
            `现在就要重启（会打断上面的任务）：先发 ${prefix}restart force，再发 ${prefix}restart confirm。`,
            `不想重启了：发 ${prefix}restart cancel。`,
          ].join('\n'),
        )
        return
      }
      await sendText(
        qq,
        `已排程：${r.delaySecs} 秒后重启 DSH（${r.scheduledAt}）。\n` +
          '窗口会关掉再自己弹回来，NapCat 会跟着重连；' +
          `20～40 秒后发 ${prefix}start 确认。`,
      )
    } catch (err) {
      await sendText(qq, `重启排程失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── 停止会话 ──────────────────────────────────────────────────────────────
  // 和客户端那个停止按钮做同一件事：agent.cancel({ kind: 'user' }) —— 中断当前这一轮，
  // 顺带把排队等着的消息（inbox）一起清掉。中止逻辑归 DSH 管，这里不自己拼。
  // 「在跑」的判据在 agent-boot.js 里，与 session-ask 共用。

  /** 内存里活着的 agent 列表：[{ agent, sid, running }]。 */
  function liveSessions() {
    const handles = typeof agents.list === 'function' ? agents.list() : []
    const out = []
    for (const handle of handles) {
      const agent = handle?.agent ?? handle
      const sid = String(agent?.session?.header?.id ?? agent?.id ?? '')
      if (!sid) {
        log(`[live] 取不到会话 id: agent=[${Object.keys(agent ?? {}).join(',')}]`)
        continue
      }
      out.push({ agent, sid, running: isRunningAgent(agent) })
    }
    return out
  }

  /** #stop：停掉指定会话（不写路由时用默认路由；只有一个在跑就直接停它）。 */
  async function stopSession(qq, rest) {
    const running = liveSessions().filter((item) => item.running)
    if (!running.length) {
      await sendText(qq, `现在没有正在输出的会话，没得停（${prefix}running 可以确认）。`)
      return
    }

    const token = String(rest ?? '').trim().split(/\s+/)[0] ?? ''
    let target = ''
    if (token) {
      const resolved = await resolveRoute(token)
      if (!resolved) {
        await sendText(qq, `没找到路由「${token}」。先发 ${prefix}list 看看。`)
        return
      }
      target = resolved
    } else {
      const current = sticky.get(qq) ?? config.default_session ?? ''
      if (current) target = (await resolveRoute(current).catch(() => null)) ?? current
    }

    let hit = target ? running.find((item) => item.sid === target) : null
    if (!hit && !target) {
      if (running.length === 1) {
        hit = running[0]
      } else {
        const rows = []
        for (const item of running) {
          const title = await readTitle(item.sid)
          rows.push(`${shortId(item.sid)}  ${title || '(无标题)'}`)
        }
        await sendText(
          qq,
          [`有 ${running.length} 个会话正在跑，得指定停哪个：`, ...rows, '', `用法：${prefix}stop <路由>`].join('\n'),
        )
        return
      }
    }
    if (!hit) {
      if (target) {
        const title = await readTitle(target)
        await sendText(qq, `${shortId(target)}${title ? ' 「' + title + '」' : ''} 现在没在跑，不用停。`)
      }
      return
    }

    const { agent, sid } = hit
    const title = await readTitle(sid)
    try {
      if (typeof agent.cancel === 'function') agent.cancel({ kind: 'user' })
      else if (typeof agent.abort === 'function') await agent.abort()
      else throw new Error('这个 agent 没有 cancel/abort 方法')
      log(`[stop] 已请求停止 ${sid}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`[stop] 停止失败: ${message}`)
      await sendText(qq, `停止失败：${message}`)
      return
    }

    // 中止是异步收敛的：最多等 3 秒看它有没有真的落到 idle，再据实回报。
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && isRunningAgent(agent)) await delay(200)
    await sendText(
      qq,
      `已停 ${shortId(sid)}${title ? ' 「' + title + '」' : ''}${isRunningAgent(agent) ? '（还没完全停下，稍等再看一眼）' : ''}\n` +
        '和客户端停止按钮一样：这一轮立刻中断，排队的消息也一起清掉。',
    )
  }

  // ── 本轮提权 ──────────────────────────────────────────────────────────────
  // #escalate 把本轮内「需要授权的操作」全部自动放行（等价于替人一路点允许），
  // 回合结束（agent 从 running 回到 idle）立刻撤销，权限回到原设定。
  // 命令词必须整词，不接受缩写；生效前要再发一次 #escalate confirm。

  function escalationRows() {
    const rows = []
    for (const [sid, item] of escalations) {
      rows.push(`${shortId(sid)}  已提权 ${Math.round((Date.now() - item.at) / 1000)}s`)
    }
    return rows
  }

  async function activateEscalation(qq, hit) {
    const { agent, sid } = hit
    const title = await readTitle(sid)
    escalations.set(sid, { agent, sid, at: Date.now(), qq })
    let released = 0
    for (const [code, entry] of [...approvals]) {
      if (entry.sid !== sid) continue
      if (settleApproval(code, 'allowed-once')) released += 1
    }
    log(`[escalate] 已提权 ${sid}${released ? `，顺带放行 ${released} 条待审批` : ''}`)
    await sendText(
      qq,
      [
        `已给 ${shortId(sid)}${title ? ' 「' + title + '」' : ''} 提权：本轮内需要授权的操作全部自动允许${released ? `（顺手放行了 ${released} 条挂着的审批）` : ''}。`,
        '只在当轮有效，这一轮跑完立刻恢复原权限。',
        `中途撤销：${prefix}escalate off`,
      ].join('\n'),
    )
    void watchEscalation(sid).catch((err) => log(`[escalate] 监视失败：${err instanceof Error ? err.message : String(err)}`))
  }

  /** 盯着这一轮什么时候结束；结束就撤销提权。 */
  async function watchEscalation(sid) {
    const item = escalations.get(sid)
    if (!item) return
    const deadline = Date.now() + 2 * 60 * 60 * 1000
    while (escalations.has(sid) && !isRunningAgent(item.agent) && Date.now() < deadline) await delay(500)
    while (escalations.has(sid) && isRunningAgent(item.agent) && Date.now() < deadline) await delay(500)
    if (!escalations.has(sid)) return
    escalations.delete(sid)
    const title = await readTitle(sid)
    log(`[escalate] ${sid} 回合结束，权限已恢复`)
    for (const uid of allow) {
      await tellApproval(
        uid,
        `提权结束：${shortId(sid)}${title ? ' 「' + title + '」' : ''} 这一轮跑完了，权限回到原设定。`,
      )
    }
  }

  /** 挑一个会话作为提权目标；说不出是哪个就列出来让人选。 */
  async function pickEscalateTarget(qq, args) {
    const live = liveSessions()
    if (!live.length) {
      await sendText(qq, `现在没有活着的会话可以提权。先发 ${prefix}list 看看，或用 ${prefix}new 起一个。`)
      return null
    }
    const token = args.find((arg) => /\d|#/u.test(arg) || /^[A-Za-z_-]{2,}$/.test(arg)) ?? ''
    let target = ''
    if (token) {
      const resolved = await resolveRoute(token)
      if (!resolved) {
        await sendText(qq, `没找到路由「${token}」。先发 ${prefix}list 看看。`)
        return null
      }
      target = resolved
    } else {
      const current = sticky.get(qq) ?? config.default_session ?? ''
      if (current) target = (await resolveRoute(current).catch(() => null)) ?? current
    }
    if (target) {
      const hit = live.find((item) => item.sid === target)
      if (!hit) {
        await sendText(qq, `会话 ${shortId(target)} 现在没有活着（可能已关闭），没法提权。`)
        return null
      }
      return hit
    }
    const running = live.filter((item) => item.running)
    const pool = running.length ? running : live
    if (pool.length === 1) return pool[0]
    const rows = []
    for (const item of pool) {
      const title = await readTitle(item.sid)
      rows.push(`${shortId(item.sid)}  ${title || '(无标题)'}${item.running ? '  [在跑]' : ''}`)
    }
    await sendText(qq, ['有多个会话，得说清给哪个提权：', ...rows, '', `用法：${prefix}escalate <路由>`].join('\n'))
    return null
  }

  async function escalateFromQq(qq, rest) {
    const args = String(rest ?? '').trim().split(/\s+/).filter(Boolean)
    const first = String(args[0] ?? '').toLowerCase()

    if (['off', 'cancel', '撤销', '取消', '关闭'].includes(first)) {
      const route = args[1] ? ((await resolveRoute(args[1]).catch(() => null)) ?? '') : ''
      let cleared = 0
      for (const key of [...escalations.keys()]) {
        if (route && key !== route) continue
        escalations.delete(key)
        cleared += 1
      }
      escalatePending = null
      await sendText(qq, cleared ? `已撤销 ${cleared} 个会话的提权，权限回到原设定。` : '当前没有生效中的提权。')
      return
    }

    if (first === 'confirm') {
      const pending = escalatePending
      escalatePending = null
      if (!pending || pending.qq !== qq) {
        await sendText(qq, `没有等你确认的提权。先发 ${prefix}escalate [路由] 看范围，再发 ${prefix}escalate confirm。`)
        return
      }
      if (Date.now() - pending.at > 120000) {
        await sendText(qq, `确认超时了（超过 2 分钟），重新发 ${prefix}escalate 再来一次。`)
        return
      }
      await activateEscalation(qq, pending)
      return
    }

    if (escalations.size && !args.length) {
      const rows = escalationRows()
      await sendText(
        qq,
        ['这些会话已经提权：', ...rows, '', `再加一个：${prefix}escalate <路由>`, `撤销：${prefix}escalate off`].join('\n'),
      )
      return
    }

    const hit = await pickEscalateTarget(qq, args)
    if (!hit) return
    escalatePending = { qq, agent: hit.agent, sid: hit.sid, at: Date.now() }
    const title = await readTitle(hit.sid)
    await sendText(
      qq,
      [
        `要给 ${shortId(hit.sid)}${title ? ' 「' + title + '」' : ''} 提权吗？`,
        '作用：本轮内所有需要授权的操作自动允许（最高权限），这一轮结束立刻恢复原设定。',
        `确认请发：${prefix}escalate confirm（整词，不接受缩写，2 分钟内有效）`,
      ].join('\n'),
    )
  }

  /** 跑一次账单脚本，返回最后一行（失败返回空串，不影响回话）。 */
  async function runBill() {
    const script = String(config.bill_script ?? '').trim()
    if (!script || config.bill_auto === false) return ''
    return await new Promise((resolve) => {
      const comspec = process.env.ComSpec || 'cmd.exe'
      execFile(
        comspec,
        ['/c', script],
        { timeout: 60000, windowsHide: true, encoding: 'buffer', maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            log(`[bill] 脚本失败：${err instanceof Error ? err.message : String(err)}`)
            resolve('')
            return
          }
          // 中文 Windows 的 .cmd 默认按 GBK 输出，直接当 UTF-8 读会变成乱码。
          const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''))
          let text = buf.toString('utf8')
          if (text.includes('\ufffd')) {
            try {
              text = new TextDecoder('gbk').decode(buf)
            } catch {
              /* 没有 GBK 支持就保留原样 */
            }
          }
          const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
          resolve(lines.length ? lines[lines.length - 1].slice(0, 500) : '')
        },
      )
    })
  }

  /** 回合结束后由宿主单独补一条账单，不占模型上下文、不需要模型调工具。 */
  async function billAfter(peer, isGroup) {
    try {
      const line = await runBill()
      if (!line) return
      await sendPeerText(peer, isGroup, line)
      log(`[bill] ${isGroup ? 'group' : 'private'}:${peer} 已追加账单`)
    } catch (err) {
      log(`[bill] 追加失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function sendPeerText(peer, isGroup, text, quoteId) {
    const body = String(text ?? '').trim()
    if (!body) return
    const parts = chunk(body, Math.max(200, Number(config.reply_chunk_size) || 4000))
    for (const part of parts) {
      if (isGroup) {
        const message = quoteId
          ? [{ type: 'reply', data: { id: String(quoteId) } }, { type: 'text', data: { text: part } }]
          : [{ type: 'text', data: { text: part } }]
        await sendRaw('send_group_msg', { group_id: Number(peer), message })
      } else {
        await sendText(Number(peer), part)
      }
    }
  }

  let teamSessionId = ''

  /** 团队槽：把要求交给隔离 worktree 里的一个会话，跑完把 diff 摘要发给主号 */
  async function runTeamChange(grant, text) {
    const info = slots.teamWork(grant.token)
    if (!info.worktree) throw new Error('团队令牌没有可用的隔离工作区（先 #keynew team 或 #gitlist）')
    if (!teamSessionId) teamSessionId = await createSessionForQq(info.worktree)
    const handle = await acquireAgent(teamSessionId)
    const agent = handle?.agent ?? handle
    if (!agent || typeof agent.followup !== 'function') throw new Error('团队会话拿不到 followup')
    const header = [
      '[团队槽 · 隔离工作区]',
      '这是主号授权对象通过外部请求转来的一条改动要求。',
      '你的工作目录是隔离的 git worktree（分支 ' + info.branch + '），只动这里的文件，不要碰仓库其他路径。',
      '按需修改；改完用一两句话说明改了什么，不要长篇解释。',
    ].join('\n')
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: header + '\n\n' + text }],
        source: { kind: 'user' },
      }),
    )
    if (typeof agent.whenIdle === 'function') await agent.whenIdle()
    if (sessions && typeof sessions.flush === 'function' && agent.session) await sessions.flush(agent.session)
    const r = slots.commitTeam(text, grant.token)
    return { changed: r.changed, branch: r.branch, stat: r.stat, files: r.files, diff: r.diff }
  }

  async function handleTeamMessage(event, isGroup = false) {
    if (isOn('qq', 'team_ai_only')) {
      const peer = isGroup ? String(event.group_id) : String(event.user_id)
      await sendPeerText(peer, isGroup, '团队槽已设为仅 AI 可用（插件详情页 → QQ → 团队槽仅 AI 可用）。')
      log('[team] 团队槽仅 AI 可用，拒绝 QQ 侧请求')
      return
    }
    const peer = isGroup ? String(event.group_id) : String(event.user_id)
    const segs = Array.isArray(event.message) ? event.message : []
    const text = (await segsText(segs)).trim()
    const grant = slots.grantForPeer(peer, 'team')
    const info = grant ? slots.teamWork(grant.token) : { worktree: '', branch: '' }
    if (!grant || !info.worktree) {
      await sendPeerText(peer, isGroup, '还没有绑定的团队入口（或者工作区已经被删了），先等主号发一个团队令牌。')
      return
    }
    // 团队槽改文件是重动作：只认 #edit 前缀，群里随口一句不触发。
    const body = text.startsWith(prefix) ? text.slice(prefix.length).trim() : text
    const head = body.split(/\s+/, 1)[0] || ''
    const request = body.slice(head.length).trim()
    if (head !== 'edit' && head !== 'write') {
      await sendPeerText(
        peer,
        isGroup,
        `团队槽只回 ${prefix}edit 开头的要求（例如 ${prefix}edit 把 README 的标题改短一点）。`,
        event.message_id,
      )
      return
    }
    if (!request) {
      await sendPeerText(peer, isGroup, `用法：${prefix}edit <要做的事>。`, event.message_id)
      return
    }
    const verdict = guard.note(`team:${grant.token}`, request)
    if (verdict.blocked) {
      await sendPeerText(peer, isGroup, '这个槽已经被监管模块临时关闭了，等主号看过再开。')
      return
    }
    log(`[team] ${grant.token} ${isGroup ? 'group:' : ''}${peer}: ${request.slice(0, 120)}`)
    await sendPeerText(peer, isGroup, `收到，正在隔离工作区里处理（分支 ${info.branch}），完成后把改动摘要报给主号。`)
    void (async () => {
      try {
        if (!teamSessionId) teamSessionId = await createSessionForQq(info.worktree)
        const handle = await acquireAgent(teamSessionId)
        const agent = handle?.agent ?? handle
        if (!agent || typeof agent.followup !== 'function') throw new Error('团队会话拿不到 followup')
        const header = [
          '[团队槽 · 隔离工作区]',
          `这是主号授权对象 ${isGroup ? '群 ' : ''}${peer} 通过 QQ 转来的一条改动要求。`,
          `你的工作目录是隔离的 git worktree（分支 ${info.branch}），只动这里的文件，不要碰仓库其他路径。`,
          '按需修改；改完用一两句话说明改了什么，不要长篇解释。',
        ].join('\n')
        agent.followup(
          createUserMessage({ content: [{ type: 'text', text: header + '\n\n' + request }], source: { kind: 'user' } }),
        )
        if (typeof agent.whenIdle === 'function') await agent.whenIdle()
        if (sessions && typeof sessions.flush === 'function' && agent.session) await sessions.flush(agent.session)
        const r = slots.commitTeam(request, grant.token)
        if (!r.changed) {
          await sendPeerText(peer, isGroup, '这一轮没有产生文件改动。')
          await sendText(boundQq, `团队槽：${peer} 的要求跑完了，工作区没有改动。`)
          return
        }
        await sendPeerText(peer, isGroup, `已提交到临时分支 ${r.branch}，等主号审阅。`)
        await sendText(
          boundQq,
          [
            `团队槽有改动（分支 ${r.branch}）：`,
            r.stat,
            r.files ? `文件：\n${r.files}` : '',
            `确认合并发 ${prefix}gitmerge，丢掉发 ${prefix}gitdrop，看完整 diff 发 ${prefix}gitdiff。`,
          ]
            .filter(Boolean)
            .join('\n'),
          { forceForward: true },
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log(`[team] 处理失败：${msg}`)
        await sendPeerText(peer, isGroup, `团队槽处理失败：${msg}`)
        await sendText(boundQq, `团队槽处理失败：${msg}`)
      }
    })()
  }

  async function handleShareMessage(event, isGroup) {
    if (isOn('qq', 'share_ai_only')) {
      const peer = isGroup ? String(event.group_id) : String(event.user_id)
      await sendPeerText(peer, isGroup, '分享槽已设为仅 AI 可用（插件详情页 → QQ → 分享槽仅 AI 可用）。')
      log('[share] 分享槽仅 AI 可用，拒绝 QQ 侧请求')
      return
    }
    const peer = isGroup ? String(event.group_id) : String(event.user_id)
    const segs = Array.isArray(event.message) ? event.message : []
    const text = (await segsText(segs)).trim()
    const selfId = String(event.self_id ?? '')
    const mentioned = segs.some((seg) => seg?.type === 'at' && String(seg?.data?.qq) === selfId)
    const body = text.startsWith(prefix) ? text.slice(prefix.length).trim() : text
    const head = body.split(/\s+/, 1)[0] || ''
    const rest = body.slice(head.length).trim()
    if (head === 'bind') {
      const token = rest.trim()
      if (!token) {
        await sendPeerText(peer, isGroup, `用法：${prefix}bind <令牌>，令牌由主号发 ${prefix}sharekey <目录> 或 ${prefix}teamkey <仓库> 生成。`, event.message_id)
        return
      }
      const r = slots.bindByToken(token, peer, isGroup ? 'group' : 'member')
      if (!r.ok) {
        await sendPeerText(peer, isGroup, r.msg, event.message_id)
        return
      }
      if (isGroup) {
        // 群里的确认口令私聊给主号：群成员都能看到群消息，谁看到谁能确认
        await sendText(
          boundQq,
          `[${r.kind}] 群 ${peer} 要用${r.kind === 'share' ? '分享' : '团队'}入口，确认口令 ${r.challenge}。在私聊回 ${prefix}confirm ${r.challenge} 生效。`,
        )
        await sendPeerText(peer, isGroup, '已把确认口令私聊发给主号，等主号确认。', event.message_id)
        return
      }
      await sendPeerText(peer, isGroup, r.msg, event.message_id)
      return
    }
    if (head === 'confirm' || head === '确认') {
      const r = slots.confirmBind(peer, rest, { owner: isGroup ? false : false })
      log(`[slot] ${peer} 确认绑定：${r.ok ? 'ok' : r.msg}`)
      await sendPeerText(peer, isGroup, r.msg, event.message_id)
      return
    }
    if (!slots.grantForPeer(peer, 'share')) {
      await sendPeerText(
        peer,
        isGroup,
        `这个对象还没有绑定分享令牌。请主号私聊发 ${prefix}sharekey <目录> 生成令牌，再在这里发 ${prefix}bind share-xxxxxx，然后按提示回 ${prefix}confirm <口令>。`,
        event.message_id,
      )
      return
    }
    if (isGroup && !mentioned && !text.startsWith(prefix)) return
    // 分享槽只回 #read 开头的问题：群成员随口聊天不触发模型调用。
    const question = head === 'read' || head === 'ask' ? rest : ''
    if (!question) {
      await sendPeerText(
        peer,
        isGroup,
        `分享槽只回 ${prefix}read 开头的问题（例如 ${prefix}read 这个目录里有什么）。`,
        event.message_id,
      )
      return
    }
    log(`[share] ${isGroup ? 'group:' : ''}${peer}: ${question.slice(0, 120)}`)
    const res = await slots.answerShare({ peer, question })
    await sendPeerText(peer, isGroup, res.text, event.message_id)
  }

  /**
   * 群接待：把这个群的消息交给它自己的长期会话。
   *
   * 和团队槽/分享槽的区别：这里不写固定台词，也不规定先读还是先改——
   * 会话里的 AI 自己决定用 share_read 看资料、用 team_edit 改文件、
   * 用 onebot_send（target 写 group:<群号>）回话，或者干脆不说话。
   */
  async function handleHostMessage(event, gid) {
    const segs = Array.isArray(event.message) ? event.message : []
    const raw = (await segsText(segs)).trim()
    const body = raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw
    const replySeg = segs.find((seg) => seg?.type === 'reply')
    const mediaSegs = segs.filter((seg) => MEDIA_KINDS.includes(seg?.type))
    const quoted = replySeg ? await quotedLine(replySeg.data?.id ?? replySeg.data) : ''
    if (!body && !quoted && !mediaSegs.length) return
    const nick = String(event.sender?.card || event.sender?.nickname || event.user_id || '')
    const uid = Number(event.user_id)
    // 群里也记一条 lastIn：qq_reply / group_poke 的默认目标才有东西可引用。
    if (event.message_id !== undefined) lastInId.set(Number(gid), String(event.message_id))
    // 主号自己发的话，这一轮跟普通会话一样有完整工具；群友发的才收窄。
    host.setTrigger(gid, boundQq && String(uid) === String(boundQq) ? 'owner' : 'peer')

    let entry = host.entry(gid)
    if (!entry) return
    let sid = String(entry.sessionId ?? '')
    if (!sid) {
      sid = await createSessionForQq()
      host.setSession(gid, sid)
      entry = host.entry(gid)
    }
    let agent
    try {
      agent = await acquireAgent(sid)
    } catch (err) {
      // 会话被删或恢复不了：换一个新会话继续接待，不让这个群从此没反应。
      log(`[host] 恢复会话 ${sid} 失败，换新会话：${err instanceof Error ? err.message : String(err)}`)
      sid = await createSessionForQq()
      host.setSession(gid, sid)
      entry = host.entry(gid)
      agent = await acquireAgent(sid)
    }
    const handle = agent?.agent ?? agent
    if (!handle || typeof handle.followup !== 'function') throw new Error('群接待会话拿不到 followup')

    const lines = []
    if (!entry?.personaSent) {
      lines.push('[宿主设定] 下面这段是你在本群的身份与说话方式，之后也一直适用。')
      lines.push(host.persona())
      lines.push('')
      lines.push(`[本群] 群号 ${gid}。要说话就调 onebot_send，target 写 group:${gid}；不调工具就等于这条不接。`)
      const hint = stickerHint()
      if (hint) lines.push(hint)
      lines.push('')
      host.markPersonaSent(gid)
    }
    lines.push(`[群消息] ${nick}(${uid})${quoted ? `（引用 ${quoted}）` : ''}：${body}`)
    // 群里的图片/语音/文件也落盘并把路径写进正文，否则 AI 在群里等于看不见图。
    const attach = await attachmentFor(gid, mediaSegs, null)
    if (attach) lines.push(attach)

    handle.followup(
      createUserMessage({
        content: [{ type: 'text', text: lines.join('\n') }],
        source: { kind: 'user' },
      }),
    )
    log(`[host] ${gid} <- ${nick}(${uid})：${body.slice(0, 100)}`)
    void (async () => {
      try {
        if (typeof handle.whenIdle === 'function') await handle.whenIdle()
        if (sessions && typeof sessions.flush === 'function' && handle.session) {
          await sessions.flush(handle.session)
        }
        await billAfter(gid, true)
      } catch (err) {
        log(`[host] 群 ${gid} 这一轮出错：${err instanceof Error ? err.message : String(err)}`)
      }
    })()
  }

  async function handleMessage(event) {
    try {
      if (event?.post_type !== 'message') return
      const groupEvent = event?.message_type === 'group'
      if (event?.message_type !== 'private' && !groupEvent) return
      // 插件详情页上的开关：关掉后通道还连着，但不再执行任何远程指令与工具。
      if (!isOn('qq')) {
        log('[in] QQ 通道开关已关，忽略这条消息')
        return
      }
      // 先把原始事件转给桥的订阅者（别的通道插件想观察/转发时用），不影响下面自己的处理。
      try {
        bridge?.notifyInbound(normalizeInbound(event))
      } catch (err) {
        log(`[bridge] 通知订阅者失败：${err instanceof Error ? err.message : String(err)}`)
      }
      // 槽对象的消息不走主号的绑定与白名单：它们只被允许进 share / team 那条受限通道。
      if (groupEvent) {
        const gsegs = Array.isArray(event.message) ? event.message : []
        const gtext = gsegs.filter((seg) => seg?.type === 'text').map((seg) => String(seg.data?.text ?? '')).join('').trim()
        const gself = String(event.self_id ?? '')
        const gmentioned = gsegs.some((seg) => seg?.type === 'at' && String(seg?.data?.qq) === gself)
        const fromOwner = Number(event.user_id) === boundQq
        // 主号在群里发 bind / confirm：那个群的绑定要走分享槽通道，
        // 不能落到主号命令表里（那样会把「绑定对象」错记成主号自己的 QQ）。
        const ghead = gtext.startsWith(prefix) ? gtext.slice(prefix.length).trim().split(/\s+/, 1)[0] : ''
        if (fromOwner && (ghead === 'bind' || ghead === 'confirm' || ghead === '确认')) {
          await handleShareMessage(event, true)
          return
        }
        // 主号在群里发管理命令一律拒绝：群里发的消息别的成员也看得见，
        // #guardreset / #sharekey / #unbind 这类只有私聊才该能执行。
        if (fromOwner && gtext.startsWith(prefix)) {
          const gword = gtext.slice(prefix.length).trim().split(/\s+/, 1)[0] || ''
          // 接待开关允许在群里就地开关（#hoston / #hostoff / #hostlist），其余管理命令仍然只在私聊。
          if (!['hoston', 'hostoff', 'hostlist', 'hostpersona'].includes(gword)) {
            log(`[in] 群 ${event.group_id} 拒绝管理命令 #${gword}（只允许私聊）`)
            await sendPeerText(String(event.group_id), true, `管理命令只在主号私聊里执行（#${gword} 未生效）。群里只做提问与 #bind / #confirm。`)
            return
          }
        }
        // 群接待：这个群开了接待、开关也开着时，整条消息交给群自己的长期会话。
        // 说不说话、要不要读资料或改文件都由 AI 决定，插件不写固定台词。
        if (isOn('qq', 'group_host') && host.isEnabled(String(event.group_id))) {
          if (!gtext.startsWith(prefix) && !gmentioned) return
          await handleHostMessage(event, String(event.group_id))
          return
        }
        if (slots.grantForPeer(String(event.group_id), 'team')) {
          // 群里只认 @ 或带前缀的，避免每句闲聊都回「请用 #edit」。
          if (!gtext.startsWith(prefix) && !gmentioned) return
          await handleTeamMessage(event, true)
          return
        }
        const bound = Boolean(slots.grantForPeer(String(event.group_id), 'share'))
        if (!bound && !gtext.startsWith(prefix) && !gmentioned) return
        if (!gtext.startsWith(prefix) && !gmentioned) return
        await handleShareMessage(event, true)
        return
      }
      if (Number(event.user_id) !== boundQq && slots.grantForPeer(String(event.user_id), 'share')) {
        await handleShareMessage(event, false)
        return
      }
      if (Number(event.user_id) !== boundQq && slots.grantForPeer(String(event.user_id), 'team')) {
        await handleTeamMessage(event)
        return
      }
      const qq = Number(event.user_id)
      // 桥送进来的事件（别的通道插件）已经由它自己的授权流程把关，不再要求 QQ 绑定口令；
      // QQ 自己的事件永远走下面的绑定闸门。
      const trusted = event?.__bridgeTrusted === true
      // 同一个 NapCat 会把事件广播给每条连上来的连接：本通道收一遍，中继插件
      // 再 deliver 一遍。同一个 message_id 只处理一次，否则会重复注入、重复回话。
      const dedupeId = event?.message_id !== undefined ? String(event.message_id) : ''
      if (dedupeId) {
        const seenAt = handledIds.get(dedupeId)
        if (seenAt && Date.now() - seenAt < 60000) {
          log(`[dedupe] 重复事件 ${dedupeId}（${trusted ? '来自桥' : '来自本通道'}），跳过`)
          return
        }
        handledIds.set(dedupeId, Date.now())
        if (handledIds.size > 500) {
          const cutoff = Date.now() - 120000
          for (const [key, at] of handledIds) if (at < cutoff) handledIds.delete(key)
        }
      }
      // 绑定验证：同一个 NapCat 上的事件会广播给所有连上来的插件，
      // 所以光靠白名单不够——别的插件服务别的号与群聊时，我们只认
      // 用口令绑定过的这一个号，其余静默忽略，各管各的。
      const bindToken = String(config.bind_token ?? '').trim()
      if (bindToken && !trusted) {
        const quick = (Array.isArray(event.message)
          ? event.message
              .filter((seg) => seg?.type === 'text')
              .map((seg) => String(seg.data?.text ?? ''))
              .join('')
          : String(event.raw_message ?? '')
        ).trim()
        // share-/team- 开头的是槽密钥，不是账号绑定口令，交给下面的槽命令处理
        const maybeSlotKey = quick.startsWith(`${prefix}bind `) ? quick.slice(prefix.length + 4).trim() : ''
        const isSlotKey = /^(share|team)-/i.test(maybeSlotKey)
        if (!isSlotKey && (quick === `${prefix}bind` || quick.startsWith(`${prefix}bind `))) {
          const given = quick.slice(prefix.length + 4).trim()
          if (boundQq && qq !== boundQq) {
            await sendText(qq, `已经有别的号绑定了（${boundQq}）。要换绑，先让原号发 ${prefix}unbind。`)
            return
          }
          if (given !== bindToken) {
            log(`[bind] ${qq} 口令不对`)
            await sendText(qq, '口令不对。')
            return
          }
          boundQq = qq
          persistSticky()
          log(`[bind] 已绑定 ${qq}`)
          await sendText(qq, `绑定成功：以后只有这个号的消息会进 DSH，其他号静默忽略。解绑发 ${prefix}unbind。`)
          return
        }
        // 白名单是主号亲手写的，永远给过；绑定号闸门只挡白名单以外的号
        if (!allow.has(qq) && qq !== boundQq) {
          if (!boundQq) log(`[bind] 忽略 ${qq}（还没有绑定账号，先发 ${prefix}bind <口令>）`)
          else log(`[bind] 忽略 ${qq}（已绑定 ${boundQq}）`)
          return
        }
      }
      if (!trusted && !allow.has(qq) && qq !== boundQq) {
        log(`[in] 忽略 ${qq}（不在白名单）`)
        return
      }
      if (event.message_id !== undefined) {
        lastInId.set(qq, String(event.message_id))
        // 落盘：重启后 qq_reply 的默认引用仍然是「真正的上一条」，
        // 而不是靠调用方猜一个 id（猜错就会引用到别处去）。
        persistSticky()
      }
      const segs = Array.isArray(event.message) ? event.message : null
      const mediaSegs = segs ? segs.filter((seg) => MEDIA_KINDS.includes(seg?.type)) : []
      const replySeg = segs ? segs.find((seg) => seg?.type === 'reply') : null
      // 消息是段数组时只把文字段拼成正文，媒体段单独下载、路径另附，
      // 否则正文里会混进 [image file=…] 这种占位符，模型看着像乱码。
      const raw = (segs
        ? await segsText(segs)
        : messageToText(event.message ?? event.raw_message)
      ).trim()
      if (!raw) {
        // 纯媒体消息（拍张照就发）：先看 #set 设过的默认会话，其次才是这一次运行里
        // 最近聊过的会话；两个都没有就提示用户选，不猜一个会话塞进去。
        const attachOnly = await attachmentFor(qq, mediaSegs, replySeg)
        if (!attachOnly) return
        const fallback = sticky.get(qq) ?? lastRoute.get(qq) ?? (config.default_session || '')
        if (!fallback) {
          await sendText(qq, noRouteHint())
          return
        }
        const hit = await resolveRoute(fallback).catch(() => null)
        await inject(qq, hit ?? fallback, attachOnly)
        return
      }
      if (!raw.startsWith(prefix)) {
        // 不写前缀就是普通说话：进默认会话。没有默认会话时只提示选定，不猜目标。
        log(`[in] ${qq}（默认路由）: ${raw.slice(0, 160)}`)
        const fallback = sticky.get(qq) ?? lastRoute.get(qq) ?? (config.default_session || '')
        if (!fallback) {
          await sendText(qq, noRouteHint())
          return
        }
        const attach = await attachmentFor(qq, mediaSegs, replySeg)
        const hit = await resolveRoute(fallback).catch(() => null)
        await inject(qq, hit ?? fallback, attach ? `${raw}\n\n${attach}` : raw)
        return
      }
      log(`[in] ${qq}: ${raw.slice(0, 160)}`)

      const body = raw.slice(prefix.length).trim()
      if (!body) return

      // 命令词只取第一行里的第一个词：带参数的单行命令（#1 msg、#set 2、#list 2、#restart 30）
      // 必须能拆成「命令 + 参数」。原来把整行当 head，这些指令全都拆不开，
      // #1 msg 会被当成正文 "1 msg" 注进默认会话。
      const firstLine = body.split(/\r?\n/, 1)[0]
      const head = firstLine.split(/\s+/)[0]
      const rest = body.slice(head.length).trim()
      // git* 命令的写法可以是「#gitlist」「#gitlist 令牌」「#gitlist 1 team-xxxx」。
      const takeGitArgs = (raw) => {
        const parts = String(raw ?? '').trim().split(/\s+/).filter(Boolean)
        let token = ''
        if (parts.length && /^(team|share)-[a-z0-9]{4,12}$/i.test(parts[0])) token = parts.shift()
        return { token, sel: parts.join(' ') }
      }

      const gitAlias = { teamdiff: 'gitdiff', teammerge: 'gitmerge', teamdrop: 'gitdrop', teamlist: 'gitlist', teamdiscard: 'gitdiscard' }
      const cmd = gitAlias[head] ?? head
      // 群接待开关：在群里发就作用于当前群，在私聊发要带群号。
      const hostCommands = ['hoston', 'hostoff', 'hostlist', 'hostpersona']
      if (hostCommands.includes(cmd)) {
        const answer = (text) => (groupEvent ? sendPeerText(String(event.group_id), true, text) : sendText(qq, text))
        if (qq !== boundQq) {
          await answer('只有主号能用这条命令。')
          return
        }
        if (cmd === 'hostlist') {
          await answer(host.listText())
          return
        }
        if (cmd === 'hostpersona') {
          const arg = rest.trim().toLowerCase()
          if (arg === 'reset') {
            host.resetPersona()
            await answer('人设已恢复默认，下一条群消息生效。')
            return
          }
          const text = host.persona()
          await answer(`人设文件：${host.personaPath}\n改完保存即生效，不用重启。\n\n${text.slice(0, 1500)}${text.length > 1500 ? '\n…（后面还有）' : ''}`)
          return
        }
        const target = groupEvent ? String(event.group_id) : rest.trim()
        if (!/^\d{5,12}$/.test(target)) {
          await answer(`用法：${prefix}hoston <群号>（在那个群里发可以省掉群号）`)
          return
        }
        if (cmd === 'hoston') {
          if (!isOn('qq', 'group_host')) {
            await answer('群接待在插件详情页被关掉了（QQ → 群接待）。先打开再开启这个群。')
            return
          }
          const r = host.enable(target)
          await answer(
            `群 ${target} 已${r.created ? '开启' : '本来就在'}接待。被 @ 或带 ${prefix} 的消息会进这个群自己的长期会话，由 AI 决定说什么、要不要动手。\n关闭：${prefix}hostoff ${target}`,
          )
          return
        }
        const r = host.disable(target)
        await answer(r.removed ? `群 ${target} 已关闭接待（会话保留，之后重开还能接着聊）。` : `群 ${target} 本来就没开接待。`)
        return
      }
      const slotCommands = ['keylist', 'keynew', 'keydel', 'keyunbind', 'keykick', 'keylink', 'sharekey', 'teamkey', 'sharelist', 'sharekick', 'teamkick', 'shareunbind', 'teamunbind', 'shareopen', 'shareconfirm', 'shareclose', 'teamopen', 'teamconfirm', 'gitdiff', 'gitmerge', 'gitdrop', 'gitlist', 'gitdiscard', 'tokendel', 'guardreset', 'bind', 'confirm']
      if (slotCommands.includes(cmd)) {
        if (qq !== boundQq) {
          await sendText(qq, '只有主号能用这条命令。')
          return
        }
        // 命令归到哪个槽：key* 管令牌、share* 管分享、team* 管团队、git* 管改动。
        const slotKind = (() => {
          if (cmd === 'keynew') {
            const w = rest.trim().split(/\s+/)[0] || ''
            if (/^(team|团队|git)/i.test(w)) return 'team'
            if (/^(share|分享)/i.test(w)) return 'share'
            return ''
          }
          if (cmd === 'keylist' || cmd === 'keydel' || cmd === 'keyunbind' || cmd === 'keykick' || cmd === 'keylink' || cmd === 'tokendel' || cmd === 'guardreset') return ''
          if (cmd === 'bind' || cmd === 'confirm' || cmd === 'shareconfirm' || cmd === 'teamconfirm') return ''
          if (cmd.startsWith('share')) return 'share'
          if (cmd.startsWith('team')) return 'team'
          return 'team'
        })()
        if (!config.slots_enabled) {
          await sendText(qq, '分享槽/团队槽在插件详情页被整体关掉了。')
          return
        }
        if (slotKind && !isOn('qq', slotKind === 'share' ? 'share_slot' : 'team_slot')) {
          await sendText(qq, `${slotKind === 'share' ? '分享槽' : '团队槽'}在插件详情页被关掉了。`)
          return
        }
        if (!slotKind && !isOn('qq', 'share_slot') && !isOn('qq', 'team_slot')) {
          await sendText(qq, '分享槽和团队槽在插件详情页都被关掉了。')
          return
        }
        try {
          if (cmd === 'keylink') {
            const parts = rest.trim().split(/\s+/).filter(Boolean)
            const text = parts.length >= 3
              ? slots.keylinkSet(parts[0], parts[1], parts.slice(2).join(' '))
              : slots.keylinkList(parts[0] ?? '')
            await sendText(qq, text)
            return
          }
          if (cmd === 'sharekey' || cmd === 'teamkey' || cmd === 'keynew') {
            const parts = rest.trim().split(/\s+/).filter(Boolean)
            let target = cmd === 'sharekey' ? 'share' : cmd === 'teamkey' ? 'team' : ''
            let dir = cmd === 'keynew' ? parts.slice(1).join(' ') : rest.trim()
            if (cmd === 'keynew') {
              const w = (parts[0] || '').toLowerCase()
              if (/^(both|双权限|读写)/.test(w)) target = 'both'
              else if (/^(team|团队|git)/.test(w)) target = 'team'
              else if (/^(share|分享)/.test(w)) target = 'share'
            }
            if (!dir) {
              await sendText(
                qq,
                target === 'share'
                  ? `用法：${prefix}sharekey <目录>\n每发一次生成一个令牌，令牌绑死这个目录；要同时开多个目录就多发几次。\n等价写法：${prefix}keynew share <目录>`
                  : target === 'team'
                    ? `用法：${prefix}teamkey <git 仓库目录>\n每次会为这个仓库建一个隔离 worktree 并生成令牌，绑定对象只能改那份工作区。\n等价写法：${prefix}keynew team <目录>`
                    : `用法：${prefix}keynew share <目录> / ${prefix}keynew team <git 目录> / ${prefix}keynew both <读目录> [git 目录]\n或者直接用 ${prefix}sharekey <目录> / ${prefix}teamkey <git 目录>。`,
              )
              return
            }
            if (target === 'both') {
              if (!isOn('qq', 'dual_key')) {
                await sendText(qq, '双权限令牌在插件详情页被关掉了（qq → 双权限令牌）。')
                return
              }
              const bothParts = parts.slice(1)
              const readDir = bothParts[0] ?? ''
              const repoDir = bothParts[1] ?? ''
              if (!readDir) {
                await sendText(
                  qq,
                  `用法：${prefix}keynew both <读目录> [git 目录]\n只给一个目录时，读写都在它上面（要求它是 git 仓库）。\n一条令牌两用：群里提问读的是读目录，改动写在隔离工作区，仍需确认码与 diff。`,
                )
                return
              }
              const r = slots.addBothGrant(readDir, repoDir)
              await sendText(
                qq,
                `双权限令牌：${r.token}\n读目录：${r.dir}\n写仓库：${r.repo}\n工作区：${r.worktree}（分支 ${r.branch}）\n让目标号发 ${prefix}bind ${r.token}，再回 ${prefix}confirm <口令> 完成绑定。\n提醒：这条令牌同时能读和能改，外泄等于把两边一起交出去。`,
              )
              return
            }
            if (target === 'share') {
              const r = slots.addShareGrant(dir)
              await sendText(qq, `分享令牌：${r.token}\n目录：${r.dir}\n让目标号或群发 ${prefix}bind ${r.token}，再回 ${prefix}confirm <口令> 完成绑定。之后要换目录就重新发一个令牌。`)
              return
            }
            const r = slots.addTeamGrant(dir)
            await sendText(qq, `团队令牌：${r.token}\n仓库：${r.repo}\n工作区：${r.worktree}（分支 ${r.branch}）\n让目标号发 ${prefix}bind ${r.token}，再回 ${prefix}confirm <口令> 完成绑定。`)
            return
          }
          if (cmd === 'sharelist' || cmd === 'keylist') {
            const lines = [slots.listText()]
            const gl = guard.list()
            lines.push('', '监管计数（10 分钟窗口，3 次自动拦截）：')
            if (!gl.length) lines.push('  没有命中记录')
            else {
              for (const g of gl) {
                lines.push(`  ${g.identity}  命中 ${g.hits} 次${g.blocked ? '  已拦截' : ''}`)
              }
              lines.push(`清空：${prefix}guardreset；清一个：${prefix}guardreset <对象>`)
            }
            await sendText(qq, lines.join('\n'))
            return
          }
          if (cmd === 'shareunbind') {
            await sendText(qq, slots.unbind('share', rest))
            return
          }
          if (cmd === 'teamunbind') {
            await sendText(qq, slots.unbind('team', rest))
            return
          }
          if (cmd === 'keyunbind') {
            await sendText(qq, slots.unbindAny(rest))
            return
          }
          if (cmd === 'sharekick' || cmd === 'teamkick' || cmd === 'shareclose' || cmd === 'keykick') {
            if (cmd === 'keykick' && !rest.trim()) {
              const bound = slots.slotInfo().grants.filter((g) => g.peer)
              await sendText(
                qq,
                bound.length
                  ? `用法：${prefix}keykick <令牌|all>\n当前绑定：\n${bound.map((g) => `  ${g.token}  ${g.peerKind}:${g.peer}`).join('\n')}`
                  : '现在没有绑定中的对象。',
              )
              return
            }
            const slot = cmd === 'teamkick' ? 'team' : cmd === 'keykick' ? rest.trim() : 'share'
            await sendText(qq, slots.kick(slot))
            return
          }
          if (cmd === 'teamopen') {
            const r = slots.askOpenTeam(rest)
            await sendText(
              qq,
              `要给团队槽开一个隔离工作区：\n${r.dir}\n\n会在这里 git worktree add 一个临时分支，对方只能改那份工作区，改动先提交到临时分支、由你审阅。\n确认无误就发 ${prefix}teamconfirm ${r.confirm}（5 分钟内有效）。`,
            )
            return
          }
          if (cmd === 'gitdiff') {
            const d = slots.teamDiff(takeGitArgs(rest).token)
            await sendText(qq, [`分支 ${d.branch}（${d.worktree}）`, d.head, d.pending ? `未提交改动：\n${d.pending}` : '没有未提交改动。'].join('\n'), { forceForward: true })
            return
          }
          if (cmd === 'gitlist') {
            const branches = slots.teamBranches(takeGitArgs(rest).token)
            if (!branches.length) {
              await sendText(qq, '团队槽现在没有未合并的改动。')
              return
            }
            const lines = []
            for (const b of branches) {
              lines.push(`分支 ${b.branch}（${b.commits.length} 条改动）`)
              b.commits.forEach((c, i) => {
                const when = new Date(c.when).toLocaleString('zh-CN', { hour12: false })
                lines.push(`  ${i + 1}. ${c.short} ${c.subject}（${when}）`)
              })
            }
            lines.push('', `合并某条：${prefix}gitmerge <编号>；丢掉某条：${prefix}gitdiscard <编号…>；全丢：${prefix}gitdiscard all`)
            await sendText(qq, lines.join('\n'), { forceForward: lines.length > 24 })
            return
          }
          if (cmd === 'gitmerge') {
            await sendText(qq, slots.mergeTeam(takeGitArgs(rest).sel, takeGitArgs(rest).token))
            return
          }
          if (cmd === 'gitdiscard') {
            await sendText(qq, slots.discardTeam(takeGitArgs(rest).sel, takeGitArgs(rest).token))
            return
          }
          if (cmd === 'gitdrop') {
            await sendText(qq, slots.dropTeam(takeGitArgs(rest).token))
            return
          }
          if (cmd === 'shareopen') {
            const r = slots.askOpenShare(rest)
            await sendText(
              qq,
              `要把这个目录交给分享槽只读：\n${r.dir}\n\n它只读文本文件（单文件 200 KB 内，总量 120 KB 内），回答先经过一次无工具的总结。\n确认无误就发 ${prefix}shareconfirm ${r.confirm}（5 分钟内有效）。`,
            )
            return
          }
          if (head === 'shareconfirm' || head === 'teamconfirm' || head === 'confirm') {
            const purpose = slots.pendingPurpose()
            if (purpose === 'bind') {
              const r2 = slots.confirmBind(String(qq), rest, { owner: true })
              log(`[slot] 主号确认绑定：${r2.ok ? 'ok' : r2.msg}`)
              await sendText(qq, r2.msg)
              return
            }
            const r = slots.confirmPending(rest)
            await sendText(
              qq,
              `已生成令牌：${r.token}\n${r.kind === 'share-open' ? `目录 ${r.dir}（只读）` : `工作区 ${r.worktree ?? r.dir}（分支 ${r.branch ?? '-'}）`}\n让对象发 ${prefix}bind ${r.token} 完成绑定。`,
            )
            return
          }
          if (cmd === 'tokendel' || cmd === 'keydel') {
            const words = rest.trim().split(/\s+/).filter(Boolean)
            if ((words[0] || '').toLowerCase() === 'all') {
              if ((words[1] || '').toLowerCase() !== 'confirm') {
                keydelAllAt = Date.now()
                await sendText(qq, `要删掉全部令牌：再发一次 ${prefix}keydel all confirm（2 分钟内），这一步不可撤销。`)
                return
              }
              if (!(Date.now() - keydelAllAt < 120000)) {
                await sendText(qq, `确认已过期，重新发 ${prefix}keydel all 再确认。`)
                keydelAllAt = 0
                return
              }
              keydelAllAt = 0
              await sendText(qq, slots.deleteToken('all'))
              return
            }
            await sendText(qq, slots.deleteToken(rest))
            return
          }
          if (cmd === 'guardreset') {
            const want = rest.trim()
            const all = guard.list()
            if (!all.length) {
              await sendText(qq, '监管计数本来就是空的。')
              return
            }
            if (!want || want === 'all') {
              for (const g of all) guard.reset(g.identity)
              await sendText(qq, `已清空 ${all.length} 个对象的命中计数与封禁状态。`)
              return
            }
            const hits = all.filter((g) => g.identity === want || g.identity.endsWith(`:${want}`) || g.identity.includes(want))
            if (!hits.length) {
              await sendText(qq, `没有匹配 ${want} 的对象。当前：${all.map((g) => g.identity).join('、')}`)
              return
            }
            for (const g of hits) guard.reset(g.identity)
            await sendText(qq, `已清掉 ${hits.map((g) => g.identity).join('、')} 的命中计数与封禁状态。`)
            return
          }
          if (cmd === 'bind') {
            const r = slots.bindByToken(rest.trim(), String(qq), 'member')
            await sendText(qq, r.msg)
            return
          }
        } catch (err) {
          await sendText(qq, err?.message ?? String(err))
          return
        }
      }
      if (['list', 'ls', '列表'].includes(head)) {
        await sendText(qq, await renderTable(Number(rest) || 1))
        return
      }
      if (['help', '?', '帮助'].includes(head)) {
        await sendText(qq, helpText())
        return
      }
      if (['status', '状态'].includes(head)) {
        const cur = sticky.get(qq) ?? config.default_session ?? ''
        await sendText(
          qq,
          [
            `OneBot: ${bot ? '已连接' : '未连接'} (${config.ws_url})`,
            `前缀: ${prefix}`,
            `当前默认路由: ${cur || '(未设定)'}`,
            `待回话轮次: ${pendingTurns.get(qq) ?? 0}`,
            `待回答提问: ${[...asks.values()].filter((entry) => typeof entry.submit === 'function').length}，待审批: ${approvals.size}`,
            `提权中: ${escalations.size ? [...escalations.keys()].map((sid) => shortId(sid)).join('、') : '无'}`,
            `路由表: ${table.items.length} 条，${table.builtAt ? fmtTime(table.builtAt) + ' 建立' : '未建立'}`,
          ].join('\n'),
        )
        return
      }
      if (['set', 'use', '切换', '用', '设为'].includes(head)) {
        if (!rest) {
          await sendText(qq, `用法：${prefix}set <路由>（编号、别名或短 id），设完不带路由的消息都进它`)
          return
        }
        const target = await resolveRoute(rest)
        if (!target) {
          await sendText(qq, `没找到路由「${rest}」。先发 ${prefix}list 看看。`)
          return
        }
        sticky.set(qq, target)
        persistSticky()
        const title = await readTitle(target)
        await sendText(qq, `默认会话已设成 ${shortId(target)}${title ? ' 「' + title + '」' : ''}，重启 DSH 后会重置。`)
        return
      }

      if (['unbind', '解绑'].includes(head)) {
        const arg = rest.trim()
        const token = String(config.bind_token ?? '').trim()
        const items = []
        if (boundQq) items.push({ n: items.length + 1, kind: 'self', label: `账号绑定：${boundQq}` })
        for (const g of slots.grantsOf('share')) items.push({ n: items.length + 1, kind: 'share', token: g.token, label: `分享 ${g.token}：${g.peer ? `${g.peerKind}:${g.peer}` : '未绑定'}，目录 ${g.dir}` })
        for (const g of slots.grantsOf('team')) items.push({ n: items.length + 1, kind: 'team', token: g.token, label: `团队 ${g.token}：${g.peer ? `${g.peerKind}:${g.peer}` : '未绑定'}，工作区 ${g.worktree || '(已删)'}` })
        const lower = arg.toLowerCase()

        // 不带参数：列出绑定，像 #list 一样给编号
        if (!arg) {
          if (!items.length) {
            await sendText(qq, '现在没有任何绑定。')
            return
          }
          const lines = ['当前绑定：', ...items.map((it) => `${it.n}. ${it.label}`), '']
          lines.push(`${prefix}unbind <编号>       解绑那一条`)
          lines.push(`${prefix}unbind all          解绑除自己以外的全部（要再确认一次）`)
          lines.push(`${prefix}unbind self <口令>  解绑自己，需要绑定口令`)
          await sendText(qq, lines.join('\n'))
          return
        }

        if (lower === 'all') {
          const shareGrants = slots.grantsOf('share')
          const teamGrants = slots.grantsOf('team')
          if (!shareGrants.length && !teamGrants.length) {
            await sendText(qq, `除了自己，没有别的绑定。解绑自己用 ${prefix}unbind self <口令>。`)
            return
          }
          unbindAllAt = Date.now()
          await sendText(
            qq,
            `将要解绑：\n${items.filter((it) => it.kind !== 'self').map((it) => `- ${it.label}`).join('\n')}\n\n确认请再发 ${prefix}unbind all confirm（2 分钟内有效）；解绑自己用 ${prefix}unbind self <口令>。`,
          )
          return
        }
        if (lower === 'all confirm' || lower === 'all 确认') {
          if (!(Date.now() - unbindAllAt < 120000)) {
            await sendText(qq, `确认已过期，重新发 ${prefix}unbind all。`)
            return
          }
          const done = []
          for (const g of slots.grantsOf('share')) done.push(`分享 ${g.token}：${slots.unbind('share', g.token)}`)
          for (const g of slots.grantsOf('team')) done.push(`团队 ${g.token}：${slots.unbind('team', g.token)}`)
          if (!done.length) {
            await sendText(qq, '除了自己，没有别的绑定可解。')
            return
          }
          unbindAllAt = 0
          log('[unbind] 主号解绑全部分享/团队槽')
          await sendText(qq, done.join('\n'))
          return
        }
        if (lower === 'self' || lower.startsWith('self ')) {
          const given = lower === 'self' ? '' : arg.slice(4).trim()
          if (!token) {
            await sendText(qq, '没有配置绑定口令（bind_token），不能解绑自己。')
            return
          }
          if (!given) {
            await sendText(qq, `解绑自己需要再提供一次绑定口令：${prefix}unbind self <口令>。`)
            return
          }
          if (given !== token) {
            log(`[unbind] ${qq} self 口令不对`)
            await sendText(qq, '口令不对，没有解绑。')
            return
          }
          if (!boundQq) {
            await sendText(qq, '现在没有绑定账号。')
            return
          }
          if (qq !== boundQq) {
            await sendText(qq, `只有绑定号本人能解绑自己（当前绑定号是 ${boundQq}）。`)
            return
          }
          boundQq = 0
          persistSticky()
          log(`[unbind] ${qq} 已解绑自己`)
          await sendText(qq, `已解绑自己。重新绑定发 ${prefix}bind <口令>。`)
          return
        }

        const idx = Number(arg)
        if (Number.isInteger(idx) && idx > 0 && idx <= items.length) {
          const it = items[idx - 1]
          if (it.kind === 'self') {
            await sendText(qq, `解绑自己需要再提供一次绑定口令：${prefix}unbind self <口令>。`)
            return
          }
          if (it.kind === 'share' || it.kind === 'team') {
            await sendText(qq, slots.unbind(it.kind, it.token || ''))
            return
          }
        }
        await sendText(qq, `没有这个编号。发 ${prefix}unbind 看当前列表。`)
        return
      }

      if (['ap', 'approvals', '审批', '待审批'].includes(head)) {
        if (!approvals.size) {
          await sendText(qq, '现在没有等你决定的审批。')
          return
        }
        const rows = [...approvals.entries()].map(([code, entry]) => `${code}  ${entry.label}`)
        await sendText(
          qq,
          ['等你决定的审批：', ...rows, '', `${prefix}y <编号> 允许，${prefix}n <编号> 拒绝`].join('\n'),
        )
        return
      }

      if (APPROVAL_YES.includes(head.toLowerCase()) || APPROVAL_NO.includes(head.toLowerCase())) {
        const allowIt = APPROVAL_YES.includes(head.toLowerCase())
        if (!approvals.size) {
          await sendText(qq, `现在没有等你决定的审批，${prefix}y / ${prefix}n 不用回。`)
          return
        }
        // 只认第一个词：`#y 0001 好的` 里的「好的」不该被当成编号的一部分
        const code = String(rest || '').trim().split(/\s+/)[0] || currentApprovalCode()
        if (!code) {
          await sendText(qq, `有 ${approvals.size} 条待审批，得带编号：${prefix}y <编号>，发 ${prefix}ap 看列表。`)
          return
        }
        if (!settleApproval(code, allowIt ? 'allowed-once' : 'rejected')) {
          await sendText(qq, `没有编号「${code}」的待审批。发 ${prefix}ap 看当前列表。`)
          return
        }
        return // settleApproval 那边已经挂了结果回报
      }

      if (['file', 'sendfile'].includes(head)) { await fileFromQq(qq, rest); return }

      if (['img', 'image', 'pic', '图片'].includes(head)) {
        if (!isOn('qq', 'sticker')) {
          await sendText(qq, '表情与图片已在插件详情页关掉（dsh-toolkit 开关）。')
          return
        }
        const spec = String(rest ?? '').trim()
        if (!spec) {
          await sendText(qq, `用法：${prefix}img <本机图片路径>\n支持 png / jpg / jpeg / gif / webp / bmp，上限 10 MB；直接发图用 ${prefix}sticker。`)
          return
        }
        try {
          const { name, size } = await sendImageTo(qq, spec)
          await sendText(qq, `已发送图片 ${name}（${(size / 1024).toFixed(1)} KB）。`)
        } catch (err) {
          await sendText(qq, `发不出去：${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }

      if (['sticker', '表情', '贴图'].includes(head)) {
        if (!isOn('qq', 'sticker')) {
          await sendText(qq, '表情与图片已在插件详情页关掉（dsh-toolkit 开关）。')
          return
        }
        await stickerFromQq(qq, rest)
        return
      }

      if (['stickerpath', '表情目录'].includes(head)) {
        if (qq !== boundQq) {
          await sendText(qq, '只有主号能改表情目录。')
          return
        }
        const arg = rest.trim()
        const fallbackDir = join(dshHome, 'dsh-toolkit-stickers')
        if (!arg) {
          const info = stickerInfo(config.sticker_dir, fallbackDir)
          await sendText(
            qq,
            [
              `当前表情目录：${info.dir}`,
              `来源：${info.source === 'runtime' ? '运行期设置' : info.source === 'config' ? '插件配置 qq.sticker_dir' : '默认目录'}`,
              `状态：${info.exists ? `存在，${info.count} 张图` : '目录不存在'}`,
              '',
              `改路径：${prefix}stickerpath <绝对路径>`,
              `恢复默认：${prefix}stickerpath reset`,
              '也可以直接在 DSH「插件 → dsh-toolkit 详情页」里改。',
            ].join('\n'),
          )
          return
        }
        if (arg.toLowerCase() === 'reset' || arg === '默认') {
          writeStickerDir('')
          await sendText(qq, `已恢复默认：${stickerInfo(config.sticker_dir, fallbackDir).dir}`)
          return
        }
        const dir = expandHome(arg) || arg
        try {
          if (!statSync(dir).isDirectory()) throw new Error('不是目录')
        } catch {
          await sendText(qq, `目录不存在或不是目录：${dir}`)
          return
        }
        writeStickerDir(dir)
        const info = stickerInfo(config.sticker_dir, fallbackDir)
        await sendText(qq, `表情目录已改成：${info.dir}（${info.count} 张图）`)
        return
      }

      if (['progress', '进度'].includes(head)) { await progressFromQq(qq, rest); return }

      if (['testask', '自检提问'].includes(head)) { await testAskOnce(qq); return }

      if (['answer', 'ans', 'a'].includes(head)) {
        await answerAskFromQq(qq, rest)
        return
      }

      if (['link', '配对', 'pin'].includes(head)) {
        try {
          const { url, ttl } = await fetchPairLink()
          await sendText(
            qq,
            [url, ttl !== null ? `（${ttl} 秒内有效，过期再发 ${prefix}link）` : `（本次运行有效；DSH 重启后失效，重发 ${prefix}link）`].filter(Boolean).join('\n'),
          )
        } catch (err) {
          await sendText(qq, `拿不到配对链接：${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }

      if (['new', '新建', '新对话'].includes(head)) {
        await startNewSession(qq, rest)
        return
      }

      if (['check', '排查', '自检'].includes(head)) {
        await runCheck(qq, rest)
        return
      }

      if (['start', '启动', '开机'].includes(head)) {
        const portUp = await portOpen(napcatPort())
        if (bot && portUp) {
          await sendText(
            qq,
            [
              '运行中',
              `NapCat 已连上${lastSelfId ? '（bot ' + lastSelfId + '）' : ''}`,
              `插件在线，待回话 ${pendingTurns.get(qq) ?? 0} 轮`,
            ].join('\n'),
          )
          return
        }
        const wait = Number(config.start_wait_secs) || 90
        await sendText(
          qq,
          `没连上（端口 ${napcatPort()} ${portUp ? '在听，但握手失败' : '没在听'}），正在拉起 NapCat，最多等 ${wait} 秒`,
        )
        if (!portUp) {
          const spawned = await spawnDetached(config.napcat_path)
          log(`[start] spawn "${config.napcat_path}" -> ${spawned ? 'ok' : 'fail'}`)
          if (!spawned) {
            await sendText(qq, `拉起 NapCat 失败，检查 napcat_path：${config.napcat_path}`)
            return
          }
        }
        const deadline = Date.now() + wait * 1000
        let connected = false
        let waited = 0
        while (Date.now() < deadline) {
          await delay(3000)
          waited += 3
          if (!(await portOpen(napcatPort(), 1000))) continue
          log(`[start] 端口已开，第 ${waited}s 尝试连接`)
          if (await startBot(1)) {
            connected = true
            break
          }
        }
        if (connected) {
          await sendText(qq, `NapCat 起来了${lastSelfId ? '，bot ' + lastSelfId + ' 已登录' : ''}，插件已连上`)
        } else {
          const stillUp = await portOpen(napcatPort(), 1000)
          await sendText(
            qq,
            stillUp
              ? `等了 ${wait} 秒端口在听但握手不进去 —— 多半是 bot 没登录，去 NapCat 那边扫码`
              : `等了 ${wait} 秒端口还是没开 —— NapCat 没启动成功，看它的日志`,
          )
        }
        return
      }

      if (['restart', '重启'].includes(head)) {
        await restartViaTask(qq, rest)
        return
      }

      if (['running', '运行中', '在跑'].includes(head)) {
        const handles = typeof agents.list === 'function' ? agents.list() : []
        const live = liveSessions()
        const lines = []
        for (const item of live) {
          if (!item.running) continue
          const title = await readTitle(item.sid)
          lines.push(`${shortId(item.sid)}  ${item.agent?.phase?.kind ?? 'running'}  ${title || '(无标题)'}`)
        }
        const pend = [...pendingTurns.entries()].filter(([, n]) => n > 0)
        await sendText(
          qq,
          (lines.length
            ? `正在运行 ${lines.length} 个：\n` + lines.join('\n') + `\n\n停止：${prefix}stop <路由>`
            : `没有正在运行的会话（内存里活着的 agent ${handles.length} 个，都不是运行态）`) +
            (pend.length ? `\n来自 QQ 的待回话轮次：${pend.map(([k, n]) => k + '×' + n).join('，')}` : ''),
        )
        return
      }

      if (['stop', '停止', '停'].includes(head)) {
        await stopSession(qq, rest)
        return
      }

      if (ESCALATE_WORDS.includes(head.toLowerCase())) {
        await escalateFromQq(qq, rest)
        return
      }

      if (['msg', 'last'].includes(head)) {
        await pullLatest(qq, head, rest)
        return
      }

      // 先试着把第一个词当路由；解析不出来就整段当作内容，用当前默认路由。
      let sessionId = null
      let text = body
      const token = body.split(/\s+/)[0]
      const candidate = await resolveRoute(token)

      // 打错命令或写错编号时只回用法：这类消息本意是操作插件，不该悄悄发给 AI。
      if (!candidate) {
        if (/^\d+$/.test(token)) {
          await sendText(qq, `没有 ${token} 号路由。先发 ${prefix}list 看编号，或用别名、短 id。`)
          return
        }
        // 纯 ASCII 词才可能是打错命令；带参数时只在确实像某个命令（编辑距离近）才拦，
        // 中文内容、普通的英文内容照旧当正文发。
        if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(token)) {
          const near = nearestCommand(token)
          if (!rest || near) {
            await sendText(
              qq,
              (near
                ? `没有「${token}」这个命令，你要发的是 ${prefix}${near} 吗？`
                : `没有「${token}」这个命令。`) + '\n\n' + helpText(),
            )
            return
          }
        }
      }

      if (candidate && !rest) {
        // 只有编号没内容：切到该路由并提示，不能把字面量 "3" 当正文注入会话
        sessionId = candidate
        sticky.set(qq, candidate)
        persistSticky()
        const title = await readTitle(candidate)
        await sendText(
          qq,
          `已切到 ${shortId(candidate)}${title ? ' 「' + clipText(title, 30) + '」' : ''}。\n现在直接发内容就行，也可以继续写 ${prefix}${token} 内容。`,
        )
        return
      }

      if (rest && candidate) {
        // 路由在前、命令在后也认：#<路由> msg / #<路由> last
        const sub = rest.split(/\s+/)[0]
        if (sub === 'msg' || sub === 'last') {
          await pullLatest(qq, sub, token)
          return
        }
        sessionId = candidate
        text = rest
      } else if (rest && !candidate) {
        // 首个词不是路由，整段就是内容（含多行）
        text = body
      }
      if (!sessionId) sessionId = sticky.get(qq) ?? (config.default_session || null)
      if (!sessionId) {
        await sendText(qq, `还没设定会话。先发 ${prefix}list 看编号，再用 ${prefix}use <编号> 固定，或直接写 ${prefix}<编号> 内容。`)
        return
      }
      const ok = await resolveRoute(sessionId).catch(() => null)
      if (!ok) {
        // 允许 default_session/sticky 里直接写 id
        log(`[route] 未能解析 ${sessionId}，按原值使用`)
      }
      const attach = await attachmentFor(qq, mediaSegs, replySeg)
      await inject(qq, ok ?? sessionId, attach ? `${text}\n\n${attach}` : text)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`[in] 处理失败: ${message}`)
      try {
        if (bot) await sendText(Number(event?.user_id), `处理失败：${message}`)
      } catch {
        /* 连回复都失败就只能记日志 */
      }
    }
  }

  // ── 工具：让模型主动回话 ──────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'onebot_send',
      description:
        '把一条消息发送到 QQ 用户。target 形如 private:<QQ>，必须在白名单内。这是内容送达 QQ 的唯一途径：每次调用立即发送，可以分多次调用（先回答、再查资料、再补充）。',
      parameters: {
        target: { type: 'string', required: true, description: '目标，例如 private:123456789' },
        content: { type: 'string', required: true, description: '要发送的文本' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            delivered: { type: 'boolean', required: true },
            target: { type: 'string', required: true },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) =>
          value.delivered
            ? [{ type: 'text', text: `已发送到 ${value.target}` }]
            : [{ type: 'text', text: `没有发：${value.reason ?? '被节流拦下'}` }],
      },
      async execute(args) {
        if (!isOn('qq')) throw new Error('QQ 通道已在插件详情页关掉（dsh-toolkit 开关）')
        const target = String(args.target ?? '')
        const content = String(args.content ?? '')
        const g = /^group:(\d+)$/.exec(target)
        if (g) {
          const gid = g[1]
          const allowed =
            host.isEnabled(gid) || Boolean(slots.grantForPeer(gid, 'share')) || Boolean(slots.grantForPeer(gid, 'team'))
          if (!allowed) throw new Error(`群 ${gid} 没有开启接待模式，也没有绑定槽权限`)
          if (!content.trim()) throw new Error('content 不能为空')
          // 真人不会一秒一条：节流 + 一点点随机延迟，避免被 QQ 判成机器号踢下线。
          // 撞上间隔/每分钟上限时排队等，不直接失败（反复重试更像机器）；
          // 只有「同一句话刚说过」才真的拒绝。
          let gate = host.allowReply(gid, content)
          for (let i = 0; !gate.ok && gate.kind !== 'dedupe' && gate.kind !== 'empty' && gate.waitMs <= 20000 && i < 3; i += 1) {
            log(`[host] 群 ${gid} 排队 ${Math.ceil(gate.waitMs / 1000)} 秒后再发（${gate.kind}）`)
            await delay(gate.waitMs + 200 + Math.random() * 400)
            gate = host.allowReply(gid, content)
          }
          if (!gate.ok) {
            log(`[host] 群 ${gid} 回复被节流：${gate.reason}`)
            return { delivered: false, target, reason: gate.reason }
          }
          await delay(700 + Math.random() * 1600)
          await sendPeerText(gid, true, content)
          return { delivered: true, target }
        }
        const m = /^private:(\d+)$/.exec(target)
        if (!m) throw new Error('target 必须是 private:<QQ> 或 group:<群号>')
        const uid = Number(m[1])
        if (!allow.has(uid)) throw new Error(`QQ ${uid} 不在白名单里`)
        if (!content.trim()) throw new Error('content 不能为空')
        await sendText(uid, content)
        pendingTurns.delete(uid)
        sentCount.set(uid, (sentCount.get(uid) ?? 0) + 1)
        return { delivered: true, target }
      },
    }),
  )

  // ── 工具：把文件/图片发到 QQ ──────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'onebot_send_file',
      description:
        '把本机文件或图片发到 QQ 用户。target 形如 private:<QQ>，必须在白名单内。用于把截图、报告、生成的文档直接送到 QQ；上限 100 MB。凭据类文件（.credentials、.ssh、id_rsa、.env、*.pem/*.key 等）一律拒绝发送。',
      parameters: {
        target: { type: 'string', required: true, description: '目标，例如 private:123456789' },
        path: { type: 'string', required: true, description: '本机文件的绝对路径' },
        caption: { type: 'string', description: '可选：文件前面附一句话' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            delivered: { type: 'boolean', required: true },
            target: { type: 'string', required: true },
            name: { type: 'string', required: true },
            bytes: { type: 'number', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `已发送 ${value.name}（${value.bytes} 字节）到 ${value.target}` }],
      },
      async execute(args) {
        if (!isOn('qq')) throw new Error('QQ 通道已在插件详情页关掉（dsh-toolkit 开关）')
        const target = String(args.target ?? '')
        const m = /^private:(\d+)$/.exec(target)
        if (!m) throw new Error('target 必须是 private:<QQ>')
        const uid = Number(m[1])
        if (!allow.has(uid)) throw new Error(`QQ ${uid} 不在白名单里`)
        const { name, size } = await sendFileTo(uid, String(args.path ?? ''), args.caption)
        pendingTurns.delete(uid)
        sentCount.set(uid, (sentCount.get(uid) ?? 0) + 1)
        return { delivered: true, target, name, bytes: size }
      },
    }),
  )

  // ── 工具：QQ 互动（戳一戳 / 贴表情 / 点赞 / 撤回 / 引用回复）────────────────
  // target 有两种：private:<QQ>（白名单内）与 group:<群号>（只限开了群接待或有槽授权的群，
  // 否则等于给机器人一个往任意群发消息的口子）。
  function parseTarget(raw) {
    const text = String(raw ?? '').trim()
    const m = /^(private|group):(\d+)$/.exec(text)
    if (!m) throw new Error('target 必须是 private:<QQ> 或 group:<群号>')
    const kind = m[1]
    const id = Number(m[2])
    if (kind === 'group') {
      const key = String(id)
      const opened =
        host.isEnabled(key) ||
        Boolean(slots.grantForPeer(key, 'share')) ||
        Boolean(slots.grantForPeer(key, 'team'))
      if (!opened) throw new Error(`群 ${id} 没开群接待，也没有分享/团队授权，不能往这个群发`)
      return { kind, id }
    }
    if (!allow.has(id)) throw new Error(`QQ ${id} 不在白名单里`)
    return { kind, id }
  }

  // 图片/动图直接当表情发（避免 QQ 的超级表情接口，私聊里那个往往不可用）。
  ctx.tools.register(
    defineTool({
      name: 'qq_send_image',
      description:
        '把本机图片或动图（gif）发到 QQ 显示成图片，可当表情用。target 写 private:<QQ>（白名单内）或 group:<群号>（只在开了群接待或有槽授权的群里允许）；支持 png/jpg/jpeg/gif/webp/bmp，上限 10 MB。',
      parameters: {
        target: { type: 'string', required: true, description: '目标，例如 private:123456789 或 group:123456' },
        path: { type: 'string', required: true, description: '本机图片或动图的绝对路径' },
        caption: { type: 'string', description: '可选：图片后面附一句话' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            delivered: { type: 'boolean', required: true },
            target: { type: 'string', required: true },
            name: { type: 'string', required: true },
            bytes: { type: 'number', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `已发送图片 ${value.name}（${value.bytes} 字节）到 ${value.target}` }],
      },
      async execute(args) {
        if (!isOn('qq')) throw new Error('QQ 通道已在插件详情页关掉（dsh-toolkit 开关）')
      if (!isOn('qq', 'sticker')) throw new Error('表情与图片已在插件详情页关掉（dsh-toolkit 开关）')
        const dest = parseTarget(args.target)
        const { name, size } = await sendImageTo(dest.id, String(args.path ?? ''), args.caption, { group: dest.kind === 'group' })
        if (dest.kind === 'private') {
          pendingTurns.delete(dest.id)
          sentCount.set(dest.id, (sentCount.get(dest.id) ?? 0) + 1)
        }
        return { delivered: true, target: String(args.target), name, bytes: size }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qq_poke',
      description: '戳一戳。target 写 private:<QQ>（白名单内，NapCat friend_poke / send_poke）或 group:<群号>（群戳一戳，需另传 user 指定要戳谁）。',
      parameters: {
        target: { type: 'string', required: true, description: '目标，例如 private:123456789 或 group:123456' },
        user: { type: 'string', description: '群目标时必填：要戳的群成员 QQ 号' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            poked: { type: 'boolean', required: true },
            target: { type: 'string', required: true },
            action: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `已戳 ${value.target}（${value.action}）` }],
      },
      async execute(args) {
        if (!isOn('qq')) throw new Error('QQ 通道已在插件详情页关掉（dsh-toolkit 开关）')
      if (!isOn('qq', 'tools')) throw new Error('互动工具已在插件详情页关掉（dsh-toolkit 开关）')
        const dest = parseTarget(args.target)
        if (dest.kind === 'group') {
          const who = Number(args.user ?? lastInId.get(dest.id) ?? 0)
          if (!who) throw new Error('群戳一戳要指定 user（要戳的群成员 QQ 号），或先在群里有人说过话')
          await sendRaw('group_poke', { group_id: dest.id, user_id: who })
          return { poked: true, target: `group:${dest.id}`, action: 'group_poke' }
        }
        const uid = dest.id
        let action = 'friend_poke'
        try {
          await sendRaw('friend_poke', { user_id: uid })
        } catch (err) {
          log(`[poke] friend_poke 失败，改用 send_poke：${err instanceof Error ? err.message : String(err)}`)
          await sendRaw('send_poke', { user_id: uid })
          action = 'send_poke'
        }
        return { poked: true, target: `private:${uid}`, action }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qq_like',
      description: '给 QQ 用户的资料卡点赞（OneBot send_like），每次 1~10 个。target 写 private:<QQ> 或 group:<群号>（群里需另传 user 指定给谁点）。',
      parameters: {
        target: { type: 'string', required: true, description: '目标，例如 private:123456789 或 group:123456' },
        user: { type: 'string', description: '群目标时必填：要点赞的群成员 QQ 号' },
        times: { type: 'number', description: '点赞次数，1~10，默认 10' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            liked: { type: 'boolean', required: true },
            target: { type: 'string', required: true },
            times: { type: 'number', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `已给 ${value.target} 点了 ${value.times} 个赞` }],
      },
      async execute(args) {
        if (!isOn('qq')) throw new Error('QQ 通道已在插件详情页关掉（dsh-toolkit 开关）')
      if (!isOn('qq', 'tools')) throw new Error('互动工具已在插件详情页关掉（dsh-toolkit 开关）')
        const dest = parseTarget(args.target)
        const raw = Number(args.times)
        const times = Number.isFinite(raw) ? Math.min(10, Math.max(1, Math.round(raw))) : 10
        const uid = dest.kind === 'group' ? Number(args.user ?? lastInId.get(dest.id) ?? 0) : dest.id
        if (!uid) throw new Error('群点赞要指定 user（要点赞的群成员 QQ 号），或先在群里有人说过话')
        await sendRaw('send_like', { user_id: uid, times })
        return { liked: true, target: String(args.target), times }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qq_recall',
      description:
        '撤回一条 QQ 消息（OneBot delete_msg，只对两分钟内、自己或对方发过的消息有效）。不传 message_id 就撤回最近一条由本插件发出的消息。',
      parameters: {
        message_id: { type: 'string', description: '可选：消息 id，默认最近一条发出去的' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            recalled: { type: 'boolean', required: true },
            messageId: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `已撤回消息 ${value.messageId}` }],
      },
      async execute(args) {
        if (!isOn('qq')) throw new Error('QQ 通道已在插件详情页关掉（dsh-toolkit 开关）')
      if (!isOn('qq', 'tools')) throw new Error('互动工具已在插件详情页关掉（dsh-toolkit 开关）')
        const mid = String(args.message_id ?? lastOutId ?? '')
        if (!mid) throw new Error('没有可撤回的消息 id：本插件还没发出过消息，或传了的 id 为空')
        await sendRaw('delete_msg', { message_id: Number(mid) })
        if (mid === lastOutId) lastOutId = ''
        return { recalled: true, messageId: mid }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qq_reply',
      description:
        '在 QQ 里引用一条消息回复（带引用卡片）。target 写 private:<QQ> 或 group:<群号>；不传 quote_message_id 就引用对方最近发来的那条消息。',
      parameters: {
        target: { type: 'string', required: true, description: '目标，例如 private:123456789 或 group:123456' },
        text: { type: 'string', required: true, description: '回复正文' },
        quote_message_id: { type: 'string', description: '可选：要引用的消息 id，默认该用户最近发来的消息' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            delivered: { type: 'boolean', required: true },
            target: { type: 'string', required: true },
            quoted: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `已引用消息 ${value.quoted} 回复 ${value.target}` }],
      },
      async execute(args) {
        if (!isOn('qq')) throw new Error('QQ 通道已在插件详情页关掉（dsh-toolkit 开关）')
      if (!isOn('qq', 'tools')) throw new Error('互动工具已在插件详情页关掉（dsh-toolkit 开关）')
        const dest = parseTarget(args.target)
        const body = String(args.text ?? '')
        if (!body.trim()) throw new Error('text 不能为空')
        const quote = String(args.quote_message_id ?? lastInId.get(dest.id) ?? '')
        const message = []
        if (quote) message.push({ type: 'reply', data: { id: String(quote) } })
        message.push({ type: 'text', data: { text: body } })
        const sent =
          dest.kind === 'group'
            ? await sendRaw('send_group_msg', { group_id: dest.id, message })
            : await sendRaw('send_private_msg', { user_id: dest.id, message })
        const mid = sent?.message_id ?? sent?.data?.message_id
        if (mid) lastOutId = String(mid)
        if (dest.kind === 'private') {
          sentCount.set(dest.id, (sentCount.get(dest.id) ?? 0) + 1)
          pendingTurns.delete(dest.id)
        }
        return { delivered: true, target: String(args.target), quoted: quote || '(无)' }
      },
    }),
  )

  // ── 工具：管理 DSH 之外的那一半（常驻唤醒器 + 登录自启）───────────────────
  // 插件跑在 DSH 里，DSH 关着时它不存在；所以"用 QQ 命令启动 DSH"必须由一个
  // 独立进程做。这里只负责安装、查询、卸载，不参与日常运行。
  const wakerPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'waker.mjs')

  // 桌面端宿主里 process.execPath 是 DeepSeek Harness.exe，不是 node，
  // 所以必须显式找 node 可执行文件来跑 waker.mjs。
  function resolveNodeExe() {
    const candidates = [
      process.env.DSH_NODE,
      join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
      join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    ].filter((value) => typeof value === 'string' && value.length > 0)
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return 'node'
  }
  const nodeExe = resolveNodeExe()

  function runPowerShell(lines) {
    return new Promise((resolve, reject) => {
      const dir = mkdtempSync(join(tmpdir(), 'qq-waker-'))
      const file = join(dir, 'run.ps1')
      // PowerShell 5.1 没有 BOM 时按系统 ANSI 解码，脚本里的中文/特殊字符会变成乱码甚至语法错
      writeFileSync(file, '\ufeff' + lines.join('\r\n'), 'utf8')
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
        { timeout: 180000, windowsHide: true },
        (err, stdout, stderr) => {
          try {
            rmSync(dir, { recursive: true, force: true })
          } catch {
            /* 忽略清理失败 */
          }
          const out = String(stdout || '').trim()
          if (err && !out) reject(new Error(String(stderr || err.message).trim()))
          else resolve(out || String(stderr || '').trim())
        },
      )
    })
  }

  function wakerPowerShell(action) {
    const dir = dirname(wakerPath)
    const cfgFile = join(dir, 'waker.config.json')
    const vbsFile = join(dir, 'waker-launch.vbs')
    const startFile = join(dir, 'waker-start.ps1')
    const appExe = config.dsh_exe
    const appDir = dirname(appExe)
    const WSCRIPT = 'C:\\Windows\\System32\\wscript.exe'
    /** 拼进 PowerShell 单引号字符串前先转义，路径里带 ' 也不会截断脚本。 */
    const psq = (value) => String(value).replace(/'/g, "''")

    if (action === 'install') {
      const cfg = {
        ws: config.ws_url,
        allow: [...allow],
        prefix: config.prefix,
        exe: appExe,
        task: 'DSH Start',
        waitSecs: Math.max(90, Number(config.start_wait_secs) || 90),
      }
      // 这三份文件都从 Node 写。PowerShell 的 Set-Content -Encoding ASCII 会把中文路径
      // 写成 '?'，值里的单引号还会截断 PS 字符串。
      writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), 'utf8')
      // wscript 认 UTF-16LE + BOM 的 .vbs，中文路径不会乱码
      writeFileSync(
        vbsFile,
        Buffer.from(`\ufeffCreateObject("WScript.Shell").Run """${nodeExe}"" ""${wakerPath}""", 0, False`, 'utf16le'),
      )
      // DSH Start 任务的守卫：已经在跑就直接退出，避免唤醒器和计划任务同时拉起第二个实例
      writeFileSync(
        startFile,
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(
            [
              "$ErrorActionPreference = 'SilentlyContinue'",
              "if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) { exit 0 }",
              `Start-Process -FilePath '${psq(appExe)}' -WorkingDirectory '${psq(appDir)}'`,
              '',
            ].join('\r\n'),
            'utf8',
          ),
        ]),
      )
      return [
        "$ErrorActionPreference = 'Stop'",
        "$pr = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive",
        `$actW = New-ScheduledTaskAction -Execute '${WSCRIPT}' -Argument '"${psq(vbsFile)}"'`,
        '$setW = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)',
        '$trg = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME',
        "Register-ScheduledTask -TaskName 'DSH Waker' -Action $actW -Trigger $trg -Settings $setW -Principal $pr -Force | Out-Null",
        `$argS = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + '${psq(startFile)}' + '"'`,
        `$actS = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argS -WorkingDirectory '${psq(appDir)}'`,
        '$setS = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances Parallel',
        "Register-ScheduledTask -TaskName 'DSH Start' -Action $actS -Settings $setS -Principal $pr -Force | Out-Null",
        '$startup = [Environment]::GetFolderPath("Startup")',
        '$lnk = Join-Path $startup "DeepSeek Harness.lnk"',
        '$sh = New-Object -ComObject WScript.Shell',
        '$s = $sh.CreateShortcut($lnk)',
        `$s.TargetPath = '${psq(appExe)}'`,
        `$s.WorkingDirectory = '${psq(appDir)}'`,
        '$s.Save()',
        "Stop-ScheduledTask -TaskName 'DSH Waker' -ErrorAction SilentlyContinue",
        "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*waker.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
        'Start-Sleep -Seconds 1',
        "Start-ScheduledTask -TaskName 'DSH Waker'",
        'Start-Sleep -Seconds 4',
        "'OK installed'",
      ]
    }

    if (action === 'status') {
      return [
        '$lines = @()',
        "foreach ($n in @('DSH Start','DSH Waker')) {",
        '  $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue',
        '  $i = Get-ScheduledTaskInfo -TaskName $n -ErrorAction SilentlyContinue',
        "  $state = if ($t) { $t.State } else { 'missing' }",
        "  $res = if ($i) { $i.LastTaskResult } else { '-' }",
        "  $when = if ($i) { $i.LastRunTime.ToString('MM-dd HH:mm') } else { '-' }",
        '  $lines += ($n + "|" + $state + "|" + $res + "|" + $when)',
        '}',
        '$lnk = Join-Path ([Environment]::GetFolderPath("Startup")) "DeepSeek Harness.lnk"',
        'if (Test-Path $lnk) { $lines += "autostart|yes" } else { $lines += "autostart|no" }',
        'try { $lines += ("procs|" + ((Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Measure-Object).Count)) } catch { $lines += "procs|?" }',
        '$lines -join "`n"',
      ]
    }

    if (action === 'uninstall') {
      return [
        "Unregister-ScheduledTask -TaskName 'DSH Waker' -Confirm:$false -ErrorAction SilentlyContinue",
        "Unregister-ScheduledTask -TaskName 'DSH Start' -Confirm:$false -ErrorAction SilentlyContinue",
        '$lnk = Join-Path ([Environment]::GetFolderPath("Startup")) "DeepSeek Harness.lnk"',
        'if (Test-Path $lnk) { Remove-Item $lnk -Force }',
        `if (Test-Path '${psq(vbsFile)}') { Remove-Item '${psq(vbsFile)}' -Force }`,
        `if (Test-Path '${psq(startFile)}') { Remove-Item '${psq(startFile)}' -Force }`,
        "'OK uninstalled'",
      ]
    }

    if (action === 'start') return ["Start-ScheduledTask -TaskName 'DSH Waker'", "'OK started'"]
    if (action === 'stop') {
      return ["Stop-ScheduledTask -TaskName 'DSH Waker' -ErrorAction SilentlyContinue", "'OK stopped'"]
    }
    return null
  }


  /**
   * 解析 peer：显式参数 > 调用方所在群（群接待会话）> 最近一条入站 > 绑定号。
   * 顺序反过来会把「群接待会话问自己那个群」错认成主号私聊。
   */
  function toolPeer(args, fallback) {
    const direct = String(args?.peer ?? '').trim()
    if (direct) return direct.replace(/^group:/i, '').replace(/^member:/i, '')
    const from = String(fallback ?? '').trim()
    if (from) return from
    const ids = [...lastInId.keys()]
    const last = ids.length ? ids[ids.length - 1] : ''
    return String(last || boundQq || '')
  }

  ctx.tools.register(
    defineTool({
      name: 'share_read',
      description:
        '通过分享槽读取已授权目录并回答问题。需要插件详情页 QQ 分组里的「槽能力作为工具」打开；peer 缺省用最近一条入站消息的来源（群号或 QQ 号）。',
      parameters: {
        question: { type: 'string', required: true, description: '要问的问题，例如「这个目录里有哪些文件」' },
        peer: { type: 'string', description: '可选：group:<群号> 或 <QQ号>；缺省用最近一条入站消息的来源' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            text: { type: 'string', required: true },
            tokens: { type: 'string', required: true },
            files: { type: 'number', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        if (!isOn('qq')) throw new Error('QQ 通道已在插件详情页关掉（dsh-toolkit 开关）')
        // 群接待会话里这是唯一读资料的通道，不受「槽能力作为工具」限制
        const callerGid = host.groupOfSession(String(exec?.agent?.id ?? ''))
        if (!callerGid && !isOn('qq', 'slot_tools')) {
          throw new Error('「槽能力作为工具」已在插件详情页关掉（dsh-toolkit 开关）')
        }
        const peer = toolPeer(args, callerGid)
        if (!peer) throw new Error('还没有入站消息；请显式传 peer（group:<群号> 或 <QQ号>）')
        const question = String(args.question ?? '').trim()
        if (!question) throw new Error('question 不能为空')
        log(`[share] 工具 share_read peer=${peer} 问题=${question.slice(0, 40)}`)
        const r = await slots.answerShare({ peer, question })
        if (r.refused) return { ok: false, text: String(r.refused), tokens: '', files: 0 }
        const text = String(r.text ?? '').trim()
        return {
          ok: true,
          text: text || `（读到 ${Array.isArray(r.files) ? r.files.length : 0} 个文件，但没有可回答的正文；换个问法或检查目录里有没有文本文件）`,
          tokens: (r.tokens ?? []).join(', '),
          files: Array.isArray(r.files) ? r.files.length : 0,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'team_edit',
      description:
        '在团队槽的隔离工作区里完成一次改动：把要求交给本机一个独立会话去改，改完提交到临时分支并返回 diff。需要「槽能力作为工具」打开。不会自动合并。',
      parameters: {
        instruction: { type: 'string', required: true, description: '要改什么，一句话说清' },
        peer: { type: 'string', description: '可选：group:<群号> 或 <QQ号>；缺省用最近一条入站消息的来源' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            changed: { type: 'boolean', required: true },
            branch: { type: 'string', required: true },
            stat: { type: 'string', required: true },
            files: { type: 'string', required: true },
            diff: { type: 'string', required: true },
            note: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: [
              value.changed ? `已在 ${value.branch} 提交一次改动` : '团队会话跑完了，但工作区没有产生改动',
              value.stat,
              value.note ? `说明：${value.note}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      },
      async execute(args) {
        if (!isOn('qq')) throw new Error('QQ 通道已在插件详情页关掉（dsh-toolkit 开关）')
        if (!isOn('qq', 'slot_tools')) throw new Error('「槽能力作为工具」已在插件详情页关掉（dsh-toolkit 开关）')
        const peer = toolPeer(args)
        const grant = slots.grantForPeer(peer, 'team')
        if (!grant) throw new Error(`对象 ${peer || '(未知)'} 没有绑定团队令牌；先 #keynew team <git 目录> 再 #bind`)
        const info = slots.teamWork(grant.token)
        if (!info.worktree) throw new Error(`团队令牌 ${grant.token} 暂时没有隔离工作区，先 #teamopen 建一个`)
        const instruction = String(args.instruction ?? '').trim()
        if (!instruction) throw new Error('instruction 不能为空')
        const c = await runTeamChange(grant, instruction)
        return {
          ok: true,
          changed: Boolean(c.changed),
          branch: String(c.branch ?? ''),
          stat: String(c.stat ?? ''),
          files: String(c.files ?? ''),
          diff: String(c.diff ?? ''),
          note: '',
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qq_waker',
      description:
        '管理 QQ 远程唤醒链路里 DSH 之外的那一半：常驻唤醒器（DSH 关着时收到 #start 就启动 DSH）与登录自启。action: install 安装并启动、status 查询状态、start/stop 启停唤醒器、uninstall 卸载。安装是幂等的，可重复执行。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: 'install | status | start | stop | uninstall',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            detail: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.detail }],
      },
      async execute(args) {
        if (!isOn('qq')) throw new Error('QQ 通道已在插件详情页关掉（dsh-toolkit 开关）')
        const action = String(args.action ?? 'status')
        const lines = wakerPowerShell(action)
        if (!lines) throw new Error(`未知 action: ${action}（可用 install / status / start / stop / uninstall）`)
        const raw = await runPowerShell(lines)
        if (action === 'status') {
          const stateMap = { Ready: '就绪', Running: '正在运行', Disabled: '已禁用', missing: '不存在' }
          const out = raw
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const p = line.split('|')
              if (p[0] === 'autostart') return `登录自启: ${p[1] === 'yes' ? '已设置' : '未设置'}`
              if (p[0] === 'procs') return `DSH 进程: ${p[1] === '0' ? '没在跑' : `${p[1]} 个`}`
              return `${p[0]}: ${stateMap[p[1]] ?? p[1]}｜上次结果 ${p[2]}｜上次运行 ${p[3]}`
            })
          return { ok: true, detail: out.join('\n') || '（无输出）' }
        }
        const done = {
          install: '已安装：DSH Waker（登录自启、常驻）、DSH Start（启动任务）、登录自启快捷方式；唤醒器已启动',
          uninstall: '已卸载：两个计划任务、登录自启快捷方式、隐藏启动脚本（waker.config.json 保留）',
          start: '唤醒器已启动',
          stop: '唤醒器已停止',
        }
        return { ok: true, detail: done[action] ?? (raw || '完成') }
      },
    }),
  )

  // ── 连接 ──────────────────────────────────────────────────────────────────
  const clientLog = {
    info: (m) => log(`[onebot info] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
    warn: (m) => log(`[onebot warn] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
    error: (m) => log(`[onebot error] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
  }

  let lastSelfId = ''
  let pairLinkSent = false
  let heartbeatTimer = null

  /** 等 webServer 注入完成并返回端口。 */
  async function waitWebPort() {
    for (let i = 0; i < 15 && !webServerRef; i++) await delay(200)
    const port = webServerRef && typeof webServerRef.port === 'number' ? webServerRef.port : 0
    if (!port) throw new Error('拿不到 web 服务端口（webserver 未就绪）')
    return port
  }

  /** DSH Web 自己对内广告的地址（loopback）。 */
  function advertisedUrl() {
    try {
      const webApp = ctx.get('webApp')
      const url = webApp && typeof webApp.getAdvertisedUrl === 'function' ? webApp.getAdvertisedUrl() : ''
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url
    } catch {
      /* 没有 webApp 服务就退回 loopback */
    }
    return `http://127.0.0.1:${webServerRef?.port ?? 0}/`
  }

  /**
   * 默认出口地址：向公网地址 connect 一个 UDP socket，读它绑定的本机地址（不发包）。
   * 这样拿到的是真正能上网那块网卡（通常是 WLAN），而不是虚拟网卡。
   */
  async function defaultRouteAddress() {
    const socket = createUdpSocket('udp4')
    try {
      await new Promise((resolve, reject) => {
        socket.once('error', reject)
        socket.connect(53, '223.5.5.5', () => resolve())
      })
      const addr = socket.address()
      return typeof addr?.address === 'string' && addr.address !== '0.0.0.0' ? addr.address : ''
    } catch {
      return ''
    } finally {
      try {
        socket.close()
      } catch {
        /* 已关闭 */
      }
    }
  }

  /** 挑一个手机能访问的本机 IPv4：默认出口地址优先，其次常见局域网段，最后任意地址。 */
  async function pickLanAddress() {
    const routed = await defaultRouteAddress()
    if (routed) return routed
    const list = []
    for (const entries of Object.values(networkInterfaces())) {
      for (const a of entries ?? []) {
        if (!a || a.family !== 'IPv4' || a.internal) continue
        list.push(a.address)
      }
    }
    const score = (ip) => {
      if (/^192\.168\./.test(ip)) return 0
      if (/^10\./.test(ip)) return 1
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return 3
      return 4
    }
    list.sort((a, b) => score(a) - score(b))
    return list[0] ?? ''
  }

  /**
   * 把一条进来的连接转发给 DSH Web，并把 Host / Origin 改写成 loopback 权威。
   *
   * 为什么必须改写：Web 服务的 Host/Origin 围栏只认它自己监听的权威，鉴权 cookie 也按
   * 权威命名与校验。手机用局域网地址访问时，只有改写后整条鉴权链才和本机浏览器一致。
   * 非升级请求补 Connection: close，保证一条连接只承载一个请求，不会漏改后续请求的 Host。
   */
  /** 判断是不是本机/局域网地址（IPv4 私有段、链路本地、IPv6 ULA）。 */
  function isLanAddress(ip) {
    const addr = String(ip || '').replace(/^::ffff:/, '')
    if (!addr) return false
    if (addr === '127.0.0.1' || addr === '::1') return true
    if (/^10\./.test(addr)) return true
    if (/^192\.168\./.test(addr)) return true
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return true
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(addr)) return true
    if (/^169\.254\./.test(addr)) return true
    if (/^f[cd][0-9a-f]{2}:/i.test(addr)) return true
    return false
  }

  function proxyConnection(socket, upstreamOf) {
    // 这个代理会把 Host/Origin 改写成 loopback 权威，等于让上游当成"本机访问"；
    // 所以只接局域网来源，别把公网流量也洗成 loopback。
    if (!isLanAddress(socket.remoteAddress)) {
      log(`[link] 拒绝非局域网来源 ${socket.remoteAddress}`)
      socket.destroy()
      return
    }
    // 端口按请求现取：webserver 重建会换端口，代理不能把创建那一刻的端口钉死
    const resolveUpstream = () => (typeof upstreamOf === 'function' ? upstreamOf() : upstreamOf)
    let buf = Buffer.alloc(0)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buf.length > 128 * 1024) socket.destroy()
        return
      }
      socket.removeListener('data', onData)
      const upstreamPort = resolveUpstream()
      const authority = `127.0.0.1:${upstreamPort}`
      const lines = buf.subarray(0, end).toString('latin1').split('\r\n')
      const rest = buf.subarray(end + 4)
      const isUpgrade = lines.some((l) => /^upgrade:/i.test(l))
      const out = [lines[0]]
      for (const line of lines.slice(1)) {
        if (/^host:/i.test(line)) out.push(`Host: ${authority}`)
        else if (/^origin:/i.test(line)) out.push(`Origin: http://${authority}`)
        else if (/^referer:/i.test(line)) out.push(line.replace(/^([a-z]+:\/\/)[^/]+/i, `$1${authority}`))
        else if (!isUpgrade && /^connection:/i.test(line)) continue
        else out.push(line)
      }
      if (isUpgrade) socket.setTimeout(0)
      else out.push('Connection: close')
      const upstream = createConnection({ host: '127.0.0.1', port: upstreamPort })
      upstream.on('connect', () => {
        upstream.write(Buffer.from(out.join('\r\n') + '\r\n\r\n', 'latin1'))
        if (rest.length) upstream.write(rest)
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
      upstream.on('error', () => socket.destroy())
      upstream.on('close', () => socket.destroy())
      socket.on('close', () => upstream.destroy())
    }
    socket.on('error', () => socket.destroy())
    socket.setTimeout(60000, () => socket.destroy())
    socket.on('data', onData)
  }

  let linkProxy = null
  let linkProxyStarting = null

  /** 起动（或复用）本机代理端口，返回 { port, upstreamPort }。 */
  async function ensureLinkProxy() {
    if (linkProxy) return linkProxy
    if (linkProxyStarting) return linkProxyStarting
    linkProxyStarting = (async () => {
      const upstreamPort = await waitWebPort()
      const port = Number(config.link_proxy_port) || 62566
      const server = createNetServer((socket) => proxyConnection(socket, () => webPortNow || upstreamPort))
      server.on('error', (err) => log(`[link] 代理出错: ${err instanceof Error ? err.message : String(err)}`))
      await new Promise((resolve, reject) => {
        const onError = (err) => reject(err)
        server.once('error', onError)
        server.listen(port, '0.0.0.0', () => {
          server.removeListener('error', onError)
          resolve()
        })
      })
      linkProxy = { server, port, upstreamPort }
      log(`[link] 本机代理 0.0.0.0:${port} -> 127.0.0.1:${upstreamPort}`)
      return linkProxy
    })()
    try {
      return await linkProxyStarting
    } finally {
      linkProxyStarting = null
    }
  }

  /** 本机代理 + 本次运行的启动令牌，拼出一条手机能直接打开的链接。 */
  async function localLink() {
    const proxy = await ensureLinkProxy()
    const raw = String(config.link_public_host ?? '').trim()
    let base
    if (/^https?:\/\//i.test(raw)) {
      base = raw.endsWith('/') ? raw : `${raw}/`
    } else {
      const host = raw || (await pickLanAddress())
      if (!host) throw new Error('找不到可用的局域网地址')
      const authority = host.includes(':') ? host : `${host}:${proxy.port}`
      base = `http://${authority}/`
    }
    let connection = null
    try {
      connection = ctx.get('connection')
    } catch {
      connection = null
    }
    const url =
      connection && typeof connection.authenticatedUrl === 'function' ? connection.authenticatedUrl(base) : base
    log(`[link] ${base} token=${connection && typeof connection.authenticatedUrl === 'function' ? 'yes' : 'no'}`)
    return { url, ttl: null, publicBase: new URL(base).host }
  }

  /**
   * 取一条远程链接：装了远程访问插件（cloudflare 隧道）就优先用它的公网链接，
   * 没装就退回本机代理链接（局域网地址 + 本机代理端口 + 本次运行的启动令牌）。
   */
  async function fetchPairLink() {
    try {
      const port = await waitWebPort()
      const body = config.pair_link_address ? JSON.stringify({ address: config.pair_link_address }) : '{}'
      const res = await fetch(`http://127.0.0.1:${port}/api/pair/issue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10000),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data && data.ok === true && typeof data.url === 'string') {
        const ttl =
          typeof data.expiresAt === 'number' ? Math.max(0, Math.round((data.expiresAt - Date.now()) / 1000)) : null
        return { url: data.url, ttl, publicBase: data.publicBaseUrl }
      }
      log(`[pair] 配对接口不可用（${res.status}），改用本机代理链接`)
    } catch (err) {
      log(`[pair] 远程访问插件不可用（${err instanceof Error ? err.message : String(err)}），改用本机代理链接`)
    }
    return localLink()
  }

  /** 探测本机端口是否可连（用来判断 NapCat 的 WS 是否在听）。 */
  /** NapCat 的 OneBot 端口：从 ws_url 里解析，解析不出来才回退 3001。 */
  function napcatPort() {
    try {
      const parsed = new URL(config.ws_url)
      const p = Number(parsed.port || (parsed.protocol === 'wss:' ? 443 : 80))
      return Number.isFinite(p) && p > 0 ? p : 3001
    } catch {
      return 3001
    }
  }

  function portOpen(port, timeout = 1200) {
    return new Promise((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port })
      let settled = false
      const done = (ok) => {
        if (settled) return
        settled = true
        try { socket.destroy() } catch { /* 忽略 */ }
        resolve(ok)
      }
      socket.setTimeout(timeout)
      socket.once('connect', () => done(true))
      socket.once('timeout', () => done(false))
      socket.once('error', () => done(false))
    })
  }

  /**
   * 同名进程是否已经在跑。
   * 为什么需要：NapCat 进程还在、只是 WS 端口没起时，spawn 会拉起第二个实例，
   * 同一个号两个客户端互踢 —— 用户看到的「隔一段时间被踢一次」就是这个。
   */
  function processRunning(exePath) {
    const base = String(exePath ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''
    if (!base) return Promise.resolve(false)
    return new Promise((resolve) => {
      execFile(
        'tasklist.exe',
        ['/FI', `IMAGENAME eq ${base}`, '/FO', 'CSV', '/NH'],
        { timeout: 8000, windowsHide: true },
        (err, stdout) => {
          if (err) return resolve(false)
          resolve(String(stdout ?? '').toLowerCase().includes(base.toLowerCase()))
        },
      )
    })
  }

  /**
   * 脱离父进程启动一个可执行文件（NapCat 桌面端）。
   * spawn 的失败是异步 'error' 事件（ENOENT 不会同步抛），所以返回 Promise<boolean>。
   */
  function spawnDetached(exePath) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(exePath, [], { detached: true, stdio: 'ignore' })
      } catch (err) {
        log(`[start] spawn 抛错: ${err instanceof Error ? err.message : String(err)}`)
        resolve(false)
        return
      }
      let settled = false
      const done = (ok, why) => {
        if (settled) return
        settled = true
        if (why) log(`[start] ${why}`)
        resolve(ok)
      }
      child.once('spawn', () => {
        try {
          child.unref()
        } catch {
          /* 忽略 */
        }
        // 进程起来了就算成功；之后又退掉由看门狗靠端口探测发现
        setTimeout(() => done(true), 1500).unref?.()
      })
      child.once('error', (err) => done(false, `spawn 出错: ${err.message}`))
    })
  }

  /** 连一次 OneBot；成功则绑定消息处理与 self_id 记录。 */
  async function startBot(attempts = 20) {
    if (bot) return true
    try {
      bot = await openTransport(config.transport ?? 'onebot', {
        url: config.ws_url,
        token: config.access_token,
        log: clientLog,
        reconnection: { enable: true, attempts, delay: 5000 },
      })
    } catch (err) {
      bot = null
      log(`[connect] 失败: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
    const remember = (event) => {
      const self = event?.self_id
      if (self) lastSelfId = String(self)
    }
    bot.on('message', (event) => {
      remember(event)
      void handleMessage(event)
    })
    if (typeof bot.on === 'function') {
      try { bot.on('meta_event', remember) } catch { /* 该实现可能只有 message */ }
    }
    log('[connect] ok, message handler bound')

    // 心跳：唤醒器靠它判断"插件还在不在"。
    // 只看进程数会误判 —— DSH 关掉后残留进程仍然存在，唤醒器会以为插件在，
    // 于是保持沉默，而实际没人回答，命令就石沉大海。
    const heartbeatPath = join(dshHome, 'qq-router-heartbeat')
    const beat = () => {
      try {
        writeFileSync(heartbeatPath, String(Date.now()), 'utf8')
      } catch {
        /* 心跳失败不致命 */
      }
    }
    beat()
    heartbeatTimer = setInterval(beat, 30000)
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()

    // 自动分享配对链接：DSH 每次重启后原来的链接就失效了，
    // 连上 QQ 时顺手发一条新的，手机上直接点开就能进。
    if (config.pair_link_autosend && !pairLinkSent) {
      pairLinkSent = true
      void (async () => {
        try {
          const { url, ttl } = await fetchPairLink()
          for (const uid of allow) {
            try {
              await sendText(uid, [url, ttl !== null ? `（${ttl} 秒内有效）` : ''].filter(Boolean).join('\n'))
            } catch {
              /* 某个白名单用户发不出去不影响其他 */
            }
          }
          log('[pair] 已自动发送配对链接')
        } catch (err) {
          log(`[pair] 自动发送失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      })()
    }
    return true
  }

  void startBot(20)

  // progress_secs > 0 就自动开进度推送（也可以在 QQ 用 #progress 临时开）
  if (Number(config.progress_secs) > 0) {
    startProgress(Math.max(10, Math.min(3600, Math.round(Number(config.progress_secs)))))
  }

  // ── 看门狗：WS 断了或 NapCat 没开时自动拉起并重连 ──────────────────────────
  // 为什么必须有：NapCat 一关 WS 就断，QQ 消息到不了插件，任何命令都收不到。
  // 所以"救活"不能靠命令，只能靠插件自己定时探测。
  let reviving = false
  let lastSpawnAt = 0

  async function botAlive() {
    if (!bot) return false
    if (typeof bot.send !== 'function') return true
    try {
      await Promise.race([
        bot.send('get_status', {}),
        new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 4000)),
      ])
      return true
    } catch (error) {
      // 两种失败必须分开：连接真断了（retcode 为 -1、超时）要重连；
      // 后端压根没实现 get_status（retcode 是别的业务码）说明 WS 好着，不能判死。
      // 不分的话，每 45 秒就会把一条正常连接 disconnect 一次再抢着连回来。
      const retcode = error?.response?.retcode
      if (typeof retcode === 'number' && retcode !== -1) {
        log(`[watchdog] 该后端不支持 get_status（retcode=${retcode}），按连接状态判活`)
        return true
      }
      log('[watchdog] 存活探测失败，判定 WS 已断')
      const dead = bot
      bot = null
      // onebot.js 开了 reconnection：不主动 disconnect，旧客户端会在后台继续重连，
      // 和新客户端并存时就是双连接、双回复。
      try {
        if (dead && typeof dead.disconnect === 'function') void dead.disconnect()
      } catch {
        /* 忽略 */
      }
      return false
    }
  }

  // 只有默认 onebot 后端、且配了 napcat_path，才谈得上"拉起 NapCat"。
  // 换成别的后端（Lagrange、自写适配器）时 NapCat 根本不存在，去 spawn 它只会把重连
  // 白白卡在 napcatPort() 的轮询里，直到 start_wait_secs 耗尽。
  function usesNapCat() {
    const name = String(config.transport ?? 'onebot').trim().toLowerCase()
    return name === 'onebot' && Boolean(String(config.napcat_path ?? '').trim())
  }

  async function revive() {
    if (reviving) return
    reviving = true
    try {
      if (await botAlive()) return
      const viaNapCat = usesNapCat()
      let spawned = false
      if (viaNapCat) {
        const portUp = await portOpen(napcatPort())
        if (!portUp) {
          // 默认不主动拉起：NapCat 是带界面的应用，spawn 会把它弹到前台，
          // 而且同一个号两个实例会互踢。要在插件详情页显式打开「NapCat 掉线自动拉起」才做。
          if (!isOn('qq', 'napcat_autostart')) {
            log('[watchdog] NapCat 没在听；自动拉起已在插件页关掉，只等它自己起来')
          } else if (await processRunning(config.napcat_path)) {
            log('[watchdog] NapCat 进程已在跑但端口没开，不重复拉起')
          } else if (Date.now() - lastSpawnAt > 5 * 60 * 1000) {
            lastSpawnAt = Date.now()
            const ok = await spawnDetached(config.napcat_path)
            spawned = ok
            log(`[watchdog] ${napcatPort()} 没在听，拉起 NapCat -> ${ok ? 'ok' : 'fail'}`)
          }
        }
      } else {
        log(`[watchdog] 后端 ${config.transport ?? 'onebot'} 不由 NapCat 承载，直接重连`)
      }
      const wait = Number(config.start_wait_secs) || 90
      const deadline = Date.now() + wait * 1000
      while (Date.now() < deadline) {
        await delay(3000)
        if (viaNapCat && !(await portOpen(napcatPort(), 1000))) continue
        if (await startBot(1)) {
          log('[watchdog] 已重连')
          for (const uid of allow) {
            try {
              await sendText(uid, `NapCat 断过，${spawned ? '已自动拉起并' : ''}重连${lastSelfId ? '（bot ' + lastSelfId + '）' : ''}`)
            } catch {
              /* 通知失败不影响重连 */
            }
          }
          return
        }
      }
      log('[watchdog] 本轮复活失败，下一轮再试')
    } finally {
      reviving = false
    }
  }

  const watchdogTimer = setInterval(() => { void revive() }, 45000)
  if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref()
  const reviveTimer = setTimeout(() => { void revive() }, 25000)
  if (typeof reviveTimer.unref === 'function') reviveTimer.unref()

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try {
        stopProgress()
        clearInterval(watchdogTimer)
        clearTimeout(reviveTimer)
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        try {
          rmSync(join(dshHome, 'qq-router-heartbeat'), { force: true })
        } catch {
          /* 删除失败不重要：mtime 过期后同样会被判为离线 */
        }
      } catch {
        /* 忽略 */
      }
      try {
        if (bot && typeof bot.disconnect === 'function') void bot.disconnect()
      } catch {
        /* 忽略卸载期错误 */
      }
      try {
        if (linkProxy?.server) linkProxy.server.close()
      } catch {
        /* 忽略关闭失败 */
      }
      linkProxy = null
      restartPending.clear()
      log('[dispose] disconnected')
    })
  }

  bridge = createQqBridge({
    log,
    status: () => ({
      connected: Boolean(bot),
      bound: boundQq,
      transport: config.transport ?? 'onebot',
      prefix,
      slotsEnabled: Boolean(config.slots_enabled),
    }),
    send: ({ peer, isGroup, text, quoteId }) => sendPeerText(peer, isGroup, text, quoteId),
    deliver: (event) => handleMessage(event),
  })
  const requests = createRequests({
    slots,
    log,
    applyChange: async ({ grant, text, peer }) => {
      const r = await runTeamChange(grant, text)
      if (!r.changed) {
        await sendText(boundQq, `外部改动请求（${grant.token}）：${peer} 的要求跑完了，工作区没有改动。`)
        return r
      }
      await sendText(
        boundQq,
        [
          `外部改动请求已提交（分支 ${r.branch}）：`,
          r.stat,
          r.files ? `文件：\n${r.files}` : '',
          `审阅：${prefix}gitdiff ${grant.token}；合并：${prefix}gitmerge 1 ${grant.token}；丢弃：${prefix}gitdiscard all ${grant.token}。`,
        ]
          .filter(Boolean)
          .join('\n'),
        { forceForward: true },
      )
      return r
    },
  })
  try {
    ctx.provide('dshToolkitQq', bridge)
    log('[bridge] 已暴露 dshToolkitQq 服务（deliver / send / onInbound / status）')
  } catch (err) {
    log(`[bridge] 暴露 dshToolkitQq 失败：${err instanceof Error ? err.message : String(err)}`)
  }

  return { broadcast, bridge, requests }
}
