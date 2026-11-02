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

// 一个团队令牌 = 一个隔离工作区
const grant = slots.addTeamGrant(repo)
assert.match(grant.token, /^team-[a-z0-9]{6}$/)
const w = slots.teamWork(grant.token)
assert.equal(w.token, grant.token)
assert.ok(existsSync(w.worktree), '工作区应存在')
console.log('open:', grant.token, grant.branch)

// 绑定：同一个令牌绑给一个对象
const b = slots.bindByToken(grant.token, '10002', 'member')
assert.ok(b.ok, b.msg)
assert.equal(slots.confirmBind('10002', b.challenge).ok, true)
assert.equal(slots.grantForPeer('10002', 'team')?.token, grant.token)

// 两次独立改动，各自一条提交
writeFileSync(join(w.worktree, 'a.txt'), 'hello one\n')
const commit1 = slots.commitTeam('第一处改动', grant.token)
assert.equal(commit1.changed, true, commit1.msg)
writeFileSync(join(w.worktree, 'c.txt'), 'c\n')
const commit2 = slots.commitTeam('第二处改动', grant.token)
assert.equal(commit2.changed, true, commit2.msg)

const two = slots.teamCommits(commit1.branch, grant.token)
assert.equal(two.length, 2, `期望两条提交，实际 ${two.length}`)
assert.match(two[0].subject, /第一处改动/)
assert.match(two[1].subject, /第二处改动/)
console.log('ok  连续两次改动各成一条提交')

// 工作目录还在时不允许直接丢改动
assert.match(slots.discardTeam('1', grant.token), /先发 #gitdrop/)
console.log('ok  工作目录存在时拒绝丢改动')

// 只删工作目录：改动必须还在分支上
const dropMsg = slots.dropTeam(grant.token)
assert.equal(existsSync(w.worktree), false, '工作目录应该被删掉')
assert.match(dropMsg, /改动都还在/)
assert.equal(slots.teamCommits(commit1.branch, grant.token).length, 2, 'drop 后分支上的改动应保留')
assert.equal(slots.grantForPeer('10002', 'team')?.token, grant.token, '令牌还在，只是没有工作区')
console.log('ok  删工作目录保留改动')

// 按编号丢掉第一条，第二条保留
const discardMsg = slots.discardTeam('1', grant.token)
assert.match(discardMsg, /还剩 1 条/)
const left = slots.teamCommits(commit1.branch, grant.token)
assert.equal(left.length, 1)
assert.match(left[0].subject, /第二处改动/)
console.log('ok  按编号丢掉一条，其余保留')

// 合并剩下的那条：a.txt 应保持原样，c.txt 出现
slots.mergeTeam('1', grant.token)
assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8').trim(), 'hello', '被丢掉的改动不能被合并进去')
assert.equal(readFileSync(join(repo, 'c.txt'), 'utf8').trim(), 'c')
console.log('ok  合并保留的改动')

console.log('TEAM_SLOT_OK')

rmSync(home, { recursive: true, force: true })
rmSync(repo, { recursive: true, force: true })
