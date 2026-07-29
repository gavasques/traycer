import { useCallback } from "react";
import {
  useIsMutating,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  PrepareWorkspaceFoldersRequest,
  PrepareWorkspaceFoldersResponse,
  PreparedWorkspaceFolder,
  RemoveEpicRepoRequest,
  RemoveEpicRepoResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostClient } from "@/lib/host/runtime";
import { useHostMutation } from "@/hooks/host/use-host-query";
import {
  hostQueryKeys,
  isCloudEpicTasksQueryKey,
  workspaceMutationKeys,
} from "@/lib/query-keys";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useRemoteFolderPickerStore } from "@/stores/workspace/remote-folder-picker-store";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

interface MutationContext {
  readonly hostId: string | null;
}

export interface WorkspaceFolderActions {
  readonly isPreparing: boolean;
  readonly isRemoving: boolean;
  readonly prepareFoldersMutation: UseMutationResult<
    PrepareWorkspaceFoldersResponse,
    HostRpcError,
    PrepareWorkspaceFoldersRequest,
    MutationContext
  >;
  readonly removeEpicRepoMutation: UseMutationResult<
    RemoveEpicRepoResponse,
    HostRpcError,
    RemoveEpicRepoRequest,
    MutationContext
  >;
  readonly pickAndPrepareFolders: () => Promise<PrepareWorkspaceFoldersResponse | null>;
}

export function useWorkspaceFolderActions(): WorkspaceFolderActions {
  const client = useHostClient();
  return useWorkspaceFolderActionsForClient(client);
}

export function useWorkspaceFolderActionsForClient(
  client: HostClient<HostRpcRegistry> | null,
): WorkspaceFolderActions {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();

  const prepareFoldersMutation = useHostMutation<
    HostRpcRegistry,
    "workspace.prepareFolders",
    MutationContext
  >({
    client,
    method: "workspace.prepareFolders",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: workspaceMutationKeys.prepareFolders(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: async (_result, _variables, context) => {
        const queryKey = hostQueryKeys.methodScope(
          context.hostId,
          "workspace.resolvePathsByRepoIdentifiers",
        );
        await queryClient.cancelQueries({ queryKey });
        await queryClient.invalidateQueries({ queryKey });
      },
      // No success toast: added folders appear immediately in the picker rows.
      onError: (error) => {
        reportableErrorToast(
          "Couldn't add folders",
          {
            description: readWorkspaceActionErrorMessage(error),
          },
          {
            title: "Could not add workspace folders",
            message: null,
            code: null,
            source: "Workspace folders",
          },
        );
      },
    },
  });

  const removeEpicRepoMutation = useHostMutation<
    HostRpcRegistry,
    "epic.removeRepo",
    MutationContext
  >({
    client,
    method: "epic.removeRepo",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: workspaceMutationKeys.removeEpicRepo(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: async (_result, _variables, context) => {
        await queryClient.invalidateQueries({
          queryKey: hostQueryKeys.scope(context.hostId),
          predicate: (query) => !isCloudEpicTasksQueryKey(query.queryKey),
        });
      },
      onError: (error) => {
        reportableErrorToast(
          "Couldn't remove repository from epic",
          {
            description: readWorkspaceActionErrorMessage(error),
          },
          {
            title: "Could not remove repository from Epic",
            message: null,
            code: null,
            source: "Workspace folders",
          },
        );
      },
    },
  });

  const preparePending =
    useIsMutating({ mutationKey: workspaceMutationKeys.prepareFolders() }) > 0;
  const removeRepoPending =
    useIsMutating({ mutationKey: workspaceMutationKeys.removeEpicRepo() }) > 0;

  const { mutateAsync: prepareFoldersAsync } = prepareFoldersMutation;

  const pickAndPrepareFolders = useCallback(async () => {
    const activeHost = client?.getActiveHost() ?? null;
    if (client === null || activeHost === null) {
      reportableErrorToast("Select a host to add folders.", undefined, {
        title: "Could not add workspace folders",
        message: "No host was selected.",
        code: null,
        source: "Workspace folders",
      });
      return null;
    }

    // Local/mock hosts share the client machine, so the native OS directory
    // dialog picks real host paths. Every other host is remote from this
    // client's point of view.
    if (!canAssociateLocalWorkspaces(activeHost)) {
      // The RPC-backed remote picker is a surface for shells WITHOUT a
      // native folder dialog (mobile/browser). Desktop keeps its native
      // dialog and the switch-to-local guidance for remote hosts.
      if (runnerHost.workspaceFolders.canPickNatively) {
        reportableErrorToast(
          "Select the local host to add folders.",
          undefined,
          {
            title: "Could not add workspace folders",
            message: "The local host was not selected.",
            code: null,
            source: "Workspace folders",
          },
        );
        return null;
      }
      // Hand the picker THIS client: in a tab it is host-bound for life, and
      // the picked path is submitted through the same client below - the
      // globally mounted dialog must browse that host, not whichever host is
      // app-wide-active at the time.
      const pickedPath = await useRemoteFolderPickerStore
        .getState()
        .requestPick(client);
      if (pickedPath === null) return null;
      return prepareFoldersAsync({ folderPaths: [pickedPath] }).catch(
        () => null,
      );
    }

    const folderPaths = await runnerHost.workspaceFolders.pickFolders();
    if (folderPaths.length === 0) {
      return null;
    }

    return prepareFoldersAsync({ folderPaths: [...folderPaths] }).catch(
      () => null,
    );
  }, [client, runnerHost, prepareFoldersAsync]);

  return {
    isPreparing: preparePending,
    isRemoving: removeRepoPending,
    prepareFoldersMutation,
    removeEpicRepoMutation,
    pickAndPrepareFolders,
  };
}

export function preparedWorkspaceFolderToWorkspaceFolderInfo(
  folder: PreparedWorkspaceFolder,
): WorkspaceFolderInfo {
  return {
    path: folder.workspacePath,
    name: folder.workspaceName,
    repoIdentifier: folder.repoIdentifier,
  };
}
function canAssociateLocalWorkspaces(
  activeHost: HostDirectoryEntry | null,
): activeHost is HostDirectoryEntry & {
  readonly kind: "local" | "mock";
} {
  return (
    activeHost !== null &&
    (activeHost.kind === "local" || activeHost.kind === "mock")
  );
}

function readWorkspaceActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
