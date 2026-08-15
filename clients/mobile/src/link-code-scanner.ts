import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from "@capacitor/barcode-scanner";
import type {
  ILinkCodeScanner,
  LinkCodeScanResult,
} from "@traycer-clients/shared/platform/runner-host";

/**
 * Native QR scanner for the link-login sign-in path, backed by the official
 * `@capacitor/barcode-scanner` plugin — chosen over the ML Kit community
 * plugin because this iOS project consumes Capacitor plugins through SPM
 * (`CapApp-SPM/Package.swift`) and the ML Kit one ships CocoaPods-only.
 *
 * Constructed by the entry point only on a native platform; `scanBarcode`
 * owns the whole native interaction — the permission prompt and the
 * fullscreen scan UI — and rejects for every non-scan outcome, so this
 * adapter's job is to translate that single rejection channel into the
 * surface's explicit states.
 */
export class MobileLinkCodeScanner implements ILinkCodeScanner {
  async scan(): Promise<LinkCodeScanResult> {
    try {
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
        scanInstructions: "Point the camera at the QR on your desktop",
      });
      const text = result.ScanResult;
      if (typeof text !== "string" || text.length === 0) {
        return { kind: "canceled" };
      }
      return { kind: "scanned", text };
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (message.includes("cancel")) {
        return { kind: "canceled" };
      }
      if (message.includes("permission") || message.includes("denied")) {
        return { kind: "permission-denied" };
      }
      return { kind: "error" };
    }
  }
}
