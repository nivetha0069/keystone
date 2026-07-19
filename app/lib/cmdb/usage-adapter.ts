// AI usage normalization for a single Migration Run.
// Never fabricates token counts: unknown numeric fields normalize to 0, and the
// caller is responsible for surfacing an explicit unavailable/error state when the
// backend returns nothing usable. Pure helpers are exported for reuse and testing.

export type AiUsageCall = {
  id: string;
  timestamp: string;
  phase: "Comprehend" | "Mara" | "Prioritize" | string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs?: number;
  status: "success" | "fallback" | "error" | string;
};

export type AiUsageTotals = {
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs?: number;
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

/** Coerce any numeric-looking value to a finite, non-negative number; else 0. */
export function toNumber(value: unknown): number {
  const n = typeof value === "string" ? Number(value.trim()) : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function str(value: unknown, fallback: string): string {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = toNumber(value);
  return n === 0 && !Number.isFinite(Number(value)) ? undefined : n;
}

function arrayFromPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const value = payload as Record<string, unknown>;
  for (const key of ["calls", "result", "data", "items", "records", "usage"]) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
  }
  return [];
}

function normalizePhase(value: unknown): string {
  const raw = str(value, "Unknown").trim();
  const match = KNOWN_PHASES.find(p => p.toLowerCase() === raw.toLowerCase());
  return match ?? raw;
}

/** Normalize one raw call, tolerating snake_case and camelCase field names. */
export function normalizeCall(item: unknown, index: number): AiUsageCall {
  const row = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
  const inputTokens = toNumber(row.inputTokens ?? row.input_tokens ?? row.prompt_tokens);
  const outputTokens = toNumber(row.outputTokens ?? row.output_tokens ?? row.completion_tokens);
  const reportedTotal = toNumber(row.totalTokens ?? row.total_tokens ?? row.tokens);
  // Prefer a coherent sum over a backend total that ignores its own parts.
  const totalTokens = reportedTotal >= inputTokens + outputTokens ? reportedTotal : inputTokens + outputTokens;

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
  };
}

export function normalizeUsage(payload: unknown, runId: string): AiUsageResponse {
  const outer = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const unavailable = optionalStr(outer.unavailable ?? outer.error ?? outer.message);
  const calls = arrayFromPayload(payload).map(normalizeCall);

  const rawTotals = (outer.totals && typeof outer.totals === "object" ? outer.totals : {}) as Record<string, unknown>;
  const totals: AiUsageTotals = {
    callCount: toNumber(rawTotals.callCount ?? rawTotals.call_count),
    inputTokens: toNumber(rawTotals.inputTokens ?? rawTotals.input_tokens),
    outputTokens: toNumber(rawTotals.outputTokens ?? rawTotals.output_tokens),
    totalTokens: toNumber(rawTotals.totalTokens ?? rawTotals.total_tokens),
    durationMs: optionalNumber(rawTotals.durationMs ?? rawTotals.duration_ms),
  };

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

// --- Pure aggregation helpers (recompute totals client-side, group by dimension) ---

export function computeTotals(calls: AiUsageCall[]): AiUsageTotals {
  const durationMs = calls.reduce((sum, c) => sum + (c.durationMs ?? 0), 0);
  const anyDuration = calls.some(c => c.durationMs !== undefined);
  return {
    callCount: calls.length,
    inputTokens: calls.reduce((s, c) => s + c.inputTokens, 0),
    outputTokens: calls.reduce((s, c) => s + c.outputTokens, 0),
    totalTokens: calls.reduce((s, c) => s + c.totalTokens, 0),
    durationMs: anyDuration ? durationMs : undefined,
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

/** True when backend totals materially disagree with the client recomputation. */
export function totalsDiffer(backend: AiUsageTotals, client: AiUsageTotals): boolean {
  return (
    backend.callCount !== client.callCount ||
    backend.inputTokens !== client.inputTokens ||
    backend.outputTokens !== client.outputTokens ||
    backend.totalTokens !== client.totalTokens
  );
}
