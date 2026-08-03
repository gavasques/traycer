import { useRouterState } from "@tanstack/react-router";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { SettingsPanelForSection } from "@/components/settings/settings-modal-content";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { cn } from "@/lib/utils";
import "./settings-touch-targets.css";

/** Route-independent Settings body. The current route selects its section. */
export function SettingsSurface(props: { readonly lastPath: string | null }) {
  const sectionPath = useRouterState({
    select: (state) =>
      state.location.pathname.startsWith("/settings")
        ? state.location.pathname
        : props.lastPath,
  });
  const section = settingsSectionFromPath(sectionPath);
  // Phone rules, unchanged in intent from when they lived on the route shell:
  // the rail is a pointer-width affordance, so below md the surface stacks and
  // shows the panel alone (`/settings` itself renders the section list - see
  // `settings-index-route-components.tsx`), under the coarse-pointer
  // hit-area scope. Desktop (>=768px) is byte-for-byte unaffected.
  const isMobile = useIsMobileViewport();

  return (
    <div
      data-settings-touch-scope
      className={cn(
        "flex min-h-0 min-w-0 flex-1 bg-background text-foreground",
        isMobile && "flex-col",
      )}
    >
      {isMobile ? null : (
        <SettingsSidebar mode={{ kind: "route" }} variant="rail" />
      )}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <SettingsPanelForSection section={section} />
      </div>
    </div>
  );
}

function settingsSectionFromPath(pathname: string | null) {
  if (pathname === "/settings/service") return "host";
  return (
    SETTINGS_SECTIONS.find(
      (candidate) => `/settings/${candidate.id}` === pathname,
    )?.id ?? "general"
  );
}
