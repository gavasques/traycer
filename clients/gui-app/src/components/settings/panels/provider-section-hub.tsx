import { useId, type ReactNode } from "react";
import {
  Boxes,
  Braces,
  ChevronDown,
  ChevronUp,
  Gauge,
  KeyRound,
  Puzzle,
  Server,
  Sparkles,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { Tabs as TabsPrimitive } from "radix-ui";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { cn } from "@/lib/utils";
import {
  providerSectionMeta,
  type ProviderTabKey,
} from "./provider-settings-tabs";

/**
 * One glyph per section, so a tile is recognisable before its label is read.
 *
 * EXHAUSTIVE `Record`, not a partial one: a section added to
 * `PROVIDER_TAB_ORDER` without an icon would otherwise render an empty box on
 * phones and nothing at all would mark the omission. The compiler asks instead.
 */
const PROVIDER_SECTION_ICONS: Record<ProviderTabKey, LucideIcon> = {
  account: KeyRound,
  usage: Gauge,
  general: SquareTerminal,
  env: Braces,
  modelProviders: Boxes,
  mcp: Server,
  plugins: Puzzle,
  skills: Sparkles,
};

/**
 * The phone presentation of the provider section rail: a grid of section tiles
 * that names EVERY supported section on entry, collapsing to a single row once
 * one is picked.
 *
 * Why a grid rather than the desktop tab bar. Below `md` that bar wraps into
 * two ragged rows, and it is the FOURTH row of chrome on that screen (mobile
 * crumb header -> provider select -> provider header -> rail), so the wrap
 * pushes content off the fold. The three conventional repairs each break a
 * rule this surface has to keep: a horizontally scrolling row hides section
 * names behind a gesture; a drill-in nests the same gesture the settings
 * surface already spends on picking a section (`settings-surface.tsx`); an
 * accordion or a single scrolling page would mount several section bodies at
 * once, and MCP / Plugins / Skills / Model Providers each drive their own host
 * queries and unbounded lists.
 *
 * The grid keeps the one-pane-at-a-time invariant intact - only the LIST is
 * bespoke, so Radix still mounts exactly one `TabsContent` BODY (every pane's
 * div stays in the DOM, hidden while inactive) - and it absorbs the
 * 3-8 sections `supportedTabsFor` can return with no per-count geometry:
 * two columns, however many rows that takes.
 *
 * Built on `TabsPrimitive` rather than `@/components/ui/tabs` because the tile
 * is a different SHAPE, not a restyled pill (icon over a wrapping two-line
 * label, full-width target, no underline), and the shared wrapper's line/filled
 * variants would have to be fought class by class to get there. Triggers still
 * carry `role="tab"` and Radix's roving focus, which is what keeps the existing
 * panel tests' `selectTab` helper honest.
 */
export function ProviderSectionHub({
  tabs,
  activeTab,
  state,
  expanded,
  onExpandedChange,
  labelFor,
}: {
  readonly tabs: readonly ProviderTabKey[];
  readonly activeTab: ProviderTabKey;
  readonly state: ProviderCliState;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly labelFor: (tab: ProviderTabKey) => string;
}): ReactNode {
  const gridId = useId();
  const ActiveIcon = PROVIDER_SECTION_ICONS[activeTab];
  // A one-section provider has nothing to switch to, so the bar is a caption
  // rather than a control - an expander that opens a grid of one is a lie
  // about there being a choice.
  const canExpand = tabs.length > 1;
  const showGrid = expanded && canExpand;
  return (
    <div className="flex w-full max-w-full shrink-0 flex-col gap-2 border-b border-border/60 pb-2">
      <button
        type="button"
        // Not a tab: it opens and closes the grid. Selection stays entirely
        // with the triggers below, so nothing here can desync from `activeTab`.
        onClick={() => onExpandedChange(!expanded)}
        disabled={!canExpand}
        aria-expanded={showGrid}
        aria-controls={showGrid ? gridId : undefined}
        className={cn(
          "flex w-full max-w-full items-center justify-between gap-3 rounded-md border border-border/60 bg-card/40 px-3 py-2 text-left",
          canExpand ? "hover:bg-card/60" : "cursor-default",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <ActiveIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium text-ui-sm text-foreground">
            {labelFor(activeTab)}
          </span>
        </span>
        {canExpand ? (
          <span className="flex shrink-0 items-center gap-1 text-ui-xs text-muted-foreground">
            {showGrid ? "Collapse" : "All sections"}
            {showGrid ? (
              <ChevronUp className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
          </span>
        ) : null}
      </button>
      {/* The grid expands IN PLACE rather than rising as a bottom sheet. Both
          carry the same information; the sheet's advantage is reach (the top of
          a tall phone is outside the thumb arc, and a sheet is not), its cost
          is an overlay over the pane you are configuring. If reach testing
          picks the sheet, the swap is local to this block - the state, the
          triggers and the one-mounted-pane invariant are all unaffected. */}
      {showGrid ? (
        <TabsPrimitive.List
          id={gridId}
          className="grid w-full max-w-full grid-cols-2 gap-2"
        >
          {tabs.map((tab) => {
            const Icon = PROVIDER_SECTION_ICONS[tab];
            const meta = providerSectionMeta(tab, state);
            return (
              <TabsPrimitive.Trigger
                key={tab}
                value={tab}
                // Only the re-pick case. A selection that CHANGES the active
                // section collapses through the `Tabs` value change instead,
                // which is where every activation path (mouseDown, roving
                // focus, Enter/Space) converges - see `providers-settings-panel`.
                onClick={() => onExpandedChange(false)}
                className={cn(
                  "flex w-full min-w-0 flex-col items-start gap-1.5 rounded-lg border border-border/60 bg-card/40 p-3 text-left transition-colors",
                  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                  "data-[state=active]:border-primary/50 data-[state=active]:bg-primary/10",
                )}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="w-full text-ui-sm leading-snug font-medium text-foreground">
                  {labelFor(tab)}
                </span>
                {meta === null ? null : (
                  <span className="w-full text-ui-xs leading-snug text-muted-foreground">
                    {meta}
                  </span>
                )}
              </TabsPrimitive.Trigger>
            );
          })}
        </TabsPrimitive.List>
      ) : null}
    </div>
  );
}
