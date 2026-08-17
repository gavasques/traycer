# AGENTS.md — clients/gui-app

GUI renderer for Traycer. Read with repo-root `AGENTS.md`. Treat as a normal
browser React app unless the task needs native/desktop integration.

**Stack:** Vite, React, TS, TanStack Router (file-based) + Query, Zustand,
Tailwind v4, shadcn/ui, Vitest + Testing Library.

## Commands

```bash
# from clients/gui-app/
bun run dev
bun run build
bun run test
bun run lint
bun run compile
bun run react-doctor   # manual after .ts/.tsx changes; not in pre-commit
```

Changed-files-only: `npx -y react-doctor@latest . --verbose --diff <base> --offline --no-score`.

**Commits:** don't manually run `compile` / `build` / `lint` / `format` before
committing — repo-root `pre-commit` already runs the affected checks (see root
`AGENTS.md`). Tests are CI, not the hook. Re-run checks only when diagnosing
failures. `react-doctor` stays manual (not hooked).

## Map

| Path                          | Role                                                                   |
| ----------------------------- | ---------------------------------------------------------------------- |
| `src/routes/`                 | File-based routes                                                      |
| `src/components/`             | App UI; `components/ui/` = shadcn primitives (compose, don't rewrite)  |
| `src/stores/`                 | Zustand (UI/client state only)                                         |
| `src/hooks/`                  | App hooks (`hooks/<ns>/use-<verb>-<noun>-{mutation,query}.ts`)         |
| `src/lib/query-keys/`         | Central query/mutation key builders                                    |
| `src/lib/commands/`           | Command palette sources + `actions/` (palette and UI call the same fn) |
| `src/stores/epics/open-epic/` | Per-epic Y.Doc projector — read code/tests before changing             |
| `src/providers/`              | App-wide providers                                                     |

Generated — don't hand-edit: `src/routeTree.gen.ts`, `dist/`, `.tanstack/`.

## Non-negotiable rules

- **`cn(...)`** from `@/lib/utils` for all composed `className`s. No template
  literals / `+` / `.join(" ")`. Static single strings OK.
- **Fluid layout sizing** — `w-full`, `max-w-*`, viewport caps. No fixed px/rem
  for layout surfaces (icons / touch targets OK).
- Prefer composition over editing `src/components/ui/`.
- Spinners: `AgentSpinningDots` only — no new ad-hoc spinners.
- No `key={x ?? fallback}` when `undefined` already remounts correctly.
- Zustand = client UI state; TanStack Query = server/host data.
- Keep browser-safe unless the task adds a native host.

## Backend calls → TanStack Query

Every host RPC / AuthService / RunnerHost request goes through Query. No
`useState` loading flags or ad-hoc `toast.error` in components.

| Kind     | Use                                                                               |
| -------- | --------------------------------------------------------------------------------- |
| Host RPC | `useHostQuery` / `useHostMutation` / `useHostQueries` (owns host key + null gate) |
| Non-host | bare `useQuery` / `useMutation` + key from `src/lib/query-keys/`                  |

- Return full `UseQueryResult` / `UseMutationResult` — don't narrow.
- Hook names: `use<Namespace><Verb><Noun>` (e.g. `useEpicCreate`).
- Default cache update: `invalidateQueries` in `onSuccess`. Optimistic
  `setQueryData` only when justified.
- Host-swap races: capture `hostId` in `onMutate`, use it in
  `onSuccess`/`onError`.
- Errors: `toastFromHostError` / `toastFromAuthError` / `toastFromRunnerError`
  in `onError` (omit only for inline-error surfaces).
- Pending UX: `disabled={isPending}` + unchanged label + inline
  `AgentSpinningDots`. Never swap labels ("Submitting…").
- Never inline `["mutation", "..."]` keys — add builders under
  `src/lib/query-keys/`.

Host scope: tab tiles use `useTabHostId()` / `useTabHostClient()`; app-wide
surfaces use `useEffectiveHostId()` / `useHostClient()`. Don't mix.
`useEffectiveHostId()` is the selection authority's DERIVED host (selection
model §1) — one decider per app, delivered to every window. Settings ▸ Activate
is the only UI gesture that changes it; no picker anywhere writes it, and
`HostDirectoryService.selectById` is lint-restricted to the one authority
bridge. Surface pickers write a per-surface pin (`useSurfaceHostPin`), and a
surface with no pin resolves to `useEffectiveHostId()`.

**A pin is a preference, not a binding** — the same two-tier shape as
preferred/effective, one tier down. `resolvedHostId` is the pin while its host
can serve and `effective` while it cannot, so a surface whose pinned host dies
AUTO-FOLLOWS and returns on its own when the host is usable again. The pin is
never cleared by death; that is what makes the return sticky. Only deliberate
deregistration clears it (the host left the account — a pointer to nothing),
mirroring the authority's own `clearPreferredOutsideFleet`, empty-fleet guard
included. Death is `lease.status === "dead"` and deliberately NOT
`!isUsableForSelection`: `restarting-expected` is a hold, and an incumbent
holds through an expected restart exactly as the app-wide failover does.
Read `honoredSelection`, never `selection`, when resolving a client — the raw
pin still names the dead host. There is no dead-state banner: the chip renders
the RESOLVED host, and the dead host's own picker row says `offline`.

Composers have a **target host** (tab host, fork dialog's fixed host, the
new-conversation modal's host). `null` means "follow the effective host" —
the landing composer and the new-conversation modal opened from the app-wide
sidebar trigger, both of which sit outside every `TabHostProvider`.

**The composer is PLACEMENT.** Its resolved host (the pin rule above, keyed per
WINDOW) decides where a created epic/chat lives for life, so its picker writes
that pin and never the app-wide selection. Submit re-validates: a host the
CALLER NAMED (the row-scoped modal's `overrideHostId`) must not be dead, and —
named, pinned or following — the client the create is about to be sent on must
still address the resolved host, else the composer refuses inline and creates
nothing, never a silent fallback onto whatever the window is bound to. A PIN
does not reach that first refusal: it re-resolves to `effective` instead, and
the chip has been showing that host since it moved. An override does, because
naming the machine IS the request. There is deliberately no separate
reachability gate on the following path: usability of the effective host is the
selection authority's call (selection model §1), and re-deriving it here would
be a second decider.
A create that resolves its host separately from the chip is the bug this
structure exists to prevent; route new composer creates through the placement
the chip is showing.

Every host RPC around a
composer — mentions, slash commands, harness/model catalog, providers/profiles,
pack retry, catalog refresh — and every surface that dispatches into the
focused composer (the palette's Pick provider/model, via
`FocusedComposerEntry.hostClient`) resolves through that host's client
(`…ForClient` hooks / `runTargetHostId` → `useHostClientForHostId`). The
default-host wrappers (`useDefaultHostClient()`, `useProvidersList()`,
`useGuiHarness*Query()`) are for app-wide surfaces only (prefetcher, Settings,
a palette with no focused composer) — never inside a composer surface.

**Deliberate exception — dictation.** `useDictationAvailability` /
`useVoiceDictation` stay on the app-wide host (`useHostClient()`) even inside a
host-pinned composer. They describe the person at the keyboard, not the run:
`speech.dictate` streams live microphone audio and `speech.ensureModel`
downloads an on-device model, so following a remote run target would ship a
user's audio to a machine they only picked to execute a turn on, and drop a
model download there. The cost is real and accepted — a composer pinned to
host B gates its mic on the app-wide host's model, not B's. Scope a NEW
composer RPC to the target host unless it is about the human's input devices.

## Routing

- Auth/redirects → route `beforeLoad`; search → `validateSearch`; critical
  data → route `loader` + Query prefetch. Not component effects.
- Don't mutate UI/stores from preload paths (`beforeLoad`/`loader` may run
  before commit).
- Effects only for external sync (router↔store, streams, browser APIs).

## Testing

Prefer integrated tests (real stores/docs/watchers) over isolated units. Fake
only external/nondeterministic boundaries. Reset stores between tests; use
Testing Library role queries.

## Skills (use when matched)

| Skill                             | When                           |
| --------------------------------- | ------------------------------ |
| `shadcn`                          | Init/add/primitives            |
| `tailwind-v4-shadcn`              | Theme tokens, dark mode, TW v4 |
| `react-best-practices`            | React / `.tsx`                 |
| `frontend-design`                 | New UI / visual work           |
| `vite` / `vitest` / `zod` / `bun` | As named                       |

Materialized from `skills-lock.json` under `.agents/` / `.claude/`.

## Terminal theming (xterm)

Invariants only — read `src/lib/theme-applier.ts`, `terminal-theme.ts`,
`styles/terminal-themes.css` before changing:

- `theme-applier.ts` owns `<html>` class / `data-theme` (module-load, outside
  React). Don't write those attributes elsewhere.
- ANSI tokens in CSS (`--term-ansi-*`); new full-palette preset = one CSS block.
- `buildTerminalTheme` is sync (no flash); unset bright slots L-shift at runtime.
- Lazy-load `TerminalXtermHost`; clear atlas via `scheduleAtlasClear`.
