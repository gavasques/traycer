import {
  use,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as Y from "yjs";
import { useNavigate } from "@tanstack/react-router";
import { QueryClientContext, type QueryClient } from "@tanstack/react-query";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  LOCAL_ORIGIN,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { EpicStreamClient } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";
import { openOwnedDurableStreamClient } from "@/lib/host/owned-durable-stream-client";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useAuthService, useHostBinding } from "@/lib/host";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useReactiveOwnerIdentityKey } from "@/hooks/host/use-reactive-owner-identity-key";
import { updateEpicTitleInCloudTaskCaches } from "@/lib/cloud-epic-tasks-query/cache";
import {
  claimDesktopEpicOwnership,
  getDesktopEpicOwnershipBridge,
  releaseDesktopEpicOwnership,
} from "@/lib/windows/desktop-epic-ownership";
import {
  EpicSessionContext,
  EpicSessionHostClientContext,
  EpicSessionPresentationContext,
  getEpicStreamClientFactoryOverride,
  getOpenEpicRegistry,
  handleHostIds,
  handleOwnerIdentityKeys,
} from "@/lib/registries/epic-session-registry";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { shouldMergeEpicRoomSwap } from "@/lib/epics/epic-room-swap";

const ESTABLISHING_DEADLINE_MS = 15_000;

export interface EpicSessionProviderProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly children: ReactNode;
}

interface MountedSessionState {
  readonly handle: OpenEpicStoreHandle;
  readonly hostId: string;
  readonly ownerIdentityKey: string | null;
}

type SessionPresentationKind = "ready" | "establishing" | "failed";

interface SessionPresentationState {
  readonly kind: SessionPresentationKind;
  readonly targetHostId: string | null;
  readonly originalHostId: string | null;
}

export function EpicSessionProvider(
  props: EpicSessionProviderProps,
): ReactNode {
  const { epicId, tabId, children } = props;
  // The session OWNS its durable transport: the factory built in the acquire
  // effect opens it (socket + auth + wake) and the returned handle's `close()`
  // tears it down on dispose. A host restart under a STABLE `hostId` is healed
  // by the durable transport itself (live endpoint + wake re-dial), not by a
  // provider-driven re-subscribe; a `hostId` CHANGE releases the session below.
  const openTransport = useDurableStreamTransportFactory();
  const effectiveHostId = useEffectiveHostId();
  // Owner-identity discriminator (R-1): `activeHostId` alone cannot see a
  // same-host remote public-key rotation (re-enrollment / corruption
  // recovery), since the hostId is unchanged. Folded into the rebuild
  // decision below alongside the existing hostId/user checks, not in place
  // of them.
  const binding = useHostBinding();
  const ownerIdentityKey = useReactiveOwnerIdentityKey(
    binding === null ? null : binding.hostClient,
  );
  // One explicit-host resolver per retained Epic surface. Sidebar rows share
  // the result through context instead of each mounting a directory listener,
  // query observer, and transient client for this same host.
  const authService = useAuthService();
  const queryClient = use(QueryClientContext);
  const navigate = useNavigate();
  const desktopBridge = getDesktopEpicOwnershipBridge();
  // Persisted state (`lastFocusedArtifactId`) is bucketed under the active
  // user's email so a different signed-in identity on this device cannot
  // restore prior-user focus state. Email is the only stable identity field
  // surfaced through `AuthProfile`; null means signed-out / hydrating.
  const sessionUserId = useAuthStore((state) => state.profile?.email ?? null);
  const cloudTasksUserId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );

  // When the host terminates the epic stream with `UNAUTHORIZED`, the
  // current context bearer is no longer accepted. Re-validate the live
  // RequestContext: AuthnV3 either confirms/rotates it (transient host
  // miss; a future reconnect will succeed) or rejects it (cascade to sign-out
  // so the user can re-authenticate). This is an event emitted by the acquired
  // session, not a reason to reacquire the session if the auth service object
  // changes identity.
  const onAuthError = useEffectEvent((): void => {
    void authService.revalidateCurrentContext();
  });

  const ownershipKey =
    desktopBridge === null
      ? "browser"
      : `${desktopBridge.windowId}\x1f${epicId}\x1f${tabId}`;
  const [claimedOwnershipKey, setClaimedOwnershipKey] = useState<string | null>(
    () => (desktopBridge === null ? ownershipKey : null),
  );
  const ownershipClaimed =
    desktopBridge === null || claimedOwnershipKey === ownershipKey;

  // Desktop only: claim single-window ownership before acquiring a live epic
  // session. The provider still renders its children while this guard runs;
  // session-bound slots see a null context and show their own loading content.
  useEffect(() => {
    if (desktopBridge === null) return;

    const lifecycle = { cancelled: false };
    let claimHeld = false;
    void (async () => {
      const claim = await claimDesktopEpicOwnership(tabId, epicId);
      if (lifecycle.cancelled) {
        if (claim.ok) {
          await releaseDesktopEpicOwnership(tabId);
        }
        return;
      }
      if (claim.ok) {
        claimHeld = true;
        setClaimedOwnershipKey(ownershipKey);
        return;
      }
      const cleanupPatch = useEpicCanvasStore.getState().discardTabState(tabId);
      if (cleanupPatch !== null) {
        await desktopBridge.perWindowState.update(cleanupPatch);
      }
      getOpenEpicRegistry().release(epicId);
      await desktopBridge.requestFocus(claim.currentOwner);
      void navigate({ to: "/epics", replace: true });
    })();

    return () => {
      lifecycle.cancelled = true;
      if (claimHeld) {
        void releaseDesktopEpicOwnership(tabId);
      }
    };
  }, [desktopBridge, epicId, navigate, ownershipKey, tabId]);

  const [session, setSession] = useState<MountedSessionState | null>(null);
  const sessionRef = useRef<MountedSessionState | null>(null);
  const originalHostIdRef = useRef<string | null>(null);
  const [requestedHostId, setRequestedHostId] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [presentation, setPresentation] = useState<SessionPresentationState>({
    kind: "establishing",
    targetHostId: effectiveHostId,
    originalHostId: null,
  });
  const targetHostId = requestedHostId ?? effectiveHostId;
  const resolvedSessionHostClient = useHostClientForHostId(
    session?.hostId ?? targetHostId,
  );

  const retryRepoint = useCallback((): void => {
    setRetryGeneration((generation) => generation + 1);
  }, []);
  const openOnOriginalHost = useCallback((): void => {
    const originalHostId = originalHostIdRef.current;
    if (originalHostId === null) return;
    setRequestedHostId(originalHostId);
    setRetryGeneration((generation) => generation + 1);
  }, []);

  useEffect(() => {
    if (!ownershipClaimed) return;
    if (targetHostId === null) {
      // A selection gap must be visible. The old provider silently bailed and
      // left the task permanently skeleton-bound; retain any established
      // handle but put the shell into an explicit recoverable state.
      setPresentation({
        kind: "failed",
        targetHostId: null,
        originalHostId: originalHostIdRef.current,
      });
      return;
    }
    if (originalHostIdRef.current === null) {
      originalHostIdRef.current = targetHostId;
    }
    const lifecycle = { cancelled: false };
    const registry = getOpenEpicRegistry();
    const handleSessionAuthError = (): void => {
      onAuthError();
    };
    // The session OWNS its transport: the factory opens it (socket + auth +
    // wake) and the returned handle's `close()` tears it all down on dispose.
    // The registry only closes the handle when it DISPOSES the session, so the
    // socket survives across the MRU warm window and a revived session is never
    // handed a dead transport; the durable transport's live endpoint + wake
    // re-dial heal a host restart under a stable `hostId` on their own. Tests
    // drive the stream through the override seam and never open a real socket.
    const streamClientFactory: EpicStreamClientFactory = (
      factoryEpicId,
      callbacks,
    ) => {
      const override = getEpicStreamClientFactoryOverride();
      if (override !== null) {
        return override(factoryEpicId, callbacks);
      }
      // `targetHostId` is non-null here: the acquire effect gates on it above,
      // and it is a `const`, so that narrowing flows into this factory closure.
      // Removing the gate would surface a compile error at this call (which
      // requires a concrete `hostId`), not a runtime throw - the type system is
      // the invariant.
      const result = openOwnedDurableStreamClient(
        openTransport,
        targetHostId,
        (ws) =>
          new EpicStreamClient({
            wsStreamClient: ws,
            epicId: factoryEpicId,
            callbacks,
          }),
      );
      return {
        applyUpdate: (updateBytes) => result.client.applyUpdate(updateBytes),
        awareness: (awarenessBytes) => result.client.awareness(awarenessBytes),
        applyArtifactRoomUpdate: (artifactRoomId, updateBytes) =>
          result.client.applyArtifactRoomUpdate(artifactRoomId, updateBytes),
        artifactRoomAwareness: (artifactRoomId, awarenessBytes) =>
          result.client.artifactRoomAwareness(artifactRoomId, awarenessBytes),
        retryMigration: () => result.client.retryMigration(),
        close: result.close,
      };
    };
    const createHandle = (): OpenEpicStoreHandle =>
      createOpenEpicStore({
        epicId,
        streamClientFactory,
        userId: sessionUserId,
        onAuthError: handleSessionAuthError,
      });
    const current = sessionRef.current;
    if (
      current === null ||
      current.handle.userId !== sessionUserId ||
      current.ownerIdentityKey !== ownerIdentityKey
    ) {
      // Identity changes are security boundaries, not re-points: discard the
      // old user/owner session before opening another stream.
      if (current !== null) {
        registry.release(epicId);
      }
      const nextHandle = registry.acquireMounted(epicId, createHandle);
      handleHostIds.set(nextHandle, targetHostId);
      handleOwnerIdentityKeys.set(nextHandle, ownerIdentityKey);
      const nextSession = {
        handle: nextHandle,
        hostId: targetHostId,
        ownerIdentityKey,
      };
      sessionRef.current = nextSession;
      setSession(nextSession);
      setPresentation({
        kind: "ready",
        targetHostId,
        originalHostId: originalHostIdRef.current,
      });
      return;
    }
    if (current.hostId === targetHostId) {
      setPresentation({
        kind: "ready",
        targetHostId,
        originalHostId: originalHostIdRef.current,
      });
      return;
    }

    // The previous handle remains registered and rendered while its successor
    // establishes. The successor is deliberately outside the registry until a
    // complete snapshot makes an atomic replacement possible.
    const nextHandle = createHandle();
    handleHostIds.set(nextHandle, targetHostId);
    handleOwnerIdentityKeys.set(nextHandle, ownerIdentityKey);
    setPresentation({
      kind: "establishing",
      targetHostId,
      originalHostId: originalHostIdRef.current,
    });
    let settled = false;
    const disposePending = (): void => {
      if (settled) return;
      settled = true;
      nextHandle.dispose();
    };
    const commitReplacement = (): void => {
      if (lifecycle.cancelled || settled) return;
      if (!nextHandle.store.getState().snapshotLoaded) return;
      if (sessionRef.current !== current) {
        disposePending();
        return;
      }
      settled = true;
      const previousRoomId =
        current.handle.store.getState().snapshotMeta?.roomId;
      const nextRoomId = nextHandle.store.getState().snapshotMeta?.roomId;
      if (
        shouldMergeEpicRoomSwap(
          { roomId: previousRoomId },
          { roomId: nextRoomId },
        )
      ) {
        // LOCAL_ORIGIN routes the CRDT union through the replacement's normal
        // local-update path, preserving unacknowledged edits for recovery.
        Y.applyUpdate(
          nextHandle.doc,
          Y.encodeStateAsUpdate(current.handle.doc),
          LOCAL_ORIGIN,
        );
      }
      const replaced = registry.replaceMounted(
        epicId,
        current.handle,
        nextHandle,
      );
      if (!replaced) {
        nextHandle.dispose();
        return;
      }
      const nextSession = {
        handle: nextHandle,
        hostId: targetHostId,
        ownerIdentityKey,
      };
      sessionRef.current = nextSession;
      setSession(nextSession);
      setPresentation({
        kind: "ready",
        targetHostId,
        originalHostId: originalHostIdRef.current,
      });
    };
    const unsubscribe = nextHandle.store.subscribe(commitReplacement);
    const deadline = window.setTimeout(() => {
      if (lifecycle.cancelled || settled) return;
      disposePending();
      setPresentation({
        kind: "failed",
        targetHostId,
        originalHostId: originalHostIdRef.current,
      });
    }, ESTABLISHING_DEADLINE_MS);
    commitReplacement();

    return () => {
      lifecycle.cancelled = true;
      window.clearTimeout(deadline);
      unsubscribe();
      disposePending();
    };
  }, [
    epicId,
    openTransport,
    ownerIdentityKey,
    ownershipClaimed,
    sessionUserId,
    targetHostId,
    retryGeneration,
  ]);

  useEffect(() => {
    return () => {
      getOpenEpicRegistry().releaseMounted(epicId);
      sessionRef.current = null;
      originalHostIdRef.current = null;
    };
  }, [epicId]);

  const handle = ownershipClaimed ? session?.handle ?? null : null;
  const sessionPresentation = useMemo(
    () => ({
      ...presentation,
      retry: retryRepoint,
      openOnOriginalHost,
    }),
    [openOnOriginalHost, presentation, retryRepoint],
  );
  useCloudTaskTitleCacheSync({
    activeHostId: session?.hostId ?? null,
    epicId,
    handle,
    queryClient,
    userId: cloudTasksUserId,
  });

  return (
    <EpicSessionContext.Provider value={handle}>
      <EpicSessionPresentationContext.Provider value={sessionPresentation}>
        <EpicSessionHostClientContext.Provider
          value={handle === null ? null : resolvedSessionHostClient}
        >
          {children}
        </EpicSessionHostClientContext.Provider>
      </EpicSessionPresentationContext.Provider>
    </EpicSessionContext.Provider>
  );
}

interface CloudTaskTitleCacheSyncArgs {
  readonly activeHostId: string | null;
  readonly epicId: string;
  readonly handle: OpenEpicStoreHandle | null;
  readonly queryClient: QueryClient | undefined;
  readonly userId: string | null;
}

function useCloudTaskTitleCacheSync(args: CloudTaskTitleCacheSyncArgs): void {
  const { activeHostId, epicId, handle, queryClient, userId } = args;
  useEffect(() => {
    if (activeHostId === null) return;
    if (handle === null) return;
    if (queryClient === undefined) return;
    if (userId === null) return;

    let lastSyncedTitle: string | null = null;
    const syncTitle = (): void => {
      const title = normalizeGeneratedTitle(handle.store.getState().epic.title);
      if (title === null || title === lastSyncedTitle) return;
      lastSyncedTitle = title;
      updateEpicTitleInCloudTaskCaches(
        queryClient,
        { hostId: activeHostId, userId },
        epicId,
        title,
      );
    };

    syncTitle();
    return handle.store.subscribe(syncTitle);
  }, [activeHostId, epicId, handle, queryClient, userId]);
}

function normalizeGeneratedTitle(title: string): string | null {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : null;
}
