# Traycer mobile client

This workspace is the Capacitor adapter around the shared Traycer GUI App. It
does not start, discover, or modify a host. `make dev-desktop` runs the GUI App
web server as a first-class per-worktree service; this adapter consumes that
server and the selected slot metadata under:

`~/.traycer/host/dev-runs/<slot>/`

## Live-reload development

Start `make dev-desktop`, boot one iOS Simulator, then select the slot printed
by the stack:

```bash
bun run --cwd clients/mobile dev:ios -- \
  --slot <slot>
```

The launcher reads the allocated `gui-app` URL from the slot's `run.json`,
creates the ignored local web bundle when a clean checkout does not have one,
builds/installs the native app, and connects Capacitor live reload to the same
Vite server used for ordinary browser testing. Web/React/CSS edits reload
without reinstalling. Capacitor config, plugin, Swift, signing, or Xcode-project
changes still require a native rebuild. Build products and per-device Xcode
state stay ignored and are recreated locally.

The current milestone is Simulator-only because the existing dev host binds to
Mac loopback. Reaching it from a physical iPhone requires a future remote/tunnel
path outside this client workspace.
