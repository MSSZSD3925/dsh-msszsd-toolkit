// 给别的 DSH 插件用的 QQ 桥：把「QQ 消息进 DSH」和「DSH 说话回 QQ」这两件事
// 从 QQ 通道里露出来，别的通道插件（Telegram、官方 QQ 机器人、Satori 之类）可以：
//
//   1. deliver(event)  造一个 OneBot 11 形状的消息事件交给我们，走完整的绑定、路由、工具与监管；
//   2. send({ peer, isGroup, text, quoteId })  用我们的通道说话；
//   3. onInbound(fn)   观察所有入站消息（做日志、转发、统计都行）。
//
// 桥本身不认识 QQ 协议，所有动作都从外层注进来，方便单测。

export function createQqBridge({ send, deliver, status, log = () => {} }) {
  const inbound = new Set()

  const notifyInbound = (payload) => {
    for (const fn of [...inbound]) {
      try {
        fn(payload)
      } catch (err) {
        log(`[bridge] 订阅者出错：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  return {
    name: 'dshToolkitQq',
    notifyInbound,
    onInbound(fn) {
      if (typeof fn !== 'function') throw new Error('onInbound 需要一个函数')
      inbound.add(fn)
      return () => inbound.delete(fn)
    },
    async deliver(event) {
      if (!event || typeof event !== 'object') throw new Error('deliver 需要一个消息事件对象')
      if (!event.message_type) throw new Error('消息事件缺少 message_type（private / group）')
      // 打标：这条事件来自别的通道插件，已经由它的授权流程把关；
      // QQ 自己的事件不经过这里，所以绑定口令闸门对它仍然生效。
      await deliver({ ...event, __bridgeTrusted: true })
      return { ok: true }
    },
    async send({ peer, isGroup = false, text = '', quoteId = '' }) {
      const kind = isGroup || String(peer ?? '').startsWith('group:') ? 'group' : 'member'
      const target = String(peer ?? '').replace(/^(private|group):/, '')
      if (!target) throw new Error('send 需要 peer（QQ 号或群号）')
      await send({ peer: target, isGroup: kind === 'group', text: String(text ?? ''), quoteId: String(quoteId ?? '') })
      return { ok: true, peer: target, peerKind: kind }
    },
    status() {
      return { name: 'dshToolkitQq', ...status() }
    },
  }
}

export function normalizeInbound(event, media = []) {
  const group = event?.message_type === 'group'
  const segs = Array.isArray(event?.message) ? event.message : []
  const text = (Array.isArray(event?.message) ? segs : [])
    .filter((seg) => seg?.type === 'text')
    .map((seg) => String(seg?.data?.text ?? ''))
    .join('')
    .trim() || String(event?.raw_message ?? '').trim()
  return {
    source: 'qq',
    selfId: String(event?.self_id ?? ''),
    peer: String(group ? event?.group_id ?? '' : event?.user_id ?? ''),
    peerKind: group ? 'group' : 'member',
    sender: String(event?.user_id ?? ''),
    text,
    media,
    raw: event,
  }
}
