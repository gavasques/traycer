import { type ReactNode } from "react";
import { Laptop } from "lucide-react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostUnavailability,
  type HostUnavailability,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isHostDialable } from "@/components/layout/host-readiness-controller-context";
import { useHostBinding } from "@/lib/host";
import { useRemoteSessionPollReadiness } from "@/hooks/agent/use-host-reachability";
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

/**
 * The badge's vocabulary, which is the same three reasons every other host
 * surface distinguishes ({@link hostUnavailability}). One "Offline" for all of
 * them told someone to go restart a machine that was working, and hid the
 * upgrade that was the actual remedy.
 *
 * `indeterminate` gets its own word rather than borrowing either side's: the
 * row it sits on stays SELECTABLE (the transport dials on a failed liveness
 * read), so a badge reading "Offline" would contradict the control it labels,
 * and one reading "Online" would state a fact nobody has established.
 */
const CHOOSE_HOST_BADGE: Record<
  HostUnavailability | "dialable",
  { readonly label: string; readonly variant: "default" | "secondary" }
> = {
  dialable: { label: "Online", variant: "default" },
  offline: { label: "Offline", variant: "secondary" },
  "plan-restricted": { label: "Local only", variant: "secondary" },
  indeterminate: { label: "Status unknown", variant: "secondary" },
};

function ChooseHostRow(props: {
  readonly entry: HostDirectoryEntry;
  readonly onSelect: () => void;
}): ReactNode {
  // Subscribed rather than read: the session cache is pull-only and a
  // readiness flip changes no directory value, so a bare read would freeze
  // this row's answer until an unrelated directory emit happened by.
  const hasReadySession = useRemoteSessionPollReadiness(props.entry.hostId);
  // The SAME predicate the readiness gate will apply to the selection this row
  // makes, so the row can only enable a pick that resolves to `ready`. Asking
  // a second, hand-rolled question here is how a row and the surface behind it
  // stop agreeing - and the disagreement lands the user on the dead end this
  // wall exists to prevent.
  const selectable = isHostDialable(props.entry, hasReadySession);
  const badge =
    CHOOSE_HOST_BADGE[hostUnavailability(props.entry) ?? "dialable"];
  return (
    <Button
      type="button"
      variant="outline"
      // Unreachable hosts render (the user should see their own machine) but
      // are NOT selectable: selecting one would bind it and land on the
      // unavailable-host surface, which on a relay-only shell has no switch
      // or recovery action - a dead-end this wall exists to prevent. The
      // wall's Refresh action re-asks the registry, and rows re-enable live
      // as hosts come online.
      disabled={!selectable}
      className="h-12 w-full justify-start gap-3 px-4"
      data-testid={`choose-host-${props.entry.hostId}`}
      onClick={props.onSelect}
    >
      <Laptop className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-left">
        {props.entry.label}
      </span>
      <Badge variant={badge.variant}>{badge.label}</Badge>
    </Button>
  );
}
