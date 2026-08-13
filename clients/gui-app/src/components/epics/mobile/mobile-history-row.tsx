import {
  memo,
  useCallback,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Link } from "@tanstack/react-router";
import { Check, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import {
  canDeleteHistoryItem,
  canEditHistoryItemTitle,
  type HistoryItem,
} from "@/components/home/data/home-page.data";
import { HistoryRowLeadingIcon } from "@/components/epics/epics-list-shared";
import { historyItemDisplayTitle } from "@/components/epics/history-item-title";
import {
  TRAY_ACTION_PX,
  useRowSwipeTray,
} from "@/components/epics/mobile/use-row-swipe-tray";
import { useLongPress } from "@/components/epics/mobile/use-long-press";
import { useEpicUpdateTitle } from "@/hooks/epic/use-epic-title-mutation";
import { useInlineRename } from "@/hooks/ui/use-inline-rename";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { cn } from "@/lib/utils";

/**
 * How long the row takes to settle back to - or out to - its resting offset
 * once the finger is gone. Matches the shell drawer's settle so the two
 * horizontal motions in the app read as the same material.
 *
 * A class rather than an inline style, and that is load-bearing: `press-scrim`
 * lands its tint by zeroing `transition-duration` under `:active`, and an
 * inline duration would outrank it and stretch the press tint over the settle.
 */
const SETTLE_CLASS = "transition-transform duration-[220ms]";

type TrayActionKind = "pin" | "rename" | "delete";

interface TrayAction {
  readonly kind: TrayActionKind;
  readonly label: string;
  readonly icon: ReactNode;
  readonly destructive: boolean;
  readonly run: () => void;
}

export interface MobileHistoryRowProps {
  readonly item: HistoryItem;
  readonly selectionMode: boolean;
  readonly isSelected: boolean;
  readonly isTrayOpen: boolean;
  readonly isPinPending: boolean;
  readonly onTrayOpenChange: (epicId: string, open: boolean) => void;
  readonly onToggleSelection: (id: string) => void;
  readonly onRequestDelete: (ids: ReadonlyArray<string>) => void;
  readonly onSetPinned: (epicId: string, pinned: boolean) => void;
  readonly onOpen: (item: HistoryItem) => void;
}

/**
 * One task in the phone list: title, when it was last touched, and nothing
 * else at rest.
 *
 * The row carries three touch gestures and they are deliberately layered so
 * only one can ever win. A tap opens the task. A swipe left reveals the action
 * tray - never committing on its own, because delete lives in there. A
 * press-and-hold enters selection mode, the same mode the toolbar's Select
 * button opens, with this row already checked.
 *
 * The recognizers cancel each other rather than vote: the swipe cancels a
 * pending hold the moment it declares an axis, and either one having fired
 * swallows the click the browser synthesises afterwards. Without that swallow
 * a long press would select the row AND open it.
 */
export const MobileHistoryRow = memo(function MobileHistoryRow(
  props: MobileHistoryRowProps,
): ReactNode {
  const {
    item,
    selectionMode,
    isSelected,
    isTrayOpen,
    isPinPending,
    onTrayOpenChange,
    onToggleSelection,
    onRequestDelete,
    onSetPinned,
    onOpen,
  } = props;

  const displayTitle = historyItemDisplayTitle(item);
  const canDelete = canDeleteHistoryItem(item);
  const canRename = canEditHistoryItemTitle(item);
  // Phases carry no pin bit of their own - they are reached through the epic
  // that owns them - so pinning is an epic-only affordance.
  const canPin = item.taskType === "epic";
  const isPhase = item.taskType === "phase";
  const linkTabId = useEpicCanvasStore(
    (s) => s.resolveTabIdForEpic(item.epicId) ?? item.epicId,
  );

  const { mutate: renameEpicTitle, isPending: isRenamePending } =
    useEpicUpdateTitle();
  const commitTitle = useCallback(
    (nextTitle: string) => {
      renameEpicTitle({
        epicDelta: { id: item.epicId, title: nextTitle, updatedAt: Date.now() },
      });
    },
    [item.epicId, renameEpicTitle],
  );
  const {
    isEditing: isRenaming,
    startEditing: startRenaming,
    inputProps: renameInputProps,
  } = useInlineRename({
    value: item.title,
    canEdit: canRename && !isRenamePending,
    onCommit: commitTitle,
  });

  const setTrayOpen = useCallback(
    (open: boolean) => {
      onTrayOpenChange(item.epicId, open);
    },
    [item.epicId, onTrayOpenChange],
  );

  const actions = buildTrayActions({
    item,
    displayTitle,
    canPin,
    canRename,
    canDelete,
    isPinPending,
    onSetPinned,
    onRequestDelete,
    onStartRename: startRenaming,
  });

  const longPress = useLongPress({
    // A row nobody may act on has nothing to select, so the hold would open a
    // mode with a permanently unchecked row in it.
    disabled: selectionMode || isRenaming || !canDelete,
    onLongPress: () => {
      setTrayOpen(false);
      onToggleSelection(item.epicId);
    },
  });
  const swipe = useRowSwipeTray({
    actionCount: actions.length,
    isOpen: isTrayOpen,
    onOpenChange: setTrayOpen,
    disabled: selectionMode || isRenaming,
    onDragStart: longPress.cancel,
  });

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    longPress.handlers.onPointerDown(event);
    swipe.handlers.onPointerDown(event);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    longPress.handlers.onPointerMove(event);
    swipe.handlers.onPointerMove(event);
  };
  const handlePointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    longPress.handlers.onPointerUp(event);
    swipe.handlers.onPointerUp(event);
  };
  const handlePointerCancel = (event: ReactPointerEvent<HTMLElement>) => {
    longPress.handlers.onPointerCancel(event);
    swipe.handlers.onPointerCancel(event);
  };

  // The gutter checkbox and the card's overlay are disjoint subtrees - neither
  // contains the other - so a tap lands on exactly one of them and there is no
  // bubbling path that could toggle twice. They are also only ever the SAME
  // action: the overlay is a plain button in selection mode, never the router
  // Link, so "open" is unreachable from either while the mode is on.
  const handleToggleSelection = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    if (!canDelete) return;
    onToggleSelection(item.epicId);
  };

  // Bound to the overlay ITSELF, never to an ancestor. The overlay is a router
  // Link, and the router runs its own click handler on the anchor and
  // navigates from it - by the time a click reached a handler on the card it
  // would already have gone somewhere, taking the Phase migration route, the
  // tray-dismiss tap and the selection toggle with it. A handler supplied to
  // the Link runs first and `preventDefault()` here is what stands the router
  // down.
  const handleActivate = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    if (longPress.consumedTap() || swipe.consumedTap()) return;
    if (selectionMode) {
      handleToggleSelection(event);
      return;
    }
    // While the tray is out the row itself is the way back: tapping it puts
    // the actions away rather than navigating past them.
    if (isTrayOpen) {
      swipe.close();
      return;
    }
    onOpen(item);
  };

  return (
    <li
      data-testid="epics-list-row"
      data-pinned={item.isPinned}
      // The tray is always mounted (it has to keep its place in the tab order),
      // so "revealed" is a state rather than a presence.
      data-tray-open={isTrayOpen ? "true" : undefined}
      className="flex items-stretch gap-2"
    >
      {selectionMode ? (
        // The gutter is a full touch target, not a 16px box with a 16px hit
        // area. Rows shifting right on entering the mode is the platform's own
        // behaviour and reads as the mode announcing itself.
        <button
          type="button"
          role="checkbox"
          aria-checked={isSelected && canDelete}
          aria-disabled={!canDelete}
          aria-label={`Select ${displayTitle}`}
          data-testid="epics-list-row-select"
          className={cn(
            "flex size-11 shrink-0 self-center items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            // An `aria-disabled` control still matches `:active`, so the press
            // has to be suppressed explicitly or the row tints for a tap that
            // does nothing.
            canDelete ? "active:press-scrim" : "cursor-not-allowed",
          )}
          onClick={handleToggleSelection}
        >
          <span
            aria-hidden="true"
            className={cn(
              "flex size-4 items-center justify-center rounded-sm border transition-colors",
              canDelete ? "opacity-100" : "opacity-50",
              isSelected && canDelete
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-transparent",
            )}
          >
            <Check className="size-3" />
          </span>
        </button>
      ) : null}
      {/* The clip is what makes the tray a reveal rather than a second row:
          it sits underneath at full height and is only ever seen through the
          gap the card leaves as it slides. */}
      <div className="relative min-w-0 flex-1 overflow-hidden rounded-md">
        {actions.length > 0 ? (
          <div
            className="absolute inset-y-0 right-0 flex items-stretch"
            style={{ width: `${swipe.trayWidthPx}px` }}
            data-testid="epics-list-row-tray"
            // The tray stays mounted while closed so it keeps its place in the
            // tab order; a keyboard reaching it opens it, because a caret on a
            // clipped control is a dead end.
            onFocus={() => {
              setTrayOpen(true);
            }}
          >
            {actions.map((action) => (
              <button
                key={action.kind}
                type="button"
                aria-label={action.label}
                data-testid={`epics-list-row-tray-${action.kind}`}
                style={{ width: `${TRAY_ACTION_PX}px` }}
                className={cn(
                  "flex shrink-0 items-center justify-center outline-none active:press-scrim focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
                  action.destructive
                    ? "bg-destructive/15 text-destructive"
                    : "bg-muted text-muted-foreground",
                )}
                onClick={() => {
                  swipe.close();
                  action.run();
                }}
              >
                {action.icon}
              </button>
            ))}
          </div>
        ) : null}
        <div
          data-testid="epics-list-row-card"
          // `pan-y` hands the vertical axis back to the list and keeps the
          // horizontal one here, which is what lets the swipe recognizer read
          // the drag without ever cancelling a scroll.
          className={cn(
            "relative flex touch-pan-y items-center gap-2 rounded-md bg-background p-3 text-ui-sm",
            "active:press-scrim pointer-coarse:touch-chrome",
            isSelected &&
              selectionMode &&
              canDelete &&
              "bg-accent/40 ring-1 ring-inset ring-primary/40",
            !swipe.isDragging && SETTLE_CLASS,
          )}
          style={{ transform: `translate3d(-${swipe.offsetPx}px, 0, 0)` }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        >
          {isRenaming ? null : (
            <RowActivationOverlay
              item={item}
              displayTitle={displayTitle}
              isPhase={isPhase}
              linkTabId={linkTabId}
              selectionMode={selectionMode}
              onActivate={handleActivate}
            />
          )}
          {/* Everything the row paints is inert, so the overlay is the only
              thing a touch can land on and activation has exactly one path.
              The pointer handlers above still see the gesture - pointer events
              reach the card by bubbling, which is not where the problem was. */}
          <span className="pointer-events-none flex shrink-0 items-center">
            <HistoryRowLeadingIcon item={item} />
          </span>
          {isRenaming ? (
            <input
              {...renameInputProps}
              type="text"
              aria-label={`Rename ${displayTitle}`}
              data-testid="epics-list-row-title-input"
              className="w-full min-w-0 flex-1 rounded border border-input bg-background/90 px-1.5 py-0.5 font-medium text-foreground outline-none focus:border-ring/70 focus-visible:ring-0"
            />
          ) : (
            <span className="pointer-events-none flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden">
              <span className="flex min-w-0 items-center gap-1.5">
                {item.isPinned ? (
                  // State, not an action: pinning is a tray action, and
                  // without this marker the sort order would be the only
                  // evidence it took effect.
                  <Pin
                    className="size-3 shrink-0 fill-current text-primary"
                    data-testid="epics-list-row-pinned"
                    role="img"
                    aria-label="Pinned"
                  />
                ) : null}
                <span className="truncate font-medium text-foreground">
                  {displayTitle}
                </span>
              </span>
              <span className="truncate text-ui-xs text-muted-foreground">
                updated {item.updatedLabel}
              </span>
            </span>
          )}
        </div>
      </div>
    </li>
  );
});

/**
 * The focusable, addressable surface over the row.
 *
 * A link rather than a bare click target so the row has a real destination -
 * focus ring, assistive-technology role, and a URL. It is also the ONLY thing
 * in the row a touch can land on: the card's contents are inert, so there is
 * one activation path rather than a race between this and an ancestor. In
 * selection mode it is a button instead, because a link that never goes
 * anywhere would announce a destination the tap does not take.
 */
function RowActivationOverlay(props: {
  readonly item: HistoryItem;
  readonly displayTitle: string;
  readonly isPhase: boolean;
  readonly linkTabId: string;
  readonly selectionMode: boolean;
  readonly onActivate: (event: ReactMouseEvent<HTMLElement>) => void;
}): ReactNode {
  const overlayClassName =
    "absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
  if (props.selectionMode) {
    return (
      <button
        type="button"
        aria-label={`Toggle selection for ${props.displayTitle}`}
        className={overlayClassName}
        onClick={props.onActivate}
      />
    );
  }
  return (
    <Link
      to="/epics/$epicId/$tabId"
      params={{ epicId: props.item.epicId, tabId: props.linkTabId }}
      search={{
        focusedAt: undefined,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        migrationSource: props.isPhase ? "phase" : undefined,
        focusPaneId: undefined,
        focusTileInstanceId: undefined,
      }}
      onClick={props.onActivate}
      aria-label={`Open task ${props.displayTitle}`}
      className={overlayClassName}
    />
  );
}

function buildTrayActions(args: {
  readonly item: HistoryItem;
  readonly displayTitle: string;
  readonly canPin: boolean;
  readonly canRename: boolean;
  readonly canDelete: boolean;
  readonly isPinPending: boolean;
  readonly onSetPinned: (epicId: string, pinned: boolean) => void;
  readonly onRequestDelete: (ids: ReadonlyArray<string>) => void;
  readonly onStartRename: () => void;
}): ReadonlyArray<TrayAction> {
  const { item, displayTitle } = args;
  const actions: TrayAction[] = [];
  if (args.canPin) {
    actions.push({
      kind: "pin",
      label: item.isPinned
        ? `Unpin ${displayTitle} from top`
        : `Pin ${displayTitle} to top`,
      icon: item.isPinned ? (
        <PinOff className="size-4" />
      ) : (
        <Pin className="size-4" />
      ),
      destructive: false,
      run: () => {
        // The pin flips optimistically, so a second tap landing inside the
        // mutation's window would toggle it straight back.
        if (args.isPinPending) return;
        args.onSetPinned(item.epicId, !item.isPinned);
      },
    });
  }
  if (args.canRename) {
    actions.push({
      kind: "rename",
      label: `Rename ${displayTitle}`,
      icon: <Pencil className="size-4" />,
      destructive: false,
      // Inline, exactly as the desktop row renames: the input lands where the
      // row already is, so the keyboard pushes the list rather than covering a
      // centred dialog.
      run: args.onStartRename,
    });
  }
  if (args.canDelete) {
    actions.push({
      kind: "delete",
      label: `Delete ${displayTitle}`,
      icon: <Trash2 className="size-4" />,
      destructive: true,
      // Opens the shared confirm dialog rather than deleting here. A swipe is
      // a cheap gesture and this is the one irreversible thing a row can do.
      run: () => {
        args.onRequestDelete([item.epicId]);
      },
    });
  }
  return actions;
}
