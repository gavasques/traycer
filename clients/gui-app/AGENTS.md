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
- **Safe area** — never write `env(safe-area-inset-*)`; `index.css` owns the
  only reads. `#root` reserves the top and both horizontal insets app-wide
  (landscape is supported, so the sensor housing can be on either side), which
  makes every in-flow surface safe with no code of its own. Those edges have no
  opt-out, for content and surface backgrounds alike. What is left to a
  surface: the bottom edge (`pb-safe-bottom`), and anything `fixed`.
  - Window-filling: `h-safe-dvh` / `min-h-safe-svh` / `w-safe-dvw`, never the
    raw `h-dvh` / `min-h-svh` / `w-screen`.
  - Floating over the viewport: the `*-safe-<edge>-gutter` tokens, which are
    the layout's own 1rem or the device inset, whichever is larger.
  - `fixed` overlays are portalled outside `#root` and inset themselves:
    `top-safe-center-y` + `left-safe-center-x` when centred (the horizontal
    centre is displaced by half the DIFFERENCE between the side insets, since
    the landscape housing is only ever on one side), `top-safe-top` when
    full-height, and `max-w-safe-dvw` to cap width. CSS allows one width clamp
    per element, so that cap is a default a call site can displace with an
    unmodified `max-w-*`, not a floor — the contract test is the other half of
    the guarantee. Where a
    primitive already owns `inset-y-0`/`h-full` under a `data-*` variant, use
    `mt-safe-top` + `h-safe-dvh` under that **same** variant —
    `tailwind-merge` only displaces a class whose modifiers match, and its
    conflict map lets `inset-y-*` displace `top-*` but not the reverse, so a
    bare `top-safe-top` ties on specificity instead of winning. `sheet.tsx` and
    `drawer.tsx` already do this per side, so their callers need nothing.
  - A full-screen dim is not a surface and stays edge to edge.
  - **The one sanctioned full-bleed surface** is `StandaloneShell`
    (`routes/root-route-components.tsx`) — sign-in and the tour. It is `fixed
inset-0` and marked `data-full-bleed-surface`, so it takes the viewport
    instead of sitting inside `#root`'s reservation, and its edge-to-edge
    artwork reaches the status bar. The exception covers the BACKGROUND only:
    each surface inside it insets its own content layer, because artwork and
    content are siblings there. `fixed` escapes `#root` wholesale, so a content
    layer must restore **all three** reservations — top and both sides —
    plus the bottom wherever that surface has content near it. Restoring only
    the top reads as handled and still fails in landscape; a band whose
    HEIGHT clears the home indicator does not clear it for a line box centred
    inside that band. Do not add a second full-bleed surface — the contract
    test asserts the marker appears exactly once.
  - New tokens must also be registered in `cn()`'s `extendTailwindMerge`
    (`lib/utils.ts`) or they never conflict with the utility they override —
    which is invisible on desktop, where every inset is zero.
  - When a library takes geometry as a value rather than a style (Radix
    `collisionPadding`), read `readSafeAreaInsets()` from
    `lib/safe-area-insets.ts`. It is the only sanctioned runtime read; do not
    add another `getComputedStyle` call site.
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
surfaces use `useReactiveActiveHostId()` / `useHostClient()`. Don't mix.

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
