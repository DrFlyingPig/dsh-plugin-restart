/**
 * 插件契约自测：不启动 DSH，用假 ctx 跑一遍 apply()，检查
 *   · 结构化注入行（页面按钮）的形状与去重；
 *   · 宿主路由的注册路径、方法与信任栅栏；
 *   · /restart 命令的形状、参数解析；
 *   · 「不是桌面宿主时必须明确拒绝」。
 *
 * 运行：npm test   （等价于 node test/contract.mjs）
 */

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 把日志写到临时目录，别污染真实的 ~/.dsh/logs/plugin-restart.log
process.env.DSH_HOME = path.join(os.tmpdir(), 'dsh-plugin-restart-contract-test')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'index.js')).href)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label} :: ${detail}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
}

check('exports.name', mod.name === 'desktop-restart', String(mod.name))
check('exports.inject 为空（不能推迟 apply）', Array.isArray(mod.inject) && mod.inject.length === 0, JSON.stringify(mod.inject))
check('exports.apply is function', typeof mod.apply === 'function')
check('exports.ROUTE_PATH', mod.ROUTE_PATH === '/plugins/dsh-plugin-restart/restart', String(mod.ROUTE_PATH))

/** 假上下文：记录注册物，按需把局部 inject 立刻回调。 */
const listeners = []
const routes = []
const commands = []
const effectLabels = []
const disposers = []

const ctx = {
  effect(factory, label) {
    effectLabels.push(label)
    const disposer = factory()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
  on(event, listener) {
    listeners.push({ event, listener })
    return () => {}
  },
  inject(deps, callback) {
    const scope = {
      effect: (factory, label) => ctx.effect(factory, label),
      get: () => undefined,
      webServer: {
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
      commands: {
        register(definition) {
          commands.push(definition)
          return () => {}
        },
      },
    }
    callback(scope)
  },
}

mod.apply(ctx)

// ① 注入行
const indexListeners = listeners.filter((entry) => entry.event === 'webserver/index-inject')
check('注册了 index-inject 监听', indexListeners.length === 1, String(indexListeners.length))

const table = []
indexListeners[0]?.listener(table, {})
check('注入表里追加了一行', table.length === 1, String(table.length))
const row = table[0] ?? {}
check('注入行 kind=script', row.kind === 'script', String(row.kind))
check('注入行 placement=body', row.placement === 'body', String(row.placement))
check('注入脚本含按钮标记', typeof row.text === 'string' && row.text.includes('data-dsh-restart'))
check('注入脚本含路由', typeof row.text === 'string' && row.text.includes(mod.ROUTE_PATH))
check('注入脚本不含 </script', typeof row.text === 'string' && !row.text.includes('</script'))
check('注入脚本挂到标题栏菜单栏', typeof row.text === 'string' && row.text.includes('[data-windows-menu]') && row.text.includes('menubar'))

const again = []
indexListeners[0]?.listener(again, {})
indexListeners[0]?.listener(again, {})
check('重复收集不会重复注入', again.length === 1, String(again.length))

// ② 路由
check('注册了一条路由', routes.length === 1, String(routes.length))
const route = routes[0] ?? {}
check('路由 kind=exact', route.kind === 'exact', String(route.kind))
check('路由 path 正确', route.path === mod.ROUTE_PATH, String(route.path))
check('路由 handler 是函数', typeof route.handler === 'function')

/** 跑一次路由，返回 { status, body }。 */
const call = async (method, headers) => {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(text) { this.body = text ?? '' },
  }
  await route.handler({ method, headers, url: mod.ROUTE_PATH }, res)
  return { status: res.statusCode, body: res.body }
}

const okHost = { host: '127.0.0.1:8129' }

const getResult = await call('GET', okHost)
check('GET 被拒（405）', getResult.status === 405, JSON.stringify(getResult))

const noHeader = await call('POST', okHost)
check('缺 x-dsh-restart 头被拒（403）', noHeader.status === 403, JSON.stringify(noHeader))

const evilHost = await call('POST', { host: 'evil.example.com', 'x-dsh-restart': '1' })
check('非回环 Host 被拒（403）', evilHost.status === 403, JSON.stringify(evilHost))

const crossSite = await call('POST', { ...okHost, 'x-dsh-restart': '1', 'sec-fetch-site': 'cross-site' })
check('cross-site 被拒（403）', crossSite.status === 403, JSON.stringify(crossSite))

const crossOrigin = await call('POST', { ...okHost, 'x-dsh-restart': '1', origin: 'http://evil.example.com' })
check('跨源 Origin 被拒（403）', crossOrigin.status === 403, JSON.stringify(crossOrigin))

const plainHost = await call('POST', { ...okHost, 'x-dsh-restart': '1' })
const plainBody = JSON.parse(plainHost.body || '{}')
check(
  '非桌面宿主下路由返回失败并说明原因',
  plainHost.status === 500 && plainBody.ok === false && String(plainBody.error).includes('DSH Desktop'),
  plainHost.body,
)

// ③ 命令
check('注册了一个命令', commands.length === 1, String(commands.length))
const def = commands[0] ?? {}
check('command name', def.name === 'restart', String(def.name))
check('command description', typeof def.description === 'string' && def.description.length > 0, def.description)
check('command input hint', typeof def.input?.hint === 'string', JSON.stringify(def.input))
check('recordInput false', def.recordInput === false, String(def.recordInput))
check('handler is function', typeof def.handler === 'function')

const plain = await def.handler({ rawInput: '' })
check('非桌面宿主返回 error', plain.kind === 'error' && plain.text.includes('DSH Desktop'), JSON.stringify(plain))

const unknownFlag = await def.handler({ rawInput: ' --nope' })
check('未知参数返回 error', unknownFlag.kind === 'error' && unknownFlag.text.includes('--nope'), JSON.stringify(unknownFlag))

const badDelay = await def.handler({ rawInput: ' --delay=5' })
check('非法 delay 返回 error', badDelay.kind === 'error' && badDelay.text.includes('--delay'), JSON.stringify(badDelay))

check('effect 标签都在', effectLabels.every((label) => typeof label === 'string' && label.length > 0), JSON.stringify(effectLabels))

// ④ 纯函数
check('parseOptions 默认值', mod.parseOptions('').dryRun === false && mod.parseOptions('').delayMs === 800, JSON.stringify(mod.parseOptions('')))
check('parseOptions --dry-run', mod.parseOptions(' --dry-run').dryRun === true)
check('parseOptions --delay', mod.parseOptions(' --delay=1500').delayMs === 1500)

let threw = false
try {
  mod.parseOptions(' bogus')
} catch {
  threw = true
}
check('parseOptions 拒绝乱写的参数', threw)

const detected = mod.detectDesktop()
check('detectDesktop 在普通 Node 下拒绝', detected.ok === false && detected.reason.includes('DSH Desktop'), JSON.stringify(detected))

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURE(S):\n${failures.join('\n')}`)
process.exit(failures.length === 0 ? 0 : 1)
