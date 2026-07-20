"use client";

import { useMemo } from "react";
import type { ConfigurationItem, HealthData, Relationship, TimelineEvent } from "./cmdb-data";
import { Icon } from "./icons";
import {
  deriveAgentWorkspaceSnapshot,
  type AgentWorkspaceSnapshot,
  type CprPhaseId,
} from "./lib/cmdb/agent-workspace";
import type { RemediationFinding, RemediationReview } from "./lib/cmdb/comprehend-adapter";
import { deriveRemediationWorkQueue } from "./lib/cmdb/work-queue";

type WorkspaceFocus = "overview" | "approvals";

export function AgentWorkspaceView(props: {
  runLabel: string;
  runState: string;
  apiState: "connecting" | "live" | "partial" | "demo" | "error";
  cis: ConfigurationItem[];
  timeline: TimelineEvent[];
  relationships: Relationship[];
  findings: RemediationFinding[];
  reviews: RemediationReview[];
  health: HealthData;
  focus?: WorkspaceFocus;
  onOpenPhase: (phase: CprPhaseId) => void;
  onOpenRemediation: (stagedCiId?: string) => void;
  onOpenEvidence: () => void;
  onRefresh: () => void;
}) {
  const queue = useMemo(() => deriveRemediationWorkQueue({
    cis: props.cis,
    timeline: props.timeline,
    healthFixes: props.health.fixes,
    findings: props.findings,
    reviews: props.reviews,
    demoFallback: !props.runLabel && props.apiState === "demo",
  }), [props.apiState, props.cis, props.findings, props.health.fixes, props.reviews, props.runLabel, props.timeline]);
  const snapshot = useMemo(() => deriveAgentWorkspaceSnapshot({
    runLabel: props.runLabel,
    runState: props.runState,
    cis: props.cis,
    timeline: props.timeline,
    relationships: props.relationships,
    findings: props.findings,
    reviews: props.reviews,
    health: props.health,
    queue,
  }), [props.cis, props.findings, props.health, props.relationships, props.reviews, props.runLabel, props.runState, props.timeline, queue]);
  const sourceLabel = props.apiState === "live" || props.apiState === "partial"
    ? "SERVICENOW-BACKED AUTONOMY"
    : props.apiState === "connecting"
      ? "CONNECTING TO SERVICENOW"
      : props.runLabel
        ? "SERVICENOW EVIDENCE UNAVAILABLE"
        : "DEMO FALLBACK";

  return <div className="page agent-workspace-page">
    <section className="workspace-command">
      <div>
        <div className="workspace-kicker"><span className={"api-dot " + props.apiState} /> {sourceLabel}</div>
        <h1>{props.focus === "approvals" ? "Governed approvals" : "Agent Workspace"}</h1>
        <p>{snapshot.objective}</p>
      </div>
      <div className={"agent-now " + snapshot.status}>
        <span><Icon name={snapshot.status === "approval_required" ? "shield" : "spark"} size={18} /></span>
        <div><small>{snapshot.activeAgent.toUpperCase()} / {snapshot.decisionSource.replaceAll("_", " ")}</small><strong>{snapshot.activeAction}</strong></div>
        <i />
      </div>
    </section>

    <section className="cpr-rail panel" aria-label="CPR phase progress">
      {snapshot.phases.map((phase, index) => <button key={phase.id} className={"cpr-phase " + phase.state} onClick={() => props.onOpenPhase(phase.id)}>
        <span>{String(index + 1).padStart(2, "0")}</span>
        <div><small>{phase.state.replaceAll("_", " ")}</small><strong>{phase.label}</strong><p>{phase.summary}</p></div>
        <Icon name="chevron" size={15} />
      </button>)}
    </section>

    {props.focus === "approvals"
      ? <ApprovalWorkspace snapshot={snapshot} onOpenRemediation={props.onOpenRemediation} />
      : <WorkspaceOverview snapshot={snapshot} onOpenRemediation={props.onOpenRemediation} onOpenEvidence={props.onOpenEvidence} onRefresh={props.onRefresh} />}
  </div>;
}

function WorkspaceOverview(props: {
  snapshot: AgentWorkspaceSnapshot;
  onOpenRemediation: (stagedCiId?: string) => void;
  onOpenEvidence: () => void;
  onRefresh: () => void;
}) {
  const { snapshot } = props;
  return <>
    <section className="workspace-health">
      <div className="health-stage baseline"><small>BASELINE</small><strong>{snapshot.health.baseline}</strong><span>Before verified work</span></div>
      <Icon name="arrow" size={18} />
      <div className="health-stage verified"><small>VERIFIED NOW</small><strong>{snapshot.health.verified}</strong><span>+{snapshot.health.realizedLift} realized</span></div>
      <Icon name="arrow" size={18} />
      <div className="health-stage projected"><small>PROJECTED</small><strong>{snapshot.health.projected}</strong><span>+{snapshot.health.remainingLift} available</span></div>
      <div className="relationship-readiness"><small>RELATIONSHIP READINESS</small><strong>{snapshot.relationships.ready}<span> / {snapshot.relationships.total}</span></strong><p>{snapshot.relationships.blocked} held until both endpoints verify</p></div>
    </section>

    <section className="workspace-grid">
      <div className="panel work-groups-panel">
        <div className="panel-heading"><div><span className="section-index">01</span><div><h2>Ranked work groups</h2><p>Repeated findings become one bounded agent strategy.</p></div></div><button className="icon-command" title="Refresh ServiceNow evidence" aria-label="Refresh ServiceNow evidence" onClick={props.onRefresh}><Icon name="refresh" size={16} /></button></div>
        <div className="work-group-list">
          {snapshot.groups.map(group => <article key={group.id} className="work-group-row">
            <span className="work-priority">{group.priority}</span>
            <div className="work-group-copy"><small>{group.signature}</small><strong>{group.title}</strong><p>{group.blocker || (group.strategy ? "Allowlisted strategy: " + group.strategy : "Awaiting deterministic strategy evidence.")}</p></div>
            <div className="work-group-impact"><small>IMPACT</small><strong>+{group.projectedLift}</strong><span>{group.realizedLift} verified</span></div>
            <div className="work-group-state"><small>{group.affected} affected</small><span className={group.blocker ? "blocked" : "ready"}>{group.blocker ? "Blocked" : group.strategy ? "Retry eligible" : "Observed"}</span></div>
          </article>)}
          {!snapshot.groups.length && <EmptyWorkspaceState title="No finding groups yet" detail="Mara is waiting for persisted ServiceNow findings and health evidence." />}
        </div>
      </div>

      <aside className="workspace-side">
        <ApprovalSummary snapshot={snapshot} onOpenRemediation={props.onOpenRemediation} />
        <section className="panel activity-stream">
          <div className="panel-heading compact"><div><span className="section-index">03</span><div><h2>Agent activity</h2><p>Durable decisions and tool evidence.</p></div></div><button className="icon-command" title="Open full evidence" aria-label="Open full evidence" onClick={props.onOpenEvidence}><Icon name="clock" size={16} /></button></div>
          <div className="workspace-events">{snapshot.recentActivity.slice(-6).reverse().map(event => <article key={event.id}><span className={"event-status " + event.status} /><div><small>#{event.seq} / {event.actor} / {event.decisionSource.replaceAll("_", " ")}</small><strong>{event.title}</strong><p>{event.summary}</p></div></article>)}</div>
        </section>
      </aside>
    </section>
  </>;
}

function ApprovalWorkspace({ snapshot, onOpenRemediation }: { snapshot: AgentWorkspaceSnapshot; onOpenRemediation: (stagedCiId?: string) => void }) {
  return <section className="workspace-grid approvals-focus">
    <div className="panel approval-list-panel">
      <div className="panel-heading"><div><span className="section-index">01</span><div><h2>Awaiting authorization</h2><p>Each approval is scoped to one staged CI and one simulation fingerprint.</p></div></div><span className="panel-stat">{snapshot.approvals.length} OPEN</span></div>
      <div className="approval-list">
        {snapshot.approvals.map(item => <article key={item.id}>
          <span className="ci-icon status-review"><Icon name="shield" size={15} /></span>
          <div><small>{item.finding?.number || "IRE SIMULATION"} / {item.stagedCiId}</small><strong>{item.ci.name}</strong><p>{item.reason}</p><code>{item.simulationFingerprint || "Fingerprint pending from ServiceNow"}</code></div>
          <button className="primary-button" onClick={() => onOpenRemediation(item.stagedCiId)}>Review authorization <Icon name="arrow" size={15} /></button>
        </article>)}
        {!snapshot.approvals.length && <EmptyWorkspaceState title="No approvals waiting" detail="Mara pauses here only when a policy boundary requires human authorization." />}
      </div>
    </div>
    <aside className="panel authorization-scope"><Icon name="shield" size={23} /><small>AUTHORIZATION SCOPE</small><h2>One fingerprint. One CI. One execution.</h2><p>Approval authorizes ServiceNow to resume Mara, execute exactly this staged record through IRE, and perform correlation-linked read-only verification.</p><strong>Changes to staged data invalidate the approval.</strong></aside>
  </section>;
}

function ApprovalSummary({ snapshot, onOpenRemediation }: { snapshot: AgentWorkspaceSnapshot; onOpenRemediation: (stagedCiId?: string) => void }) {
  const next = snapshot.approvals[0];
  return <section className={"panel approval-summary " + (next ? "required" : "")}>
    <div><span><Icon name="shield" size={17} /></span><div><small>{next ? "APPROVAL REQUIRED" : "GOVERNANCE CLEAR"}</small><strong>{next ? next.ci.name : "No human action needed"}</strong></div></div>
    <p>{next ? "Authorize one IRE execution for this staged CI and fingerprint. ServiceNow then executes and verifies automatically." : "Mara can continue bounded, non-mutating work until the next policy boundary."}</p>
    {next && <button className="primary-button full" onClick={() => onOpenRemediation(next.stagedCiId)}>Review approval <Icon name="arrow" size={15} /></button>}
  </section>;
}

function EmptyWorkspaceState({ title, detail }: { title: string; detail: string }) {
  return <div className="workspace-empty"><Icon name="spark" size={20} /><strong>{title}</strong><p>{detail}</p></div>;
}
