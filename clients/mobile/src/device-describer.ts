import { Device } from "@capacitor/device";
import type { IDeviceDescriber } from "@traycer-clients/shared/platform/runner-host";

/**
 * Apple ships hardware identifiers ("iPhone17,3"), not marketing names, and
 * iOS 16+ returns a generic "iPhone" from the user-visible device name API
 * without a special entitlement — so a small identifier map is the honest
 * ceiling for "which phone is asking?". Unknown identifiers fall back to the
 * family so a brand-new model still reads as an iPhone rather than a code.
 */
const IPHONE_MODEL_NAMES: Readonly<Record<string, string>> = {
  "iPhone17,1": "iPhone 16 Pro",
  "iPhone17,2": "iPhone 16 Pro Max",
  "iPhone17,3": "iPhone 16",
  "iPhone17,4": "iPhone 16 Plus",
  "iPhone17,5": "iPhone 16e",
  "iPhone16,1": "iPhone 15 Pro",
  "iPhone16,2": "iPhone 15 Pro Max",
  "iPhone15,4": "iPhone 15",
  "iPhone15,5": "iPhone 15 Plus",
  "iPhone15,2": "iPhone 14 Pro",
  "iPhone15,3": "iPhone 14 Pro Max",
  "iPhone14,7": "iPhone 14",
  "iPhone14,8": "iPhone 14 Plus",
  "iPhone14,2": "iPhone 13 Pro",
  "iPhone14,3": "iPhone 13 Pro Max",
  "iPhone14,4": "iPhone 13 mini",
  "iPhone14,5": "iPhone 13",
  "iPhone14,6": "iPhone SE (3rd generation)",
};

function marketingName(model: string): string | null {
  const mapped = IPHONE_MODEL_NAMES[model];
  if (mapped !== undefined) {
    return mapped;
  }
  if (model.startsWith("iPhone")) {
    return "iPhone";
  }
  if (model.startsWith("iPad")) {
    return "iPad";
  }
  // Android reports marketing-grade models directly ("Pixel 9").
  return model.length > 0 ? model : null;
}

/**
 * `IRunnerHost.deviceDescriber` for the mobile app: the native hardware
 * model, mapped to its marketing name, for the desktop's approve prompt and
 * the session row. Best-effort and never throws — a failed native call just
 * leaves the caller on its UA fallback.
 */
export class MobileDeviceDescriber implements IDeviceDescriber {
  async describe(): Promise<string | null> {
    try {
      const info = await Device.getInfo();
      return marketingName(info.model);
    } catch {
      return null;
    }
  }
}
