/**
 * dsh-plugin-restart 的重启助手（独立进程）。
 *
 * 由 lib/index.js 以「同一份 Electron 二进制 + ELECTRON_RUN_AS_NODE=1」分离启动，
 * 因此：
 *   · 用户机器上不需要额外装 Node；
 *   · 它和宿主进程不在同一个「进程树收尾」路径上——宿主被一起杀掉也能继续干活。
 *
 * 调用约定（argv）：
 *   <mainPid> <hostPid> <executable> <delayMs> <logFile>
 *
 * 流程：
 *   1. 先等 delayMs，让 /restart 的成功回显先回到界面；
 *   2. 让桌面应用主进程退出（先礼貌：taskkill / SIGTERM，再强制）；
 *   3. 等宿主进程（我们自己的父进程）也退出——不然 profile 锁没放开，新实例起不来；
 *   4. 重新拉起应用（清掉 ELECTRON_RUN_AS_NODE，否则新实例会当成 Node 跑）。
 *
 * 任何一步失败都只写日志并退出，绝不重复拉起，避免出现两个实例抢 profile。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const [, , mainPidArg, hostPidArg, executable, delayArg, logArg] = process.argv

const mainPid = Number(mainPidArg)
const hostPid = Number(hostPidArg)
const delayMs = Number.isFinite(Number(delayArg)) ? Number(delayArg) : 800
const logFile = typeof logArg === 'string' ? logArg : ''

const MAIN_GRACE_MS = 15_000
const HOST_GRACE_MS = 8_000
const SETTLE_MS = 400

function log(line) {
  if (logFile === '') return
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] [relaunch ${process.pid}] ${line}\n`)
  } catch {
    /* 日志不可写时静默，重启本身更重要 */
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 进程是否还活着（EPERM = 存在但不归我们管，也算活着）。 */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

/**
 * 请求进程退出：先礼貌，等一会儿还在就强制。
 * Windows 上 /F 只能点名主进程本身——**不能用 /T**，否则会把助手自己也算进被杀的子进程树里。
 */
function requestExit(pid, label) {
  if (!alive(pid)) return

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
  } else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* 已经没了 */
    }
  }
  log(`asked ${label} ${pid} to exit`)
}

function forceKill(pid, label) {
  if (!alive(pid)) return
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, stdio: 'ignore' })
    log(`force killed ${label} ${pid} (taskkill status=${result.status})`)
  } else {
    try {
      process.kill(pid, 'SIGKILL')
      log(`force killed ${label} ${pid}`)
    } catch (error) {
      log(`force kill ${label} ${pid} failed: ${error && error.message}`)
    }
  }
}

/** 等到进程消失；返回是否确实消失。 */
async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await sleep(150)
  }
  return !alive(pid)
}

/** 先礼貌再强制，最后确认真的没了。 */
async function stopProcess(pid, label, timeoutMs) {
  if (!alive(pid)) return true
  requestExit(pid, label)
  if (await waitGone(pid, Math.min(2_500, timeoutMs))) return true
  forceKill(pid, label)
  return waitGone(pid, timeoutMs)
}

function relaunch() {
  const env = { ...process.env }
  // 关键：不删掉这个变量，新实例会以 Node 模式启动，界面根本不会出现。
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE

  const child = spawn(executable, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: path.dirname(executable),
    env,
  })
  child.on('error', (error) => log(`relaunch spawn error: ${error && error.message}`))
  child.unref()
  log(`relaunched ${executable} pid=${child.pid}`)
}

async function main() {
  if (!Number.isInteger(mainPid) || mainPid <= 1) throw new Error(`invalid mainPid: ${mainPidArg}`)
  if (typeof executable !== 'string' || executable === '') throw new Error('missing executable path')
  if (!fs.existsSync(executable)) throw new Error(`executable not found: ${executable}`)

  log(`restart requested (main=${mainPid}, host=${hostPid}, delay=${delayMs}ms)`)

  await sleep(Math.max(0, delayMs))

  const mainStopped = await stopProcess(mainPid, 'desktop main', MAIN_GRACE_MS)
  log(`desktop main stopped=${mainStopped}`)
  if (!mainStopped) {
    log('ABORT: desktop main is still running; not relaunching')
    return 2
  }

  // 宿主通常是主进程的子进程，主进程一死它就该自己收尾；这里再兜一层底。
  if (alive(hostPid)) {
    const hostStopped = await stopProcess(hostPid, 'desktop host', HOST_GRACE_MS)
    log(`desktop host stopped=${hostStopped}`)
    if (!hostStopped) {
      log('ABORT: desktop host is still running; not relaunching')
      return 3
    }
  }

  await sleep(SETTLE_MS)

  if (alive(mainPid)) {
    log('ABORT: desktop main came back before relaunch; not relaunching')
    return 4
  }

  relaunch()
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    log(`FAILED: ${error && error.stack ? error.stack : error}`)
    process.exit(1)
  })
