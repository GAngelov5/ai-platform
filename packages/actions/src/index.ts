/**
 * Proposals, approvals and execution (state machine in the handoff, section 5).
 * NOT IMPLEMENTED in Phase 1 — scheduled for Phase 5. No external writes exist
 * in this milestone; nothing here can execute an action.
 */
export type ActionState =
  | "proposed"
  | "pending_approval"
  | "approved"
  | "executing"
  | "succeeded"
  | "rejected"
  | "expired"
  | "cancelled"
  | "failed"
  | "unknown";

export const ACTIONS_IMPLEMENTED = false as const;
