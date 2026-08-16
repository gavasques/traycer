import type { HostHealthState } from "@/components/settings/host-scope/host-health";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";

/**
 * What CHOOSING a host does on this surface — the one thing that legitimately
 * differs between the pickers now that they share a list.
 *
 * - `view`: point a read-only surface at the host (Settings' scoped sections,
 *   the header's usage popover). A host this client cannot dial is a legal
 *   pick: the surface then says why it is empty, and picking it is how you get
 *   back to it when it returns.
 * - `bind`: make it the host this window RUNS on — where new work lands (the
 *   composer, the shell's Select host dialog). A host this client cannot dial
 *   is not a legal answer there, so its row is inert rather than a click that
 *   could only fail.
 * - `pin`: scope this surface's RPCs; never rebinds the window (git-diff
 *   panel, file tree, new-terminal picker). Undialable rows stay inert, and
 *   there is no "Active" chip — same pick legality as `bind`, different write.
 *
 * All intents draw the SAME row. Which hosts exist, what they are called and
 * whether they can be reached is one answer everywhere; only the consequence of
 * clicking differs.
 */
export type HostPickIntent = "view" | "bind" | "pin";

/**
 * Whether choosing this row is a legal answer for that intent.
 *
 * Every container asks THIS, rather than re-deriving "can I click it" from
 * `connectable` beside its own copy of the reason word. A second gate written
 * as a hand-rolled subset of this one is how a row ends up inert with no
 * explanation, or explained but still clickable.
 */
export function isHostOptionSelectable(
  host: HostScopeOption,
  intent: HostPickIntent,
): boolean {
  return intent === "view" || host.connectable;
}

/**
 * The row's status word — the SAME vocabulary the Overview card speaks, in the
 * terse form a single-line row can carry.
 *
 * It used to answer a ROUTE question in STATUS words:
 *
 *     if (host.connectable) return null;
 *     return host.planRestricted ? "requires upgrade" : "unreachable";
 *
 * which made this the app's THIRD independent status vocabulary — after the
 * Settings health line and the tile banners — and the one that contradicted its
 * own row. A registry-only host whose health line read "Reported reachable"
 * carried the word "unreachable" beside it, in the same row, because the two
 * were answering different questions in the same voice.
 *
 * Those questions are now cleanly split. **Route decides interactivity**
 * (`isHostOptionSelectable` below, which the containers use to render a row
 * inert); **status decides words**, and status means the lease-derived
 * `health.state`. A row that cannot be dialled is therefore silent about it
 * here and inert to the touch, with the full reason spoken by the scope gate
 * when a `view` pick lands on it — rather than a fourth surface inventing its
 * own word for a fact three others already describe.
 *
 * `host.settingUp` outranks the table, and that ordering is the M5 requirement:
 * a machine whose host is being installed right now is not "offline" in any
 * sense a user can act on — it is mid-setup, and it will be dialable shortly.
 * It is also a mutation-lane fact rather than a status one, which is why it
 * sits outside the table instead of inside it.
 */
const STATUS_WORD: Record<HostHealthState, string | null> = {
  // Nothing to add: the dot carries it, and a word here would restate the
  // absence of a problem on every healthy row in the list.
  online: null,
  // Deliberately silent. The host is pickable and will dial; "reported
  // reachable" is a nuance for the card, not a warning for a row, and the
  // muted dot already withholds the liveness claim (F26).
  "reported-reachable": null,
  // A blind cloud read is not something a person acts on from a picker.
  unknown: null,
  // A WINDOW-scope fact: when the client is offline every row is in this
  // state, so the global narrator owns it (`windowNarratorOwns`) and repeating
  // it down a list of eight is the layered-narration class this epic deletes.
  "viewer-offline": null,
  restarting: "restarting",
  offline: "offline",
  // The remedy, not the symptom — one word covering both this and `offline`
  // is what sent people debugging a network over a billing limit.
  "local-only": "requires upgrade",
  "update-required": "update required",
  removed: "removed",
  stopped: "stopped",
  "not-installed": "not installed",
};

export function hostOptionStatusWord(host: HostScopeOption): string | null {
  if (host.settingUp) return "setting up";
  return STATUS_WORD[host.health.state];
}

/**
 * What KIND of host this is, in words.
 *
 * The row draws this as a glyph, which is `aria-hidden` — so when the Select
 * host dialog moved onto the shared row it silently dropped the `Local` /
 * `Remote` badge that had been the only kind information a screen reader ever
 * got there. The glyph stays the visual carrier; this is its text twin,
 * rendered `sr-only` beside it, so nobody has to infer a machine's kind from an
 * icon they cannot see.
 */
export function hostOptionKindLabel(host: HostScopeOption): string {
  if (host.isLocalMachine) return "This machine";
  if (host.entry?.kind === "remote") return "Remote host";
  if (host.entry?.kind === "mock") return "Mock host";
  return "Host";
}
