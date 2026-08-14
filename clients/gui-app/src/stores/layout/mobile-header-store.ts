import { type ReactNode } from "react";
import { create } from "zustand";

/**
 * Slot for surface-contributed actions on the right of the mobile header, for
 * controls that depend on state only the surface holds (the landing terminal's
 * reveal toggle reads its own panel layout). The header renders whatever is
 * present. Desktop never renders the mobile header, so this is unused there.
 *
 * ONE cell, last writer wins, and a surface clears it on unmount - so it can
 * only carry a control whose owner is the surface actually on screen. A
 * control that is a pure function of the route (the epic tab switcher) is
 * derived in the header instead: published here it would race whichever other
 * mounted surface wrote last, and lose the slot to that surface's unmount.
 */
interface MobileHeaderState {
  readonly rightActions: ReactNode | null;
  readonly setRightActions: (node: ReactNode | null) => void;
}

export const useMobileHeaderStore = create<MobileHeaderState>((set) => ({
  rightActions: null,
  setRightActions: (node) => {
    set({ rightActions: node });
  },
}));
