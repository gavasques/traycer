import { useRouterState } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { useActiveLandingDraftShell } from "@/stores/home/landing-draft-store";
import { HomeHero } from "@/components/home/home-hero";
import { LandingComposer } from "@/components/home/composer/landing-composer";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import { HostUpdateBanner } from "@/components/home/host-update-banner";
import { HostWorkspaceSelector } from "@/components/home/host-workspace-selector/host-workspace-selector";
import { EpicsListPanel } from "@/components/epics/epics-list-panel";
import { LandingTerminalPanel } from "@/components/home/terminal-panel/landing-terminal-panel";
import { parseSystemTabOverlayView } from "@/lib/system-tab-overlay-search";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import "./home-touch-targets.css";

export function HomePage() {
  // Subscribe to the render-stable shell, NOT the full draft: the active
  // draft's `prompt` changes on every keystroke, but `LandingComposer` reads it
  // once at mount (keyed by draft id), so excluding it here keeps typing from
  // re-rendering the entire home surface.
  const { draftId, workspaceFolders, settings } = useActiveLandingDraftShell();

  // Pre-mint the mount identity for the null-draft landing so the first
  // substantive edit (which creates a draft and flips activeDraftId null→id)
  // does not remount the Tiptap editor. Switching between existing drafts still
  // remounts via a changing key.
  //
  // Bound→null rotation is a render-phase state adjustment (React docs pattern):
  // a passive useEffect would leave one committed frame still keyed by the
  // retired draft id (stale interactive editor). Adjusting here re-renders
  // synchronously before commit so the new pending id is the first key after
  // the transition — exactly one remount, no stale frame.
  const [pendingDraftId, setPendingDraftId] = useState(() => uuidv4());
  const [prevDraftId, setPrevDraftId] = useState<string | null>(draftId);
  if (draftId !== prevDraftId) {
    setPrevDraftId(draftId);
    if (draftId === null) {
      setPendingDraftId(uuidv4());
    }
  }
  const composerMountId = draftId ?? pendingDraftId;

  // The Settings / History modal renders over the home page. While it's open the
  // embedded list is fully occluded, yet it shares the history-search store +
  // query with the modal, so searching/filtering in the modal would re-render it
  // behind the dialog. Select a plain boolean (stable across unrelated
  // navigations) and unmount the occluded list so that work never happens.
  const systemModalOpen = useRouterState({
    select: (state) => {
      const overlay = parseSystemTabOverlayView(state.location.search);
      return overlay.settingsOverlay || overlay.historyOverlay;
    },
  });
  // Phones drop the embedded list entirely: the hamburger drawer already
  // carries "Recent tasks" + "View all" off the same `useHistoryQuery`, so an
  // inline copy is pure duplication at this width.
  const isMobile = useIsMobileViewport();
  const workspaceSurface = useMemo(
    () => ({ kind: "home" as const, draftId }),
    [draftId],
  );
  // Composer v3: host select · Workspace rail picker. Per-folder
  // Environment config lives inside the selected folder panel.
  const workspaceControls = useMemo(
    () => <HostWorkspaceSelector surface={workspaceSurface} />,
    [workspaceSurface],
  );

  return (
    <div
      data-home-touch-scope
      className="relative flex min-h-0 flex-1 overflow-hidden bg-background text-foreground"
    >
      {/* The column track must be minmax(0,1fr), not the implicit `auto`: an
          auto track's minimum is its items' min-content, so the composer
          toolbar's intrinsic width would lock the whole column wider than a
          narrow viewport (or the space left beside the terminal panel) and
          the outer overflow-hidden would clip the right edge instead of
          letting content reflow. */}
      {/* Row 2 bottom-aligns the hero and row 3 top-anchors the composer, so
          the boundary between them is where the pair sits. An even 1fr/1fr
          split (desktop, where the epics list fills row 3) centres it; below md
          the list is gone, so row 3 is weighted heavier to lift the pair just
          above the midpoint, where it reads better on a tall phone. Both rows
          stay fractional on purpose - an intrinsic row 3 would let a grown
          composer (attachments, several folders, keyboard open) squeeze row 2
          to zero and then clip against this container's overflow-hidden. */}
      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_minmax(0,1fr)] overflow-hidden max-md:grid-rows-[auto_minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="mx-auto w-full max-w-3xl px-6 pt-3 max-md:px-4">
          <HostUpdateBanner className={undefined} />
        </div>

        <section className="mx-auto flex w-full max-w-3xl items-end justify-center px-6 pb-10 pt-3 max-md:px-4 max-md:pb-6">
          <HomeHero workspaceFolders={workspaceFolders} />
        </section>

        {/* Composer + recent epics share one row so the composer is top-anchored:
            adding a folder grows it downward into the (scrollable) epics list
            below instead of recentering and shoving the hero up. */}
        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-col px-6 max-md:px-4">
          <div className="shrink-0">
            <SurfaceActivityProvider active={!systemModalOpen}>
              <LandingComposer
                key={composerMountId}
                draftId={draftId}
                pendingCreateId={draftId === null ? pendingDraftId : null}
                initialSettings={settings}
                workspaceControls={workspaceControls}
              />
            </SurfaceActivityProvider>
          </div>

          {isMobile ? null : (
            <div className="mt-3 flex min-h-0 flex-1 flex-col pb-6">
              {systemModalOpen ? null : (
                <EpicsListPanel
                  variant="embedded"
                  onSelectEpic={null}
                  routeSearch={null}
                  historyNowMs={null}
                  autoFocusSearch={false}
                />
              )}
            </div>
          )}
        </div>
      </div>
      <LandingTerminalPanel draftId={draftId} />
    </div>
  );
}
