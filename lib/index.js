/**
 * dsh-plugin-restart —— 在 DSH Desktop 里重启整个桌面应用。
 *
 * 背景（为什么 v2 完全换了实现）：
 *   v1 依赖 `ctx.desktopRuntime.registerTrayItem()` + `ctx.desktopRuntime.requestRestart()`，
 *   那是 DSH 0.1 时代由 `@deepseek-ai/dsh-plugin-desktop` 注入到 Electron 主进程的 seam。
 *   从 0.2 开始桌面端改成了「Electron 主进程 fork 一个 Node 宿主进程
 *   （@deepseek-ai/dsh-desktop-host）跑普通 dsh profile」的架构：
 *     · `desktopRuntime` 服务、`registerTrayItem`、`requestRestart` 全部被删除；
 *     · 托盘菜单在 lib/main.js 里被硬编码成「打开应用 / 退出」，没有插件扩展点；
 *     · 打包版（非 development）连「重启应用与 Host」菜单项都不注册。
 *   也就是说：**插件已经碰不到 Electron 主进程了**，官方没有留下任何重启 seam。
 *
 * v2 的做法：插件跑在宿主进程里，它自己就是 Electron 主进程的子进程，
 * 于是可以拿到「应用主进程 PID（process.ppid）」和「应用可执行文件（process.execPath）」，
 * 再分离启动一个重启助手（lib/relaunch.js，用同一份 Electron 二进制以
 * ELECTRON_RUN_AS_NODE=1 运行，因此不需要用户机器上额外装 Node）：
 *   等一会儿让命令结果回到界面 → 让主进程退出（先礼貌后强制）→ 等宿主一起退出
 *   （否则 profile 锁会让新实例起不来）→ 重新拉起应用。
 *
 * v2.2 的入口（两种，随便用哪个）：
 *   · 会话斜杠命令：`/restart`、`/restart --dry-run`、`/restart --delay=2000`
 *   · 窗口左上角标题栏菜单栏里的「重启」按钮（紧挨「应用」「编辑」）：
 *     宿主通过 `webserver/index-inject` 往页面注入一段内联脚本，脚本把按钮挂进
 *     preload 自建的 `[data-windows-menu]` shadow root；点击时 POST 到本插件注册的
 *     `/plugins/dsh-plugin-restart/restart` 路由，由宿主执行同一套重启逻辑。
 *
 * 为什么不直接加进「应用」下拉菜单：那个菜单是 Electron 主进程用原生
 * `Menu.buildFromTemplate(applicationItems())` 弹出来的（lib/main.js），项是写死的，
 * IPC 也没有接受自定义菜单项的通道；不改 DSH 本体就插不进去。菜单栏本身是
 * preload 用 DOM 画的，所以能挂兄弟按钮 —— 位置就在左上角，紧挨「应用」。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Cordis 插件名（同一 profile 内必须唯一）。 */
export const name = 'desktop-restart'

/**
 * 故意不声明对象级依赖：对象级 `inject` 会把整个 apply() 推迟到服务就绪之后，
 * 而桌面端收集 index 注入表的时机是**宿主启动时一次性**的
 * （dsh-desktop-host 的 `ctx.webServer.collectIndexInjections()` → IPC → 渲染层）。
 * 订阅晚于那次收集，注入的按钮就永远不会出现。所以 apply() 立刻执行，
 * 依赖各自用 `ctx.inject([...], cb)` 局部等待。
 */
export const inject = []

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RELAUNCHER = path.join(HERE, 'relaunch.js')

/** 日志与用户数据统一放 $DSH_HOME，避免 node_modules 被清理后丢证据。 */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const LOG_FILE = path.join(DSH_HOME, 'logs', 'plugin-restart.log')

const VERSION = '2.2.0'

/** 页面按钮点击后请求的宿主路由。 */
export const ROUTE_PATH = '/plugins/dsh-plugin-restart/restart'

const DEFAULT_DELAY_MS = 800
const MIN_DELAY_MS = 200
const MAX_DELAY_MS = 15_000

/** 注入脚本里用来识别「这个按钮已经挂过了」的标记属性。 */
const BUTTON_MARK = 'data-dsh-restart'

/**
 * 判断当前宿主能不能重启桌面应用，并算出重启所需的两个 PID。
 * 不做任何副作用，方便 /restart --dry-run 与测试直接复用。
 * @returns {{ok: true, executable: string, mainPid: number, hostPid: number} | {ok: false, reason: string}}
 */
export function detectDesktop() {
  const electron = process.versions === undefined ? undefined : process.versions.electron
  if (electron === undefined) {
    return {
      ok: false,
      reason: '当前宿主不是 DSH Desktop（没有 Electron 运行时），重启只能在桌面应用里用。',
    }
  }

  const executable = process.execPath
  const base = path.basename(executable).toLowerCase()
  if (base === 'node' || base === 'node.exe') {
    return { ok: false, reason: `无法确定桌面应用的启动程序（execPath=${executable}），已拒绝重启。` }
  }
  if (!fs.existsSync(executable)) {
    return { ok: false, reason: `桌面应用的启动程序不存在：${executable}` }
  }

  const mainPid = process.ppid
  if (!Number.isInteger(mainPid) || mainPid <= 1) {
    return { ok: false, reason: `拿不到桌面应用主进程 PID（ppid=${mainPid}），已拒绝重启。` }
  }

  return { ok: true, executable, mainPid, hostPid: process.pid }
}

/**
 * 校验 `--delay` 的取值。
 * @param {unknown} raw
 * @returns {number}
 */
function parseDelay(raw) {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < MIN_DELAY_MS || value > MAX_DELAY_MS) {
    throw new Error(`--delay 需要 ${MIN_DELAY_MS}~${MAX_DELAY_MS} 之间的整数（毫秒），例如 --delay=1500`)
  }
  return value
}

/**
 * 解析 `/restart` 后面的自由文本。
 * @param {string} rawInput - 命令名之后的原文（含前导空白）。
 * @returns {{dryRun: boolean, delayMs: number}}
 */
export function parseOptions(rawInput) {
  const text = String(rawInput == null ? '' : rawInput)
  let dryRun = false
  let delayMs = DEFAULT_DELAY_MS

  for (const token of text.trim().split(/\s+/u)) {
    if (token === '') continue
    if (token === '--dry-run' || token === '--dry' || token === 'dry-run') {
      dryRun = true
      continue
    }
    const match = /^--delay(?:=(\d+))?$/u.exec(token)
    if (match !== null) {
      delayMs = parseDelay(match[1])
      continue
    }
    throw new Error(`不认识的参数：${token}。可用：--dry-run、--delay=<毫秒>`)
  }

  return { dryRun, delayMs }
}

/** 人类可读的重启计划（dry-run 输出）。 */
function planText(target, delayMs) {
  return [
    '重启计划（未执行）：',
    `· 桌面应用主进程 PID：${target.mainPid}`,
    `· 宿主进程 PID：${target.hostPid}`,
    `· 重新拉起的可执行文件：${target.executable}`,
    `· 命令回显后等待：${delayMs}ms`,
    `· 重启助手：${RELAUNCHER}`,
    `· 日志：${LOG_FILE}`,
  ].join('\n')
}

/**
 * 分离启动重启助手。助手是独立进程，父进程（宿主）被一起杀掉也不影响它把应用拉起来。
 * @param {{executable: string, mainPid: number, hostPid: number}} target
 * @param {number} delayMs
 * @returns {number | undefined} 助手 PID
 */
function launchRelauncher(target, delayMs) {
  const args = [
    RELAUNCHER,
    String(target.mainPid),
    String(target.hostPid),
    target.executable,
    String(delayMs),
    LOG_FILE,
  ]

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    // 用同一份 Electron 二进制当 Node 跑助手：用户机器上不需要另外装 Node。
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })

  child.on('error', (error) => {
    logLine(`spawn relauncher failed: ${error && error.message}`)
  })
  child.unref()
  return child.pid
}

/**
 * 真正的重启动作（命令与页面按钮共用）。
 * @param {{dryRun: boolean, delayMs: number}} options
 * @returns {{kind: 'success' | 'error', text: string}}
 */
export function runRestart(options) {
  const target = detectDesktop()
  if (!target.ok) return { kind: 'error', text: target.reason }

  if (options.dryRun) return { kind: 'success', text: planText(target, options.delayMs) }

  let helperPid
  try {
    helperPid = launchRelauncher(target, options.delayMs)
  } catch (error) {
    return {
      kind: 'error',
      text: `重启助手启动失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  return {
    kind: 'success',
    text: [
      `已安排重启 DSH Desktop（应用 PID ${target.mainPid}，${options.delayMs}ms 后动手）。`,
      '窗口会自己关掉再重新打开，等几秒就好；如果没自动打开，手动启动一次即可。',
      `重启助手 PID：${helperPid === undefined ? '未知' : helperPid}，日志：${LOG_FILE}`,
    ].join('\n'),
  }
}

/** `/restart` 命令的处理函数：不经过模型，结果直接由界面渲染。 */
function handleRestart({ rawInput }) {
  let options
  try {
    options = parseOptions(rawInput)
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
  return runRestart(options)
}

/** 记一行日志；日志写不了也绝不影响功能。 */
function logLine(text) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${text}\n`)
  } catch {
    /* 日志写不了就算了，别把插件搞崩 */
  }
}

/** 记一行「插件确实被加载了」，出问题时先看这行就知道插件有没有生效。 */
function noteApplied() {
  const electron = process.versions === undefined ? 'no' : (process.versions.electron ?? 'no')
  logLine(`plugin applied (v${VERSION}) electron=${electron} pid=${process.pid} ppid=${process.ppid}`)
}

/**
 * 回环 / 同源 / 宿主信任栅栏。返回 null 表示放行，否则是应当返回的状态码。
 * 这些路由不经过 DSH 的 API 网关，所以鉴权要自己做：
 *   · 只认回环 Host（本机页面）；
 *   · 带 Origin 时必须与 Host 同源，`Sec-Fetch-Site: cross-site` 一律拒绝；
 *   · 宿主提供 `connection.requestRejection()` 时再委托它判一次（它知道 --trusted-host）。
 * @param {any} scope - 已注入 webServer 的局部上下文
 * @param {import('node:http').IncomingMessage} req
 * @returns {number | null}
 */
function requestRejection(scope, req) {
  try {
    const headers = (req && req.headers) || {}
    let hostUrl = null
    try {
      hostUrl = new URL(`http://${String(headers.host || '')}`)
    } catch {
      return 403
    }
    const hostname = hostUrl.hostname.toLowerCase()
    const loopback = hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname === '::1'
      || hostname === '[::1]'
      || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname)
    if (!loopback) return 403

    if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403

    const origin = headers.origin
    if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
      let originUrl = null
      try {
        originUrl = new URL(origin)
      } catch {
        return 403
      }
      if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) return 403
    }

    const connection = typeof scope.get === 'function' ? scope.get('connection') : undefined
    if (connection !== undefined && typeof connection.requestRejection === 'function') {
      const code = connection.requestRejection(req)
      if (code !== undefined && code !== null && code !== false) {
        return typeof code === 'number' ? code : 403
      }
    }
    return null
  } catch {
    return 403
  }
}

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/**
 * `POST /plugins/dsh-plugin-restart/restart`：页面按钮的宿主侧入口。
 * 查询参数：`dry=1` 只看计划不动手；`delay=<毫秒>` 调整等待。
 * 要求 POST + `x-dsh-restart: 1` 头：跨站表单发不出自定义头，浏览器预检也不会被放行，
 * 因此这条写接口不能被跨站页面直接触发。
 * @param {any} scope
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function handleRestartRoute(scope, req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { ok: false, error: '只接受 POST' })
      return
    }
    if (req.headers['x-dsh-restart'] !== '1') {
      sendJson(res, 403, { ok: false, error: '缺少 x-dsh-restart 头' })
      return
    }
    const rejected = requestRejection(scope, req)
    if (rejected !== null) {
      sendJson(res, rejected, { ok: false, error: '请求被信任栅栏拒绝' })
      return
    }

    const url = new URL(req.url || ROUTE_PATH, 'http://127.0.0.1')
    let delayMs = DEFAULT_DELAY_MS
    const rawDelay = url.searchParams.get('delay')
    if (rawDelay !== null) delayMs = parseDelay(rawDelay)

    const result = runRestart({ dryRun: url.searchParams.get('dry') === '1', delayMs })
    sendJson(res, result.kind === 'success' ? 200 : 500, { ok: result.kind === 'success', text: result.text, error: result.kind === 'success' ? undefined : result.text })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * 注入到页面里的内联脚本：在标题栏菜单栏「应用」「编辑」右边挂一个「重启」按钮。
 *
 * 为什么是脚本而不是客户端插件 bundle：这条通道
 * （`webserver/index-inject` 的 `script` 行）在桌面壳上一定生效，
 * 不依赖客户端模块系统、也不需要构建产物；`script` 行由页面侧
 * createElement + textContent 插入，不会像 `script-src` 行那样在加载失败时
 * 把启动流程一起 reject 掉。
 *
 * 注意：这段文本里不能出现 `</script`，否则会提前闭合元素。
 */
const BUTTON_SCRIPT = `(function () {
  var ROUTE = ${JSON.stringify(ROUTE_PATH)}
  var MARK = ${JSON.stringify(BUTTON_MARK)}
  var IDLE = '重启'
  var CONFIRM = '确认重启？'
  var BUSY = '重启中…'
  function log(text) {
    try { console.log('[dsh-plugin-restart] ' + text) } catch (error) {}
  }
  function send(button) {
    button.textContent = BUSY
    button.disabled = true
    fetch(ROUTE, { method: 'POST', credentials: 'same-origin', headers: { 'x-dsh-restart': '1' } })
      .then(function (response) {
        return response.json().catch(function () { return null }).then(function (body) {
          return { ok: response.ok, body: body }
        })
      })
      .then(function (result) {
        var body = result.body || {}
        if (!result.ok || body.ok !== true) throw new Error(body.error || ('HTTP ' + result.ok))
        log('restart scheduled: ' + String(body.text || '').split('\\n')[0])
      })
      .catch(function (error) {
        var message = error && error.message ? error.message : String(error)
        button.textContent = IDLE
        button.disabled = false
        log('restart failed: ' + message)
        try { window.alert('重启失败：' + message) } catch (ignored) {}
      })
  }
  function arm(button) {
    if (button.getAttribute('data-dsh-armed') === '1') {
      button.removeAttribute('data-dsh-armed')
      if (button.dshTimer) { window.clearTimeout(button.dshTimer); button.dshTimer = 0 }
      send(button)
      return
    }
    button.setAttribute('data-dsh-armed', '1')
    button.textContent = CONFIRM
    button.dshTimer = window.setTimeout(function () {
      button.removeAttribute('data-dsh-armed')
      button.textContent = IDLE
    }, 3000)
  }
  function mount() {
    var host = document.querySelector('[data-windows-menu]')
    var shadow = host ? host.shadowRoot : null
    var bar = shadow ? shadow.querySelector('[role="menubar"]') : null
    if (!bar) return false
    if (bar.querySelector('[' + MARK + ']')) return true
    var button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.setAttribute('tabindex', '-1')
    button.setAttribute(MARK, '')
    button.textContent = IDLE
    button.title = '重启 DSH Desktop（关闭应用并重新启动）'
    button.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      arm(button)
    })
    bar.appendChild(button)
    log('restart button mounted in the caption menubar')
    return true
  }
  if (mount()) return
  var observer = new MutationObserver(function () {
    if (mount()) observer.disconnect()
  })
  try { observer.observe(document.documentElement, { childList: true, subtree: true }) } catch (error) {}
  window.setTimeout(function () {
    observer.disconnect()
    if (!mount()) log('caption menubar not found (non-desktop shell); button skipped')
  }, 20000)
})()`

/**
 * 注册结构化注入行。必须在 apply() 里**同步**完成：
 * 桌面端注入表是宿主启动时收集一次的，订阅晚了这一行就进不了表。
 * @param {any} ctx
 */
function installClientEntry(ctx) {
  ctx.effect(
    () => ctx.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (row && row.kind === 'script' && typeof row.text === 'string' && row.text.includes(BUTTON_MARK)) return
        }
        table.push({ kind: 'script', placement: 'body', text: BUTTON_SCRIPT })
      } catch {
        /* 注入表是别人的数组，出错也不该影响宿主 */
      }
    }),
    'dsh-plugin-restart: caption restart button',
  )
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  noteApplied()

  // ① 页面按钮：同步注册注入行（不依赖任何服务）
  installClientEntry(ctx)

  // ② 按钮点击后调用的宿主路由
  ctx.inject(['webServer'], (scope) => {
    scope.effect(
      () => scope.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: (req, res) => handleRestartRoute(scope, req, res),
      }),
      `dsh-plugin-restart: POST ${ROUTE_PATH}`,
    )
    logLine(`restart route registered: POST ${ROUTE_PATH}`)
  })

  // ③ 会话斜杠命令（无界面也能用，也是按钮出现前唯一的重启入口）
  ctx.inject(['commands'], (scope) => {
    scope.effect(
      () => scope.commands.register({
        name: 'restart',
        description: '重启 DSH Desktop 桌面应用（杀掉主进程并重新拉起）',
        input: { hint: '可留空；--dry-run 只看计划，--delay=<毫秒> 调整等待' },
        // 命令本身不产生模型可见内容，输入只是开关参数，没必要写进会话日志。
        recordInput: false,
        handler: handleRestart,
      }),
      'dsh-plugin-restart: /restart command',
    )
  })
}
