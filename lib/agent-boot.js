/**
 * 拿到一个【已有会话】的 agent 实例：内存里活着就直接用，没活着就 resume 回来。
 *
 * qq.js（QQ 远程驾驶）与 session-ask.js（跨会话提问）都要做这件事，做法必须一致，
 * 否则会出现"同一个会话在两条路径上状态不同"的问题。这里保留 qq.js 原来的全部判据，
 * 原因写在下面每个分支旁边。
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import { resolveResumeAgentOptions } from './restart.js'

/**
 * @param {object} options
 * @param {object} options.ctx    插件 context（用于取 agentPresets）
 * @param {object} options.agents agents 服务
 * @param {(msg: string) => void} [options.log]
 */
export function createAgentBoot({ ctx, agents, log = () => {} } = {}) {
  /**
   * 解析默认 Agent 预设，并给出发布前挂载它的 setup 回调（与 GUI 的 composeAgent 同形）。
   * agentPresets 服务不存在时返回 undefined，调用方退化成不带预设。
   */
  async function composePresetSetup() {
    const presets = ctx?.get?.('agentPresets')
    if (!presets || typeof presets.resolve !== 'function' || typeof presets.mount !== 'function') return undefined
    try {
      const resolved = await presets.resolve(undefined)
      return {
        agentPreset: resolved.id,
        setup: async (agentCtx) => {
          await presets.mount(agentCtx, resolved.id)
        },
      }
    } catch (err) {
      log(`[agent] 预设解析失败，按无预设继续：${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }

  async function acquireAgent(sessionId) {
    const sid = SessionId(sessionId)
    let handle = null
    try {
      handle = agents.get(sid)
    } catch (err) {
      log(`[agent] get 抛错: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!handle) {
      log(`[agent] resume ${sessionId}`)
      // resume 不带 agentOptions 时，被恢复 agent 的 provider/model 是空的，
      // 提示词里的 {{model}} 在组装阶段取不到值，这一轮直接报错；而且这个空 options 的 agent
      // 会留在进程里，之后在 GUI 里给同一会话发消息也照样报错，看起来就是"卡死"。
      // 所以一定要用界面当前选中的模型去 resume。
      const agentOptions = await resolveResumeAgentOptions({ ctx, agents }, log)
      if (!agentOptions) {
        log(`[agent] 拿不到模型选择，拒绝 resume ${sessionId}`)
        throw new Error('拿不到可用的模型选择，无法恢复这个会话（先在 DSH 里选好模型再试）')
      }
      log(`[agent] resume 使用的模型：${agentOptions.provider}/${agentOptions.model}`)
      // 与 GUI 恢复会话保持一致：把默认预设也挂回去，否则被恢复的 agent 只有裸工具集，
      // 预设贡献的系统提示段和工具都缺席。拿不到预设服务时退化成只带模型。
      const preset = await composePresetSetup()
      // 新版 AgentLoop 的 resume 读的是 options.resumeSessionId；
      // 传 sessionId 会让内部按 undefined 取长度而抛 "Cannot read properties of undefined (reading 'length')"。
      // 两个键都传，兼容新旧版本。
      handle = await agents.resume({
        resumeSessionId: sid,
        sessionId: sid,
        agentOptions,
        ...(preset ? { setup: preset.setup } : {}),
      })
    }
    return handle
  }

  return { acquireAgent, composePresetSetup }
}

/** agent 是否在跑（status 优先，退回 phase.kind）。qq.js 与 session-ask.js 共用同一判据。 */
export function isRunningAgent(agent) {
  if (!agent) return false
  if (typeof agent.status === 'string') return agent.status === 'running'
  const phase = agent.phase
  const kind = typeof phase === 'string' ? phase : phase?.kind
  return !/^(idle|maintenance)$/.test(String(kind ?? ''))
}
