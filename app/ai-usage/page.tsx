"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import {
  AiUsageCall,
  AiUsageResponse,
  AiUsageTotals,
  computeTotals,
  groupByModel,
  groupByPhase,
  normalizeUsage,
} from "../lib/cmdb/usage-adapter";
import { normalizeMaraRun } from "../lib/cmdb/mara-audit";
import { isTerminalRunState } from "../lib/cmdb/run-lifecycle";
import {
  isSysId,
  rememberRun,
  resolveActiveRun,
  writeRunToUrl,
} from "../lib/cmdb/run-context";

const PHASES = ["Comprehend", "Mara", "Prioritize"] as const;
const intFmt = new Intl.NumberFormat("en-US");
// Polling cadence for a live-processing run. Matches the dashboard's
// pipeline-progress interval so the user sees consistent refresh behavior.
const POLL_INTERVAL_MS = 8000;
// Backend states we treat as "still working" — worth polling for fresh usage.
const ACTIVE_RUN_STATES = new Set(["ingesting", "analyzing"]);

type LoadState = "idle" | "loading" | "ready" | "empty" | "unavailable" | "error";

function fmt(n: number) { return intFmt.format(n); }

// Render "—" for a missing token count, the formatted number otherwise.
// "Missing" is distinct from an explicit 0 the backend actually returned.
function fmtTokens(value: number | undefined): string {
  return value === undefined ? "—" : fmt(value);
}

function fmtDuration(ms?: number) {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${fmt(Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

// Pull a human-readable string out of an arbitrary error body (string, {message},
// {error}, {error:{message}}), never leaking "[object Object]" to the UI.
function readableError(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return "";
  const row = raw as Record<string, unknown>;
  const candidate = row.unavailable ?? row.message ?? row.error ?? row.detail;
  if (typeof candidate === "string") return candidate;
  if (candidate && typeof candidate === "object") return readableError(candidate);
  return "";
}

export default function AiUsagePage() {
  // Seeded empty so SSR and the first client render match; the real value is
  // resolved after mount from URL → localStorage.
  const [runId, setRunId] = useState("");
  const [runDraft, setRunDraft] = useState("");
  const [showChangeRun, setShowChangeRun] = useState(false);
  const [state, setState] = useState<LoadState>("idle");
  const [message, setMessage] = useState("");
  const [data, setData] = useState<AiUsageResponse | null>(null);
  const [runState, setRunState] = useState("");
  const [runLabel, setRunLabel] = useState("");
  const [lastSync, setLastSync] = useState("");
  const inFlight = useRef(false);

  const load = useCallback(async (run: string, { silent = false }: { silent?: boolean } = {}) => {
    const trimmed = run.trim();
    if (!isSysId(trimmed)) {
      setState("idle");
      setData(null);
      setMessage("");
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    if (!silent) setState(current => current === "ready" ? "ready" : "loading");
    try {
      // Fetch usage and the migration-run record in parallel: the run record
      // drives auto-refresh (poll while active, stop at terminal). Both are
      // GETs — this page never mutates ServiceNow.
      const [usageResponse, runResponse] = await Promise.all([
        fetch(`/api/cmdb/usage?run=${encodeURIComponent(trimmed)}`, { method: "GET", cache: "no-store" }),
        fetch(`/api/cmdb/run?run=${encodeURIComponent(trimmed)}`, { method: "GET", cache: "no-store" }).catch(() => null),
      ]);

      const rawUsage = await usageResponse.json().catch(() => ({}));
      const usage = normalizeUsage(rawUsage, trimmed);

      if (runResponse && runResponse.ok) {
        try {
          const runRecord = normalizeMaraRun(await runResponse.json());
          if (runRecord?.state) setRunState(runRecord.state);
          if (runRecord?.number) setRunLabel(runRecord.number);
        } catch { /* run record is best-effort; usage still renders */ }
      }

      if (!usageResponse.ok) {
        setData(null);
        const unavailableStatus = [404, 501, 502, 503].includes(usageResponse.status);
        setState(unavailableStatus ? "unavailable" : "error");
        setMessage(readableError(rawUsage) || `Request failed (${usageResponse.status}).`);
        return;
      }
      setData(usage);
      setLastSync(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      if (usage.calls.length) {
        setState("ready");
        setMessage("");
      } else {
        setState("empty");
        setMessage(readableError(usage.unavailable) || "");
      }
    } catch (error) {
      if (!silent) {
        setData(null);
        setState("error");
        setMessage(error instanceof Error ? error.message : "Unable to reach the AI usage endpoint.");
      }
    } finally {
      inFlight.current = false;
    }
  }, []);

  // Auto-resolve on mount: URL > localStorage. No manual paste required.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const resolved = resolveActiveRun();
      if (isSysId(resolved)) {
        setRunId(resolved);
        setRunDraft(resolved);
        rememberRun(resolved);
        writeRunToUrl(resolved);
        void load(resolved);
      } else {
        setState("idle");
        setMessage("");
      }
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll while the backend is still working on this run. Stops on any terminal
  // state and on unmount. Never issues a write.
  useEffect(() => {
    if (!isSysId(runId)) return;
    if (isTerminalRunState(runState)) return;
    if (runState && !ACTIVE_RUN_STATES.has(runState)) return;
    const timer = window.setInterval(() => { void load(runId, { silent: true }); }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [runId, runState, load]);

  function switchRun(next: string) {
    const trimmed = next.trim();
    if (!isSysId(trimmed)) {
      setState("idle");
      setMessage(trimmed ? "Not a valid 32-character migration_run sys_id." : "");
      return;
    }
    setRunId(trimmed);
    setRunDraft(trimmed);
    setShowChangeRun(false);
    rememberRun(trimmed);
    writeRunToUrl(trimmed);
    setData(null);
    setRunState("");
    setRunLabel("");
    void load(trimmed);
  }

  const backHref = runId ? `/?run=${encodeURIComponent(runId)}` : "/";
  const calls = useMemo(() => data?.calls ?? [], [data]);
  const clientTotals: AiUsageTotals = useMemo(() => computeTotals(calls), [calls]);
  const phaseGroups = useMemo(() => groupByPhase(calls), [calls]);
  const modelGroups = useMemo(() => groupByModel(calls), [calls]);
  const fallbackCount = useMemo(() => calls.filter(c => c.status.toLowerCase() === "fallback").length, [calls]);
  const partialTelemetry = calls.length > 0 && clientTotals.callsWithTokens > 0 && clientTotals.callsWithTokens < calls.length;
  const noTelemetry = calls.length > 0 && clientTotals.callsWithTokens === 0;
  // ServiceNow /usage today ships `{"inputTokens":0,"outputTokens":0,"totalTokens":0}`
  // for every call, even when duration > 0. Per the contract we preserve the
  // explicit 0, but flag the pattern so it is not silently misread as "the model
  // used no tokens" — the real cause is missing instrumentation on the backend.
  const suspiciousAllZero = clientTotals.tokenMetricsAvailable
    && clientTotals.callsWithTokens === clientTotals.callCount
    && clientTotals.totalTokens === 0
    && (clientTotals.durationMs ?? 0) > 0;

  return (
    <div className="app-shell">
      <main style={{ minHeight: "100vh" }}>
        <div className="page">
          <section className="page-heading">
            <div>
              <span className="eyebrow accent">MODEL TELEMETRY</span>
              <h1>AI usage for this run</h1>
              <p>Token consumption and model calls across Comprehend, Mara, and Prioritize — read-only, per migration run.</p>
            </div>
            <Link className="ghost-button" href={backHref}><Icon name="chevron" size={14} /> Back to control plane</Link>
          </section>

          <section className="run-context panel">
            <div className="run-context-copy">
              <span className="section-index">AI</span>
              <div>
                <h2>Active migration run</h2>
                <p>Resolved from the control plane. Usage refreshes automatically while the run is still processing.</p>
              </div>
            </div>
            {runId ? (
              <div className="run-context-summary">
                <div className="run-context-facts">
                  <div><small>RUN</small><strong>{runLabel || `RUN-${runId.slice(0, 8).toUpperCase()}`}</strong></div>
                  <div><small>SYS_ID</small><code>{runId}</code></div>
                  {runState && <div><small>STATE</small><strong>{runState.replaceAll("_", " ")}</strong></div>}
                  {lastSync && <div><small>LAST SYNC</small><strong>{lastSync}</strong></div>}
                </div>
                <div className="run-context-actions">
                  <button className="primary-button" onClick={() => void load(runId)} disabled={state === "loading"}>
                    <Icon name="refresh" size={15} /> {state === "loading" ? "Refreshing" : "Refresh"}
                  </button>
                  <button className="ghost-button" onClick={() => setShowChangeRun(current => !current)}>
                    <Icon name="chevron" size={13} /> {showChangeRun ? "Cancel" : "Change run"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="run-context-summary">
                <div><strong style={{ color: "var(--amber)" }}>No migration run is selected.</strong><p style={{ margin: "4px 0 0", color: "var(--muted)" }}>Open a run in the control plane and it will flow through here automatically.</p></div>
                <div className="run-context-actions">
                  <Link className="primary-button" href="/"><Icon name="chevron" size={13} /> Open control plane</Link>
                  <button className="ghost-button" onClick={() => setShowChangeRun(current => !current)}>{showChangeRun ? "Cancel" : "Enter sys_id"}</button>
                </div>
              </div>
            )}
            {showChangeRun && (
              <label className="run-id-field">
                <span>MIGRATION RUN SYS_ID</span>
                <input
                  value={runDraft}
                  onChange={event => setRunDraft(event.target.value)}
                  onKeyDown={event => { if (event.key === "Enter") switchRun(runDraft); }}
                  placeholder="Paste migration_run sys_id"
                  autoFocus
                />
                <button className="primary-button" onClick={() => switchRun(runDraft)}>Load</button>
              </label>
            )}
          </section>

          {state === "loading" && !data && <div className="panel empty-state">Loading AI usage for {runId.slice(0, 8) || "run"}…</div>}

          {state === "idle" && !runId && (
            <div className="panel empty-state">
              <strong style={{ display: "block", marginBottom: 6 }}>No migration run selected</strong>
              <p style={{ margin: 0, color: "var(--muted)" }}>Pick a run in the control plane and its AI usage will load here automatically.</p>
            </div>
          )}

          {state === "unavailable" && (
            <div className="panel empty-state">
              <strong style={{ color: "var(--amber)", display: "block", marginBottom: 6 }}>Usage unavailable</strong>
              {message || "Token metrics are not available for this run yet."}
            </div>
          )}

          {state === "error" && (
            <div className="panel empty-state">
              <strong style={{ color: "var(--coral)", display: "block", marginBottom: 6 }}>Could not load usage</strong>
              {message || "The AI usage endpoint returned an error."}
            </div>
          )}

          {state === "empty" && (
            <div className="panel empty-state">{message || `No model calls were recorded for run ${runId.slice(0, 8)}.`}</div>
          )}

          {(state === "ready" || (state === "loading" && data)) && data && (
            <>
              {fallbackCount > 0 && (
                <div className="panel empty-state" style={{ padding: "12px 16px", textAlign: "left", color: "var(--amber)", font: "10px var(--mono)" }}>
                  DETERMINISTIC FALLBACK USED · {fallbackCount} of {calls.length} call{calls.length === 1 ? "" : "s"} ran without a model.
                </div>
              )}

              {noTelemetry && (
                <div className="panel empty-state" style={{ padding: "12px 16px", textAlign: "left", color: "var(--amber)", font: "10px var(--mono)" }}>
                  TOKEN METRICS NOT CAPTURED · The backend returned {calls.length} call{calls.length === 1 ? "" : "s"} without token counts. Duration and status are still shown.
                </div>
              )}

              {partialTelemetry && (
                <div className="panel empty-state" style={{ padding: "12px 16px", textAlign: "left", color: "var(--amber)", font: "10px var(--mono)" }}>
                  PARTIAL TOKEN METRICS · Token metadata available for {clientTotals.callsWithTokens} of {calls.length} call{calls.length === 1 ? "" : "s"}. Missing calls show “—”.
                </div>
              )}

              {suspiciousAllZero && (
                <div className="panel empty-state" style={{ padding: "12px 16px", textAlign: "left", color: "var(--amber)", font: "10px var(--mono)" }}>
                  BACKEND REPORTED ZERO TOKENS FOR EVERY CALL · Durations are non-zero, so the model ran. ServiceNow /usage is likely not populating input_tokens/output_tokens — the frontend is not fabricating counts, it is displaying what the backend returned.
                </div>
              )}

              <section className="kpi-grid">
                <SummaryCard tone="lime" label="AI CALLS" value={fmt(clientTotals.callCount)} foot="Model + fallback" />
                <SummaryCard tone="green" label="INPUT TOKENS" value={fmtTokens(clientTotals.inputTokens)} foot={tokenCardFoot(clientTotals)} />
                <SummaryCard tone="amber" label="OUTPUT TOKENS" value={fmtTokens(clientTotals.outputTokens)} foot={tokenCardFoot(clientTotals)} />
                <SummaryCard tone="lime" label="TOTAL TOKENS" value={fmtTokens(clientTotals.totalTokens)} foot={tokenCardFoot(clientTotals)} />
              </section>

              {clientTotals.durationMs !== undefined && (
                <section className="kpi-grid" style={{ gridTemplateColumns: "1fr" }}>
                  <SummaryCard tone="green" label="TOTAL MODEL DURATION" value={fmtDuration(clientTotals.durationMs)} foot="Sum of call latencies" />
                </section>
              )}

              {data.cost && (
                <section className="kpi-grid" style={{ gridTemplateColumns: "1fr" }}>
                  <SummaryCard
                    tone="amber"
                    label="ESTIMATED COST"
                    value={new Intl.NumberFormat("en-US", { style: "currency", currency: data.cost.currency }).format(data.cost.amount)}
                    foot="Reported by backend"
                  />
                </section>
              )}

              <BreakdownPanel
                index="01"
                title="Phase breakdown"
                subtitle="Comprehend · Mara · Prioritize"
                rows={PHASES.map(phase => phaseGroups.find(g => g.key === phase) ?? emptyGroup(phase))
                  .concat(phaseGroups.filter(g => !PHASES.includes(g.key as (typeof PHASES)[number])))}
              />

              <BreakdownPanel index="02" title="Model breakdown" subtitle="Grouped by model name" rows={modelGroups} />

              <section className="panel table-panel">
                <div className="panel-heading compact">
                  <div>
                    <span className="section-index">03</span>
                    <div><h2>Per-call detail</h2><p>Every model invocation for this run</p></div>
                  </div>
                  <span className="panel-stat">{fmt(calls.length)} CALLS</span>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Timestamp</th><th>Phase</th><th>Model</th>
                        <th style={{ textAlign: "right" }}>Input</th>
                        <th style={{ textAlign: "right" }}>Output</th>
                        <th style={{ textAlign: "right" }}>Total</th>
                        <th style={{ textAlign: "right" }}>Duration</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {calls.map(call => <CallRow key={call.id} call={call} />)}
                    </tbody>
                  </table>
                </div>
                <div className="table-footer">
                  <span>Recalculated client-side from {fmt(calls.length)} calls</span>
                  <span>TOTAL <strong>{fmtTokens(clientTotals.totalTokens)}</strong> tokens</span>
                </div>
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function tokenCardFoot(totals: AiUsageTotals): string {
  if (!totals.tokenMetricsAvailable) return "Not captured by backend";
  if (totals.callsWithTokens < totals.callCount) return `From ${totals.callsWithTokens} of ${totals.callCount} calls`;
  return "Sum across calls";
}

function emptyGroup(key: string) {
  return { key, callCount: 0, inputTokens: undefined, outputTokens: undefined, totalTokens: undefined, durationMs: undefined, callsWithTokens: 0, tokenMetricsAvailable: false };
}

function SummaryCard({ tone, label, value, foot }: { tone: string; label: string; value: string; foot: string }) {
  return (
    <div className={`panel kpi-card ${tone}`}>
      <div className="kpi-top"><span>{label}</span></div>
      <strong>{value}</strong>
      <div className="kpi-foot"><span>{foot}</span><i /></div>
    </div>
  );
}

function BreakdownPanel({ index, title, subtitle, rows }: {
  index: string; title: string; subtitle: string;
  rows: { key: string; callCount: number; inputTokens?: number; outputTokens?: number; totalTokens?: number; durationMs?: number; callsWithTokens: number; tokenMetricsAvailable: boolean }[];
}) {
  return (
    <section className="panel table-panel" style={{ marginTop: 12 }}>
      <div className="panel-heading compact">
        <div>
          <span className="section-index">{index}</span>
          <div><h2>{title}</h2><p>{subtitle}</p></div>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{title.startsWith("Phase") ? "Phase" : "Model"}</th>
              <th style={{ textAlign: "right" }}>Calls</th>
              <th style={{ textAlign: "right" }}>Input</th>
              <th style={{ textAlign: "right" }}>Output</th>
              <th style={{ textAlign: "right" }}>Total</th>
              <th style={{ textAlign: "right" }}>Duration</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.key} style={{ cursor: "default" }}>
                <td><strong style={{ color: "var(--ink)" }}>{row.key}</strong></td>
                <td style={{ textAlign: "right" }}>{fmt(row.callCount)}</td>
                <td style={{ textAlign: "right" }}>{fmtTokens(row.inputTokens)}</td>
                <td style={{ textAlign: "right" }}>{fmtTokens(row.outputTokens)}</td>
                <td style={{ textAlign: "right" }}>{fmtTokens(row.totalTokens)}</td>
                <td style={{ textAlign: "right" }}>{fmtDuration(row.durationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CallRow({ call }: { call: AiUsageCall }) {
  const status = call.status.toLowerCase();
  const tone = status === "fallback" ? "review" : status === "error" ? "insert_as_incomplete" : "insert";
  return (
    <tr style={{ cursor: "default" }}>
      <td className="source-name">{call.timestamp}</td>
      <td>{call.phase}</td>
      <td>{call.model}</td>
      <td style={{ textAlign: "right" }}>{fmtTokens(call.inputTokens)}</td>
      <td style={{ textAlign: "right" }}>{fmtTokens(call.outputTokens)}</td>
      <td style={{ textAlign: "right" }}>{fmtTokens(call.totalTokens)}</td>
      <td style={{ textAlign: "right" }}>{fmtDuration(call.durationMs)}</td>
      <td><span className={`operation operation-${tone}`}>{call.status}</span></td>
    </tr>
  );
}
