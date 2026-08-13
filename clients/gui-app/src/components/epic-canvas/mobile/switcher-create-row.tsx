import { useState } from "react";
import { MessageSquarePlus, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MobileNewTerminalDialog } from "@/components/epic-canvas/mobile/mobile-new-terminal-dialog";
import { useEpicPermissionRole } from "@/lib/epic-selectors";
import { isEditableRole } from "@/lib/epic-permissions";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { ACTIVE_TILE_PLACEMENT } from "@/lib/canvas/conversation-tile-placement";

interface SwitcherCreateRowProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}

/**
 * The switcher sheet's create row: **New chat** and **New terminal**, the two
 * ways an epic grows a tab. It sits above the category bar because creating an
 * agent or a terminal is a peer of picking one, not a property of whichever
 * category happens to be open - so those two categories carry no "+" of their
 * own. Artifact creation stays a per-category affordance in the Artifacts list,
 * where its kind menu belongs.
 *
 * Both actions replace the sheet with their own surface (the New Conversation
 * modal, the terminal picker dialog), so the sheet closes as they open.
 *
 * Editor-gated as a whole: a viewer's create is server-rejected, so an ungated
 * row would only lead to a dead end. The gate is the same role predicate the
 * desktop sidebar uses.
 */
export function SwitcherCreateRow(props: SwitcherCreateRowProps) {
  const { epicId, tabId, onClose } = props;
  const canMutate = isEditableRole(useEpicPermissionRole());
  const [terminalPickerOpen, setTerminalPickerOpen] = useState(false);

  const handleNewChat = () => {
    // The exact desktop funnel (see NewConversationModalAction): force chat
    // mode, then open the shared New Conversation modal request for this epic.
    // NewConversationModalHost (mounted on the active epic route) renders it.
    useNewConversationModalStore.getState().setComposerMode(epicId, "chat");
    useNewConversationModalOpenStore.getState().open({
      epicId,
      tabId,
      placement: ACTIVE_TILE_PLACEMENT,
      parentId: null,
      hostId: null,
    });
    onClose();
  };

  if (!canMutate) return null;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-canvas-border/70 p-2">
        <Button
          type="button"
          variant="outline"
          data-testid="switcher-new-chat"
          onClick={handleNewChat}
          className="min-h-11 flex-1 justify-center gap-2 text-ui-sm"
        >
          <MessageSquarePlus className="size-4" />
          New chat
        </Button>
        <Button
          type="button"
          variant="outline"
          data-testid="switcher-new-terminal"
          onClick={() => setTerminalPickerOpen(true)}
          className="min-h-11 flex-1 justify-center gap-2 text-ui-sm"
        >
          <SquareTerminal className="size-4" />
          New terminal
        </Button>
      </div>
      <MobileNewTerminalDialog
        epicId={epicId}
        tabId={tabId}
        open={terminalPickerOpen}
        onOpenChange={setTerminalPickerOpen}
        onLaunched={onClose}
      />
    </>
  );
}
