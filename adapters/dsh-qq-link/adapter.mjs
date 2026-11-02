/**
 * dsh-qq-link → dsh-msszsd-toolkit 适配层（最小接口版本）。
 *
 * 背景：dsh-qq-link 自己会轮询 OneBot 11 的 get_friend_msg_history /
 * get_group_msg_history，然后把正文塞进它自己建的会话。dsh-msszsd-toolkit
 * 已经有完整的「QQ → 会话」那一半（路由、绑定号、槽、监管、媒体），两边都跑
 * 就会抢同一条消息、各回一遍。
 *
 * 这个适配层只做一件事：把 dsh-qq-link 收到的消息换成 dshToolkitQq 的形状交给
 * 我们，把我们的回复用它的 OneBot 客户端发出去；它自己那套建会话与 followup
 * 关掉不用。宿主里有 dshToolkitQq 服务时才生效，没有就原样退回它自己的行为。
 *
 * 用法（两步，不需要改它的核心）：
 *   1. 把本文件放进 dsh-qq-link 的 lib/ 下。
 *   2. 在它的 host.js 里「QQ → DSH」入口与「回话发送」两处各插一行调用
 *      （具体位置见 README「适配 dsh-qq-link」一节）。
 */

/** 群消息的 OneBot11 事件 → 我们认的形状 */
export function toBridgeEvent(event, { isGroup = false } = {}) {
  if (!event || typeof event !== 'object') throw new Error('toBridgeEvent 需要一个 OneBot11 事件对象')
  const groupId = isGroup ? String(event.group_id ?? '') : ''
  if (isGroup && !groupId) throw new Error('群消息缺少 group_id')
  const userId = String(event.user_id ?? '')
  if (!userId) throw new Error('消息缺少 user_id')
  const message = Array.isArray(event.message) ? event.message : []
  return {
    post_type: 'message',
    message_type: isGroup ? 'group' : 'private',
    sub_type: isGroup ? 'normal' : event.sub_type || 'friend',
    self_id: event.self_id,
    user_id: userId,
    ...(isGroup ? { group_id: groupId } : {}),
    message,
    raw_message: String(event.raw_message ?? ''),
    sender: event.sender ?? { user_id: userId },
    message_id: event.message_id,
  }
}

/** 我们的回复 → dsh-qq-link 发消息时要的参数（它自己调 send_private_msg / send_group_msg） */
export function toSendParams({ peer, isGroup = false, text, quoteId }) {
  if (!peer) throw new Error('toSendParams 需要 peer')
  const out = { message: String(text ?? '') }
  if (quoteId) out.message = [{ type: 'reply', data: { id: String(quoteId) } }, { type: 'text', data: { text: String(text ?? '') } }]
  if (isGroup) return { action: 'send_group_msg', params: { group_id: String(peer), ...out } }
  return { action: 'send_private_msg', params: { user_id: String(peer), ...out } }
}

/**
 * 装到 dsh-qq-link 的 ctx 上。返回 { active, deliver, send }：
 * active=false 表示本机没装 dsh-msszsd-toolkit，让它按原来的方式跑。
 */
export function installBridge(ctx, log = () => {}) {
  const bridge = ctx?.get?.('dshToolkitQq')
  if (!bridge || typeof bridge.deliver !== 'function') {
    log('[adapter] 没有 dshToolkitQq 服务，dsh-qq-link 走自己的会话')
    return { active: false, deliver: null, send: null }
  }
  log('[adapter] 已接管：消息交给 dshToolkitQq，回话走本插件的 OneBot 客户端')
  return {
    active: true,
    deliver: (event, opts) => bridge.deliver(toBridgeEvent(event, opts)),
    send: (payload) => bridge.send(payload),
  }
}
