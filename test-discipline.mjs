import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = await mkdtemp(join(process.env.TEMP || tmpdir(), 'dsh-disc-'))
process.env.DSH_HOME = home

const disc = await import('./lib/discipline.js')
const toggles = await import('./lib/toggles.js')

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0)
const day = (d) => (d.getDay() === 0 ? 7 : d.getDay())

// 1. 时钟解析
assert.equal(disc.parseClock('09:00'), 540)
assert.equal(disc.parseClock('9：5'), 545, '全角冒号与一位分钟也要认')
assert.equal(disc.parseClock('24:00'), null)
assert.equal(disc.fmtClock(540), '09:00')
assert.equal(disc.fmtClock(1440 + 30), '00:30')

// 2. 规则窗口：工作日 9:00-18:00
const workday = { label: 't', target: 'session_ask', from: '09:00', to: '18:00', days: [1, 2, 3, 4, 5], enabled: true, id: 'r1' }
assert.equal(disc.ruleAllows(workday, at(2026, 11, 2, 10, 0)), true, '周一 10:00 应允许')
assert.equal(disc.ruleAllows(workday, at(2026, 11, 2, 8, 59)), false, '周一 08:59 应被挡')
assert.equal(disc.ruleAllows(workday, at(2026, 11, 2, 18, 0)), false, '终点不包含')
assert.equal(disc.ruleAllows(workday, at(2026, 11, 7, 10, 0)), false, '周六应被挡')

// 3. 跨夜窗口 22:00-06:00
const night = { label: 'n', target: 'qq.tools', from: '22:00', to: '06:00', days: [], enabled: true, id: 'r2' }
assert.equal(disc.ruleAllows(night, at(2026, 11, 2, 23, 30)), true)
assert.equal(disc.ruleAllows(night, at(2026, 11, 2, 3, 0)), true)
assert.equal(disc.ruleAllows(night, at(2026, 11, 2, 12, 0)), false)

// 4. 自然语言解析
const d1 = disc.parseRule('每天 9:00 到 18:00 才允许跨会话提问')
assert.equal(d1.target, 'session_ask')
assert.equal(d1.from, '09:00')
assert.equal(d1.to, '18:00')
assert.deepEqual(d1.days, [])

const d2 = disc.parseRule('工作日 9点到18点 才允许 QQ 互动工具')
assert.equal(d2.target, 'qq.tools')
assert.deepEqual(d2.days, [1, 2, 3, 4, 5])
assert.equal(d2.from, '09:00')

const d3 = disc.parseRule('周末全天禁止团队槽')
assert.equal(d3.target, 'qq.team_slot')
assert.deepEqual(d3.days, [6, 7])

assert.throws(() => disc.parseRule('帮我管紧一点'), /没找到时段/)
assert.throws(() => disc.parseRule(''), /先写一句描述/)

// 5. 状态读写 + 总开关
let state = disc.writeDiscipline({ enabled: true, rules: [workday] })
assert.equal(state.enabled, true)
assert.equal(disc.readDiscipline().rules.length, 1)
assert.equal(disc.disciplineAllows('session_ask', undefined, at(2026, 11, 2, 10, 0)), true)
assert.equal(disc.disciplineAllows('session_ask', undefined, at(2026, 11, 2, 22, 0)), false)
assert.match(disc.disciplineBlockedReason('session_ask', undefined, at(2026, 11, 2, 22, 0)), /强纪律/)

// 通配规则能挡所有模块
disc.writeDiscipline({ enabled: true, rules: [{ id: 'star', label: '全体', target: '*', from: '09:00', to: '18:00', days: [] }] })
assert.equal(disc.disciplineAllows('qq', undefined, at(2026, 11, 2, 12, 0)), true)
assert.equal(disc.disciplineAllows('peak', undefined, at(2026, 11, 2, 21, 0)), false)

// 关掉强纪律后一处都不挡
disc.setDisciplineEnabled(false)
assert.equal(disc.disciplineAllows('qq', undefined, at(2026, 11, 2, 21, 0)), true)

// 6. 增删改
disc.setDisciplineEnabled(true)
disc.writeDiscipline({ enabled: true, rules: [] })
disc.addRule({ label: 'a', target: 'restart', from: '09:00', to: '10:00' })
disc.addRule({ label: 'b', target: 'pause', from: '11:00', to: '12:00' })
assert.equal(disc.readDiscipline().rules.length, 2)
const idb = disc.readDiscipline().rules.find((r) => r.label === 'b').id
disc.setRuleEnabled(idb, false)
assert.equal(disc.readDiscipline().rules.find((r) => r.label === 'b').enabled, false)
disc.removeRule(idb)
assert.equal(disc.readDiscipline().rules.length, 1)
assert.throws(() => disc.removeRule('nope'), /没有这条规则/)

// 7. 与 toggles 的联动：总开关关掉时不改任何开关结果
disc.setDisciplineEnabled(false)
await writeFile(join(home, 'dsh-toolkit-toggles.json'), JSON.stringify({ qq: true }), 'utf8')
assert.equal(toggles.isOn('qq', 'tools'), true)
toggles.setToggle('qq', false, 'tools')
assert.equal(toggles.isOn('qq', 'tools'), false)
assert.match(toggles.offReason('qq', 'tools'), /关掉/)

// 8. 状态文件快照
const status = disc.disciplineStatus(at(2026, 11, 2, 12, 0))
assert.equal(status.path, join(home, 'dsh-toolkit-discipline.json'))
assert.ok(status.targets.length >= 5)
assert.equal(status.weekday, '周一')

await rm(home, { recursive: true, force: true })
console.log('DISCIPLINE_TESTS_OK')
