// DSH host plugin: add a "重启 / Restart" command to the DSH Desktop system-tray
// menu, positioned just above the Quit (退出) entry.
//
// Runs in the Electron main process via the host `desktopRuntime` service -- the
// exact same seam the built-in desktop-terminal / desktop-diagnostics tray items use.
//
// Tray item shape (from @deepseek-ai/dsh-plugin-desktop's desktop-diagnostics):
//   { group: 'tools' | 'profiles' | 'status', order: number,
//     label: () => string, invoke: () => void }
export const name = 'desktop-restart'

export const inject = ['desktopRuntime']

export function apply(ctx) {
  ctx.effect(() => {
    const registration = ctx.desktopRuntime.registerTrayItem({
      // 'status' is the last contributed group in the tray template, rendered just
      // above the shell-mode toggle / Quit (退出) entries.
      group: 'status',
      order: 10,
      label: () => '重启',
      invoke: () => {
        // requestRestart() relaunches the Electron app (app.relaunch + quit).
        // It is intentional that this triggers immediately on click.
        ctx.desktopRuntime.requestRestart()
      },
    })
    return () => {
      registration.dispose()
    }
  }, 'dsh-plugin-restart: tray restart command')
}