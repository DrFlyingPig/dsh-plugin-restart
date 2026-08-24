# dsh-plugin-restart

Adds a **重启** command to the **DSH Desktop system-tray menu** (right-click the DSH tray icon near the Windows clock). Selecting it restarts the whole DSH Desktop application via `desktopRuntime.requestRestart()`.

It is a *host plugin*, running in the Electron main process, so it does **not** modify any DSH Desktop shell files. It uses the exact same seam as the built-in `Terminal` / `Export diagnostics` tray items.

## What it does

- Registers one tray menu item always labelled **重启** (no English), placed in the **status** group just above the Quit (**退出**) entry.
- On click: `ctx.desktopRuntime.requestRestart()` → relaunches the desktop app (no confirmation dialog).

## Layout

```
dsh-plugin-restart/
├── package.json         # npm name + dsh.bundle.patch declaration
├── cordis.patch.yml     # inserts the desktop-restart plugin entry into the Cordis tree
├── lib/index.js         # the host plugin { name, inject:['desktopRuntime'], apply }
└── README.md
```

The package is a Cordis **composition bundle**: `package.json` declares
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, so when it is added to a
profile the Desktop applies its patch and loads the plugin in the main process.

## Install

Requires the DSH CLI available to the running Desktop:

```bash
# from the directory containing this package's parent (or use the package's absolute path)
dsh plugin add dsh-plugin-restart
```

or, to install by path:

```bash
dsh plugin add "C:\Users\10530\Desktop\project\test\dsh-plugin-restart"
```

> You may need to switch to / target the desktop profile if the Desktop uses a
> named profile: `dsh plugin --profile desktop add dsh-plugin-restart`.

After adding the bundle, **fully quit and relaunch DSH Desktop**, then
right-click the tray icon — `Restart / 重启` appears near `Terminal` and
`Export diagnostics`.

## Verify it loaded

If the item does not appear, check the Desktop log for
`dsh-plugin-restart` or `desktop-restart`:
- the plugin's `apply` runs inside `ctx.effect(...)`, and its registration is
  cleaned up on dispose automatically;
- a failed mount throws during the desktop's plugin load and is reported in the
  startup log.

## Uninstall

```bash
dsh plugin remove dsh-plugin-restart   # removes the bundle from the profile
```

## Notes / limitations

- Clicking `Restart` relaunches the app immediately (no confirmation dialog).
- The DSH Desktop re-reads profile bundles on launch, so no Desktop rebuild is
  needed; a normal app restart is required for the menu item to appear.