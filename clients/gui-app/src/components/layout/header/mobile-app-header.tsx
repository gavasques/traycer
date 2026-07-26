import { type ReactNode } from "react";
import { ChevronRight, Menu } from "lucide-react";
import { Link, useMatch, useRouterState } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { RateLimitIconButton } from "@/components/layout/header/rate-limit-icon";
import { ResourceMonitorPopover } from "@/components/resources/resource-monitor-popover";
import "@/components/layout/shell/mobile-shell-touch-targets.css";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import { useMobileHeaderStore } from "@/stores/layout/mobile-header-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { isHistoryPath } from "@/stores/tabs/kinds/history";
import { isSettingsPath } from "@/stores/tabs/kinds/settings";

/**
 * The phone app header. Replaces the desktop tab strip + control cluster with a
 * hamburger (opens the navigation drawer), the current surface title, and a
 * right slot the active route fills with its own actions. Rendered only below
 * md (see `AppHeader`), so desktop is untouched.
 */
export function MobileAppHeader(): ReactNode {
  const setNavOpen = useMobileNavStore((state) => state.setOpen);
  const rightActions = useMobileHeaderStore((state) => state.rightActions);
  const showGlobalResourceMonitor = useSettingsStore(
    (state) => state.showGlobalResourceMonitor,
  );
  const title = useMobileHeaderTitle();
  const settingsSection = useSettingsSectionLabel();
  return (
    <header
      data-testid="app-header"
      data-variant="app"
      data-mobile-shell-touch-scope=""
      className="relative z-20 flex h-[calc(2.5rem_+_env(safe-area-inset-top))] shrink-0 items-center gap-1 bg-canvas px-2 pt-[env(safe-area-inset-top)] text-canvas-foreground after:absolute after:inset-x-0 after:bottom-0 after:z-1 after:h-px after:bg-border/90 after:content-['']"
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
      {settingsSection === null ? (
        <span
          className="min-w-0 flex-1 truncate font-medium text-foreground"
          data-testid="mobile-header-title"
        >
          {title}
        </span>
      ) : (
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
      )}
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
        {rightActions}
      </div>
    </header>
  );
}

/**
 * The active settings section's label when the route is a settings section
 * (drill-down depth 1), null on the settings index and everywhere else.
 */
function useSettingsSectionLabel(): string | null {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const section = SETTINGS_SECTIONS.find((s) =>
    pathname.startsWith(`/settings/${s.id}`),
  );
  return section === undefined ? null : section.label;
}

/**
 * Derives the header title from the active route: the open epic's name on the
 * epic route, otherwise a per-surface label.
 */
function useMobileHeaderTitle(): string {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const epicTabId = useMatch({
    from: "/epics/$epicId/$tabId",
    shouldThrow: false,
    select: (match) => match.params.tabId,
  });
  const epicName = useEpicCanvasStore((state) =>
    epicTabId === undefined ? null : (state.tabsById[epicTabId]?.name ?? null),
  );
  // While the epic tab name is still unresolved, fall through to the app-name
  // fallback rather than flashing an empty header.
  if (epicTabId !== undefined && epicName !== null) return epicName;
  if (isSettingsPath(pathname)) return "Settings";
  if (isHistoryPath(pathname)) return "History";
  if (pathname.startsWith("/draft")) return "New task";
  return "Traycer";
}
