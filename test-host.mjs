import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
// 临时目录放在仓库里：沙箱下系统临时目录会 EPERM
import { join } from 'node:path'
import { createHost } from './lib/host.js'

const dir = mkdtempSync(join(process.cwd(), '.host-test-'))
let failed = 0
function ok(cond, label) {
  if (cond) return
  failed++
  console.log('FAIL', label)
}

try {
  const host = createHost({ dshHome: dir })

  ok(host.isEnabled('123456') === false, '默认没有开启任何群')
  const r1 = host.enable('123456')
  ok(r1.created === true, '第一次开启 created')
  ok(host.isEnabled('123456') === true, '开启后 isEnabled')
  ok(host.enable('123456').created === false, '重复开启不重复创建')

  ok(host.setSession('123456', 'session-abc12345def') === true, '写入会话')
  ok(host.entry('123456').sessionId === 'session-abc12345def', '会话落盘')
  ok(host.markPersonaSent('123456') === true, '标记人设已发送')
  ok(host.entry('123456').personaSent === true, '人设标记落盘')
  ok(host.setSession('999', 'session-x') === false, '未开启的群不能写会话')

  // 换一个实例读同一个文件：模拟重启
  const host2 = createHost({ dshHome: dir })
  ok(host2.entry('123456')?.sessionId === 'session-abc12345def', '重启后仍记得会话')

  const list = host2.listText()
  ok(list.includes('123456'), '列表包含群号')
  ok(list.includes('abc12345'), '列表显示短会话 id')

  // 人设：首次读会写出默认文件
  const persona = host2.persona()
  ok(persona.includes('小鲸鱼'), '默认人设含角色名')
  ok(readFileSync(host2.personaPath, 'utf8').trim() === persona.trim(), '人设文件与返回值一致')

  // 用户改人设后要生效
  writeFileSync(host2.personaPath, '这是改过的人设\n', 'utf8')
  ok(host2.persona() === '这是改过的人设', '读取用户改过的人设')
  ok(host2.resetPersona() === true, 'resetPersona 成功')
  ok(host2.persona().includes('小鲸鱼'), 'reset 后回到默认')

  ok(host2.disable('123456').removed === true, '关闭接待')
  ok(host2.isEnabled('123456') === false, '关闭后 isEnabled 为假')
  ok(host2.disable('123456').removed === false, '重复关闭不报错')

  const state = JSON.parse(readFileSync(join(dir, 'dsh-toolkit-host.json'), 'utf8'))
  ok(typeof state.groups === 'object', '状态文件结构正确')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failed) {
  console.log(`HOST_TESTS_FAILED ${failed}`)
  process.exit(1)
}
console.log('HOST_TESTS_OK')
