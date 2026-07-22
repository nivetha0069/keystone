// Pure helpers for classifying and humanizing frontend/API errors. Kept out
// of the client component tree so smoke tests can exercise them from Node
// without a React runtime.

export type EndpointErrorKind = "unavailable" | "client" | "backend";

export class EndpointError extends Error {
  status: number;
  kind: EndpointErrorKind;
  resource: string;
  detail?: string;
  constructor(resource: string, status: number, kind: EndpointErrorKind, detail?: string) {
    super(`${resource}: ${status}${detail ? ` — ${detail}` : ""}`);
    this.name = "EndpointError";
    this.resource = resource;
    this.status = status;
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * Classify HTTP errors so the UI can tell "the request was intentionally
 * incomplete" apart from "the backend is broken":
 *   - 5xx or network failure → backend outage
 *   - 400/404 without an active run → expected (missing run parameter)
 *   - 400/404 with an active run → client/request error
 *   - other 4xx → client/request error
 */
export function classifyEndpointStatus(status: number, hasRun: boolean): EndpointErrorKind {
  if (status >= 500 || status === 0) return "backend";
  if (status === 404 || status === 400) return hasRun ? "client" : "unavailable";
  if (status >= 400) return "client";
  return "backend";
}

const IRE_LABELS: Record<string, string> = {
  NOT_CONFIGURED: "Missing ServiceNow IRE configuration.",
  APPROVAL_REQUIRED: "Execution is blocked until ServiceNow records approval.",
  STALE_SIMULATION: "Execution was rejected because the approved simulation is stale.",
  DUPLICATE_EXECUTION: "ServiceNow detected a duplicate idempotency key or prior execution.",
  VERIFY_MISMATCH: "Verification must use the specific execution correlation ID.",
  IRE_FAILED: "ServiceNow rejected the IRE action.",
  RUN_STATE_INVALID: "The migration run is still analyzing. Simulate unlocks once the pipeline finishes.",
};

/**
 * Return a friendly IRE error string that never duplicates itself. If the raw
 * backend message equals (or is contained within) the friendly label, only the
 * label is shown; otherwise the raw message is appended as extra detail.
 */
export function friendlyIreError(code: string, message: string): string {
  const raw = (message ?? "").toString().trim();
  const label = IRE_LABELS[code];
  if (!label) return raw || `IRE error (${code}).`;
  if (!raw) return label;
  const rawLower = raw.toLowerCase();
  const labelLower = label.toLowerCase();
  const duplicate = rawLower === labelLower
    || labelLower.includes(rawLower)
    || rawLower.includes(labelLower);
  return duplicate ? label : `${label} ${raw}`;
}

/**
 * Pulls a human-readable error string from any of the shapes ServiceNow's
 * Comprehend endpoint can return:
 *   { error }
 *   { message }
 *   { result: { error } }
 *   { result: { success: false, error } }
 *   { result: { result: { error } } }
 */
export function extractComprehendError(
  body: Record<string, unknown> | undefined | null,
  payload: Record<string, unknown> | undefined | null,
  status: number,
): string {
  const candidates: Array<unknown> = [];
  if (body) {
    candidates.push(body.error, body.message);
    const nested = body.result as Record<string, unknown> | undefined;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      candidates.push(nested.error, nested.message);
      const deeper = nested.result as Record<string, unknown> | undefined;
      if (deeper && typeof deeper === "object" && !Array.isArray(deeper)) {
        candidates.push(deeper.error, deeper.message);
      }
    }
  }
  if (payload && payload !== body) {
    candidates.push(payload.error, payload.message);
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return `Comprehend start failed (${status}).`;
}
