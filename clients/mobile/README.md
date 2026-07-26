# Traycer mobile client

This workspace is the Capacitor adapter around the shared Traycer GUI App. It
does not start, discover, or modify a host. In the internal repository,
`make dev-gui-app` runs the GUI App web server and host as first-class
per-worktree services without Electron; this adapter consumes that server and
the selected slot metadata under:

`~/.traycer/host/dev-runs/<slot>/`

## Live-reload development

From the internal repository root, start the shared stack and boot exactly one
iOS Simulator:

```bash
make dev-gui-app
```

Then launch the native shell from a second terminal:

```bash
make dev-ios
```

The root command resolves the current worktree's slot through the existing
orchestrator. The launcher reads the allocated `gui-app` URL from that slot's
`run.json`,
creates the ignored local web bundle when a clean checkout does not have one,
builds/installs the native app, and connects Capacitor live reload to the same
Vite server used for ordinary browser testing. Web/React/CSS edits reload
without reinstalling. Capacitor config, plugin, Swift, signing, or Xcode-project
changes still require a native rebuild. Build products and per-device Xcode
state stay ignored and are recreated locally.

The direct workspace command remains available when an explicit slot is
needed:

```bash
bun run --cwd clients/mobile dev:ios -- --slot <slot>
```

The current milestone is Simulator-only because the existing dev host binds to
Mac loopback. Reaching it from a physical iPhone requires a future remote/tunnel
path outside this client workspace.
