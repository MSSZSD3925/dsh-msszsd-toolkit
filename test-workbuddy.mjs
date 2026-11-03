import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { buildWorkbuddyArgs, parseWorkbuddyOutput, createWorkbuddy, DEFAULT_MODEL } from './lib/workbuddy.js'

// 1. 参数顺序与非交互模式
const args = buildWorkbuddyArgs({ script: 'C:/x/workbuddy.sh', prompt: '改一下 README', model: '' })
assert.equal(args[0], 'C:/x/workbuddy.sh')
assert.deepEqual(args.slice(1, 4), ['-p', '改一下 README', '-y'])
assert.equal(args.includes('--output-format'), true)
assert.equal(args[args.indexOf('--model') + 1], DEFAULT_MODEL)
assert.throws(() => buildWorkbuddyArgs({ script: '', prompt: 'x' }), /workbuddy 脚本路径/)
assert.throws(() => buildWorkbuddyArgs({ script: 'a', prompt: '  ' }), /任务描述是空的/)

// 2. 输出解析：正常、夹带噪声、错误、非 JSON
const ok = parseWorkbuddyOutput(JSON.stringify({ result: '已改好', num_turns: 3, modelUsage: { model: 'deepseek-v4.1-flash' } }))
assert.deepEqual([ok.ok, ok.result, ok.numTurns, ok.model], [true, '已改好', 3, 'deepseek-v4.1-flash'])
assert.equal(parseWorkbuddyOutput('log line\n{"result":"ok"}\n').result, 'ok')
assert.equal(parseWorkbuddyOutput(JSON.stringify({ is_error: true, result: '失败' })).ok, false)
assert.throws(() => parseWorkbuddyOutput('not json'), /不是 JSON/)

// 3. 跑一次假进程
function fakeChild({ stdout = '', stderr = '', code = 0 }) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', stdout)
    if (stderr) child.stderr.emit('data', stderr)
    child.emit('close', code)
  })
  return child
}

let captured = null
const spawnFn = (cmd, argv, opts) => {
  captured = { cmd, argv, opts }
  return fakeChild({ stdout: JSON.stringify({ result: 'done', num_turns: 2 }) })
}
const wb = createWorkbuddy({ config: { workbuddy_script: '/tmp/wb.sh', workbuddy_timeout_ms: 1000 }, spawnFn })
assert.equal(wb.ready, true)
const out = await wb.run({ cwd: '/tmp/repo', prompt: '把 a.txt 改一下' })
assert.equal(out.ok, true)
assert.equal(out.result, 'done')
assert.equal(captured.cmd, 'bash')
assert.equal(captured.argv[0], '/tmp/wb.sh')
assert.equal(captured.opts.cwd, '/tmp/repo')
assert.equal(captured.opts.timeout, 1000)

// 4. 非零退出码要抛错
const failWb = createWorkbuddy({
  config: { workbuddy_script: '/tmp/wb.sh' },
  spawnFn: () => fakeChild({ stderr: 'boom', code: 2 }),
})
await assert.rejects(failWb.run({ cwd: '/tmp', prompt: 'x' }), /退出码 2/)

// 5. 没配脚本时 ready=false，run 抛错
const empty = createWorkbuddy({ config: {} })
assert.equal(empty.ready, false)
await assert.rejects(empty.run({ cwd: '/tmp', prompt: 'x' }), /workbuddy 脚本路径/)

console.log('WORKBUDDY_TESTS_OK')
