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
assert.equal(MODULE_META.length, 5)
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
const slots = MODULE_META.find(function (m) { return m.name === 'qq' }).subs.find(function (s) { return s.key === 'slots' })
assert.equal(slots.danger, true)
console.log('ok  危险子功能带 danger 标记')

rmSync(home, { recursive: true, force: true })
console.log('TOGGLES_TESTS_OK')
