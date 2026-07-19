"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../icons";
import {
  AiUsageCall,
  AiUsageResponse,
  computeTotals,
  groupByModel,
  groupByPhase,
  normalizeUsage,
  totalsDiffer,
} from "../lib/cmdb/usage-adapter";

const PHASES = ["Comprehend", "Mara", "Prioritize"] as const;
const intFmt = new Intl.NumberFormat("en-US");

type LoadState = "idle" | "loading" | "ready" | "empty" | "unavailable" | "error";

function runFromLocation() {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("run")?.trim() || "";
}

function fmt(n: number) {
  return intFmt.format(n);
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

function fmtDuration(ms?: number) {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${fmt(Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

export default function AiUsagePage() {
  const [runDraft, setRunDraft] = useState(runFromLocation);
  const [runId, setRunId] = useState(runFromLocation);
  const [state, setState] = useState<LoadState>("idle");
  const [message, setMessage] = useState("");
  const [data, setData] = useState<AiUsageResponse | null>(null);

  const load = useCallback(async (run: string) => {
    const trimmed = run.trim();
    if (!trimmed) {
      setState("idle");
      setData(null);
      setMessage("Enter a migration run sys_id to load its AI usage.");
      return;
    }
    setState("loading");
    setMessage("");
    try {
      // GET only — this page never mutates ServiceNow.
      const response = await fetch(`/api/cmdb/usage?run=${encodeURIComponent(trimmed)}`, {
        method: "GET",
        cache: "no-store",
      });
      const raw = await response.json().catch(() => ({}));
      const usage = normalizeUsage(raw, trimmed);
      if (!response.ok) {
        setData(null);
        // "Not built / not reachable" backends → unavailable; genuine bad requests → error.
        const unavailableStatus = [404, 501, 502, 503].includes(response.status);
        setState(unavailableStatus ? "unavailable" : "error");
        setMessage(readableError(raw) || `Request failed (${response.status}).`);
        return;
      }
      if (usage.unavailable && usage.calls.length === 0) {
        setData(null);
        setState("unavailable");
        setMessage(readableError(usage.unavailable) || "Token metrics are not available for this run yet.");
        return;
      }
      setData(usage);
      setState(usage.calls.length ? "ready" : "empty");
    } catch (error) {
      setData(null);
      setState("error");
      setMessage(error instanceof Error ? error.message : "Unable to reach the AI usage endpoint.");
    }
  }, []);

  // Kick off the initial load from the URL run param (state is seeded lazily above).
  // Deferred to a timeout so the load's setState does not run inside the effect body.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (runId) void load(runId);
      else setMessage("Enter a migration run sys_id to load its AI usage.");
    }, 0);
    return () => window.clearTimeout(timer);
    // Run once on mount; runId is the seeded URL value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submit() {
    const trimmed = runDraft.trim();
    setRunId(trimmed);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (trimmed) url.searchParams.set("run", trimmed);
      else url.searchParams.delete("run");
      window.history.replaceState({}, "", url);
    }
    void load(trimmed);
  }

  const backHref = runId ? `/?run=${encodeURIComponent(runId)}` : "/";
  const calls = useMemo(() => data?.calls ?? [], [data]);
  const clientTotals = useMemo(() => computeTotals(calls), [calls]);
  const phaseGroups = useMemo(() => groupByPhase(calls), [calls]);
  const modelGroups = useMemo(() => groupByModel(calls), [calls]);
  const fallbackCount = useMemo(() => calls.filter(c => c.status.toLowerCase() === "fallback").length, [calls]);
  const mismatch = data ? totalsDiffer(data.totals, clientTotals) && data.totals.callCount > 0 : false;

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
            <a className="ghost-button" href={backHref}><Icon name="chevron" size={14} /> Back to control plane</a>
          </section>

          <section className="run-context panel">
            <div className="run-context-copy">
              <span className="section-index">AI</span>
              <div>
                <h2>Backend run context</h2>
                <p>Usage is sourced from the scoped bridge; no global AI tables are queried from the browser.</p>
              </div>
            </div>
            <label className="run-id-field">
              <span>RUN SYS_ID</span>
              <input
                value={runDraft}
                onChange={event => setRunDraft(event.target.value)}
                onKeyDown={event => { if (event.key === "Enter") submit(); }}
                placeholder="Paste migration_run sys_id"
              />
            </label>
            <div className="run-context-actions">
              <button className="primary-button" onClick={submit} disabled={state === "loading"}>
                <Icon name="refresh" size={15} /> {state === "loading" ? "Loading" : data ? "Refresh" : "Load usage"}
              </button>
            </div>
          </section>

          {state === "loading" && <div className="panel empty-state">Loading AI usage for {runId.slice(0, 8) || "run"}…</div>}

          {state === "idle" && <div className="panel empty-state">{message}</div>}

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
            <div className="panel empty-state">No model calls were recorded for run {runId.slice(0, 8)}.</div>
          )}

          {state === "ready" && data && (
            <>
              {mismatch && (
                <div className="panel empty-state" style={{ padding: "12px 16px", textAlign: "left", color: "var(--amber)", font: "10px var(--mono)" }}>
                  Usage totals were recalculated from the individual model calls.
                </div>
              )}

              {fallbackCount > 0 && (
                <div className="panel empty-state" style={{ padding: "12px 16px", textAlign: "left", color: "var(--amber)", font: "10px var(--mono)" }}>
                  DETERMINISTIC FALLBACK USED · {fallbackCount} of {calls.length} call{calls.length === 1 ? "" : "s"} ran without a model.
                </div>
              )}

              <section className="kpi-grid">
                <SummaryCard tone="lime" label="AI CALLS" value={fmt(clientTotals.callCount)} foot="Model + fallback" />
                <SummaryCard tone="green" label="INPUT TOKENS" value={fmt(clientTotals.inputTokens)} foot="Prompt" />
                <SummaryCard tone="amber" label="OUTPUT TOKENS" value={fmt(clientTotals.outputTokens)} foot="Completion" />
                <SummaryCard tone="lime" label="TOTAL TOKENS" value={fmt(clientTotals.totalTokens)} foot="Input + output" />
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
                rows={PHASES.map(phase => phaseGroups.find(g => g.key === phase) ?? { key: phase, callCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: undefined })
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
                  <span>TOTAL <strong>{fmt(clientTotals.totalTokens)}</strong> tokens</span>
                </div>
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
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
  rows: { key: string; callCount: number; inputTokens: number; outputTokens: number; totalTokens: number; durationMs?: number }[];
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
                <td style={{ textAlign: "right" }}>{fmt(row.inputTokens)}</td>
                <td style={{ textAlign: "right" }}>{fmt(row.outputTokens)}</td>
                <td style={{ textAlign: "right" }}>{fmt(row.totalTokens)}</td>
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
      <td style={{ textAlign: "right" }}>{fmt(call.inputTokens)}</td>
      <td style={{ textAlign: "right" }}>{fmt(call.outputTokens)}</td>
      <td style={{ textAlign: "right" }}>{fmt(call.totalTokens)}</td>
      <td style={{ textAlign: "right" }}>{fmtDuration(call.durationMs)}</td>
      <td><span className={`operation operation-${tone}`}>{call.status}</span></td>
    </tr>
  );
}
