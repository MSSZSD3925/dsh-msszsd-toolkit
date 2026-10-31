/**
 * dsh-toolkit 的浏览器半：插件详情页上的「功能开关」卡片。
 *
 * 为什么是单文件、零构建：客户端模块系统按「一个插件 id 一个 bundle」加载
 * （/plugins/<id>/client.js），外部插件没有多文件加载通道；本包要保持
 * `link:` 安装不跑构建脚本也能用，所以整个浏览器半手写在 lib/client.js 里。
 *
 * 开关状态由 Host 半的 lib/toggles.js 持有（$DSH_HOME/dsh-toolkit-toggles.json），
 * 卡片只是它的一个前端：GET /dsh-toolkit/toggles 读，POST 写。因此点一下立刻
 * 生效，不需要重载插件、不需要改配置、不需要重启。
 *
 * 卡片注册位置：
 *   没装 dsh-web-settings 时用官方 keyed seat `plugins.bundle.config`，
 *   key 是包名 dsh-toolkit —— 也就是「插件 → dsh-toolkit → 详情页」里那张卡；
 *   装了 dsh-web-settings（服务 webUiSettings）时改挂到 family 列表 seat
 *   `web-ui.plugin.item`，两处切换靠 slots/changed 重新评估。
 */
window.__ModuleLoader__.load({ id: 'dsh-toolkit', factory: (require) => {
var module = { exports: {} }
var exports = module.exports
var React = require('react')
var h = React.createElement

var NS = 'dsh-toolkit'
var API = '/dsh-toolkit/toggles'
var OFFICIAL_SEAT = 'plugins.bundle.config'
var FAMILY_SEAT = 'web-ui.plugin.item'
var BUNDLE = 'dsh-toolkit'

/** 卡片里的一行：模块 id 对应的名字与说明。顺序即渲染顺序。 */
var ROWS = [
  { name: 'qq', label: 'QQ 远程驾驶', desc: '从 QQ 收消息、发通知与文件；关掉后消息不再进入 DSH，三个 QQ 工具也会拒绝调用。' },
  { name: 'session_ask', label: '跨会话提问', desc: '向本机另一个会话问一句并取回回答；关掉后四个 session_ask* 工具都不再工作。' },
  { name: 'pause', label: '暂停按钮', desc: '界面左下角的暂停：在下一个步进边界停住等你补话；关掉后按钮变灰不再响应。' },
  { name: 'restart', label: '重启 DSH', desc: '由计划任务在进程树之外杀掉再拉起；关掉后 restart 类请求直接拒绝。' },
  { name: 'peak', label: '贵时段纪律', desc: '工作日高峰时段把纪律段注入系统提示；关掉后不再注入。' },
]

/** 把后端返回的 modules 表规整成 { name: bool }，缺键按开处理。 */
function normalize(payload) {
  var mods = payload && payload.modules && typeof payload.modules === 'object' ? payload.modules : {}
  var out = {}
  for (var i = 0; i < ROWS.length; i += 1) out[ROWS[i].name] = mods[ROWS[i].name] !== false
  return out
}

/** GET 当前开关表。 */
function fetchToggles() {
  return fetch(API, { credentials: 'same-origin', headers: { accept: 'application/json' } }).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return res.json()
  })
}

/** POST 改一个开关，返回整张新表。 */
function putToggle(name, value) {
  return fetch(API, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ name: name, value: value }),
  }).then(function (res) {
    return res.json().then(function (body) {
      if (!res.ok || !body || body.ok === false) throw new Error((body && body.reason) || 'HTTP ' + res.status)
      return body
    })
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

function Row(props) {
  var busy = props.busy
  return h('div', {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12,
      padding: '10px 0',
      borderTop: '1px solid rgba(127,127,127,0.16)',
    },
  },
    h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
      h('div', { style: { fontSize: 13, fontWeight: 500, lineHeight: '20px' } }, props.label),
      h('div', { style: { fontSize: 12, lineHeight: '18px', opacity: 0.62 } }, props.desc),
    ),
    h(Switch, { on: props.on, disabled: busy, label: props.label, onChange: props.onChange }),
  )
}

/** 开关卡本体：折叠头 + 五行开关，读写 Host 半的路由。 */
function ToggleCard() {
  var [open, setOpen] = React.useState(true)
  var [state, setState] = React.useState({ loading: true, error: '', on: {} })
  var [busy, setBusy] = React.useState('')

  var load = React.useCallback(function () {
    setState(function (prev) { return { loading: true, error: '', on: prev.on } })
    fetchToggles()
      .then(function (payload) {
        setState({ loading: false, error: '', on: normalize(payload) })
      })
      .catch(function (err) {
        setState(function (prev) { return { loading: false, error: '读不到开关状态：' + (err && err.message ? err.message : err), on: prev.on } })
      })
  }, [])

  React.useEffect(function () { load() }, [load])

  var toggle = function (name, next) {
    setBusy(name)
    setState(function (prev) {
      var on = {}
      for (var k in prev.on) on[k] = prev.on[k]
      on[name] = next
      return { loading: prev.loading, error: '', on: on }
    })
    putToggle(name, next)
      .then(function (payload) {
        setState({ loading: false, error: '', on: normalize(payload) })
      })
      .catch(function (err) {
        setState(function (prev) {
          var on = {}
          for (var k in prev.on) on[k] = prev.on[k]
          on[name] = !next
          return { loading: false, error: '保存失败：' + (err && err.message ? err.message : err), on: on }
        })
      })
      .then(function () { setBusy('') })
  }

  var body = []
  for (var i = 0; i < ROWS.length; i += 1) {
    var row = ROWS[i]
    body.push(h(Row, {
      key: row.name,
      label: row.label,
      desc: row.desc,
      on: state.on[row.name] !== false,
      busy: busy === row.name,
      onChange: (function (name, current) {
        return function () { toggle(name, !current) }
      })(row.name, state.on[row.name] !== false),
    }))
  }

  var onCount = 0
  for (var j = 0; j < ROWS.length; j += 1) if (state.on[ROWS[j].name] !== false) onCount += 1

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
        style: {
          flex: '0 0 auto',
          fontSize: 11,
          opacity: 0.6,
          transform: open ? 'rotate(90deg)' : 'none',
          transition: 'transform .15s ease',
        },
      }, '▶'),
      h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
        h('div', { style: { fontSize: 13, fontWeight: 600, lineHeight: '20px' } }, '功能开关'),
        h('div', { style: { fontSize: 12, lineHeight: '18px', opacity: 0.62 } }, '点一下就生效，不用重启；关掉的模块保留注册但不干活。'),
      ),
      h('span', { style: { flex: '0 0 auto', fontSize: 11, opacity: 0.55 } }, state.loading ? '读取中…' : (onCount + '/' + ROWS.length + ' 开启')),
    ),
    open ? h('div', { style: { paddingBottom: 10 } },
      body,
      state.error ? h('div', { style: { paddingTop: 8, fontSize: 12, color: '#ff7a7a' } }, state.error) : null,
      h('div', { style: { paddingTop: 8, fontSize: 11, opacity: 0.5 } }, '状态保存在 $DSH_HOME/dsh-toolkit-toggles.json，缺键等于开。'),
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
      try { console.warn('[dsh-toolkit] 卡片席位注册被拒：' + (err && err.message ? err.message : err)) } catch { /* 忽略 */ }
    } finally {
      reconciling = false
    }
  }

  /** 席位事件与 locale 无关，只在本客户端插件仍活着时监听。 */
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
  // 卡片文案直接写在组件里，这里仍然注册一个最小的 locale 命名空间：
  // 席位要求 target 存在，注册失败也不影响卡片渲染（我们自己不用 t()）。
  ctx.effect(function () {
    try {
      if (ctx.locale && typeof ctx.locale.register === 'function') {
        return ctx.locale.register(NS, {
          zh: { 'dsh-toolkit.title': '功能开关' },
          en: { 'dsh-toolkit.title': 'Feature switches' },
        })
      }
    } catch { /* 注册不上就算了 */ }
    return undefined
  }, 'dsh-toolkit: 卡片文案')

  ctx.effect(function () { return installCard(ctx) }, 'dsh-toolkit: 详情页开关卡')
}

module.exports = { name: 'dsh-toolkit', inject: inject, apply: apply }
return module.exports
} })
