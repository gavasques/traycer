# AGENTS.md

Read this together with the repository root guide and
`clients/gui-app/AGENTS.md`.

## Purpose and boundary

`clients/mobile` is a thin Capacitor iOS shell around the shared `gui-app`.
The current milestone is intentionally iOS-Simulator-only.

This workspace may:

- mount `<TraycerApp />` with a mobile `IRunnerHost`;
- bridge browser, secure-storage, and native HTTP capabilities;
- consume an existing `make dev-desktop` slot;
- adapt the shared GUI for phone safe areas and touch layout in mobile-only
  CSS.

It must not change or duplicate the RPC protocol, host lifecycle, authn
service, cloud UI, remote-host service, or root `dev-desktop` allocator. Android,
push, Sentry, deep-link auth callbacks, store signing, and release automation
are outside the current milestone.

## Host and auth model

- Mobile has no bundled local host. `onLocalHostChange` synchronously emits
  `null` and never transitions.
- `vite.config.ts` reads the selected existing slot at
  `~/.traycer/host/dev-runs/<slot>/pid.json`, validates it, and injects exactly
  one `kind: "remote"` directory entry through the GUI's existing
  `RemoteHostFetcher` seam.
- Dev auth/cloud URLs are explicit launcher inputs. Never hard-code ports or
  derive the root allocator's port algorithm here.
- Interactive sign-in is current OAuth device flow. The callback signal is
  payload-free and sign-in must complete by polling even if no return signal is
  delivered.
- Capacitor's native HTTP patch keeps auth requests out of WKWebView CORS.
- The shared device-auth client currently supports `"desktop"` and `"cli"`;
  mobile reuses `"desktop"` without changing shared/backend contracts.

## Important files

- `src/mobile-runner-host.ts` — current `IRunnerHost`, device-flow controller,
  and native secure token storage.
- `src/web/main.tsx` — mounts the shared GUI and supplies the one-host fetcher.
- `src/web/index.css` — Tailwind entrypoint; its `@source` for `gui-app` is
  required or shared utility classes disappear from the mobile bundle.
- `src/web/mobile.css` — mobile-only safe-area/responsive overrides.
- `scripts/dev-ios.ts` — live-reload launcher that consumes the existing slot.
- `ios/` — generated Capacitor 8 Swift Package Manager project. Keep generated
  project structure authoritative and reapply only small reviewed native deltas.

## Commands

From the repository root:

```bash
bun run --cwd clients/mobile compile
bun run --cwd clients/mobile test
bun run --cwd clients/mobile build:web
bun run --cwd clients/mobile sync:ios
bun run --cwd clients/mobile dev:ios -- \
  --slot <slot>
```

`make dev-desktop` owns the per-worktree GUI App Vite server. The iOS launcher
reads that server's URL from the slot's `run.json`, builds/installs the native
app, creates ignored web assets when they are absent, and connects Capacitor
live reload to it. React/CSS changes reload without reinstalling; Capacitor
config, plugin, Swift, or Xcode-project changes require a native rebuild.

## Working rules

- Import shared contracts; do not redefine them.
- Keep unsupported mobile capabilities as explicit no-ops/nulls matching
  `IRunnerHost`.
- Keep the production mobile code free of Android/release/push/telemetry
  scaffolding until those milestones are explicitly approved.
- Follow root type-safety rules: no `any`, unsafe assertions, optional function
  parameters, or default parameter values.
- Tests live under `__tests__/` and mock native plugins at the package boundary.
