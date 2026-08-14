import { type ReactNode } from "react";
import { ChevronRight, Menu } from "lucide-react";
import { Link, useMatch, useRouterState } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { RateLimitIconButton } from "@/components/layout/header/rate-limit-icon";
import { ResourceMonitorPopover } from "@/components/resources/resource-monitor-popover";
import { MobileNotificationsButton } from "@/components/notifications/mobile-notifications-button";
import {
  EpicMobileSwitcherTrigger,
  MobileEpicHeaderTitle,
} from "@/components/epic-canvas/mobile/epic-mobile-header-actions";
import "@/components/layout/shell/mobile-shell-touch-targets.css";
import { useRegisteredEpicTitle } from "@/lib/epic-selectors";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import { useMobileHeaderStore } from "@/stores/layout/mobile-header-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { isHistoryPath } from "@/stores/tabs/kinds/history";
import { isSettingsPath } from "@/stores/tabs/kinds/settings";

/**
 * The phone app header. Replaces the desktop tab strip + control cluster with a
 * hamburger (opens the navigation drawer), the current surface title, and a
 * right cluster carrying the global status controls plus the current surface's
 * own action. Rendered only below md (see `AppHeader`), so desktop is
 * untouched.
 */
export function MobileAppHeader(): ReactNode {
  const setNavOpen = useMobileNavStore((state) => state.setOpen);
  const rightActions = useMobileHeaderStore((state) => state.rightActions);
  const showGlobalResourceMonitor = useSettingsStore(
    (state) => state.showGlobalResourceMonitor,
  );
  const epicId = useMobileHeaderEpicId();
  const epicTabId = useMobileHeaderEpicTabId();
  const title = useMobileHeaderTitle(epicId, epicTabId);
  const settingsSection = useSettingsSectionLabel();
  return (
    <header
      data-testid="app-header"
      data-variant="app"
      data-mobile-shell-touch-scope=""
      // `bg-background`, not the desktop header's `bg-canvas`: canvas exists to
      // mark window chrome (title bar + tab strip) apart from content, and at
      // this width there is no tab strip - the row is just a title sitting on
      // the page, so the 1.5% lightness step between the two tokens read as a
      // seam rather than as intent.
      // The row is a plain header height: the status-bar strip above it is
      // reserved by `#root`, and `bg-background` is the same token the strip
      // shows, so the two read as one surface without the header having to
      // reach under the bar.
      className="relative z-20 flex h-10 shrink-0 items-center gap-1 bg-background px-2 text-foreground after:absolute after:inset-x-0 after:bottom-0 after:z-1 after:h-px after:bg-border/90 after:content-[''] pointer-coarse:touch-chrome"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Open menu"
        data-testid="mobile-nav-trigger"
        onClick={() => setNavOpen(true)}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <Menu className="size-4" />
      </Button>
      <MobileHeaderTitleSlot
        title={title}
        settingsSection={settingsSection}
        epicId={epicId}
      />
      {/* Right cluster: global status controls sit parallel to the hamburger,
          mirroring the desktop header's rate-limit + resource-monitor gating
          (navDisabled never applies here - MobileAppHeader only renders for the
          "app" variant). They come before the route-provided actions so a
          route's own controls (e.g. the epic overflow) land outermost. */}
      <div className="flex shrink-0 items-center gap-1">
        <RateLimitIconButton />
        {showGlobalResourceMonitor ? (
          <ResourceMonitorPopover className={undefined} />
        ) : null}
        {/* Last of the global controls, matching the desktop header's order
            (rate limit -> resource monitor -> bell). */}
        <MobileNotificationsButton />
        {/* The epic route's control is DERIVED from the route, not published
            into the slot below. The slot is one last-writer-wins cell: a
            surface fills it from an effect and clears it on unmount, so any
            other mounted surface that owns actions (the landing terminal
            panel) can overwrite or blank the epic's trigger purely by the
            order its effects run in - and nothing re-runs the epic's write
            afterwards. The trigger needs only the route's `tabId`, so reading
            it here makes it a function of the route and removes both the
            ordering and the mount-gating (a trigger published from inside the
            epic session tree cannot appear until that session is live).
            Surfaces whose actions genuinely depend on their own state keep
            using the slot. */}
        {epicTabId === null ? (
          rightActions
        ) : (
          <EpicMobileSwitcherTrigger tabId={epicTabId} />
        )}
      </div>
    </header>
  );
}

interface MobileHeaderTitleSlotProps {
  readonly title: string | null;
  readonly settingsSection: string | null;
  /** The open epic on the epic route; null on every other surface. */
  readonly epicId: string | null;
}

/**
 * The header's centre slot. Always claims the row's spare width so the right
 * cluster stays pinned right, even on the landing route where there is no title
 * to show.
 *
 * An epic's name is the one title the user owns, so it renders as an inline
 * editable field rather than static text; every other surface's title names a
 * place in the app and is not the user's to change.
 */
function MobileHeaderTitleSlot(props: MobileHeaderTitleSlotProps): ReactNode {
  const { title, settingsSection, epicId } = props;
  if (settingsSection !== null) {
    return (
      // Drill-down breadcrumb for settings section routes: the parent crumb
      // navigates back to the full-screen section list, replacing the
      // dedicated back-link row the settings layout used to render.
      // Unpadded crumbs so "Settings" sits exactly where the plain title
      // does on the index route - no shift when the section crumb appears.
      // The link's tap target comes from the full header-row height.
      <span
        className="flex h-full min-w-0 flex-1 items-center gap-1"
        data-testid="mobile-header-title"
      >
        <Link
          to="/settings"
          data-testid="mobile-header-settings-crumb"
          className="flex h-full shrink-0 items-center font-medium text-muted-foreground transition-colors active:text-foreground"
        >
          Settings
        </Link>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium text-foreground">
          {settingsSection}
        </span>
      </span>
    );
  }
  if (title === null) {
    return <span className="min-w-0 flex-1" />;
  }
  if (epicId !== null) {
    return (
      // Full-height slot so the title's tap target is the whole header row,
      // the same way the settings crumb takes its target from the row.
      <span
        className="flex h-full min-w-0 flex-1 items-center"
        data-testid="mobile-header-title"
      >
        <MobileEpicHeaderTitle epicId={epicId} title={title} />
      </span>
    );
  }
  return (
    <span
      className="min-w-0 flex-1 truncate font-medium text-foreground"
      data-testid="mobile-header-title"
    >
      {title}
    </span>
  );
}

/**
 * The open epic's id on the epic route, null everywhere else.
 */
function useMobileHeaderEpicId(): string | null {
  const epicId = useMatch({
    from: "/epics/$epicId/$tabId",
    shouldThrow: false,
    select: (match) => match.params.epicId,
  });
  return epicId ?? null;
}

/**
 * The open epic's tab id on the epic route, null everywhere else.
 */
function useMobileHeaderEpicTabId(): string | null {
  const tabId = useMatch({
    from: "/epics/$epicId/$tabId",
    shouldThrow: false,
    select: (match) => match.params.tabId,
  });
  return tabId ?? null;
}

/**
 * The active settings section's label when the route is a settings section
 * (drill-down depth 1), null on the settings index and everywhere else.
 */
function useSettingsSectionLabel(): string | null {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const section = SETTINGS_SECTIONS.find((s) =>
    pathname.startsWith(`/settings/${s.id}`),
  );
  return section === undefined ? null : section.label;
}

/**
 * Derives the header title from the active route: the open epic's name on the
 * epic route, otherwise a per-surface label.
 *
 * An epic's name has two live sources and the header takes whichever has
 * resolved, live session first. The tab record's name is a cache of that same
 * title, written by the epic route's active-session effects - so it is the
 * faster of the two (it survives a restart in the persisted canvas) but also
 * the one that can be absent or stale, because a route restored straight into
 * an epic reaches this header before anything has written it. The registered
 * session is the authority whenever it is up, which is the same reason the
 * title control reads its permission role from that registry too.
 */
function useMobileHeaderTitle(
  epicId: string | null,
  epicTabId: string | null,
): string | null {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const tabName = useEpicCanvasStore((state) =>
    epicTabId === null ? null : (state.tabsById[epicTabId]?.name ?? null),
  );
  const liveTitle = useRegisteredEpicTitle(epicId);
  const epicName = firstResolvedTitle(liveTitle, tabName);
  // An epic whose name has not resolved yet falls through to no title rather
  // than to a placeholder, so the header never flashes a stand-in and then
  // swaps it for the real name.
  if (epicTabId !== null && epicName !== null) return epicName;
  if (isSettingsPath(pathname)) return "Settings";
  if (isHistoryPath(pathname)) return "History";
  // Titles name a place you navigated TO. The composer surfaces - landing and
  // drafts - are where you already are, and each one opens with a hero greeting
  // that carries the page, so "Traycer" and "New task" were both labelling the
  // obvious. History, Settings and an epic's name are the ones that earn a row.
  return null;
}

/**
 * The first candidate that carries an actual name. Blank is "not resolved
 * yet", not a title: a tab record can hold an empty name, and rendering it
 * would present an empty rename field as though the epic were untitled.
 */
function firstResolvedTitle(
  preferred: string | null,
  fallback: string | null,
): string | null {
  const fromPreferred = preferred === null ? "" : preferred.trim();
  if (fromPreferred.length > 0) return fromPreferred;
  const fromFallback = fallback === null ? "" : fallback.trim();
  return fromFallback.length > 0 ? fromFallback : null;
}
