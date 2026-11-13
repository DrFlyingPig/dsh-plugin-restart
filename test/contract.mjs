/**
 * 插件契约自测：不启动 DSH，用假 ctx 跑一遍 apply()，
 * 检查命令注册形状、参数解析、以及「不是桌面宿主时必须明确拒绝」。
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
check('exports.inject', Array.isArray(mod.inject) && mod.inject.includes('commands'), JSON.stringify(mod.inject))
check('exports.apply is function', typeof mod.apply === 'function')

const registered = []
let effectLabel
mod.apply({
  effect(factory, label) {
    effectLabel = label
    return factory()
  },
  commands: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
})

check('effect label', typeof effectLabel === 'string' && effectLabel.includes('restart'), String(effectLabel))
check('registered exactly one command', registered.length === 1, String(registered.length))

const def = registered[0] ?? {}
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
