// AI usage normalization for a single Migration Run.
//
// Fabricates nothing. Token fields are optional so the UI can distinguish a
// backend that reported an explicit 0 from one that reported nothing at all
// — the previous behaviour of coercing missing counts to 0 rendered runs with
// no telemetry as if every call had genuinely used zero tokens.
//
// Field recognition is exact, not a broad recursive dig: only the token key
// shapes actually seen in the ServiceNow /usage bridge are accepted (snake +
// camel case, plus a `usage` / `token_usage` sub-object). Anything outside
// that list is treated as absent and surfaced honestly in the UI.

export type AiUsageCall = {
  id: string;
  timestamp: string;
  phase: "Comprehend" | "Mara" | "Prioritize" | string;
  model: string;
  /** Undefined when the backend did not report input tokens for this call. */
  inputTokens?: number;
  /** Undefined when the backend did not report output tokens for this call. */
  outputTokens?: number;
  /** Undefined when neither input nor output tokens were reported. */
  totalTokens?: number;
  durationMs?: number;
  status: "success" | "fallback" | "error" | string;
  /** True iff at least one of input/output/total token fields was present. */
  tokenMetricsAvailable: boolean;
};

export type AiUsageTotals = {
  callCount: number;
  /** Undefined when no call in the aggregate reported input tokens. */
  inputTokens?: number;
  /** Undefined when no call in the aggregate reported output tokens. */
  outputTokens?: number;
  /** Undefined when no call in the aggregate reported any token count. */
  totalTokens?: number;
  durationMs?: number;
  /** Number of calls that contributed at least one token value. */
  callsWithTokens: number;
  /** True iff at least one call contributed at least one token value. */
  tokenMetricsAvailable: boolean;
};

export type AiUsageResponse = {
  runId: string;
  calls: AiUsageCall[];
  totals: AiUsageTotals;
  /** Optional cost, only present when the backend explicitly returns it. */
  cost?: { amount: number; currency: string };
  /** Backend-declared unavailable/error state, passed through untouched. */
  unavailable?: string;
};

const KNOWN_PHASES = ["Comprehend", "Mara", "Prioritize"];

/** Coerce a numeric-looking value to a finite non-negative number, or undefined. */
export function optionalTokenCount(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }
  return undefined;
}

function str(value: unknown, fallback: string): string {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function optionalNumber(value: unknown): number | undefined {
  return optionalTokenCount(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// The ServiceNow bridge nests every payload under a `result` envelope, and the
// /usage script double-wraps it as `result.result`. Drill through those object
// layers so the call list (and its token fields) is actually found — without
// this the whole array reads as empty and every token count renders as "—".
function arrayFromPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const value = record(payload);
  for (const key of ["calls", "result", "data", "items", "records", "usage"]) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
    if (value[key] && typeof value[key] === "object") {
      const nested = arrayFromPayload(value[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

/** Peel `result`/`data` object wrappers so envelope-level fields are readable. */
function unwrapEnvelope(payload: unknown): Record<string, unknown> {
  let value = record(payload);
  for (let depth = 0; depth < 4; depth += 1) {
    const inner = value.result ?? value.data;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) value = inner as Record<string, unknown>;
    else break;
  }
  return value;
}

function normalizePhase(value: unknown): string {
  const raw = str(value, "Unknown").trim();
  const match = KNOWN_PHASES.find(p => p.toLowerCase() === raw.toLowerCase());
  return match ?? raw;
}

function readInputTokens(row: Record<string, unknown>): number | undefined {
  const nested = row.usage && typeof row.usage === "object" ? row.usage as Record<string, unknown> : undefined;
  const tokenUsage = row.token_usage && typeof row.token_usage === "object" ? row.token_usage as Record<string, unknown> : undefined;
  const candidates = [
    row.inputTokens, row.input_tokens, row.prompt_tokens,
    row.input_token_count, row.promptTokenCount,
    nested?.input_tokens, nested?.prompt_tokens, nested?.inputTokens,
    tokenUsage?.input_tokens, tokenUsage?.prompt_tokens,
  ];
  for (const candidate of candidates) {
    const n = optionalTokenCount(candidate);
    if (n !== undefined) return n;
  }
  return undefined;
}

function readOutputTokens(row: Record<string, unknown>): number | undefined {
  const nested = row.usage && typeof row.usage === "object" ? row.usage as Record<string, unknown> : undefined;
  const tokenUsage = row.token_usage && typeof row.token_usage === "object" ? row.token_usage as Record<string, unknown> : undefined;
  const candidates = [
    row.outputTokens, row.output_tokens, row.completion_tokens,
    row.output_token_count, row.completionTokenCount,
    nested?.output_tokens, nested?.completion_tokens, nested?.outputTokens,
    tokenUsage?.output_tokens, tokenUsage?.completion_tokens,
  ];
  for (const candidate of candidates) {
    const n = optionalTokenCount(candidate);
    if (n !== undefined) return n;
  }
  return undefined;
}

function readTotalTokens(row: Record<string, unknown>): number | undefined {
  const nested = row.usage && typeof row.usage === "object" ? row.usage as Record<string, unknown> : undefined;
  const tokenUsage = row.token_usage && typeof row.token_usage === "object" ? row.token_usage as Record<string, unknown> : undefined;
  const candidates = [
    row.totalTokens, row.total_tokens, row.tokens,
    nested?.total_tokens, nested?.tokens,
    tokenUsage?.total_tokens, tokenUsage?.tokens,
  ];
  for (const candidate of candidates) {
    const n = optionalTokenCount(candidate);
    if (n !== undefined) return n;
  }
  return undefined;
}

/** Normalize one raw call. Missing token fields stay missing. */
export function normalizeCall(item: unknown, index: number): AiUsageCall {
  const row = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
  const inputTokens = readInputTokens(row);
  const outputTokens = readOutputTokens(row);
  const reportedTotal = readTotalTokens(row);
  const derivedTotal = inputTokens !== undefined || outputTokens !== undefined
    ? (inputTokens ?? 0) + (outputTokens ?? 0)
    : undefined;
  // Trust an explicit total that at least matches the reported parts; otherwise
  // recompute from the parts we actually saw. Never invent one out of thin air.
  const totalTokens = reportedTotal !== undefined
    ? (derivedTotal !== undefined && reportedTotal < derivedTotal ? derivedTotal : reportedTotal)
    : derivedTotal;
  const tokenMetricsAvailable = inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined;

  return {
    id: str(row.id ?? row.sys_id ?? row.call_id, `CALL-${index + 1}`),
    timestamp: str(row.timestamp ?? row.created_at ?? row.sys_created_on ?? row.time, "-"),
    phase: normalizePhase(row.phase ?? row.stage ?? row.agent),
    model: str(row.model ?? row.model_name ?? row.llm_model, "Unknown model"),
    inputTokens,
    outputTokens,
    totalTokens,
    durationMs: optionalNumber(row.durationMs ?? row.duration_ms ?? row.latency_ms ?? row.elapsed_ms),
    status: str(row.status ?? row.result, "success"),
    tokenMetricsAvailable,
  };
}

export function normalizeUsage(payload: unknown, runId: string): AiUsageResponse {
  const outer = unwrapEnvelope(payload);
  const unavailable = optionalStr(
    outer.unavailable ?? outer.unavailableReason ?? outer.unavailable_reason ?? outer.error ?? outer.message,
  );
  const calls = arrayFromPayload(payload).map(normalizeCall);

  // Aggregate totals are always recomputed from the calls the frontend actually
  // saw — a backend that ships {"totals": {"totalTokens": 0}} while sending
  // token-free calls must not resurrect the false-zero we just eliminated.
  const totals = computeTotals(calls);

  const cost = normalizeCost(outer.cost);

  return {
    runId: str(outer.runId ?? outer.run_id ?? runId, runId),
    calls,
    totals,
    ...(cost ? { cost } : {}),
    ...(calls.length === 0 && unavailable ? { unavailable } : {}),
  };
}

function optionalStr(value: unknown): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : String(value);
}

function normalizeCost(value: unknown): AiUsageResponse["cost"] {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const amount = optionalNumber(row.amount ?? row.total ?? row.usd);
  if (amount === undefined) return undefined;
  return { amount, currency: str(row.currency, "USD") };
}

// --- Pure aggregation helpers ---

/** Sum the calls that reported at least one token value; leave the rest out. */
export function computeTotals(calls: AiUsageCall[]): AiUsageTotals {
  const callsWithTokens = calls.filter(c => c.tokenMetricsAvailable);
  const inputCalls = calls.filter(c => c.inputTokens !== undefined);
  const outputCalls = calls.filter(c => c.outputTokens !== undefined);
  const totalCalls = calls.filter(c => c.totalTokens !== undefined);
  const durationCalls = calls.filter(c => c.durationMs !== undefined);
  return {
    callCount: calls.length,
    inputTokens: inputCalls.length ? inputCalls.reduce((s, c) => s + (c.inputTokens ?? 0), 0) : undefined,
    outputTokens: outputCalls.length ? outputCalls.reduce((s, c) => s + (c.outputTokens ?? 0), 0) : undefined,
    totalTokens: totalCalls.length ? totalCalls.reduce((s, c) => s + (c.totalTokens ?? 0), 0) : undefined,
    durationMs: durationCalls.length ? durationCalls.reduce((s, c) => s + (c.durationMs ?? 0), 0) : undefined,
    callsWithTokens: callsWithTokens.length,
    tokenMetricsAvailable: callsWithTokens.length > 0,
  };
}

export type UsageGroup = AiUsageTotals & { key: string };

function groupBy(calls: AiUsageCall[], keyOf: (c: AiUsageCall) => string): UsageGroup[] {
  const map = new Map<string, AiUsageCall[]>();
  for (const call of calls) {
    const key = keyOf(call);
    (map.get(key) ?? map.set(key, []).get(key)!).push(call);
  }
  return [...map.entries()].map(([key, group]) => ({ key, ...computeTotals(group) }));
}

export function groupByPhase(calls: AiUsageCall[]): UsageGroup[] {
  return groupBy(calls, c => c.phase);
}

export function groupByModel(calls: AiUsageCall[]): UsageGroup[] {
  return groupBy(calls, c => c.model);
}
