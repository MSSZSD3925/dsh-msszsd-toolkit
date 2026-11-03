/**
 * 把「实际改动」交给 WorkBuddy 官方 CLI（腾讯 CodeBuddy Code）执行。
 *
 * 只用它的非交互模式（workbuddy.sh 是壳脚本，内部调 codebuddy）：
 *   bash <script> -p "<任务>" -y --model <id> --output-format json
 * 结果在 stdout 的 JSON 里，答案在 result 字段。
 *
 * 这一层只负责拼参数、限时、解析输出，不判断业务。
 */
import { spawn } from 'node:child_process'

export const DEFAULT_MODEL = 'deepseek-v4.1-flash'
const DEFAULT_TIMEOUT_MS = 600_000

export function buildWorkbuddyArgs({ script, prompt, model }) {
  if (!script) throw new Error('没有配置 workbuddy 脚本路径（qq.workbuddy_script）')
  if (!prompt || !String(prompt).trim()) throw new Error('任务描述是空的')
  return [
    String(script),
    '-p',
    String(prompt),
    '-y',
    '--model',
    String(model || DEFAULT_MODEL),
    '--output-format',
    'json',
  ]
}

export function parseWorkbuddyOutput(stdout) {
  const text = String(stdout ?? '').trim()
  if (!text) throw new Error('WorkBuddy 没有输出')
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        data = JSON.parse(text.slice(start, end + 1))
      } catch {
        data = null
      }
    }
  }
  if (!data) throw new Error(`WorkBuddy 输出不是 JSON：${text.slice(0, 300)}`)
  return {
    ok: data.is_error !== true && data.subtype !== 'error',
    result: typeof data.result === 'string' ? data.result : '',
    model: data.modelUsage?.model ?? data.model ?? '',
    numTurns: data.num_turns ?? null,
  }
}

export function createWorkbuddy({ config, log = () => {}, spawnFn = spawn }) {
  const script = String(config?.workbuddy_script ?? '').trim()
  const model = String(config?.workbuddy_model ?? '').trim() || DEFAULT_MODEL
  const timeoutMs =
    Number(config?.workbuddy_timeout_ms) > 0 ? Number(config.workbuddy_timeout_ms) : DEFAULT_TIMEOUT_MS

  return {
    model,
    script,
    ready: Boolean(script),
    async run({ cwd, prompt }) {
      const args = buildWorkbuddyArgs({ script, prompt, model })
      log(`[workbuddy] 开始 model=${model} cwd=${cwd} prompt=${String(prompt).slice(0, 80)}`)
      const stdout = await runBash({ args, cwd, timeoutMs, spawnFn })
      const out = parseWorkbuddyOutput(stdout)
      log(`[workbuddy] 结束 ok=${out.ok} turns=${out.numTurns ?? '-'}`)
      return out
    },
  }
}

function runBash({ args, cwd, timeoutMs, spawnFn }) {
  return new Promise((resolve, reject) => {
    const child = spawnFn('bash', args, {
      cwd,
      windowsHide: true,
      timeout: timeoutMs,
      env: { ...process.env, NO_COLOR: '1' },
    })
    let out = ''
    let err = ''
    child.stdout?.on('data', (chunk) => {
      out += chunk
    })
    child.stderr?.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`WorkBuddy 退出码 ${code}：${(err || out).slice(0, 500)}`))
    })
  })
}
