import { type ReactNode } from "react";
import { Laptop } from "lucide-react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useHostBinding } from "@/lib/host";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";

/**
 * Readiness-gate surface for the `choose-host` state: a signed-in shell with
 * NO local host, several hosts in the directory, and none selected. The
 * directory refuses to guess between multiple hosts, and only a desktop has
 * a local host to break the tie - so this device must ask. Rendered inside
 * the readiness fallback (a full-screen wall by design: nothing behind it
 * can function until a host is selected, so there is no dismissal).
 *
 * Tapping a host routes through `HostDirectoryService.selectById`, which
 * persists the selection - the wall never reappears on later launches, and
 * Settings' host pickers stay the way to switch afterwards.
 */
export function ChooseHostSurface(): ReactNode {
  const binding = useHostBinding();
  const list = useHostDirectoryList();
  if (binding === null) return null;
  const entries = list.data ?? [];
  return (
    <ul
      className="flex w-full max-w-md flex-col gap-2"
      data-testid="choose-host-surface"
    >
      {entries.map((entry) => (
        <li key={entry.hostId}>
          <ChooseHostRow
            entry={entry}
            onSelect={() => {
              binding.directory.selectById(entry.hostId);
            }}
          />
        </li>
      ))}
    </ul>
  );
}

function ChooseHostRow(props: {
  readonly entry: HostDirectoryEntry;
  readonly onSelect: () => void;
}): ReactNode {
  const online = props.entry.status === "available";
  return (
    <Button
      type="button"
      variant="outline"
      // Offline hosts render (the user should see their own machine) but are
      // NOT selectable: selecting one would bind it and land on the
      // unavailable-host surface, which on a relay-only shell has no switch
      // or recovery action - a dead-end this wall exists to prevent. The
      // wall's Refresh action re-asks the registry, and rows re-enable live
      // as hosts come online.
      disabled={!online}
      className="h-12 w-full justify-start gap-3 px-4"
      data-testid={`choose-host-${props.entry.hostId}`}
      onClick={props.onSelect}
    >
      <Laptop className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-left">
        {props.entry.label}
      </span>
      <Badge variant={online ? "default" : "secondary"}>
        {online ? "Online" : "Offline"}
      </Badge>
    </Button>
  );
}
