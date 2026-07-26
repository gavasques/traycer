import { Outlet } from "@tanstack/react-router";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { useIsMobile } from "@/hooks/ui/use-mobile";
import { cn } from "@/lib/utils";
import "./settings-touch-targets.css";

// On mobile the drill-down navigation lives in the shell header's
// "Settings > <section>" breadcrumb (mobile-app-header.tsx), so this layout
// renders no chrome of its own there - just the section outlet.
export function SettingsLayout() {
  const isMobile = useIsMobile();
  return (
    <div
      data-settings-touch-scope
      className={cn(
        "flex min-h-0 flex-1 bg-background text-foreground",
        isMobile && "flex-col",
      )}
    >
      {isMobile ? null : (
        <SettingsSidebar mode={{ kind: "route" }} variant="rail" />
      )}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
