import { memo } from "react";
import { ComposerAttachImageButton } from "@/components/home/toolbar/composer-attach-image-button";
import { PermissionsPicker } from "@/components/home/pickers/permissions-picker";
import type {
  PermissionMode,
  AgentMode,
} from "@/components/home/data/landing-options";
import { AgentModeToggle } from "@/components/home/pickers/agent-mode-toggle";

interface ComposerToolbarLeftProps {
  onAttachImages: (files: ReadonlyArray<File>) => void;
  agentMode: AgentMode;
  onAgentModeChange: (next: AgentMode) => void;
  permission: PermissionMode;
  onPermissionChange: (next: PermissionMode) => void;
  /**
   * Permission modes the active harness honors. Forwarded straight to
   * `PermissionsPicker`; `null` while the harness catalog is still loading
   * (every option stays enabled until the host reports back).
   */
  supportedPermissionModes: ReadonlyArray<PermissionMode> | null;
  /**
   * Display label of the active harness (e.g. "Cursor"). Threaded into the
   * picker's "Not supported by <name>" copy for disabled options. `null` while
   * the harness catalog is still loading, in which case the picker falls back
   * to "this provider".
   */
  harnessLabel: string | null;
  showNextTurnPermissionNote: boolean;
  showAgentModeTooltip: boolean;
  settingsLocked: boolean;
}

function ComposerToolbarLeftImpl(props: ComposerToolbarLeftProps) {
  const {
    onAttachImages,
    agentMode,
    onAgentModeChange,
    permission,
    onPermissionChange,
    supportedPermissionModes,
    harnessLabel,
    showNextTurnPermissionNote,
    showAgentModeTooltip,
    settingsLocked,
  } = props;

  return (
    <div className="flex min-w-0 items-center gap-1">
      <ComposerAttachImageButton onAttachImages={onAttachImages} />
      <PermissionsPicker
        value={permission}
        disabled={settingsLocked}
        onChange={onPermissionChange}
        supportedPermissionModes={supportedPermissionModes}
        harnessLabel={harnessLabel}
      />
      <AgentModeToggle
        value={agentMode}
        disabled={settingsLocked}
        showTooltip={showAgentModeTooltip}
        onChange={onAgentModeChange}
      />
      {showNextTurnPermissionNote ? (
        <output
          aria-live="polite"
          aria-atomic="true"
          className="max-w-[min(28vw,14rem)] truncate text-ui-xs text-muted-foreground"
        >
          New mode applies to the next turn
        </output>
      ) : null}
    </div>
  );
}

export const ComposerToolbarLeft = memo(ComposerToolbarLeftImpl);
