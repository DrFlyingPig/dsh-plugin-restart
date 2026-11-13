# dsh-plugin-restart

给 **DSH Desktop** 加一条 `/restart` 命令：在对话框里敲一下，整个桌面应用关掉再重新起来。

> **v2 说明：这个插件换过一次实现，为什么换见下面「为什么不放托盘里了」。**
> 如果你在找旧版的「托盘右键 → 重启」，那个入口在 DSH 0.2 里已经不存在了——不是插件写错了，是宿主把 seam 删了。

---

## 安装

> ⚠️ **npm 上目前还是 1.x（旧架构，在 DSH 0.2 上不生效）。** 在 2.0.0 发布到 npm 之前，请用 `link:` 装本地目录，
> 否则 `dsh plugin add dsh-plugin-restart` 拉到的会是那个已经不工作的旧版本。

```bash
# 本地开发（推荐：直接链仓库目录，改完热加载）
dsh plugin --profile desktop add link:D:\project\dsh-plugin-restart

# 发布到 npm 之后
dsh plugin --profile desktop add dsh-plugin-restart
```

装完重启一次 DSH Desktop（或让 `patchReload: live` 自己热加载），然后在任意会话里输入 `/restart`。

自测：`npm test`（不启动 DSH，用假 ctx 校验命令注册形状、参数解析和「非桌面宿主必须拒绝」）。

## 用法

| 命令 | 作用 |
| --- | --- |
| `/restart` | 重启桌面应用（默认回显后 800ms 动手） |
| `/restart --dry-run` | 只打印重启计划，不真动手（排查用） |
| `/restart --delay=2000` | 自定义「命令回显 → 动手」的等待时间，200~15000 毫秒 |

`--dry-run` 会输出类似：

```
重启计划（未执行）：
· 桌面应用主进程 PID：17492
· 宿主进程 PID：25692
· 重新拉起的可执行文件：D:\Program Files\Deepseek Harness\DeepSeek Harness.exe
· 命令回显后等待：800ms
· 重启助手：...\lib\relaunch.js
· 日志：C:\Users\<你>\.dsh\logs\plugin-restart.log
```

## 为什么不放托盘里了

v1 干的是这件事：

```js
ctx.desktopRuntime.registerTrayItem({ group: 'status', label: () => '重启', invoke: () => ctx.desktopRuntime.requestRestart() })
```

`desktopRuntime` 是 `@deepseek-ai/dsh-plugin-desktop` 在 **Electron 主进程**里注册的 seam。DSH 0.2 把桌面端换成了「主进程 fork 一个 Node 宿主进程（`@deepseek-ai/dsh-desktop-host`）跑普通 profile」的架构，于是：

* `desktopRuntime` 服务、`registerTrayItem`、`requestRestart` **全部被删除**（整个 `app.asar` 里搜 `desktopRuntime` / `registerTrayItem` 是 0 命中）；
* 托盘菜单在 `lib/main.js` 里被硬编码成「打开应用 / 退出」，**没有插件扩展点**；
* 打包版连开发模式才有的「重启应用与 Host」菜单项都不注册，IPC 通道表里也没有 restart / relaunch 之类的通道；
* 插件现在全部跑在宿主进程（普通 Node）里，**碰不到任何 Electron API**。

所以「往托盘加一项」在当前版本里无法实现。这个版本改成宿主自己完成重启：插件进程本来就是 Electron 主进程的子进程，于是

* `process.ppid` → 桌面应用主进程 PID
* `process.execPath` → 桌面应用可执行文件（宿主是用同一份 Electron 二进制以 `ELECTRON_RUN_AS_NODE=1` 跑起来的）

## 它到底怎么重启的

1. `/restart` 立刻返回一句提示，界面先看到结果；
2. 插件分离启动重启助手 `lib/relaunch.js`（`detached` + 同一份 Electron 二进制当 Node 跑，**用户机器上不需要额外装 Node**）；
3. 助手等 `delay` 毫秒后让主进程退出：先礼貌（`taskkill` / `SIGTERM`），2.5 秒还没走就强制；
4. 主进程一死，宿主收到 IPC 断开自己收尾；助手再确认宿主真的退出了——**这一步不能省**，宿主不死就会一直占着 profile 锁，新实例起不来；
5. 助手用干净的环境（删掉 `ELECTRON_RUN_AS_NODE`，否则新实例会当成 Node 跑）重新拉起应用。

任何一步失败都只写日志并退出，**绝不重复拉起**，避免两个实例抢同一个 profile。

日志：`$DSH_HOME/logs/plugin-restart.log`（默认 `C:\Users\<你>\.dsh\logs\plugin-restart.log`）。

## 注意事项

* **会强杀进程**：极端情况下可能有未落盘的草稿/终端进程没来得及收尾。想稳一点就 `--delay=3000` 给应用多留时间。
* **只在 DSH Desktop 里可用**：在纯 Web（`dsh web` 跑在终端里）或纯 Node 宿主里，`/restart` 会返回一条说明，而不是假装成功。
* **新实例没起来**：先看日志；`--dry-run` 打印的 `可执行文件` 路径如果不对（比如指向了 `node.exe`），插件会直接拒绝执行。
* 从托盘时代升级上来的人：请把旧的 `/restart` 相关手动 patch 清掉，避免同一插件被挂两次。

## 兼容性

| 平台 | 状态 |
| --- | --- |
| Windows | 已实测（`taskkill` 路径） |
| macOS / Linux | 走 `SIGTERM` → `SIGKILL` 路径，逻辑同上，未实测 |
