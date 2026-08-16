import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { saveBlobToDisk } from "@/lib/files/save-blob-to-disk";
import { copyImageBlobPromiseToClipboard } from "@/lib/images/copy-image-to-clipboard";
import { captureUsageExportImageBlob } from "@/lib/usage-analytics/usage-export-image";
import { appLogger } from "@/lib/logger";
import { imageMutationKeys } from "@/lib/query-keys";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

export interface UseUsageImageExportParams {
  /**
   * Resolves the region to rasterise at click time - `null` while no
   * loaded body is mounted (callers also disable the buttons then, so a
   * `null` here is a race, not a state).
   */
  readonly getExportNode: () => HTMLElement | null;
  readonly fileName: string;
  /** Heading drawn above the captured region ("Usage"). */
  readonly heading: string;
  /** Muted line beside the heading (scope or date range) - `null` for none. */
  readonly subheading: string | null;
}

export interface UseUsageImageExportResult {
  readonly copyImage: () => void;
  readonly downloadImage: () => void;
  readonly isCopying: boolean;
  readonly isDownloading: boolean;
}

/**
 * "Copy image" / "Download image" for a usage dialog: rasterise the
 * dialog's summary region (headline, tiles, trend chart) to a PNG, then
 * hand it to the clipboard or the save-to-disk path. Both legs reuse the
 * app-wide runtime-aware plumbing - `copyImageBlobPromiseToClipboard` falls
 * back to the desktop nativeImage bridge, `saveBlobToDisk` to the native save
 * dialog - so this hook only owns capture + toasts.
 */
export function useUsageImageExport(
  params: UseUsageImageExportParams,
): UseUsageImageExportResult {
  const { getExportNode, fileName, heading, subheading } = params;

  // The copy leg is started by `copyImage` and only *tracked* here: the
  // clipboard write has to be issued inside the click's user activation, and
  // a `mutationFn` body can run a tick later. The variable is that already
  // running promise, so this mutation owns pending state and toasts only.
  const copyMutation = useMutation<void, Error, Promise<void>>({
    mutationKey: imageMutationKeys.usageExportCopy(),
    mutationFn: (started) => started,
    onSuccess: () => {
      toast.success("Usage image copied");
    },
    onError: (err) => {
      appLogger.errorSummary("[usage] image copy failed", {}, err);
      reportableErrorToast("Failed to copy usage image", undefined, {
        title: "Could not copy usage image",
        message: null,
        code: null,
        source: "Usage dialog",
      });
    },
  });

  const downloadMutation = useMutation<string | null, Error, HTMLElement>({
    mutationKey: imageMutationKeys.usageExportDownload(),
    mutationFn: async (node) => {
      const blob = await captureUsageExportImageBlob({
        region: node,
        heading,
        subheading,
      });
      return saveBlobToDisk(blob, fileName);
    },
    onSuccess: (saved) => {
      // `null` is the user cancelling the picker - a no-op, not a success.
      if (saved !== null) {
        toast.success(`Saved ${saved}`);
      }
    },
    onError: (err) => {
      appLogger.errorSummary("[usage] image download failed", {}, err);
      reportableErrorToast("Failed to download usage image", undefined, {
        title: "Could not download usage image",
        message: null,
        code: null,
        source: "Usage dialog",
      });
    },
  });

  const { mutate: mutateCopy } = copyMutation;
  const copyImage = useCallback(() => {
    const node = getExportNode();
    if (node === null) return;
    mutateCopy(
      copyImageBlobPromiseToClipboard(
        captureUsageExportImageBlob({ region: node, heading, subheading }),
      ),
    );
  }, [getExportNode, heading, subheading, mutateCopy]);

  const { mutate: mutateDownload } = downloadMutation;
  const downloadImage = useCallback(() => {
    const node = getExportNode();
    if (node === null) return;
    mutateDownload(node);
  }, [getExportNode, mutateDownload]);

  return {
    copyImage,
    downloadImage,
    isCopying: copyMutation.isPending,
    isDownloading: downloadMutation.isPending,
  };
}
