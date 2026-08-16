/**
 * Deadlines for host-dependent loading states (redesign invariant 6: every
 * host-dependent loading state carries a deadline AND a terminal
 * presentation).
 *
 * They live in one module because the failure this epic is fixing is not any
 * single missing timer - it is that six unrelated surfaces each decided
 * separately whether to bound their wait, and five of them decided no. A
 * budget that is a shared constant is a budget the next surface inherits
 * instead of re-deciding.
 *
 * Both values are 15s, matching `epic-session-provider.tsx`'s landed
 * `ESTABLISHING_DEADLINE_MS` - the one bounded host load that already existed
 * when this table was written. Deliberately one number rather than a tuned
 * per-surface table: nothing measured says a terminal tile deserves a
 * different patience than an epic session, and two numbers would be two
 * things to keep true. That provider keeps its own copy for now (its file is
 * the least-disturbable in the tree); converging it here is a P4.3 target.
 */

/**
 * How long a tile waits for a host that is starting before it stops saying
 * "starting" and falls to the unreachable presentation WITH its affordances
 * (audit F4/S2: `host-starting` was unbounded, so a chat bound to a host that
 * never published withheld its Clone offer forever).
 *
 * The fall is a PRESENTATION change, not a death verdict - see
 * `HostReachability.basis`, which is what keeps a slow boot from firing a
 * persisted "terminal permanently closed" notification.
 */
export const HOST_STARTING_BUDGET_MS = 15_000;

/**
 * How long tab content waits for its host's data before it stops spinning and
 * says so (audit S3/S4/S5). Applies to whatever the surface is waiting on -
 * a disabled `useHostQuery`, a stream subscription that never delivers, a
 * chat-session handle that never resolves - because the user cannot tell
 * those apart and the same sentence is true of all three.
 */
export const TILE_CONTENT_BUDGET_MS = 15_000;
