/**
 * dsh-plugin-restart —— 在 DSH Desktop 里用 `/restart` 重启整个桌面应用。
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
 * 命令：
 *   /restart              重启桌面应用
 *   /restart --dry-run    只打印重启计划，不真的动手（排查用）
 *   /restart --delay=2000 自定义「结果回显 → 动手」的等待时间（毫秒，200~15000）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Cordis 插件名（同一 profile 内必须唯一）。 */
export const name = 'desktop-restart'

/** 只依赖命令注册表；没有它整个插件不 apply（桌面/Web profile 都自带）。 */
export const inject = ['commands']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RELAUNCHER = path.join(HERE, 'relaunch.js')

/** 日志与用户数据统一放 $DSH_HOME，避免 node_modules 被清理后丢证据。 */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const LOG_FILE = path.join(DSH_HOME, 'logs', 'plugin-restart.log')

const DEFAULT_DELAY_MS = 800
const MIN_DELAY_MS = 200
const MAX_DELAY_MS = 15_000

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
      reason: '当前宿主不是 DSH Desktop（没有 Electron 运行时），/restart 只能在桌面应用里用。',
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
      const value = Number(match[1])
      if (!Number.isInteger(value) || value < MIN_DELAY_MS || value > MAX_DELAY_MS) {
        throw new Error(`--delay 需要 ${MIN_DELAY_MS}~${MAX_DELAY_MS} 之间的整数（毫秒），例如 --delay=1500`)
      }
      delayMs = value
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
    try {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
      fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] spawn relauncher failed: ${error && error.message}\n`)
    } catch {
      /* 日志写不了就算了，别把插件搞崩 */
    }
  })
  child.unref()
  return child.pid
}

/**
 * `/restart` 的处理函数：不经过模型，结果直接由界面渲染。
 * @param {{rawInput: string}} invocation
 */
function handleRestart({ rawInput }) {
  let options
  try {
    options = parseOptions(rawInput)
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }

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

/** 记一行「插件确实被加载了」，出问题时先看这行就知道插件有没有生效。 */
function noteApplied() {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    const electron = process.versions === undefined ? 'no' : (process.versions.electron ?? 'no')
    fs.appendFileSync(
      LOG_FILE,
      `[${new Date().toISOString()}] plugin applied (v2.0.0) electron=${electron} pid=${process.pid} ppid=${process.ppid}\n`,
    )
  } catch {
    /* 日志写不了不影响功能 */
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  noteApplied()
  ctx.effect(
    () => ctx.commands.register({
      name: 'restart',
      description: '重启 DSH Desktop 桌面应用（杀掉主进程并重新拉起）',
      input: { hint: '可留空；--dry-run 只看计划，--delay=<毫秒> 调整等待' },
      // 命令本身不产生模型可见内容，输入只是开关参数，没必要写进会话日志。
      recordInput: false,
      handler: handleRestart,
    }),
    'dsh-plugin-restart: /restart command',
  )
}
