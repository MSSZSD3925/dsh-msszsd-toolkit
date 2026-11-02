import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
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

writeFileSync(join(w.worktree, 'a.txt'), 'hello world\n')
writeFileSync(join(w.worktree, 'b.txt'), 'new file\n')
const commit = slots.commitTeam('改了 a 并新增 b')
if (!commit.changed) throw new Error('commitTeam said no change')
console.log('commit:', commit.branch, '| files:', commit.files.replace(/\n/g, ', '))

const d = slots.teamDiff()
console.log('diff head:', d.head.split('\n')[0])

console.log('merge:', slots.mergeTeam())
if (!readFileSync(join(repo, 'a.txt'), 'utf8').includes('hello world')) throw new Error('merge did not land')

console.log('drop:', slots.dropTeam())
console.log('TEAM_SLOT_OK')

rmSync(home, { recursive: true, force: true })
rmSync(repo, { recursive: true, force: true })
