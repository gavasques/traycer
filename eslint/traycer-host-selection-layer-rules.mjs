/**
 * D12 / F12 host-selection write+read layer (selection model §5).
 *
 * Seeded in Phase 0 so no new violations accrue while the migration runs.
 * The allowlist shrinks as later phases land; do not widen it without a
 * ticket. Plan:
 *   epics/c6042be5-cbd3-4923-8cbe-d2bc00ae7ade/artifacts/host-lifecycle-redesign
 *
 * Wire from gui-app `eslint.config.mjs`:
 *   - spread `selectByIdRestrictions` into `generalCustomSyntaxRestrictions`
 *     (write path); per-file overrides for the two legitimate writers filter
 *     this array out, same recomposition style as nested-focus / tab-nav
 *   - apply `hostSelectionReadImportRestrictions` via a
 *     `@typescript-eslint/no-restricted-imports` block whose `ignores` are
 *     `hostSelectionReadAllowlist` (read path)
 */

export const HOST_SELECTION_REDESIGN_PLAN =
  "epics/c6042be5-cbd3-4923-8cbe-d2bc00ae7ade/artifacts/host-lifecycle-redesign";

const SELECT_BY_ID_MESSAGE =
  "`selectById` is restricted to the Settings activate module and the landing composer (until P1.2 migrates the composer to a surface pin). See " +
  HOST_SELECTION_REDESIGN_PLAN +
  " (selection model §5).";

const ACTIVE_HOST_READ_MESSAGE =
  "Do not import `useReactiveActiveHostId` or default-client hooks (`useHostClient`, `useDefaultHostClient`) outside the allowlisted layer (feeds, landing, epic-session registry, app chrome). Tab content must use `useTabHostId` / `useTabHostClient` / `useSurfaceHostPin`. See " +
  HOST_SELECTION_REDESIGN_PLAN +
  " (selection model §5).";

// Named individually so write-path allowlist overrides can recompose
// `generalCustomSyntaxRestrictions` minus this set (`.includes` by reference).
const selectByIdImport = {
  selector:
    "ImportSpecifier[imported.type='Identifier'][imported.name='selectById']",
  message: SELECT_BY_ID_MESSAGE,
};
const selectByIdQuotedImport = {
  selector:
    "ImportSpecifier[imported.type='Literal'][imported.value='selectById']",
  message: SELECT_BY_ID_MESSAGE,
};
const selectByIdMember = {
  selector: "MemberExpression[computed=false][property.name='selectById']",
  message: SELECT_BY_ID_MESSAGE,
};
const selectByIdComputedLiteral = {
  selector:
    "MemberExpression[computed=true][property.type='Literal'][property.value='selectById']",
  message: SELECT_BY_ID_MESSAGE,
};
const selectByIdComputedTemplate = {
  selector:
    "MemberExpression[computed=true][property.type='TemplateLiteral'][property.quasis.0.value.cooked='selectById']",
  message: SELECT_BY_ID_MESSAGE,
};
const selectByIdDestructure = {
  selector:
    "ObjectPattern > Property[key.type='Identifier'][key.name='selectById']",
  message: SELECT_BY_ID_MESSAGE,
};
const selectByIdDestructureLiteral = {
  selector:
    "ObjectPattern > Property[key.type='Literal'][key.value='selectById']",
  message: SELECT_BY_ID_MESSAGE,
};
const selectByIdDestructureTemplate = {
  selector:
    "ObjectPattern > Property[key.type='TemplateLiteral'][key.quasis.0.value.cooked='selectById']",
  message: SELECT_BY_ID_MESSAGE,
};

export const selectByIdRestrictions = [
  selectByIdImport,
  selectByIdQuotedImport,
  selectByIdMember,
  selectByIdComputedLiteral,
  selectByIdComputedTemplate,
  selectByIdDestructure,
  selectByIdDestructureLiteral,
  selectByIdDestructureTemplate,
];

/**
 * Files that may call `selectById`. The method *definition* on
 * HostDirectoryService is a MethodDefinition, not a MemberExpression, so it
 * is not in this list.
 */
export const selectByIdWriteAllowlist = [
  // Settings → Activate (the one UI writer of preferred / today's explicitSelection).
  "src/components/settings/host-scope/use-host-scope.ts",
  // Landing composer until P1.2 turns it into a surface pin.
  "src/components/home/host-workspace-selector/host-workspace-selector.tsx",
];

/**
 * Read-path allowlist. Every entry is a directory or file that may import
 * `useReactiveActiveHostId` / `useHostClient` / `useDefaultHostClient`.
 * Tab-content trees are deliberately absent.
 */
export const hostSelectionReadAllowlist = [
  // CRITICAL: P1.2 swap alias — legal re-export of useReactiveActiveHostId.
  // Removing this entry breaks useEffectiveHostId / useSurfaceHostPin.
  "src/hooks/host/use-effective-host-id.ts",

  // Host-layer adapters + default-client wrapper hook layer.
  "src/hooks/**/*.{ts,tsx}",
  "src/lib/host/**/*.{ts,tsx}",

  // Feeds
  "src/stores/notifications/**/*.{ts,tsx}",
  "src/components/notifications/**/*.{ts,tsx}",

  // Landing
  "src/components/home/**/*.{ts,tsx}",

  // Epic-session registry
  "src/providers/epic-session-provider.tsx",
  "src/providers/epic-tab-existence-reconciler.tsx",
  "src/providers/chat-records-stream-mount.tsx",
  "src/lib/registries/**/*.{ts,tsx}",
  // Selector surface over OpenEpicStore — canvas-serving (D4), not tab-pinned.
  "src/lib/epic-selectors.ts",

  // App chrome (layout, settings, providers, palette, sidebar lists, canvas shell)
  "src/components/layout/**/*.{ts,tsx}",
  "src/components/settings/**/*.{ts,tsx}",
  "src/components/local-host-gate.tsx",
  "src/providers/**/*.{ts,tsx}",
  "src/lib/commands/**/*.{ts,tsx}",
  "src/components/epic-canvas/sidebar/**/*.{ts,tsx}",
  "src/components/epic-canvas/hooks/**/*.{ts,tsx}",
  "src/components/epic-canvas/canvas/**/*.{ts,tsx}",
  "src/components/epic-canvas/panels/epic-sharing/**/*.{ts,tsx}",
  "src/components/migration/**/*.{ts,tsx}",
  "src/stores/settings/**/*.{ts,tsx}",

  // Tests mock / arrange these hooks; the production surface is what D12 polices.
  "**/__tests__/**/*.{ts,tsx}",
  "**/*.{test,spec}.{ts,tsx}",
];

export const hostSelectionReadImportRestrictions = {
  // Patterns (not `paths`) so both `@/` aliases and relative imports match
  // once. `importNames` keeps type-only / unrelated specifiers off the hook.
  patterns: [
    {
      group: [
        "**/use-reactive-active-host-id",
        "**/use-reactive-active-host-id.*",
      ],
      importNames: ["useReactiveActiveHostId"],
      message: ACTIVE_HOST_READ_MESSAGE,
    },
    {
      group: ["**/lib/host", "**/lib/host/index", "**/lib/host/runtime"],
      importNames: ["useHostClient"],
      message: ACTIVE_HOST_READ_MESSAGE,
    },
    {
      group: [
        "**/use-gui-harness-catalog",
        "**/use-gui-harness-catalog.*",
      ],
      importNames: ["useDefaultHostClient"],
      message: ACTIVE_HOST_READ_MESSAGE,
    },
  ],
};
