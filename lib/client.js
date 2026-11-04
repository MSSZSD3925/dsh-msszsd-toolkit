/**
 * dsh-msszsd-toolkit 的浏览器半：插件详情页上的「功能开关」卡片。
 *
 * 为什么是单文件、零构建：客户端模块系统按「一个插件 id 一个 bundle」加载
 * （/plugins/<id>/client.js），外部插件没有多文件加载通道；本包要保持
 * `link:` 安装不跑构建脚本也能用，所以整个浏览器半手写在 lib/client.js 里。
 *
 * 开关状态由 Host 半的 lib/toggles.js 持有（$DSH_HOME/dsh-toolkit-toggles.json），
 * 卡片只是它的一个前端：GET /dsh-toolkit/toggles 读、POST 写；表情目录由
 * lib/sticker-dir.js 持有（$DSH_HOME/dsh-toolkit-stickers.json），走 /dsh-toolkit/stickers。
 * 所以点一下立刻生效，不需要重载插件、不需要改配置、不需要重启。
 *
 * 卡片按「模块 + 子功能」分组；标了 danger 的子功能点开时要就地二次确认。
 */
window.__ModuleLoader__.load({ id: 'dsh-msszsd-toolkit', factory: (require) => {
var module = { exports: {} }
var exports = module.exports
var React = require('react')
var h = React.createElement

var NS = 'dsh-msszsd-toolkit'
var API = '/dsh-toolkit/toggles'
var STICKERS = '/dsh-toolkit/stickers'
var ADAPTER = '/dsh-toolkit/adapter/session'
var DISCIPLINE = '/dsh-toolkit/discipline'
var WATCH = '/dsh-toolkit/session-watch'
var OFFICIAL_SEAT = 'plugins.bundle.config'
var FAMILY_SEAT = 'web-ui.plugin.item'
var BUNDLE = 'dsh-msszsd-toolkit'

function jsonFetch(url, options) {
  return fetch(url, options).then(function (res) {
    return res.json().then(function (body) {
      if (!res.ok || !body || body.ok === false) throw new Error((body && body.reason) || 'HTTP ' + res.status)
      return body
    })
  })
}

function fetchAll() {
  return Promise.all([
    jsonFetch(API, { credentials: 'same-origin', headers: { accept: 'application/json' } }),
    jsonFetch(STICKERS, { credentials: 'same-origin', headers: { accept: 'application/json' } }),
    jsonFetch(DISCIPLINE, { credentials: 'same-origin', headers: { accept: 'application/json' } }),
  ]).then(function (all) {
    return { toggles: all[0], stickers: all[1], discipline: all[2] }
  })
}

function putDiscipline(payload) {
  return jsonFetch(DISCIPLINE, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  })
}

function putToggle(name, value, sub) {
  var body = { name: name, value: value }
  if (sub) body.sub = sub
  return jsonFetch(API, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
}

function installRestart() {
  return jsonFetch('/dsh-toolkit/restart/install', { method: 'POST' })
}

function putStickerDir(dir) {
  return jsonFetch(STICKERS, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ dir: dir }),
  })
}

/**
 * 适配提示词分两类，互不相干：
 *   dsh —— 对方是 DSH 插件（走进程内服务 dshToolkitQq）
 *   im  —— 对方是通讯软件那侧的机器人框架（走协议层 transport）
 * test = true 时只让 Host 校验并吐提示词，绝不新建会话。
 */
function adapterCall(kind, plugin, test) {
  return jsonFetch(ADAPTER, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ kind: kind, plugin: plugin, test: test === true }),
  })
}

function Switch(props) {
  var on = props.on === true
  var disabled = props.disabled === true
  return h('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': on,
    'aria-label': props.label,
    title: on ? '已开启，点击关闭' : '已关闭，点击开启',
    disabled: disabled,
    onClick: props.onChange,
    style: {
      flex: '0 0 auto',
      position: 'relative',
      width: 40,
      height: 22,
      padding: 0,
      border: 'none',
      borderRadius: 11,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.55 : 1,
      background: on ? 'var(--dsh-accent, #4d6bfe)' : 'rgba(127,127,127,0.38)',
      transition: 'background .15s ease',
    },
  }, h('span', {
    style: {
      position: 'absolute',
      top: 3,
      left: on ? 21 : 3,
      width: 16,
      height: 16,
      borderRadius: 8,
      background: '#fff',
      boxShadow: '0 1px 2px rgba(0,0,0,.35)',
      transition: 'left .15s ease',
    },
  }))
}

function smallButton(label, onClick, tone) {
  return h('button', {
    type: 'button',
    onClick: onClick,
    style: {
      fontSize: 12,
      lineHeight: '18px',
      padding: '2px 10px',
      borderRadius: 6,
      cursor: 'pointer',
      border: '1px solid rgba(127,127,127,0.32)',
      background: tone === 'danger' ? 'rgba(255,90,90,0.16)' : 'rgba(127,127,127,0.10)',
      color: 'inherit',
    },
  }, label)
}

/** 一行开关；danger 的行点开时先变成「确认 / 取消」 */
/** 模块分组：左边箭头可收起整组，右边是模块自己的开关 */
function Group(props) {
  var open = props.open !== false
  var arrowStyle = {
    flex: '0 0 auto', width: 18, textAlign: 'center', fontSize: 11, opacity: 0.55,
    cursor: 'pointer', userSelect: 'none', transform: open ? 'rotate(90deg)' : 'none',
    transition: 'transform .15s ease',
  }
  return h('div', { style: { borderTop: '1px solid rgba(127,127,127,0.14)' } },
    h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 0 4px' } },
      props.subs
        ? h('span', {
            role: 'button',
            tabIndex: 0,
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': open ? '收起' : '展开',
            style: arrowStyle,
            onClick: function () { props.onToggleOpen() },
            onKeyDown: function (ev) {
              if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); props.onToggleOpen() }
            },
          }, '▶')
        : h('span', { style: { ...arrowStyle, cursor: 'default' } }, ''),
      h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
        h(Row, {
          label: props.label,
          desc: props.desc,
          on: props.on,
          busy: props.busy,
          onChange: props.onChange,
        }),
      ),
    ),
    open && props.children ? h('div', { style: { paddingLeft: 18 } }, props.children) : null,
  )
}

function Row(props) {
  var pending = props.pending === true
  var children = [
    h('div', { key: 'text', style: { flex: '1 1 auto', minWidth: 0 } },
      h('div', { style: { fontSize: props.sub ? 12.5 : 13, fontWeight: props.sub ? 400 : 500, lineHeight: '20px' } }, props.label, props.danger ? h('span', { style: { marginLeft: 6, fontSize: 11, opacity: 0.55 } }, '需确认') : null),
      h('div', { style: { fontSize: 12, lineHeight: '18px', opacity: 0.62 } }, props.desc),
    ),
  ]
  if (pending) {
    children.push(h('div', { key: 'act', style: { display: 'flex', gap: 8, flex: '0 0 auto' } },
      smallButton('确认', props.onConfirm, 'danger'),
      smallButton('取消', props.onCancel),
    ))
  } else {
    children.push(h(Switch, { key: 'sw', on: props.on, disabled: props.busy, label: props.label, onChange: props.onChange }))
  }
  return h('div', {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12,
      padding: props.sub ? '6px 0 6px 22px' : '10px 0',
      borderTop: '1px solid rgba(127,127,127,0.16)',
      opacity: props.disabled ? 0.55 : 1,
    },
  }, children)
}

/** 二级折叠小节：QQ 那一栏子功能太多，按用途收起来 */
function SubGroup(props) {
  var [open, setOpen] = React.useState(props.defaultOpen === true)
  var toggleOpen = function () { setOpen(function (v) { return !v }) }
  return h('div', { style: { borderTop: '1px solid rgba(127,127,127,0.12)' } },
    h('div', {
      role: 'button',
      tabIndex: 0,
      'aria-expanded': open ? 'true' : 'false',
      style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 4px', cursor: 'pointer', userSelect: 'none' },
      onClick: toggleOpen,
      onKeyDown: function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleOpen() } },
    },
      h('span', { style: { fontSize: 10, opacity: 0.55, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s ease' } }, '▶'),
      h('span', { style: { fontSize: 12, opacity: 0.78 } }, props.label),
      h('span', { style: { fontSize: 11, opacity: 0.45, marginLeft: 'auto' } }, props.summary || ''),
    ),
    open && props.children ? h('div', { style: { paddingLeft: 10 } }, props.children) : null,
  )
}

/** 三态项：几个并列按钮，当前值高亮 */
function ChoiceRow(props) {
  var pending = props.pending === true
  var value = props.value
  var choices = props.choices || []
  var buttons = []
  for (var i = 0; i < choices.length; i += 1) {
    buttons.push((function (choice) {
      var active = choice.value === value
      return h('button', {
        key: choice.value,
        type: 'button',
        title: choice.desc || '',
        disabled: props.busy,
        onClick: function () { if (!active) props.onPick(choice.value) },
        style: {
          fontSize: 12,
          lineHeight: '18px',
          padding: '2px 10px',
          borderRadius: 6,
          cursor: props.busy ? 'default' : 'pointer',
          border: '1px solid ' + (active ? 'var(--dsh-accent, #4d6bfe)' : 'rgba(127,127,127,0.32)'),
          background: active ? 'var(--dsh-accent, #4d6bfe)' : 'rgba(127,127,127,0.10)',
          color: active ? '#fff' : 'inherit',
        },
      }, choice.label)
    })(choices[i]))
  }
  var right = pending
    ? h('div', { style: { display: 'flex', gap: 8, flex: '0 0 auto' } },
        smallButton('确认直写', props.onConfirm, 'danger'),
        smallButton('取消', props.onCancel),
      )
    : h('div', { style: { display: 'flex', gap: 6, flex: '0 0 auto', flexWrap: 'wrap', justifyContent: 'flex-end' } }, buttons)
  return h('div', {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12,
      padding: '6px 0 6px 22px',
      borderTop: '1px solid rgba(127,127,127,0.16)',
      opacity: props.disabled ? 0.55 : 1,
    },
  },
    h('div', { key: 'text', style: { flex: '1 1 auto', minWidth: 0 } },
      h('div', { style: { fontSize: 12.5, lineHeight: '20px' } }, props.label, props.danger ? h('span', { style: { marginLeft: 6, fontSize: 11, opacity: 0.55 } }, '需确认') : null),
      h('div', { style: { fontSize: 12, lineHeight: '18px', opacity: 0.62 } }, props.desc),
    ),
    right,
  )
}

function AdapterSection(props) {
  var kind = props.kind
  var [name, setName] = React.useState('')
  var [busy, setBusy] = React.useState('')
  var [error, setError] = React.useState('')
  var [done, setDone] = React.useState(null)
  var [tested, setTested] = React.useState(null)
  var run = function (test) {
    var value = name.trim()
    if (!value || busy) return
    setBusy(test ? 'test' : 'create')
    setError('')
    setDone(null)
    setTested(null)
    adapterCall(kind, value, test === true)
      .then(function (body) {
        if (body && body.ok === false) throw new Error(body.reason || '调用失败')
        if (test) setTested(body)
        else {
          setDone(body)
          setName('')
        }
      })
      .catch(function (err) { setError(String(err && err.message ? err.message : err)) })
      .then(function () { setBusy('') })
  }
  return h('div', { style: { paddingTop: 12, marginTop: 6, borderTop: '1px solid rgba(127,127,127,0.16)' } },
    h('div', { style: { fontSize: 13, fontWeight: 500, lineHeight: '20px' } }, props.label),
    h('div', { style: { fontSize: 12, lineHeight: '18px', opacity: 0.62 } }, props.hint),
    h('div', { style: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' } },
      h('input', {
        value: name,
        placeholder: props.placeholder,
        onChange: function (ev) { setName(ev.target.value) },
        onKeyDown: function (ev) { if (ev.key === 'Enter') run(false) },
        style: {
          flex: '1 1 auto',
          minWidth: 0,
          fontSize: 12,
          padding: '5px 8px',
          borderRadius: 6,
          border: '1px solid rgba(127,127,127,0.32)',
          background: 'rgba(127,127,127,0.06)',
          color: 'inherit',
        },
      }),
      smallButton(busy === 'test' ? '测试中…' : '测试（不实操）', function () { run(true) }),
      smallButton(busy === 'create' ? '新建中…' : '新建适配会话', function () { run(false) }),
    ),
    tested
      ? h('div', { style: { marginTop: 6, fontSize: 12, opacity: 0.8 } },
          '这是测试，没有新建会话。提示词 ' + (tested.chars || 0) + ' 字，类型「' + (tested.kindLabel || '') + '」，开头：' + String(tested.prompt || '').slice(0, 60) + '…')
      : null,
    done && done.sessionId
      ? h('div', { style: { marginTop: 6, fontSize: 12, opacity: 0.8 } },
          '已新建「' + (done.title || '适配会话') + '」（' + String(done.sessionId).replace(/^session-/, '').slice(0, 8) + '），去左侧会话列表打开它。')
      : null,
    error ? h('div', { style: { marginTop: 6, fontSize: 12, color: '#ff7a7a' } }, error) : null,
  )
}

function AdapterBox() {
  return h('div', null,
    h(AdapterSection, {
      kind: 'dsh',
      label: 'DSH 插件适配',
      hint: '填一个 DSH 侧插件名（如 dsh-im）。测试只校验并预览提示词，不建会话；新建才会另起一个独立会话让它自己写适配。',
      placeholder: 'DSH 插件名或仓库地址',
    }),
    h(AdapterSection, {
      kind: 'im',
      label: '通讯软件插件适配',
      hint: '填一个通讯软件那侧的框架或协议端（如 AstrBot、NoneBot2、Lagrange）。同样先测试预览，再决定要不要新建会话。',
      placeholder: '通讯软件插件名或仓库地址',
    }),
  )
}

function StickerBox(props) {
  var [draft, setDraft] = React.useState('')
  var [error, setError] = React.useState('')
  var [busy, setBusy] = React.useState(false)
  React.useEffect(function () { setDraft('') }, [props.info.dir])
  var save = function (value) {
    setBusy(true)
    setError('')
    putStickerDir(value)
      .then(function (body) { props.onSaved(body) })
      .catch(function (err) { setError(String(err && err.message ? err.message : err)) })
      .then(function () { setBusy(false) })
  }
  var info = props.info || {}
  return h('div', { style: { paddingTop: 12, marginTop: 6, borderTop: '1px solid rgba(127,127,127,0.16)' } },
    h('div', { style: { fontSize: 13, fontWeight: 500, lineHeight: '20px' } }, '表情包目录'),
    h('div', { style: { fontSize: 12, lineHeight: '18px', opacity: 0.62 } },
      '当前：' + (info.dir || '(未设置)') + ' · ' + (info.exists ? info.count + ' 张图' : '目录不存在') +
      ' · 来源：' + (info.source === 'runtime' ? '这里设的' : info.source === 'config' ? '插件配置' : '默认')),
    h('div', { style: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' } },
      h('input', {
        value: draft,
        placeholder: 'D:\\表情\\DeepSeek',
        onChange: function (ev) { setDraft(ev.target.value) },
        style: {
          flex: '1 1 auto',
          minWidth: 0,
          fontSize: 12,
          padding: '5px 8px',
          borderRadius: 6,
          border: '1px solid rgba(127,127,127,0.32)',
          background: 'rgba(127,127,127,0.06)',
          color: 'inherit',
        },
      }),
      smallButton(busy ? '保存中…' : '保存', function () { if (!busy) save(draft.trim()) }),
      smallButton('恢复默认', function () { if (!busy) save('') }),
    ),
    error ? h('div', { style: { marginTop: 6, fontSize: 12, color: '#ff7a7a' } }, error) : null,
  )
}

/** 强纪律：给花 token 的功能设允许时段；描述一句就能自扩展一条规则。 */
function DisciplineBox() {
  var [info, setInfo] = React.useState({ loading: true, enabled: false, rules: [], targets: [] })
  var [draft, setDraft] = React.useState('')
  var [busy, setBusy] = React.useState('')
  var [error, setError] = React.useState('')
  var [notice, setNotice] = React.useState('')

  var load = React.useCallback(function () {
    jsonFetch(DISCIPLINE, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (body) { setInfo({ loading: false, enabled: body.enabled === true, rules: body.rules || [], targets: body.targets || [], now: body.now, weekday: body.weekday }) })
      .catch(function (err) { setInfo(function (prev) { return { loading: false, enabled: prev.enabled, rules: prev.rules || [], targets: prev.targets || [], error: String(err && err.message ? err.message : err) } }) })
  }, [])
  React.useEffect(function () { load() }, [load])

  var call = function (payload, okText) {
    setBusy(String(payload.action || 'send'))
    setError('')
    setNotice('')
    putDiscipline(payload)
      .then(function (body) {
        setInfo({ loading: false, enabled: body.enabled === true, rules: body.rules || [], targets: body.targets || [], now: body.now, weekday: body.weekday })
        if (okText) setNotice(okText)
      })
      .catch(function (err) { setError(String(err && err.message ? err.message : err)) })
      .then(function () { setBusy('') })
  }

  var targetLabel = function (key) {
    var list = info.targets || []
    for (var i = 0; i < list.length; i += 1) if (list[i].key === key) return list[i].label
    return key
  }
  var DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
  var daysText = function (days) {
    if (!days || days.length === 0) return '每天'
    return days.map(function (d) { return DAYS[d - 1] }).join(' ')
  }
  var add = function (description) {
    var text = String(description || '').trim()
    if (!text) { setError('先写一句描述，比如「每天 9:00 到 18:00 才允许跨会话提问」'); return }
    call({ action: 'parse-add', description: text }, '已按描述添加一条规则。')
    setDraft('')
  }

  var rows = (info.rules || []).map(function (rule) {
    return h('div', {
      key: rule.id,
      style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid rgba(127,127,127,0.12)' },
    },
      h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
        h('div', { style: { fontSize: 12, lineHeight: '18px' } }, rule.label),
        h('div', { style: { fontSize: 11, lineHeight: '16px', opacity: 0.6 } },
          targetLabel(rule.target) + ' · ' + rule.from + ' - ' + rule.to + ' · ' + daysText(rule.days) + ' · ' + (rule.allowed ? '现在允许' : '现在被挡')),
      ),
      smallButton(rule.enabled === false ? '停用中' : '启用中', function () { if (!busy) call({ action: 'toggle', id: rule.id, value: rule.enabled === false }) }),
      smallButton('删除', function () { if (!busy) call({ action: 'remove', id: rule.id }) }, 'danger'),
    )
  })

  return h('div', { style: { paddingTop: 12, marginTop: 6, borderTop: '1px solid rgba(127,127,127,0.16)' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
      h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
        h('div', { style: { fontSize: 13, fontWeight: 500, lineHeight: '20px' } }, '强纪律'),
        h('div', { style: { fontSize: 12, lineHeight: '18px', opacity: 0.62 } },
          '打开后，下面每一条规则只在自己的时段里放行；时段外这些功能一律拒绝，和手动关掉效果一样。'),
      ),
      h(Switch, {
        label: '强纪律总开关',
        on: info.enabled === true,
        disabled: !!busy || info.loading === true,
        onChange: function () { if (!busy) call({ action: 'enable', value: !info.enabled }) },
      }),
    ),
    h('div', { style: { fontSize: 11, lineHeight: '16px', opacity: 0.55, paddingTop: 4 } },
      '当前 ' + (info.weekday || '') + ' ' + (info.now || '') + ' · 规则写在 $DSH_HOME/dsh-toolkit-discipline.json'),
    rows.length ? h('div', { style: { paddingTop: 6 } }, rows) : h('div', { style: { paddingTop: 8, fontSize: 12, opacity: 0.6 } }, '还没有规则。'),
    h('div', { style: { paddingTop: 10, display: 'flex', gap: 8, alignItems: 'flex-start' } },
      h('textarea', {
        value: draft,
        rows: 2,
        placeholder: '例子：工作日 9:00 到 18:00 才允许跨会话提问；或「周末全天禁止 QQ 互动工具」',
        onChange: function (ev) { setDraft(ev.target.value) },
        onKeyDown: function (ev) { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) add(draft) },
        style: {
          flex: '1 1 auto',
          minWidth: 0,
          fontSize: 12,
          lineHeight: '18px',
          padding: '6px 8px',
          borderRadius: 6,
          border: '1px solid rgba(127,127,127,0.32)',
          background: 'rgba(127,127,127,0.06)',
          color: 'inherit',
          resize: 'vertical',
        },
      }),
      smallButton(busy === 'parse-add' ? '解析中…' : '解析并添加', function () { if (!busy) add(draft) }),
    ),
    notice ? h('div', { style: { marginTop: 6, fontSize: 12, opacity: 0.8 } }, notice) : null,
    error ? h('div', { style: { marginTop: 6, fontSize: 12, color: '#ff7a7a' } }, error) : null,
  )
}

/** 会话看护：点一下扫描，点一下就能在资源管理器里打开报告。 */
function SessionWatchBox() {
  var [info, setInfo] = React.useState({ loading: true, enabled: false, dir: '', files: {}, at: 0, counts: null, error: '' })
  var [busy, setBusy] = React.useState('')
  var [error, setError] = React.useState('')
  var [notice, setNotice] = React.useState('')

  var absorb = function (body, prev) {
    var state = (body && body.state) || {}
    return {
      loading: false,
      enabled: body && body.enabled !== false,
      dir: (body && body.dir) || prev.dir,
      files: (body && body.files) || prev.files,
      at: state.at || prev.at || 0,
      counts: state.counts || prev.counts || null,
      error: state.error || '',
    }
  }

  var load = React.useCallback(function () {
    jsonFetch(WATCH, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (body) { setInfo(function (prev) { return absorb(body, prev) }) })
      .catch(function (err) { setInfo(function (prev) { return { loading: false, enabled: prev.enabled, dir: prev.dir, files: prev.files, at: prev.at, counts: prev.counts, error: String(err && err.message ? err.message : err) } }) })
  }, [])
  React.useEffect(function () { load() }, [load])

  var post = function (payload, okText) {
    setBusy(String(payload.action || ''))
    setError('')
    setNotice('')
    jsonFetch(WATCH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (body) {
        setInfo(function (prev) { return absorb(body, prev) })
        if (payload.action === 'open' && body.opened && body.opened.ok === false) {
          setError('打不开：' + (body.opened.reason || '系统不让开'))
          return
        }
        if (okText) setNotice(okText)
      })
      .catch(function (err) { setError(String(err && err.message ? err.message : err)) })
      .then(function () { setBusy('') })
  }

  var counts = info.counts || {}
  var parts = []
  if (counts.sessions != null) parts.push('扫了 ' + counts.sessions + ' 个会话')
  if (counts.gone != null) parts.push('消失 ' + counts.gone)
  if (counts.interrupted != null) parts.push('被中断 ' + counts.interrupted)
  if (counts.unfinished != null) parts.push('未收尾 ' + counts.unfinished)
  var when = info.at ? new Date(info.at).toLocaleString() : '还没扫过'
  var openButton = function (key, label) {
    return smallButton(label, function () { if (!busy) post({ action: 'open', target: key }) })
  }

  return h('div', { style: { paddingTop: 12, marginTop: 6, borderTop: '1px solid rgba(127,127,127,0.16)' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
      h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
        h('div', { style: { fontSize: 13, fontWeight: 500, lineHeight: '20px' } }, '会话看护'),
        h('div', { style: { fontSize: 12, lineHeight: '18px', opacity: 0.62 } },
          '定时扫会话日志，把「从列表消失 / 轮次被中断 / 尾部没收尾」写成报告，用来找回消失的会话。'),
      ),
      smallButton(busy === 'scan' ? '扫描中…' : '扫一遍', function () { if (!busy) post({ action: 'scan' }, '扫描完成，报告已更新。') }),
    ),
    h('div', { style: { fontSize: 11, lineHeight: '16px', opacity: 0.55, paddingTop: 4 } },
      '上次扫描：' + when + (parts.length ? ' · ' + parts.join(' · ') : '') + ' · 报告在 ' + (info.dir || '…')),
    h('div', { style: { paddingTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 } },
      openButton('dir', '打开报告目录'),
      openButton('report', 'report.md'),
      openButton('latest', 'latest.json'),
      openButton('events', 'events.jsonl'),
    ),
    info.error ? h('div', { style: { marginTop: 6, fontSize: 12, color: '#ff7a7a' } }, info.error) : null,
    notice ? h('div', { style: { marginTop: 6, fontSize: 12, opacity: 0.8 } }, notice) : null,
    error ? h('div', { style: { marginTop: 6, fontSize: 12, color: '#ff7a7a' } }, error) : null,
  )
}

function ToggleCard() {
  var [open, setOpen] = React.useState(true)
  var [state, setState] = React.useState({ loading: true, error: '', mods: {}, meta: [], stickers: {} })
  var [busy, setBusy] = React.useState('')
  var [confirmKey, setConfirmKey] = React.useState('')
  var [closed, setClosed] = React.useState({})
  var [installBusy, setInstallBusy] = React.useState(false)
  var [installed, setInstalled] = React.useState(false)
  var [installMsg, setInstallMsg] = React.useState('')

  var runInstall = React.useCallback(function () {
    setInstallBusy(true)
    setInstallMsg('')
    installRestart()
      .then(function (body) {
        setInstalled(body && body.ok === true)
        setInstallMsg(String((body && body.detail) || '').slice(0, 1200))
      })
      .catch(function (err) {
        setInstalled(false)
        setInstallMsg('安装失败：' + String(err && err.message ? err.message : err))
      })
      .then(function () { setInstallBusy(false) })
  }, [])

  var apply = React.useCallback(function (payload) {
    setState(function (prev) {
      return {
        loading: false,
        error: '',
        mods: payload.toggles.modules || {},
        meta: payload.toggles.meta || prev.meta,
        stickers: payload.stickers || prev.stickers,
      }
    })
  }, [])

  var load = React.useCallback(function () {
    setState(function (prev) { return { loading: true, error: '', mods: prev.mods, meta: prev.meta, stickers: prev.stickers } })
    fetchAll()
      .then(apply)
      .catch(function (err) {
        setState(function (prev) {
          return { loading: false, error: '读不到开关状态：' + (err && err.message ? err.message : err), mods: prev.mods, meta: prev.meta, stickers: prev.stickers }
        })
      })
  }, [apply])

  React.useEffect(function () { load() }, [load])

  var toggle = function (name, sub, next) {
    var key = sub ? name + '.' + sub : name
    setBusy(key)
    setConfirmKey('')
    putToggle(name, next, sub)
      .then(function (body) {
        setState(function (prev) { return { loading: false, error: '', mods: body.modules || prev.mods, meta: body.meta || prev.meta, stickers: prev.stickers } })
      })
      .catch(function (err) {
        setState(function (prev) { return { loading: false, error: '保存失败：' + (err && err.message ? err.message : err), mods: prev.mods, meta: prev.meta, stickers: prev.stickers } })
      })
      .then(function () { setBusy('') })
  }

  var meta = state.meta || []
  var mods = state.mods || {}
  var onCount = 0
  var total = 0
  for (var i = 0; i < meta.length; i += 1) {
    total += 1
    if (mods[meta[i].name] && mods[meta[i].name].enabled !== false) onCount += 1
  }

  var groups = []
  for (var m = 0; m < meta.length; m += 1) {
    var item = meta[m]
    var mod = mods[item.name] || { enabled: true, sub: {} }
    var modOn = mod.enabled !== false
    var subs = item.subs || []
    var folded = closed[item.name] === true
    var kids = []
    var buckets = {}
    var loose = []
    for (var k = 0; k < subs.length; k += 1) {
      var sub = subs[k]
      var key = item.name + '.' + sub.key
      var rawVal = mod.sub ? mod.sub[sub.key] : undefined
      var subOn = sub.kind === 'choice' ? rawVal !== 'off' : rawVal !== false
      var kid
      if (sub.kind === 'choice') {
        kid = h(ChoiceRow, {
          key: key,
          label: sub.label,
          desc: sub.desc,
          choices: sub.choices || [],
          value: rawVal === undefined ? sub.default : rawVal,
          danger: sub.danger === true,
          busy: busy === key,
          pending: confirmKey === key,
          disabled: !modOn,
          onPick: (function (name, sk, current, danger) {
            return function (next) {
              if (danger && next === 'direct' && current !== 'direct') {
                setConfirmKey(name + '.' + sk)
                return
              }
              toggle(name, sk, next)
            }
          })(item.name, sub.key, rawVal === undefined ? sub.default : rawVal, sub.danger === true),
          onConfirm: (function (name, sk) {
            return function () { toggle(name, sk, 'direct') }
          })(item.name, sub.key),
          onCancel: function () { setConfirmKey('') },
        })
      } else {
        kid = h(Row, {
          key: key,
          sub: true,
          label: sub.label,
          desc: sub.desc,
          danger: sub.danger === true,
          on: subOn,
          busy: busy === key,
          pending: confirmKey === key,
          disabled: !modOn,
          onChange: (function (name, sk, current, danger) {
            return function () {
              if (danger && !current) {
                setConfirmKey(name + '.' + sk)
                return
              }
              toggle(name, sk, !current)
            }
          })(item.name, sub.key, subOn, sub.danger === true),
          onConfirm: (function (name, sk) {
            return function () { toggle(name, sk, true) }
          })(item.name, sub.key),
          onCancel: function () { setConfirmKey('') },
        })
      }
      var gid = sub.group || ''
      if (gid) {
        if (!buckets[gid]) buckets[gid] = []
        buckets[gid].push(kid)
      } else {
        loose.push(kid)
      }
    }
    var groupMeta = item.groups || []
    for (var gi = 0; gi < groupMeta.length; gi += 1) {
      var gm = groupMeta[gi]
      var list = buckets[gm.id] || []
      if (!list.length) continue
      var onInGroup = 0
      for (var li = 0; li < subs.length; li += 1) {
        if ((subs[li].group || '') !== gm.id) continue
        var vv = mod.sub ? mod.sub[subs[li].key] : undefined
        if (subs[li].kind === 'choice' ? vv !== 'off' : vv !== false) onInGroup += 1
      }
      kids.push(h(SubGroup, {
        key: 'subgroup-' + gm.id,
        label: gm.label,
        summary: onInGroup + '/' + list.length,
        defaultOpen: gm.id === 'host',
      }, list))
    }
    kids = loose.concat(kids)
    if (item.name === 'restart') {
      kids.push(h('div', { key: 'restart-install', style: { padding: '8px 0 10px' } },
        h('div', {
          role: 'button',
          tabIndex: 0,
          onClick: function () { if (!installBusy) runInstall() },
          onKeyDown: function (ev) {
            if ((ev.key === 'Enter' || ev.key === ' ') && !installBusy) { ev.preventDefault(); runInstall() }
          },
          style: {
            display: 'inline-block',
            padding: '5px 12px',
            borderRadius: 8,
            fontSize: 12,
            cursor: installBusy ? 'default' : 'pointer',
            opacity: installBusy ? 0.6 : 1,
            border: '1px solid rgba(127,127,127,0.35)',
          },
        }, installBusy ? '安装中…' : (installed ? '已安装，重新安装' : '一键安装重启程序')),
        installMsg
          ? h('div', { style: { paddingTop: 6, fontSize: 11, lineHeight: '16px', opacity: 0.65, whiteSpace: 'pre-wrap' } }, installMsg)
          : null,
        h('div', { style: { paddingTop: 4, fontSize: 11, lineHeight: '16px', opacity: 0.5 } }, '把 restart.ps1 复制到 $DSH_HOME 并注册计划任务「DSH Restart Now」，装完 dsh_restart 才会真的生效。'),
      ))
    }
    groups.push(h(Group, {
      key: item.name,
      label: item.label,
      desc: item.desc,
      on: modOn,
      busy: busy === item.name,
      onChange: (function (name, current) {
        return function () { toggle(name, '', !current) }
      })(item.name, modOn),
      subs: subs.length > 0,
      open: !folded,
      onToggleOpen: (function (name, isFolded) {
        return function () {
          setClosed(function (prev) {
            var next = Object.assign({}, prev)
            if (isFolded) delete next[name]
            else next[name] = true
            return next
          })
        }
      })(item.name, folded),
    }, kids.length ? kids : null))
  }

  return h('div', {
    style: {
      border: '1px solid rgba(127,127,127,0.22)',
      borderRadius: 12,
      padding: '0 14px',
      margin: '4px 0',
      background: 'rgba(127,127,127,0.04)',
    },
  },
    h('div', {
      role: 'button',
      tabIndex: 0,
      onClick: function () { setOpen(!open) },
      onKeyDown: function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setOpen(!open) }
      },
      style: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 0', cursor: 'pointer', userSelect: 'none' },
    },
      h('span', {
        'aria-hidden': true,
        style: { flex: '0 0 auto', fontSize: 11, opacity: 0.6, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s ease' },
      }, '▶'),
      h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
        h('div', { style: { fontSize: 13, fontWeight: 600, lineHeight: '20px' } }, '功能开关'),
        h('div', { style: { fontSize: 12, lineHeight: '18px', opacity: 0.62 } }, '点一下就生效，不用重启；关掉的模块保留注册但不干活。'),
      ),
      h('span', { style: { flex: '0 0 auto', fontSize: 11, opacity: 0.55 } }, state.loading && !meta.length ? '读取中…' : (onCount + '/' + total + ' 模块开着')),
    ),
    open ? h('div', { style: { paddingBottom: 10 } },
      groups.length ? groups : h('div', { style: { fontSize: 12, opacity: 0.6, paddingTop: 10 } }, '读取中的空状态，刷新一下页面试试。'),
      h(StickerBox, {
        info: state.stickers,
        onSaved: function (body) {
          setState(function (prev) { return { loading: false, error: '', mods: prev.mods, meta: prev.meta, stickers: body } })
        },
      }),
      h(AdapterBox),
      h(DisciplineBox),
      h(SessionWatchBox),
      state.error ? h('div', { style: { paddingTop: 8, fontSize: 12, color: '#ff7a7a' } }, state.error) : null,
      h('div', { style: { paddingTop: 8, fontSize: 11, opacity: 0.5 } }, '开关存在 $DSH_HOME/dsh-toolkit-toggles.json，表情目录存在 $DSH_HOME/dsh-toolkit-stickers.json，缺键等于开。'),
    ) : null,
  )
}

/** family 组（dsh-web-settings）是否已加载：它的服务名是 webUiSettings。 */
function familyLoaded(ctx) {
  try {
    return typeof ctx.get === 'function' && ctx.get('webUiSettings') !== undefined
  } catch {
    return false
  }
}

/** 把卡片挂到当前可用的那个插件详情页席位；席位变化时先摘再挂，避免重复。 */
function installCard(ctx) {
  var dispose
  var current
  var reconciling = false

  var reconcile = function () {
    if (reconciling) return
    var target = familyLoaded(ctx) ? FAMILY_SEAT : OFFICIAL_SEAT
    if (current === target) return
    reconciling = true
    var previous = dispose
    dispose = undefined
    current = undefined
    if (previous) previous()
    try {
      var spec = target === FAMILY_SEAT
        ? { name: FAMILY_SEAT, id: BUNDLE, order: 200, locale: NS }
        : { name: OFFICIAL_SEAT, key: BUNDLE, locale: NS }
      dispose = ctx.slots.register(spec, ToggleCard)
      current = target
    } catch (err) {
      try { console.warn('[dsh-msszsd-toolkit] 卡片席位注册被拒：' + (err && err.message ? err.message : err)) } catch { /* 忽略 */ }
    } finally {
      reconciling = false
    }
  }

  var off = null
  if (typeof ctx.on === 'function') {
    try { off = ctx.on('slots/changed', reconcile) } catch { /* 没有事件服务就只做初次决定 */ }
  }
  reconcile()
  return function () {
    if (typeof off === 'function') { try { off() } catch { /* 忽略 */ } }
    if (dispose) dispose()
  }
}

var inject = ['slots']

function apply(ctx) {
  ctx.effect(function () {
    try {
      if (ctx.locale && typeof ctx.locale.register === 'function') {
        return ctx.locale.register(NS, {
          zh: { 'dsh-msszsd-toolkit.title': '功能开关' },
          en: { 'dsh-msszsd-toolkit.title': 'Feature switches' },
        })
      }
    } catch { /* 注册不上就算了 */ }
    return undefined
  }, 'dsh-msszsd-toolkit: 卡片文案')

  ctx.effect(function () { return installCard(ctx) }, 'dsh-msszsd-toolkit: 详情页开关卡')
}

module.exports = { name: 'dsh-msszsd-toolkit', inject: inject, apply: apply }
return module.exports
} })
