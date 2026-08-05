# AGENTS.md

Read this together with the repository root guide and
`clients/gui-app/AGENTS.md`.

## Purpose and boundary

`clients/mobile` is a thin Capacitor iOS shell around the shared `gui-app`.
The current milestone is intentionally iOS-Simulator-only.

This workspace may:

- mount `<TraycerApp />` with a mobile `IRunnerHost`;
- bridge browser, secure-storage, and native HTTP capabilities;
- consume an existing `make dev-gui-app` or `make dev-desktop` slot;
- adapt the shared GUI for phone safe areas and touch layout in mobile-only
  CSS.

It must not change or duplicate the RPC protocol, host lifecycle, authn
service, cloud UI, remote-host service, or root `dev-desktop` allocator. Android
builds, Sentry, deep-link auth callbacks, store signing, and release automation
are outside the current milestone. OS push (permission, APNs token
registration, tap-to-open) is IN the milestone — see `src/push-registration.ts`;
its registration flow is written platform-agnostically for the later Android
milestone.

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
- The shared device-auth client supports `"cli"`, `"desktop"`, and `"mobile"`;
  this shell signs in as `"mobile"` (authn shows mobile-specific approval copy
  and the session lists as a mobile device).
- Push tokens register against authn's `/api/v3/user/push-tokens` bound to the
  login session. Sign-out unregisters via `POST .../remove` and that call is
  the primary cleanup — plain sign-out is local-only and revokes nothing, so a
  failed remove lingers deliverable until the session family is revoked
  (sessions panel), the token rebinds, or authn's reaper collects it after the
  family's sessions expire. Explicit session revocation does cascade the row
  away server-side.

## Important files

- `src/mobile-runner-host.ts` — current `IRunnerHost`, device-flow controller,
  and native secure token storage.
- `src/push-registration.ts` — OS push lifecycle: permission, provider-token
  registration following the token store, and the tap→activation relay the
  GUI consumes through `notifications.onClick` (cold-start taps buffered).
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

In the internal repository, `make dev-gui-app` owns the per-worktree GUI App
Vite server and dev host without starting Electron. `make dev-ios` resolves
that worktree's slot, then the iOS launcher reads the server URL from
`run.json`, builds/installs the native app, creates ignored web assets when
they are absent, and connects Capacitor live reload to it. React/CSS changes
reload without reinstalling; Capacitor config, plugin, Swift, or Xcode-project
changes require a native rebuild. `make dev-desktop` remains compatible when
Electron testing is also needed.

## Working rules

- Import shared contracts; do not redefine them.
- Keep unsupported mobile capabilities as explicit no-ops/nulls matching
  `IRunnerHost`.
- Keep the production mobile code free of Android-build/release/telemetry
  scaffolding until those milestones are explicitly approved. (Push was
  approved with the notifications milestone and lives in
  `src/push-registration.ts`.)
- Follow root type-safety rules: no `any`, unsafe assertions, optional function
  parameters, or default parameter values.
- Tests live under `__tests__/` and mock native plugins at the package boundary.
