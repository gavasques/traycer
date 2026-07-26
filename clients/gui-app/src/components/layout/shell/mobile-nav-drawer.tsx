import { type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Bell,
  Layers,
  LogOut,
  Plus,
  Settings,
  SquareArrowOutUpRight,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import "@/components/layout/shell/mobile-shell-touch-targets.css";
import {
  Analytics,
  AnalyticsEvent,
  analyticsCountBucket,
} from "@/lib/analytics";
import { computeInitials } from "@/lib/auth/compute-initials";
import { resolveManageSubscriptionUrl } from "@/lib/auth/manage-subscription-url";
import { useAuthService } from "@/lib/host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { openNewEpicDraft } from "@/lib/commands/actions/new-epic";
import { openEpicFromList } from "@/lib/commands/actions/open-epic-from-list";
import { phaseMigrationRoute } from "@/lib/routes";
import { draftTabIntent, navigateToTabIntent } from "@/lib/tab-navigation";
import { cn } from "@/lib/utils";
import { epicDisplayTitle } from "@/lib/display-title";
import { DEFAULT_HISTORY_SEARCH } from "@/lib/history-search";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { useHistoryQuery } from "@/hooks/home/use-history-query";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import {
  useMergedNotificationUnreadCount,
  useNotificationBellState,
  useNotificationCenterHostState,
} from "@/stores/notifications/merged-notifications";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

const ROW_CLASS = "h-11 w-full justify-start gap-3 px-3";

/**
 * Left hamburger drawer for the mobile shell. It re-homes the global controls
 * that the desktop header carries (Settings, notifications, identity /
 * account) into a single menu, plus a "New task" entry and an inline recent
 * task list (the same `useHistoryQuery` source the landing page renders),
 * since the tab strip and header right-cluster are hidden on phones. Every
 * action reuses the same helper the desktop surfaces call. Mounted only on
 * mobile (see AppShell), so desktop is untouched.
 */
export function MobileNavDrawer(): ReactNode {
  const open = useMobileNavStore((state) => state.open);
  const setOpen = useMobileNavStore((state) => state.setOpen);
  const navigate = useNavigate();
  const profile = useAuthStore((state) => state.profile);
  const { openSettings } = useSystemTabModalActions();
  const setNotificationsOpen = useNotificationsPopoverStore(
    (state) => state.setOpen,
  );
  const unread = useMergedNotificationUnreadCount();
  const bellState = useNotificationBellState();
  const hostState = useNotificationCenterHostState();
  const runnerHost = useRunnerHost();
  const auth = useAuthService();

  const close = () => {
    setOpen(false);
  };
  const handleNewTask = () => {
    close();
    navigateToTabIntent(navigate, draftTabIntent(openNewEpicDraft()));
  };
  const handleSettings = () => {
    close();
    // Mirror the desktop user-menu call site's telemetry (user-menu.tsx). Not
    // lifted into the shared action, which would double-fire for the desktop
    // callers that already track here.
    Analytics.getInstance().track(AnalyticsEvent.SettingsOpened, {
      source: "direct_ui",
      section: "general",
    });
    openSettings({ section: null, resetToGeneral: true });
  };
  const handleNotifications = () => {
    close();
    // Mirror the desktop bell's open telemetry (notifications-bell.tsx). The
    // bell isn't mounted on mobile, so its edge-triggered open effect never
    // fires - this drawer button is the sole open path here, and it's a direct
    // UI interaction, hence entry_point "direct_ui".
    const attentionCount = bellState.kind === "attention" ? bellState.count : 0;
    Analytics.getInstance().track(AnalyticsEvent.NotificationCenterOpened, {
      entry_point: "direct_ui",
      host_state: hostState.isPartial ? "unknown" : "exact",
      attention_bucket:
        bellState.kind === "unknown"
          ? "unknown"
          : analyticsCountBucket(attentionCount),
      unread_bucket:
        bellState.kind === "unknown"
          ? "unknown"
          : analyticsCountBucket(unread),
    });
    setNotificationsOpen(true);
  };
  const handleManageSubscription = () => {
    close();
    void runnerHost
      .openExternalLink(resolveManageSubscriptionUrl(runnerHost.authnBaseUrl))
      .then(() => {
        Analytics.getInstance().track(
          AnalyticsEvent.SubscriptionManagementOpened,
          { source: "direct_ui" },
        );
      });
  };
  const handleSignOut = () => {
    close();
    Analytics.getInstance().track(AnalyticsEvent.SignOutRequested, {
      source: "direct_ui",
    });
    void auth.signOut();
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="left"
        showCloseButton={false}
        className="gap-0 p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
        data-testid="mobile-nav-drawer"
        data-mobile-shell-touch-scope=""
      >
        <SheetTitle className="sr-only">Menu</SheetTitle>
        <div className="flex shrink-0 items-center gap-3 border-b border-border/60 p-4">
          {profile === null ? null : (
            <>
              <Avatar size="sm">
                {profile.avatarUrl !== null ? (
                  <AvatarImage src={profile.avatarUrl} alt="" />
                ) : null}
                <AvatarFallback>
                  {computeInitials(profile.userName, profile.email)}
                </AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-ui-sm font-medium text-foreground">
                  {profile.userName}
                </span>
                <span className="truncate text-ui-xs text-muted-foreground">
                  {profile.email}
                </span>
              </div>
            </>
          )}
          {/* Mirrors the desktop bell trigger's badge states
              (notifications-bell.tsx); the sheet itself closes via overlay
              tap / swipe, so this slot hosts notifications instead of a
              close button. */}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
            data-testid="mobile-nav-notifications"
            className="relative ml-auto"
            onClick={handleNotifications}
          >
            <Bell className="size-4" />
            {bellState.kind === "attention" && (
              <span
                data-testid="mobile-nav-notifications-unread"
                aria-hidden
                className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-md bg-destructive px-1 text-overline font-semibold leading-none text-destructive-foreground tabular-nums shadow-sm ring-2 ring-background"
              >
                {bellState.count > 99 ? "99+" : bellState.count}
              </span>
            )}
            {bellState.kind === "quietDot" && (
              <span
                data-testid="mobile-nav-notifications-quiet-dot"
                aria-hidden
                className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary ring-2 ring-background"
              />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Sign out"
            data-testid="mobile-nav-sign-out"
            className="text-destructive hover:text-destructive"
            onClick={handleSignOut}
          >
            <LogOut className="size-4" />
          </Button>
        </div>
        {/* "New task" sits outside the scroll container so it stays pinned
            while the recent-task list below it scrolls. */}
        <nav className="flex min-h-0 flex-1 flex-col p-2">
          <Button
            type="button"
            variant="ghost"
            className={cn(ROW_CLASS, "shrink-0")}
            data-testid="mobile-nav-new-task"
            onClick={handleNewTask}
          >
            <Plus className="size-4" />
            <span className="flex-1 text-left">New task</span>
          </Button>
          <div className="mt-1 min-h-0 flex-1 overflow-y-auto">
            <DrawerTaskList onNavigate={close} />
          </div>
        </nav>
        <div className="flex shrink-0 flex-col gap-1 border-t border-border/60 p-2">
          <Button
            type="button"
            variant="ghost"
            className={ROW_CLASS}
            data-testid="mobile-nav-settings"
            onClick={handleSettings}
          >
            <Settings className="size-4" />
            <span className="flex-1 text-left">Settings</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={ROW_CLASS}
            data-testid="mobile-nav-manage-subscription"
            onClick={handleManageSubscription}
          >
            <SquareArrowOutUpRight className="size-4" />
            <span className="flex-1 text-left">Manage subscription</span>
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// Single source of a row's display label; raw epic titles can be empty, so
// apply the source-aware "Untitled task" fallback (phases carry their own
// baked fallback and render verbatim). Mirrors the landing list.
function drawerItemDisplayTitle(item: HistoryItem): string {
  return item.taskType === "phase"
    ? item.title
    : epicDisplayTitle({
        title: item.title,
        initialUserPrompt: item.initialUserPrompt,
      });
}

interface DrawerTaskListProps {
  readonly onNavigate: () => void;
}

/**
 * Inline recent-task list under "New task". Same data source as the landing
 * page's embedded list (`useHistoryQuery` → `useCloudEpicTasksQuery`) with the
 * default (unfiltered, recency-sorted) search - no filter/sort/selection
 * chrome; the full surface stays one tap away on the landing page.
 */
function DrawerTaskList(props: DrawerTaskListProps): ReactNode {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { openHistory } = useSystemTabModalActions();
  const {
    data,
    isPending,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useHistoryQuery({ search: DEFAULT_HISTORY_SEARCH, nowMs: null });
  const items = data?.items ?? [];

  const openItem = (item: HistoryItem) => {
    props.onNavigate();
    if (item.taskType === "phase") {
      void navigate(phaseMigrationRoute(item.epicId));
      return;
    }
    // Passing the row's raw title threads it through tab creation so the
    // cold-open canvas skeleton renders the real epic title immediately.
    openEpicFromList(navigate, item.epicId, pathname, {
      title: item.title,
      source: "direct_ui",
    });
  };

  let body: ReactNode;
  if (error !== null) {
    body = (
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-ui-sm text-muted-foreground">
        <span>Couldn&apos;t load tasks</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="mobile-nav-task-list-retry"
          onClick={() => {
            void refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  } else if (isPending) {
    body = (
      <div
        className="flex flex-col gap-1 px-1"
        data-testid="mobile-nav-task-list-loading"
        aria-busy="true"
        aria-label="Loading tasks"
      >
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 w-full rounded-md" />
        ))}
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <p className="px-3 py-2 text-ui-sm text-muted-foreground">No tasks yet</p>
    );
  } else {
    body = (
      <>
        {items.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant="ghost"
            className="h-10 w-full justify-start gap-3 px-3"
            data-testid="mobile-nav-task-row"
            onClick={() => {
              openItem(item);
            }}
          >
            <Layers className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-left font-normal">
              {drawerItemDisplayTitle(item)}
            </span>
            <span className="shrink-0 text-ui-xs text-muted-foreground">
              {item.updatedLabel}
            </span>
          </Button>
        ))}
        {hasNextPage ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mx-auto"
            disabled={isFetchingNextPage}
            data-testid="mobile-nav-task-list-show-more"
            onClick={() => {
              fetchNextPage();
            }}
          >
            {isFetchingNextPage ? (
              <AgentSpinningDots
                variant="dots"
                className="text-muted-foreground"
                testId={undefined}
              />
            ) : null}
            Show more
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <div
      className="flex flex-col gap-1 border-t border-border/60 pt-2"
      data-testid="mobile-nav-task-list"
    >
      <div className="flex items-center justify-between px-3 py-1">
        <span className="text-overline text-muted-foreground">
          Recent tasks
        </span>
        {/* Entry to the full history surface (search / filters / bulk
            actions) - the inline list is only the top of the feed. */}
        <button
          type="button"
          data-testid="mobile-nav-view-all-tasks"
          className="text-ui-xs text-muted-foreground transition-colors active:text-foreground"
          onClick={() => {
            props.onNavigate();
            openHistory();
          }}
        >
          View all
        </button>
      </div>
      {body}
    </div>
  );
}
