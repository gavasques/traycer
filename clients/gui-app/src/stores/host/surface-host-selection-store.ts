import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  basePersistOptions,
  surfaceHostSelectionKey,
} from "@/lib/persist";

/**
 * Per-surface host pin. `null` means follow `effective` (selection model §2).
 * The store's public shape is final; P1.2 swaps only the `effective` backing.
 */
export type SurfaceHostSelection = string | null;

/**
 * Multi-instance surfaces key by instance; singletons would use a type-level
 * instance id. Sidebar panels (git-diff, file-tree, new-terminal) all use
 * the view tab id — tab ids are uuid-unique app-wide, so a tab that moves
 * windows keeps its pins. `composer` is reserved for P1.2 (window-keyed).
 */
export type SurfaceKind =
  | "git-diff"
  | "file-tree"
  | "new-terminal"
  | "composer";

const SURFACE_KEY_SEP = "\u001f";

export const BROWSER_SURFACE_WINDOW_ID = "browser";

export function resolveSurfaceWindowId(windowId: string | null): string {
  return windowId !== null && windowId.length > 0
    ? windowId
    : BROWSER_SURFACE_WINDOW_ID;
}

export function surfaceHostKey(
  kind: SurfaceKind,
  instanceId: string,
): string {
  return `${kind}${SURFACE_KEY_SEP}${instanceId}`;
}

/** Sidebar panel instance: the view tab id. */
export function tabSurfaceKey(
  kind: Extract<SurfaceKind, "git-diff" | "file-tree" | "new-terminal">,
  tabId: string,
): string {
  return surfaceHostKey(kind, tabId);
}

/** Git-diff sidebar panel instance. `tileRef` is the view tab id. */
export function gitDiffPanelSurfaceKey(tileRef: string): string {
  return tabSurfaceKey("git-diff", tileRef);
}

/** Reserved for P1.2. Accepts null so the contract matches `resolveSurfaceWindowId`. */
export function composerSurfaceKey(windowId: string | null): string {
  return surfaceHostKey("composer", resolveSurfaceWindowId(windowId));
}

export function resolvedSurfaceHostId(
  selection: SurfaceHostSelection,
  effectiveHostId: string | null,
): string | null {
  return selection ?? effectiveHostId;
}

export type FollowingSurfaceResetListener = (input: {
  readonly previousEffectiveHostId: string | null;
  readonly nextEffectiveHostId: string | null;
}) => void;

const followingSurfaceResetListeners = new Set<FollowingSurfaceResetListener>();

/**
 * G4 reset-dependent-state hook point. Phase 1 registers consumers that
 * clear host-dependent UI (worktree, folder, branch) when a *following*
 * surface re-points. Additive: nothing calls `notifyEffectiveHostChanged`
 * until derivation actually moves.
 */
export function subscribeFollowingSurfaceReset(
  listener: FollowingSurfaceResetListener,
): () => void {
  followingSurfaceResetListeners.add(listener);
  return () => {
    followingSurfaceResetListeners.delete(listener);
  };
}

/**
 * Invoke after `effective` changes. P1.2 is the first caller. Pinned
 * instances ignore this — they keep their pin (D6).
 */
export function notifyEffectiveHostChanged(
  previousEffectiveHostId: string | null,
  nextEffectiveHostId: string | null,
): void {
  if (previousEffectiveHostId === nextEffectiveHostId) return;
  for (const listener of followingSurfaceResetListeners) {
    listener({ previousEffectiveHostId, nextEffectiveHostId });
  }
}

interface SurfaceHostSelectionStoreState {
  readonly selections: Readonly<Partial<Record<string, string>>>;
  readonly setSelection: (
    surfaceKey: string,
    selection: SurfaceHostSelection,
  ) => void;
  /**
   * G4 latch-on-first-use for the tree/diff class: if this instance is
   * still following, pin it to `resolvedHostId` so a later failover cannot
   * swap the tree underneath.
   */
  readonly latchOnFirstUse: (
    surfaceKey: string,
    resolvedHostId: string,
  ) => void;
  readonly resetForTests: () => void;
}

function persistedSelections(
  persistedState: unknown,
): Readonly<Partial<Record<string, string>>> {
  if (typeof persistedState !== "object" || persistedState === null) {
    return {};
  }
  if (!("selections" in persistedState)) return {};
  const selections = persistedState.selections;
  if (typeof selections !== "object" || selections === null) {
    return {};
  }
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(selections)) {
    if (key.length === 0) continue;
    if (typeof value !== "string" || value.length === 0) continue;
    next[key] = value;
  }
  return next;
}

export const useSurfaceHostSelectionStore =
  create<SurfaceHostSelectionStoreState>()(
    persist(
      (set, get) => ({
        selections: {},
        setSelection: (surfaceKey, selection) => {
          const current = get().selections;
          const existing = current[surfaceKey];
          if (selection === null) {
            if (existing === undefined) return;
            const next = { ...current };
            delete next[surfaceKey];
            set({ selections: next });
            return;
          }
          if (existing === selection) return;
          set({ selections: { ...current, [surfaceKey]: selection } });
        },
        latchOnFirstUse: (surfaceKey, resolvedHostId) => {
          if (resolvedHostId.length === 0) return;
          const current = get().selections;
          if (current[surfaceKey] !== undefined) return;
          set({ selections: { ...current, [surfaceKey]: resolvedHostId } });
        },
        resetForTests: () => {
          set({ selections: {} });
        },
      }),
      {
        ...basePersistOptions(surfaceHostSelectionKey(null)),
        storage: createJSONStorage(() => window.localStorage),
        merge: (persistedState, currentState) => ({
          ...currentState,
          selections: persistedSelections(persistedState),
        }),
        partialize: (state) => ({ selections: state.selections }),
      },
    ),
  );
