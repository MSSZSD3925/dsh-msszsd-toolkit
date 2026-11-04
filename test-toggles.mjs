import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert'

const home = mkdtempSync(join(tmpdir(), 'toggles-home-'))
process.env.DSH_HOME = home

const { readToggles, isOn, setToggle, MODULE_META } = await import('./lib/toggles.js')

// 缺文件 = 全开、子功能全开
assert.equal(isOn('qq'), true)
assert.equal(isOn('qq', 'sticker'), true)
const moduleIds = MODULE_META.map((m) => m.name)
assert.equal(moduleIds.length, 6)
for (const id of ['qq', 'session_ask', 'pause', 'restart', 'peak']) {
  assert.ok(moduleIds.includes(id), `缺少模块 ${id}`)
}
console.log('ok  缺文件默认全开')

// 关一个子功能，不影响模块与其他子功能
setToggle('qq', false, 'inbound_media')
assert.equal(isOn('qq'), true)
assert.equal(isOn('qq', 'inbound_media'), false)
assert.equal(isOn('qq', 'sticker'), true)
console.log('ok  子功能独立开关')

// 关模块后子功能一律视为关
setToggle('qq', false)
assert.equal(isOn('qq'), false)
assert.equal(isOn('qq', 'sticker'), false)
setToggle('qq', true)
assert.equal(isOn('qq'), true)
assert.equal(isOn('qq', 'inbound_media'), false, '模块重开后子功能保持原样')
console.log('ok  模块开关与子功能叠加')

// 未知名字当开，不会因为拼错把功能禁掉
assert.equal(isOn('nope'), true)
assert.equal(isOn('qq', 'nope'), true)
assert.throws(function () { setToggle('nope', false) })
assert.throws(function () { setToggle('qq', false, 'nope') })
console.log('ok  未知名字当开、写入报错')

// 旧形状（平铺布尔）仍能读
const { writeFileSync } = await import('node:fs')
writeFileSync(join(home, 'dsh-toolkit-toggles.json'), JSON.stringify({ session_ask: false, pause: true }))
assert.equal(isOn('session_ask'), false)
assert.equal(isOn('session_ask', 'context_guard'), false)
assert.equal(isOn('pause'), true)
console.log('ok  兼容旧平铺形状')

// 危险子功能有标记
const qqSubs = MODULE_META.find(function (m) { return m.name === 'qq' }).subs
assert.equal(qqSubs.find(function (s) { return s.key === 'share_slot' }).danger, true)
assert.equal(qqSubs.find(function (s) { return s.key === 'team_slot' }).danger, true)
// 适配提示词两类是各自独立的危险开关
assert.equal(qqSubs.find(function (s) { return s.key === 'adapter_dsh' }).danger, true)
assert.equal(qqSubs.find(function (s) { return s.key === 'adapter_im' }).danger, true)
writeFileSync(
  join(home, 'dsh-toolkit-toggles.json'),
  JSON.stringify({ qq: { enabled: true, sub: { adapter_im: false } } }),
)
assert.equal(isOn('qq', 'adapter_dsh'), true, '两类适配开关互不影响')
assert.equal(isOn('qq', 'adapter_im'), false)

// 旧键 qq.slots=false 必须同时关掉两个槽
writeFileSync(join(home, 'dsh-toolkit-toggles.json'), JSON.stringify({ qq: { enabled: true, sub: { slots: false } } }))
assert.equal(isOn('qq', 'share_slot'), false)
assert.equal(isOn('qq', 'team_slot'), false)
assert.equal(isOn('qq', 'sticker'), true)
console.log('ok  旧 slots 键拆到两个槽')

// 三态项：默认「提交」，off 视为关，direct 仍算开；非法值回默认
const toggles = await import('./lib/toggles.js')
const qqMod = MODULE_META.find(function (m) { return m.name === 'qq' })
const hw = qqMod.subs.find(function (s) { return s.key === 'group_host_write' })
assert.equal(hw.kind, 'choice')
assert.deepEqual(hw.choices.map(function (c) { return c.value }), ['off', 'commit', 'direct'])
writeFileSync(join(home, 'dsh-toolkit-toggles.json'), JSON.stringify({ qq: { enabled: true, sub: {} } }))
assert.equal(toggles.subValue('qq', 'group_host_write'), 'commit', '默认提交')
assert.equal(isOn('qq', 'group_host_write'), true)
writeFileSync(join(home, 'dsh-toolkit-toggles.json'), JSON.stringify({ qq: { enabled: true, sub: { group_host_write: 'off' } } }))
assert.equal(isOn('qq', 'group_host_write'), false)
assert.match(toggles.offReason('qq', 'group_host_write'), /禁止/)
setToggle('qq', 'direct', 'group_host_write')
assert.equal(toggles.subValue('qq', 'group_host_write'), 'direct')
assert.equal(isOn('qq', 'group_host_write'), true)
assert.throws(function () { setToggle('qq', 'write', 'group_host_write') })
writeFileSync(join(home, 'dsh-toolkit-toggles.json'), JSON.stringify({ qq: { enabled: true, sub: { group_host_write: '乱写' } } }))
assert.equal(toggles.subValue('qq', 'group_host_write'), 'commit', '非法值回默认')
console.log('ok  三态项：禁止 / 提交 / 直写')

// 二级分组：qq 声明了分组，每个子功能都归属其中一组
const groupIds = qqMod.groups.map(function (g) { return g.id })
assert.deepEqual(groupIds, ['messages', 'tools', 'slots', 'host', 'adapters'])
for (const sub of qqMod.subs) assert.ok(groupIds.includes(sub.group), sub.key + ' 缺少分组')
console.log('ok  QQ 子功能都归到二级分组')
console.log('ok  危险子功能带 danger 标记（分享槽/团队槽各自标记）')

rmSync(home, { recursive: true, force: true })
console.log('TOGGLES_TESTS_OK')
