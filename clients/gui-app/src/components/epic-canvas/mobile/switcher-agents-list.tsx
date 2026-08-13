import { useCallback, useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import { SwitcherAgentIcon } from "@/components/epic-canvas/mobile/switcher-agent-icon";
import {
  SwitcherListEmpty,
  SwitcherListRow,
} from "@/components/epic-canvas/mobile/switcher-list-row";
import { SwitcherRowActions } from "@/components/epic-canvas/mobile/switcher-row-actions";
import { SwitcherNewChatRow } from "@/components/epic-canvas/mobile/switcher-create-actions";
import { useSwitcherActivate } from "@/components/epic-canvas/mobile/use-switcher-activate";
import { useOrderedSwitcherRecords } from "@/components/epic-canvas/mobile/switcher-record-order";
import {
  useEpicArtifactRecords,
  useEpicPermissionRole,
  type EpicTreeRecord,
} from "@/lib/epic-selectors";
import { isEditableRole } from "@/lib/epic-permissions";
import {
  computeDescendantCounts,
  formatCascadeSummary,
} from "@/lib/epic-tree-cascade";
import { useIsActiveEpicArtifact } from "@/stores/epics/canvas/canvas-selectors";
import {
  isOpenableEpicNodeKind,
  makeOpenableNodeRef,
} from "@/stores/epics/canvas/types";

interface SwitcherListProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}

/**
 * Agents category: GUI chats and TUI agents interleaved in one flat list
 * (decision: interleaved, flat, no gui/tui filter v1) over the shared
 * `useEpicArtifactRecords()` projection - no duplicated data path and none of
 * the desktop tree's dnd / indentation / hover machinery.
 */
export function SwitcherAgentsList(props: SwitcherListProps) {
  const { epicId, tabId, onClose } = props;
  const records = useEpicArtifactRecords();
  const filtered = useMemo(
    () =>
      records.filter(
        (record) => record.type === "chat" || record.type === "terminal-agent",
      ),
    [records],
  );
  const agents = useOrderedSwitcherRecords(filtered);
  const canMutate = isEditableRole(useEpicPermissionRole());

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain p-1 pb-safe-bottom">
      {/* Editor-gated: a viewer's create is server-rejected, so an ungated row
          would only lead to a dead end. Inside the scroll region and above the
          items, so it is the first thing in the list either way. */}
      {canMutate ? (
        <SwitcherNewChatRow epicId={epicId} tabId={tabId} onClose={onClose} />
      ) : null}
      {agents.length === 0 ? (
        <SwitcherListEmpty message="No agents yet." />
      ) : (
        agents.map((record) => (
          <SwitcherAgentRow
            key={record.id}
            record={record}
            records={records}
            epicId={epicId}
            tabId={tabId}
            onClose={onClose}
          />
        ))
      )}
    </div>
  );
}

function SwitcherAgentRow(props: {
  readonly record: EpicTreeRecord;
  readonly records: ReadonlyArray<EpicTreeRecord>;
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}) {
  const { record, records, epicId, tabId, onClose } = props;
  const activate = useSwitcherActivate(epicId, tabId, onClose);
  const isActive = useIsActiveEpicArtifact(tabId, record.id);
  const agentType: "chat" | "terminal-agent" =
    record.type === "terminal-agent" ? "terminal-agent" : "chat";

  const onSelect = useCallback(() => {
    const type = record.type;
    if (!isOpenableEpicNodeKind(type)) return;
    activate(record.id, () =>
      makeOpenableNodeRef({
        id: record.id,
        instanceId: uuidv4(),
        type,
        name: record.name,
        hostId: record.hostId,
      }),
    );
  }, [activate, record]);

  const cascadeSummary = formatCascadeSummary(
    computeDescendantCounts(records, record.id),
  );

  return (
    <SwitcherListRow
      icon={<SwitcherAgentIcon nodeId={record.id} type={agentType} />}
      label={record.name}
      active={isActive}
      onSelect={onSelect}
      selectTestId={`switcher-agent-row-${record.id}`}
      actions={
        <SwitcherRowActions
          epicId={epicId}
          tabId={tabId}
          kind={agentType}
          nodeId={record.id}
          name={record.name}
          cascadeSummary={cascadeSummary}
        />
      }
    />
  );
}
