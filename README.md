# dsh-plugin-restart

给 **DSH Desktop** 加一个「重启」入口：

* 窗口左上角「应用 编辑」菜单栏右边多一个 **重启** 按钮（点两次确认，整个桌面应用关掉再重新起来）；
* 任意会话里也能敲 **`/restart`** 命令，效果一样。

> **v2 说明：这个插件换过一次实现，为什么换见下面「为什么不放托盘里了」。**
> 如果你在找旧版的「托盘右键 → 重启」，那个入口在 DSH 0.2 里已经不存在了——不是插件写错了，是宿主把 seam 删了。

---

## 安装

> ⚠️ **npm 上目前还是 1.x（旧架构，在 DSH 0.2 上不生效）。** 在 2.x 发布到 npm 之前，请用 `link:` 装本地目录，
> 否则 `dsh plugin add dsh-plugin-restart` 拉到的会是那个已经不工作的旧版本。

```bash
# 本地开发（推荐：直接链仓库目录）
dsh plugin --profile desktop add link:D:\project\dsh-plugin-restart

# 发布到 npm 之后
dsh plugin --profile desktop add dsh-plugin-restart
```

装完**重启一次 DSH Desktop**，左上角才会出现「重启」按钮——原因见下面「按钮是怎么出现在标题栏的」。
（`/restart` 命令不需要重启，装好即用。）

自测：`npm test`（不启动 DSH，用假 ctx 校验注入行、路由、命令注册形状和「非桌面宿主必须拒绝」）。

## 用法

| 入口 | 作用 |
| --- | --- |
| 标题栏 **重启** 按钮 | 第一次点击变成「确认重启？」，3 秒内再点一次才真的重启 |
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

所以「往托盘菜单加一项」在当前版本里无法实现，除非改 DSH 自己的 `app.asar`——这个插件不做这种事。

## 按钮是怎么出现在标题栏的

标题栏那行「应用 编辑」是 Electron 的 preload（`lib/preload-app.cjs` 里的 `installWindowsMenu()`）用 DOM 画的：
一个 `div[data-windows-menu]` 加 open shadow root，里面是 `[role=menubar]` 和两个按钮。
**但下拉菜单的内容是主进程的原生 `Menu`**（点按钮 → IPC → `Menu.popup()`），插件插不进去。

能插的是**菜单栏本身**。所以插件走宿主自己的扩展点：

1. `ctx.webServer.register()` 注册 `POST /plugins/dsh-plugin-restart/restart`；
2. 在 `webserver/index-inject` 里追加一行内联 `<script>`，随 index 一起下发；
3. 那段脚本等 `[data-windows-menu]` 的 shadow root 出现后，往 `[role=menubar]` 里 append 一个 `<button>`——样式由 shadow 里的 `button {…}` 规则自动继承，看起来和「应用」「编辑」一模一样。

注意两点：

* **注入表是宿主启动时一次性收集的**（`dsh-desktop-host` 在 ready 时把 `collectIndexInjections()` 的结果发给 Electron 主进程），所以新装的插件要**重启一次应用**按钮才会出现，热加载补不进已经发出去的页面。
* 按钮触发的 HTTP 请求要过信任栅栏：只接受回环地址、同源 `Origin`、非 `cross-site`，并且必须带 `x-dsh-restart: 1` 头——避免任意网页用 `fetch` 把用户的 DSH 重启掉。

## 它到底怎么重启的

1. 点按钮 / 敲 `/restart` 后立刻返回一句提示，界面先看到结果；
2. 插件分离启动重启助手 `lib/relaunch.js`（`detached` + 同一份 Electron 二进制当 Node 跑，**用户机器上不需要额外装 Node**）；
3. 助手等 `delay` 毫秒后让主进程退出：先礼貌（`taskkill` / `SIGTERM`），2.5 秒还没走就强制；
4. 主进程一死，宿主收到 IPC 断开自己收尾；助手再确认宿主真的退出了——**这一步不能省**，宿主不死就会一直占着 profile 锁，新实例起不来；
5. 助手用干净的环境（删掉 `ELECTRON_RUN_AS_NODE`，否则新实例会当成 Node 跑）重新拉起应用。

任何一步失败都只写日志并退出，**绝不重复拉起**，避免两个实例抢同一个 profile。

日志：`$DSH_HOME/logs/plugin-restart.log`（默认 `C:\Users\<你>\.dsh\logs\plugin-restart.log`）。

## 注意事项

* **会强杀进程**：极端情况下可能有未落盘的草稿/终端进程没来得及收尾。想稳一点就 `--delay=3000` 给应用多留时间。
* **只在 DSH Desktop 里可用**：在纯 Web（`dsh web` 跑在终端里）或纯 Node 宿主里，按钮和 `/restart` 都会返回一条说明，而不是假装成功。
* **按钮点了没反应**：先看浏览器/应用的控制台有没有 `[dsh-plugin-restart]` 开头的日志——没有说明注入脚本没下发（通常是没重启应用，或者插件没被 profile 加载）。
* **新实例没起来**：先看日志；`--dry-run` 打印的 `可执行文件` 路径如果不对（比如指向了 `node.exe`），插件会直接拒绝执行。
* 从托盘时代升级上来的人：请把旧的 `/restart` 相关手动 patch 清掉，避免同一插件被挂两次。

## 兼容性

| 平台 | 状态 |
| --- | --- |
| Windows | 已实测（标题栏按钮 + `/restart`，`taskkill` 路径） |
| macOS / Linux | 走 `SIGTERM` → `SIGKILL` 路径，逻辑同上，未实测；标题栏菜单栏本身只在 Windows 上存在，按钮在别的平台上不会出现，`/restart` 照常可用 |
