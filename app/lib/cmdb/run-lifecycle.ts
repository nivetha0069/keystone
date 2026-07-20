// Migration-run lifecycle predicates shared by the dashboard and its smoke tests.
//
// The frontend does not own the pipeline — ServiceNow does — so these helpers
// only classify observed backend state strings. The three cohorts are:
//   * DRAFT   — Comprehend has not been queued for this run; the UI may offer
//               an explicit Start/Retry analysis button that POSTs /comprehend.
//   * ACTIVE  — the backend is progressing the run; poll every resource.
//   * TERMINAL— the backend has stopped for a reason the UI must respect (done,
//               awaiting a human, simulated, approved, committed, failed); no
//               polling and no automatic /comprehend calls.

export const DRAFT_RUN_STATES = ["draft", "reset"] as const;
export const TERMINAL_RUN_STATES = [
  "awaiting_approval", "simulated", "approved", "committed",
  "complete", "completed", "failed", "error",
] as const;

const draftSet = new Set<string>(DRAFT_RUN_STATES);
const terminalSet = new Set<string>(TERMINAL_RUN_STATES);

export function isDraftRunState(state?: string): boolean {
  return Boolean(state && draftSet.has(state));
}

export function isTerminalRunState(state?: string): boolean {
  return Boolean(state && terminalSet.has(state));
}

export function isActiveRunState(state?: string): boolean {
  return Boolean(state && !draftSet.has(state) && !terminalSet.has(state));
}
