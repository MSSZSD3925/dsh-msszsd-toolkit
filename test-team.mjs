import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert'
import { createSlots } from './lib/slots.js'

const home = mkdtempSync(join(tmpdir(), 'slots-home-'))
const repo = mkdtempSync(join(tmpdir(), 'slots-repo-'))
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
const commitArgs = ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q']

git(repo, ['init', '-q', '-b', 'main'])
writeFileSync(join(repo, 'a.txt'), 'hello\n')
git(repo, ['add', 'a.txt'])
git(repo, [...commitArgs, '-m', 'add a'])

const guard = { note: () => ({ blocked: false, hit: false, labels: [] }) }
const slots = createSlots({ dshHome: home, log: () => {}, llm: null, defaultModel: null, guard })

const open = slots.askOpenTeam(repo)
const r1 = slots.confirmPending(open.confirm)
console.log('open:', r1.kind, r1.branch)
const w = slots.teamWork()

const t = slots.issueKey('team')
const taken = slots.takeKey(t)
if (!taken || taken.slot !== 'team') throw new Error('takeKey team failed')
const b = slots.bindTeam('10002')
const c = slots.confirmBindTeam('10002', b.challenge)
if (!c.ok || slots.teamPeer() !== '10002') throw new Error('bind team failed')

// 两次独立改动，各自一条提交
writeFileSync(join(w.worktree, 'a.txt'), 'hello one\n')
const commit1 = slots.commitTeam('第一处改动')
assert.equal(commit1.changed, true)
writeFileSync(join(w.worktree, 'c.txt'), 'c\n')
const commit2 = slots.commitTeam('第二处改动')
assert.equal(commit2.changed, true)

const two = slots.teamCommits()
assert.equal(two.length, 2, `期望两条提交，实际 ${two.length}`)
assert.match(two[0].subject, /第一处改动/)
assert.match(two[1].subject, /第二处改动/)
console.log('ok  连续两次改动各成一条提交')

// 工作目录还在时不允许直接丢改动
assert.match(slots.discardTeam('1'), /先发 #teamdrop/)
console.log('ok  工作目录存在时拒绝丢改动')

// 只删工作目录：改动必须还在分支上
const dropMsg = slots.dropTeam()
assert.equal(existsSync(w.worktree), false, '工作目录应该被删掉')
assert.match(dropMsg, /改动都还在/)
assert.equal(slots.teamCommits().length, 2, 'drop 后分支上的改动应保留')
console.log('ok  删工作目录保留改动')

// 按编号丢掉第一条，第二条保留
const discardMsg = slots.discardTeam('1')
assert.match(discardMsg, /还剩 1 条/)
const left = slots.teamCommits()
assert.equal(left.length, 1)
assert.match(left[0].subject, /第二处改动/)
console.log('ok  按编号丢掉一条，其余保留')

// 合并剩下的那条：a.txt 应保持原样，c.txt 出现
slots.mergeTeam()
assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8').trim(), 'hello', '被丢掉的改动不能被合并进去')
assert.equal(readFileSync(join(repo, 'c.txt'), 'utf8').trim(), 'c')
console.log('ok  合并保留的改动')

console.log('TEAM_SLOT_OK')

rmSync(home, { recursive: true, force: true })
rmSync(repo, { recursive: true, force: true })
