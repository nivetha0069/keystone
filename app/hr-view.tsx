"use client";

import { useEffect, useMemo, useState } from "react";
import type { ConfigurationItem, TimelineEvent } from "./cmdb-data";
import { cmdbFetch } from "./lib/cmdb/demo-transport";
import { Icon } from "./icons";
import {
  buildMaraReasoningSteps,
  deriveMaraServiceNowSupervisor,
  normalizeMaraFindings,
  normalizeMaraReviews,
  normalizeMaraRun,
  runMaraAudit,
  type MaraCheckStatus,
  type MaraFinding,
  type MaraReviewDecision,
  type MaraRunRecord,
  type MaraServiceNowSupervisor,
} from "./lib/cmdb/mara-audit";

export type AgentHrViewProps = {
  timeline: TimelineEvent[];
  timelineLive: boolean;
  cis: ConfigurationItem[] | null;
  activeRunId: string;
};

type EvidenceStatus = "connecting" | "live" | "unavailable";

type Evidence = {
  findings: { status: EvidenceStatus; data: MaraFinding[] | null };
  reviews: { status: EvidenceStatus; data: MaraReviewDecision[] | null };
  run: { status: EvidenceStatus; data: MaraRunRecord | null };
};

const idleEvidence: Evidence = {
  findings: { status: "unavailable", data: null },
  reviews: { status: "unavailable", data: null },
  run: { status: "unavailable", data: null },
};

const connectingEvidence: Evidence = {
  findings: { status: "connecting", data: null },
  reviews: { status: "connecting", data: null },
  run: { status: "connecting", data: null },
};

const checkStatusLabel: Record<MaraCheckStatus, string> = {
  pass: "PASS",
  warn: "WARN",
  fail: "FAIL",
  unverifiable: "CANNOT VERIFY",
};

async function readEvidence<T>(resource: string, runId: string, normalize: (payload: unknown) => T) {
  const response = await cmdbFetch(`/api/cmdb/${resource}?run=${encodeURIComponent(runId)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${resource}: ${response.status}`);
  return normalize(await response.json());
}

export function AgentHrView({ timeline, timelineLive, cis, activeRunId }: AgentHrViewProps) {
  const [fetched, setFetched] = useState<{ runId: string; evidence: Evidence } | null>(null);
  const terminalSeq = [...timeline].reverse().find(event =>
    /analysis completed|planner completion|failed|exception/i.test(`${event.name} ${event.reasoning}`),
  )?.seq ?? 0;

  useEffect(() => {
    if (!activeRunId) return;
    let cancelled = false;
    void Promise.allSettled([
      readEvidence("findings", activeRunId, normalizeMaraFindings),
      readEvidence("reviews", activeRunId, normalizeMaraReviews),
      readEvidence("run", activeRunId, normalizeMaraRun),
    ]).then(([findings, reviews, run]) => {
      if (cancelled) return;
      setFetched({
        runId: activeRunId,
        evidence: {
          findings: findings.status === "fulfilled" ? { status: "live", data: findings.value } : { status: "unavailable", data: null },
          reviews: reviews.status === "fulfilled" ? { status: "live", data: reviews.value } : { status: "unavailable", data: null },
          run: run.status === "fulfilled" && run.value ? { status: "live", data: run.value } : { status: "unavailable", data: null },
        },
      });
    });
    return () => { cancelled = true; };
  }, [activeRunId, terminalSeq]);

  const evidence = !activeRunId ? idleEvidence : fetched?.runId === activeRunId ? fetched.evidence : connectingEvidence;
  const audit = useMemo(() => runMaraAudit({
    timeline: timelineLive ? timeline : [],
    cis,
    findings: evidence.findings.data,
    reviews: evidence.reviews.data,
    run: evidence.run.data,
  }), [timeline, timelineLive, cis, evidence]);
  const reasoningSteps = useMemo(
    () => timelineLive ? buildMaraReasoningSteps(timeline) : [],
    [timeline, timelineLive],
  );
  const supervisor = useMemo(
    () => deriveMaraServiceNowSupervisor(timelineLive ? timeline : []),
    [timeline, timelineLive],
  );

  const passed = audit.checks.filter(item => item.status === "pass").length;
  const failed = audit.checks.filter(item => item.status === "fail").length;
  const warned = audit.checks.filter(item => item.status === "warn").length;
  const unverifiable = audit.checks.filter(item => item.status === "unverifiable").length;
  const run = evidence.run.data;
  const cleared = cis?.filter(ci => ci.status === "live").length ?? 0;
  const held = cis ? cis.length - cleared : 0;
  const settled = Boolean(
    terminalSeq ||
    run && ["awaiting_approval", "simulated", "complete", "failed"].includes(run.state),
  );
  const latestSeq = timeline.at(-1)?.seq ?? 0;

  const duty = !activeRunId
    ? "Waiting for a migration run"
    : !timelineLive
      ? "Run evidence unavailable — supervision on hold"
      : !settled
        ? `Watching ${reasoningSteps.at(-1)?.actor ?? "Comprehend"} process event #${latestSeq}`
        : supervisor.status === "working"
          ? "ServiceNow Mara is coordinating the next safe handoff"
          : supervisor.status === "approval_required"
            ? "Mara reached a human approval boundary"
            : failed
              ? `${failed} deterministic ${failed === 1 ? "failure needs" : "failures need"} attention`
              : `Run reached a decision point · ${unverifiable} checks awaiting evidence`;
  const emptyMessage = !activeRunId
    ? "Select a migration run to supervise."
    : !timelineLive
      ? "Event Ledger is unavailable for this run."
      : "";

  return <div className="page">
    <section className="page-heading">
      <div>
        <span className="eyebrow accent">MARA · AI SUPERVISOR</span>
        <h1>Watch the agents reason, hand off, and act.</h1>
        <p>ServiceNow Script Includes own the LLM reasoning and tools. This page visualizes only their persisted, run-scoped Event Ledger evidence.</p>
      </div>
      <div className="persona-card">
        <span className="persona-mark"><Icon name="spark" size={17} /></span>
        <div>
          <small>MARA · SERVICENOW LLM SUPERVISOR</small>
          <strong className="persona-duty">{duty}</strong>
          <span>{run ? `Run ${run.number} · ${run.state}` : activeRunId ? `Run ${activeRunId.slice(0, 8)}` : "Reports to you"}</span>
        </div>
      </div>
    </section>

    <section className="kpi-grid">
      <div className="kpi-card lime"><div className="kpi-top"><span>Records observed</span><span className="kpi-icon"><Icon name="database" size={17} /></span></div><strong>{activeRunId && cis ? cis.length.toLocaleString() : "—"}</strong><div className="kpi-foot"><span>run-scoped staged CIs</span><i /></div></div>
      <div className="kpi-card green"><div className="kpi-top"><span>Cleared</span><span className="kpi-icon"><Icon name="check" size={17} /></span></div><strong>{activeRunId && cis ? cleared.toLocaleString() : "—"}</strong><div className="kpi-foot"><span>eligible for governed simulation</span><i /></div></div>
      <div className="kpi-card amber"><div className="kpi-top"><span>Held</span><span className="kpi-icon"><Icon name="alert" size={17} /></span></div><strong>{activeRunId && cis ? held.toLocaleString() : "—"}</strong><div className="kpi-foot"><span>conflict or incomplete evidence</span><i /></div></div>
      <div className="kpi-card coral"><div className="kpi-top"><span>Agents observed</span><span className="kpi-icon"><Icon name="users" size={17} /></span></div><strong>{activeRunId ? audit.actors.length : "—"}</strong><div className="kpi-foot"><span>{activeRunId ? `${timeline.length} real ledger events` : "select a run to observe"}</span><i /></div></div>
    </section>

    {emptyMessage ? <section className="panel live-empty-state">
      <Icon name={activeRunId ? "alert" : "users"} size={23} />
      <strong>{emptyMessage}</strong>
      <p>{activeRunId ? "Mara never substitutes demo activity for a selected live run." : "Open a staged run from Import or load its migration_run sys_id in Comprehend."}</p>
    </section> : <>
      <section className="panel agent-relay-panel">
        <div className="panel-heading">
          <div><span className="section-index">01</span><div><h2>Live agent relay</h2><p>Concise reasoning summaries, tool selections, observations, and handoffs reconstructed from real ledger events.</p></div></div>
          <span className="panel-stat"><i className="live-dot" /> {settled ? "RUN SETTLED" : "PROCESSING LIVE"}</span>
        </div>
        <div className="agent-relay">
          {reasoningSteps.map(step => <article className={`relay-step ${step.kind}`} key={step.id}>
            <div className="relay-seq">#{step.seq}</div>
            <div className="relay-actor">
              {step.handoffFrom && <small>{step.handoffFrom} →</small>}
              <strong>{step.actor}</strong>
              <span>{step.role}</span>
            </div>
            <div className="relay-copy">
              <span className={`reasoning-kind ${step.kind}`}>{step.kind.toUpperCase()}</span>
              <p>{step.summary}</p>
              {step.action && <code>{step.action}</code>}
            </div>
          </article>)}
        </div>
      </section>

      <SupervisorPanel state={supervisor} settled={settled} />

      <section className="panel">
        <div className="panel-heading">
          <div><span className="section-index">03</span><div><h2>Deterministic guardrail audit</h2><p>Mara can explain and plan in ServiceNow; these evidence checks remain authoritative.</p></div></div>
          <span className="panel-stat">{failed ? `${failed} FAILED` : warned ? `${warned} WARNED` : `${passed}/${audit.checks.length} PASSED`}</span>
        </div>
        <div className="audit-list">
          {audit.checks.map(item => <article className={`audit-row ${item.status}`} key={item.id}>
            <span className={`audit-status ${item.status}`}>{checkStatusLabel[item.status]}</span>
            <div>
              <strong>{item.title}</strong>
              <p>{item.summary}</p>
              {item.evidence.length > 0 && <ul>{item.evidence.map(line => <li key={line}>{line}</li>)}</ul>}
            </div>
          </article>)}
        </div>
      </section>

      <section className="hr-layout">
        <div className="panel">
          <div className="panel-heading">
            <div><span className="section-index">04</span><div><h2>Agent evidence records</h2><p>Aggregated from this run&apos;s Event Ledger — never invented.</p></div></div>
            <span className="panel-stat">{timeline.length} LEDGER EVENTS</span>
          </div>
          <div className="roster-grid">
            {audit.actors.map(actor => <div className="roster-card" key={actor.actor}>
              <div className="roster-top">
                <strong>{actor.actor}</strong>
                <span className={`standing ${actor.errors ? "standing-watch" : "standing-solid"}`}>{actor.errors ? `${actor.errors} ERRORS` : "CLEAN"}</span>
              </div>
              <span className="roster-role">{actor.role}</span>
              <p className="actor-detail">{actor.lastDetail}</p>
              <div className="roster-foot">
                <span>{actor.events} events</span>
                <span>{actor.actions} actions · {actor.observations} obs</span>
                <span>last #{actor.lastSeq}</span>
              </div>
            </div>)}
          </div>
        </div>

        <aside className="hr-side">
          <div className="panel">
            <div className="panel-heading compact"><div><span className="section-index">05</span><div><h2>Evidence sources</h2><p>What Mara can and cannot see</p></div></div></div>
            <div className="evidence-list">
              <EvidenceRow label="Event Ledger" status={timelineLive ? "live" : "unavailable"} detail={timelineLive ? `${timeline.length} entries` : "Timeline resource failed"} />
              <EvidenceRow label="Staged CIs" status={cis ? "live" : "unavailable"} detail={cis ? `${cis.length} records` : "CI resource failed"} />
              <EvidenceRow label="Findings" status={evidence.findings.status} detail={evidence.findings.data ? `${evidence.findings.data.length} findings` : "Bridge /findings not deployed"} />
              <EvidenceRow label="Review decisions" status={evidence.reviews.status} detail={evidence.reviews.data ? `${evidence.reviews.data.length} decisions` : "Bridge /reviews not deployed"} />
              <EvidenceRow label="Run record" status={evidence.run.status} detail={run ? `${run.number} · ${run.state}` : "Bridge /run not deployed"} />
              <EvidenceRow label="Mara Script Include" status={supervisor.status === "waiting" ? "unavailable" : supervisor.status === "working" ? "connecting" : "live"} detail={supervisor.events.length ? `${supervisor.events.length} ledger events` : "No Mara events recorded"} />
            </div>
          </div>
          <div className="panel mandate-note"><Icon name="shield" size={17} /><div><strong>Autonomous until the governance boundary</strong><p>Agents may read, classify, investigate, and simulate. Human approval and ServiceNow IRE remain mandatory for CMDB mutation.</p></div></div>
        </aside>
      </section>
    </>}
  </div>;
}

function SupervisorPanel({ state, settled }: { state: MaraServiceNowSupervisor; settled: boolean }) {
  const waiting = state.status === "waiting";
  return <section className={`panel supervisor-panel ${state.status}`}>
    <div className="panel-heading">
      <div><span className="section-index">02</span><div><h2>Mara supervisor trail</h2><p>LLM output generated and persisted by ServiceNow Script Includes.</p></div></div>
      <span className={`supervisor-state ${state.status}`}>{state.status.replaceAll("_", " ").toUpperCase()}</span>
    </div>
    {waiting ? <div className="supervisor-placeholder">
      <span className="thinking-orbit"><Icon name="spark" size={18} /></span>
      <div>
        <strong>{settled ? "Waiting for ServiceNow to invoke Mara" : "Comprehend is still producing evidence"}</strong>
        <p>{state.summary} The frontend will not manufacture a supervisor result or call an external model.</p>
      </div>
    </div> : <>
      <div className="supervisor-summary">
        <div><span className="eyebrow accent">LATEST SERVICENOW RESULT</span><h3>{state.headline}</h3><p>{state.summary}</p></div>
        <div className="supervisor-confidence"><small>RECORDED EVENTS</small><strong>{state.events.length}</strong></div>
      </div>
      <div className="mara-event-list">
        {state.events.map(event => <article key={event.id}>
          <span className={`reasoning-kind ${event.kind}`}>{event.kind.toUpperCase()}</span>
          <div><small>#{event.seq} · MARA</small><p>{event.summary}</p></div>
          {event.action && <code>{event.action}</code>}
        </article>)}
      </div>
      {state.nextAction && <div className={`next-agent-action ${state.status === "approval_required" ? "approval_required" : ""}`}>
        <span><Icon name={state.status === "approval_required" ? "shield" : "bolt"} size={18} /></span>
        <div><small>NEXT RECORDED TOOL</small><strong>{state.nextAction}</strong><p>Execution remains subject to ServiceNow policy, approval, and IRE controls.</p></div>
        <code>{state.nextAction}</code>
      </div>}
    </>}
  </section>;
}

function EvidenceRow({ label, status, detail }: { label: string; status: EvidenceStatus; detail: string }) {
  return <div className="evidence-row">
    <i className={status === "live" ? "live-dot" : "live-dot demo"} />
    <strong>{label}</strong>
    <span>{status === "connecting" ? "Loading…" : detail}</span>
  </div>;
}
