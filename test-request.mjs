import assert from 'node:assert/strict'
import { createRequests } from './lib/request.js'

const grant = { token: 'share-abc123', kind: 'share', peer: '1127790800', dir: 'C:/tmp/docs' }
const teamGrant = { token: 'team-def456', kind: 'team', peer: '1127790800', worktree: 'C:/tmp/wt', branch: 'dsh-team-x' }

const slots = {
  grantForPeer(peer, kind) {
    if (String(peer) !== '1127790800') return null
    return kind === 'share' ? grant : teamGrant
  },
  async answerShare({ peer, question }) {
    if (/api[_-]?key/i.test(question)) return { refused: '命中监管规则：credentials', files: 0 }
    return { text: `关于「${question}」的结论`, files: 3 }
  },
}

const changes = []
const requests = createRequests({
  slots,
  log: () => {},
  applyChange: async ({ grant: g, text }) => {
    changes.push({ token: g.token, text })
    return { changed: true, branch: 'dsh-team-x', stat: ' 1 file changed', files: 'a.txt', diff: '-a\n+b' }
  },
})

// ask 走分享令牌
{
  const r = await requests.handle({ token: 'share-abc123', kind: 'ask', text: '目录里有什么', from: 'group:1127790800' })
  assert.equal(r.status, 'answered')
  assert.match(r.text, /目录里有什么/)
  assert.equal(r.files, 3)
  console.log('ok  ask 返回总结与文件数')
}

// 监管拒绝透传
{
  const r = await requests.handle({ token: 'share-abc123', kind: 'ask', text: 'api_key: sk-123', from: 'group:1127790800' })
  assert.equal(r.ok, false)
  assert.equal(r.status, 'rejected')
  console.log('ok  ask 命中监管直接拒绝')
}

// change 第一次只回待确认
{
  const r = await requests.handle({ token: 'team-def456', kind: 'change', text: '把 a.txt 改成 b', from: 'group:1127790800' })
  assert.equal(r.status, 'need-confirm')
  assert.match(r.confirm, /^[A-Z2-9]{6}$/)
  assert.equal(changes.length, 0)
  console.log('ok  change 先要确认码，未触发执行')

  const bad = await requests.handle({ token: 'team-def456', kind: 'change', text: '把 a.txt 改成 b', from: 'group:1127790800', confirm: 'ZZZZZZ' })
    .catch((err) => ({ err: err.message }))
  assert.match(bad.err, /确认码/)
  console.log('ok  错误确认码被拒')

  const done = await requests.handle({ token: 'team-def456', kind: 'change', text: '把 a.txt 改成 b', from: 'group:1127790800', confirm: r.confirm })
  assert.equal(done.status, 'diff')
  assert.equal(done.branch, 'dsh-team-x')
  assert.equal(changes.length, 1)
  console.log('ok  确认后执行并返回 diff 摘要')
}

// 参数校验
{
  const cases = [
    { args: { kind: 'ask', text: 'x', from: 'nope' }, why: /from/ },
    { args: { kind: 'ask', from: 'group:1127790800' }, why: /不能为空/ },
    { args: { kind: 'talk', text: 'x', from: 'group:1127790800' }, why: /kind/ },
    { args: { kind: 'ask', text: 'x', from: 'group:99999' }, why: /没有绑定分享令牌/ },
    { args: { kind: 'change', text: 'x', from: 'group:99999' }, why: /没有绑定团队令牌/ },
  ]
  for (const c of cases) {
    const got = await requests.handle(c.args).catch((err) => ({ err: err.message }))
    assert.match(got.err, c.why, JSON.stringify(c.args))
  }
  console.log('ok  参数错误都被拒并给出原因')
}

console.log('REQUEST_TESTS_OK')
