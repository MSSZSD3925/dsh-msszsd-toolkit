import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createSlots, normalizePath, permOf } from './lib/slots.js'

const root = mkdtempSync(join(tmpdir(), 'keylink-'))
const home = join(root, 'home')
const repoA = join(root, 'repo-a')
const repoB = join(root, 'repo-b')
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })

for (const [repo, file] of [[repoA, 'a.txt'], [repoB, 'b.txt']]) {
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', repo])
  writeFileSync(join(repo, file), `${file}\n`)
  execFileSync('git', ['-C', repo, 'add', '-A'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'])
}

let captured = ''
const llm = {
  async *stream(options) {
    captured = JSON.stringify(options.messages)
    yield { type: 'text-delta', text: '好的' }
  },
}
const slots = createSlots({
  dshHome: home,
  log: () => {},
  llm,
  defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  guard: { note: () => ({ hit: false, blocked: false }) },
})

// 同一目录读 + 写 -> 自动合并成双权限，只留一条令牌
const shareA = slots.addShareGrant(repoA)
const teamA = slots.addTeamGrant(repoA)
const b1 = slots.bindByToken(shareA.token, '9001')
assert.equal(b1.ok, true)
assert.equal(slots.confirmBind('9001', b1.challenge, { owner: true }).ok, true)
const b2 = slots.bindByToken(teamA.token, '9001')
assert.equal(b2.ok, true, '同一对象可以再绑一个令牌')
const r2 = slots.confirmBind('9001', b2.challenge, { owner: true })
assert.equal(r2.ok, true)
const merged = slots.grantsOf('both').filter((g) => g.peer === '9001')
assert.equal(merged.length, 1, '同目录合并成一条双权限令牌')
assert.equal(merged[0].token, shareA.token, '保留先绑的那条令牌')
assert.deepEqual(permOf(merged[0]), { read: true, write: true })
console.log('ok 同目录自动合并')

// 不同目录可以并存
const shareB = slots.addShareGrant(repoB)
const b3 = slots.bindByToken(shareB.token, '9001')
assert.equal(b3.ok, true)
assert.equal(slots.confirmBind('9001', b3.challenge, { owner: true }).ok, true)
const mine = [...new Set(slots.grantsOf('both').concat(slots.grantsOf('share')).filter((g) => g.peer === '9001').map((g) => g.token))]
assert.equal(mine.length, 2, '同一对象可以同时持有多个目录')
console.log('ok 多 key 并存')

// keylink 列表与编辑
const list = slots.keylinkList('9001')
assert.match(list, /both|双权限|读\+写/)
assert.match(list, /share-|both-/)
const removed = slots.keylinkSet('9001', '2', 'off')
assert.match(removed, /已移除/)
assert.equal(new Set(slots.grantsOf('both').concat(slots.grantsOf('share')).filter((g) => g.peer === '9001').map((g) => g.token)).size, 1, 'keylink off 只移除选中的那条')
console.log('ok keylink 列表与移除')

// 答问会合并该对象所有可读目录
const res = await slots.answerShare({ peer: '9001', question: '这里有什么' })
assert.equal(res.refused, false)
assert.ok(res.dirs.length >= 1)
assert.ok(captured.includes('a.txt') || captured.includes('b.txt'))
console.log('ok 多目录合并作答')

// 路径归一化
assert.equal(normalizePath(' "D:\\项目\\资料" '), 'D:\\项目\\资料')
assert.equal(normalizePath('Ｃ'), 'Ｃ')
assert.equal(normalizePath('a／b'), 'a/b')
console.log('ok 中文路径归一化')

rmSync(root, { recursive: true, force: true })
console.log('KEYLINK_TESTS_OK')
