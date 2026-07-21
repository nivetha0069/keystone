"use client";

import { useCallback, useMemo, useState } from "react";
import type { ConfigurationItem, HealthData, Relationship, TimelineEvent } from "./cmdb-data";
import { Icon } from "./icons";
import type { CprPhaseId } from "./lib/cmdb/agent-workspace";
import type { RemediationFinding, RemediationReview } from "./lib/cmdb/comprehend-adapter";
import {
  deriveWorkspaceViewState,
  type ApiState,
  type WorkspaceViewState,
} from "./lib/cmdb/workspace-view-state";
import {
  deriveRunJourney,
  type JourneyChapter,
  type JourneyChapterId,
} from "./lib/cmdb/run-journey";

type WorkspaceFocus = "overview" | "approvals";

export function AgentWorkspaceView(props: {
  runLabel: string;
  runId?: string;
  runState: string;
  apiState: ApiState;
  analysisState?: "idle" | "starting" | "started" | "error";
  cis: ConfigurationItem[];
  timeline: TimelineEvent[];
  relationships: Relationship[];
  findings: RemediationFinding[];
  reviews: RemediationReview[];
  health: HealthData;
  focus?: WorkspaceFocus;
  onOpenPhase: (phase: CprPhaseId) => void;
  onOpenVerify?: () => void;
  onOpenRemediation: (stagedCiId?: string) => void;
  onOpenEvidence: () => void;
  onRefresh: () => void;
}) {
  const view = useMemo(() => deriveWorkspaceViewState({
    runLabel: props.runLabel,
    runId: props.runId,
    runState: props.runState,
    apiState: props.apiState,
    analysisState: props.analysisState,
    cis: props.cis,
    timeline: props.timeline,
    relationships: props.relationships,
    findings: props.findings,
    reviews: props.reviews,
    health: props.health,
  }), [
    props.apiState, props.analysisState, props.cis, props.findings, props.health,
    props.relationships, props.reviews, props.runId, props.runLabel, props.runState, props.timeline,
  ]);

  const journey = useMemo(() => deriveRunJourney(view), [view]);

  const sourceLabel = props.apiState === "live" || props.apiState === "partial"
    ? "LIVE FACTORY FLOOR"
    : props.apiState === "connecting"
      ? "CONNECTING TO SERVICENOW"
      : props.runLabel
        ? "SERVICENOW EVIDENCE UNAVAILABLE"
        : "DEMO FALLBACK";

  const openPhase = useCallback((phase: CprPhaseId | "verify") => {
    if (phase === "verify") {
      if (props.onOpenVerify) props.onOpenVerify();
      else props.onOpenEvidence();
      return;
    }
    props.onOpenPhase(phase);
  }, [props]);

  if (props.focus === "approvals") {
    return <div className="page agent-workspace-page">
      <FactoryHeader view={view} sourceLabel={sourceLabel} runLabel={props.runLabel} onRefresh={props.onRefresh} />
      <ApprovalWorkspace view={view} onOpenRemediation={props.onOpenRemediation} />
    </div>;
  }

  return <div className="page agent-workspace-page">
    <FactoryHeader view={view} sourceLabel={sourceLabel} runLabel={props.runLabel} onRefresh={props.onRefresh} />

    <RunJourneyBanner journey={journey} />

    <ol className="journey-spine" aria-label="Run journey chapters">
      {journey.chapters.map((chapter, index) => (
        <JourneyChapterCard
          key={chapter.id}
          chapter={chapter}
          index={index + 1}
          onOpenPhase={openPhase}
          onOpenRemediation={props.onOpenRemediation}
          onOpenEvidence={props.onOpenEvidence}
        />
      ))}
    </ol>
  </div>;
}

function FactoryHeader({ view, sourceLabel, runLabel, onRefresh }: { view: WorkspaceViewState; sourceLabel: string; runLabel: string; onRefresh: () => void }) {
  return <section className="factory-header">
    <div className="factory-kicker"><span className={"api-dot " + statusToDot(view)} /> {sourceLabel}</div>
    <div className="factory-headline">
      <h1>{view.hasRun ? "Agent Workspace" : "Waiting for a run"}</h1>
      <div className="factory-actions">
        <span className="factory-run-tag">{runLabel || "NO RUN"}</span>
        <button className="icon-command" title="Refresh evidence" aria-label="Refresh evidence" onClick={onRefresh}>
          <Icon name="refresh" size={16} />
        </button>
      </div>
    </div>
    <p className="factory-sub">{view.snapshot.objective}</p>
  </section>;
}

function statusToDot(view: WorkspaceViewState) {
  if (view.requiresApproval) return "partial";
  if (view.verifyStatus === "complete") return "live";
  if (view.hasRun) return "live";
  return "demo";
}

function RunJourneyBanner({ journey }: { journey: ReturnType<typeof deriveRunJourney> }) {
  return <section className="journey-banner">
    <div className="journey-banner-mara">
      <span className="journey-banner-avatar" aria-hidden="true">🪷</span>
      <div>
        <small>MARA</small>
        <strong>{journey.headline}</strong>
      </div>
    </div>
    <p className="journey-banner-message">{journey.narration}</p>
    <p className="journey-banner-summary">{journey.summary}</p>
  </section>;
}

function JourneyChapterCard(props: {
  chapter: JourneyChapter;
  index: number;
  onOpenPhase: (phase: JourneyChapterId) => void;
  onOpenRemediation: (stagedCiId?: string) => void;
  onOpenEvidence: () => void;
}) {
  const { chapter } = props;
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const autoOpen = chapter.isActive || chapter.status === "approval_required" || chapter.status === "blocked";
  const open = manualOpen === null ? autoOpen : manualOpen;

  const statusClass = chapter.pause
    ? "paused"
    : chapter.status === "complete"
      ? "done"
      : chapter.status === "working" || chapter.isActive
        ? "active"
        : chapter.status === "blocked"
          ? "blocked"
          : "waiting";

  return <li className={"journey-chapter " + statusClass + (open ? " open" : "")}>
    <button
      type="button"
      className="journey-chapter-head"
      onClick={() => setManualOpen(current => (current === null ? !autoOpen : !current))}
      aria-expanded={open}
    >
      <span className="journey-chapter-node" aria-hidden="true">
        {chapter.status === "complete" ? <Icon name="check" size={14} /> : String(props.index).padStart(2, "0")}
      </span>
      <div className="journey-chapter-head-copy">
        <small>CHAPTER {props.index} · {statusLabel(statusClass)}</small>
        <strong>{chapter.title}</strong>
        <p>{chapter.narration}</p>
      </div>
      <span className="journey-chapter-caret"><Icon name="chevron" size={14} /></span>
    </button>

    {open && <div className="journey-chapter-body">
      {chapter.pause && <PauseCard pause={chapter.pause} onReview={() => props.onOpenPhase("comprehend")} onApprovals={() => props.onOpenRemediation()} />}

      <EvidenceBlock chapter={chapter} onOpenRemediation={props.onOpenRemediation} />

      {chapter.beats.length > 0 && <div className="journey-beats">
        <h3>Story so far</h3>
        <ul>
          {chapter.beats.slice(-5).reverse().map(beat => <li key={beat.id} className={"journey-beat " + beat.status}>
            <span className={"journey-beat-dot " + beat.status} aria-hidden="true" />
            <div>
              <small>#{beat.seq} · {beat.actor}{beat.tool ? " · " + beat.tool : ""}</small>
              <strong>{beat.headline}</strong>
              <p>{beat.summary}</p>
            </div>
          </li>)}
        </ul>
      </div>}

      <div className="journey-chapter-foot">
        <button className="ghost-button" onClick={() => props.onOpenPhase(chapter.inspect === "verify" ? "verify" as JourneyChapterId : chapter.inspect as JourneyChapterId)}>
          <Icon name="arrow" size={14} /> Inspect in {chapter.title} module
        </button>
      </div>
    </div>}
  </li>;
}

function statusLabel(statusClass: string) {
  switch (statusClass) {
    case "done": return "Complete";
    case "active": return "Working";
    case "paused": return "Awaiting decision";
    case "blocked": return "Blocked";
    default: return "Waiting";
  }
}

function PauseCard({ pause, onReview, onApprovals }: { pause: { message: string; actions: string[] }; onReview: () => void; onApprovals: () => void }) {
  return <div className="journey-pause">
    <div className="journey-pause-top">
      <span className="journey-pause-avatar" aria-hidden="true">🪷</span>
      <div>
        <small>MARA NEEDS A DECISION</small>
        <strong>{pause.message}</strong>
      </div>
    </div>
    <div className="journey-pause-actions">
      {pause.actions.includes("review_findings") && <button className="ghost-button" onClick={onReview}>
        <Icon name="search" size={14} /> Review evidence
      </button>}
      {pause.actions.includes("open_approvals") && <button className="primary-button" onClick={onApprovals}>
        <Icon name="shield" size={14} /> Open approvals
      </button>}
    </div>
  </div>;
}

function EvidenceBlock({ chapter, onOpenRemediation }: { chapter: JourneyChapter; onOpenRemediation: (stagedCiId?: string) => void }) {
  const evidence = chapter.evidence;
  switch (evidence.kind) {
    case "comprehend":
      return <div className="journey-evidence journey-evidence-stats">
        <Stat label="Staged" value={evidence.staged} />
        <Stat label="Ready" value={evidence.ready} />
        <Stat label="Held" value={evidence.held} />
      </div>;
    case "prioritize":
      if (evidence.totalGroups === 0) return <div className="journey-evidence journey-evidence-empty">No work groups ranked yet.</div>;
      return <div className="journey-evidence">
        <div className="journey-evidence-meta">
          <span>{evidence.totalGroups} work groups · showing top {Math.min(3, evidence.topGroups.length)}</span>
        </div>
        <ul className="journey-groups">
          {evidence.topGroups.map(group => <li key={group.id}>
            <span className="journey-group-priority">{group.priority}</span>
            <div>
              <strong>{group.title}</strong>
              <p>{group.blocker || (group.strategy ? "Allowlisted strategy: " + group.strategy : "Awaiting deterministic strategy evidence.")}</p>
            </div>
            <div className="journey-group-impact">
              <small>IMPACT</small>
              <strong>+{group.projectedLift}</strong>
            </div>
          </li>)}
        </ul>
      </div>;
    case "remediate":
      return <div className="journey-evidence journey-evidence-stats">
        <Stat label="Awaiting approval" value={evidence.totalApprovals} tone={evidence.totalApprovals > 0 ? "warn" : "muted"} />
        <Stat label="Executing" value={evidence.executing} />
        <Stat label="Verified" value={evidence.verified} tone={evidence.verified > 0 ? "good" : "muted"} />
        {evidence.approvals.length > 0 && <div className="journey-approval-list">
          {evidence.approvals.map(item => <button key={item.id} className="journey-approval-row" onClick={() => onOpenRemediation(item.stagedCiId)}>
            <span className="journey-approval-icon"><Icon name="shield" size={13} /></span>
            <div>
              <strong>{item.ci.name}</strong>
              <small>{item.finding?.number || "IRE simulation"} · {item.stagedCiId.slice(0, 8)}</small>
            </div>
            <Icon name="arrow" size={13} />
          </button>)}
        </div>}
      </div>;
    case "verify":
      return <div className="journey-evidence">
        <div className="journey-health">
          <div className="journey-health-cell">
            <small>BASELINE</small>
            <strong>{formatHealth(evidence.baseline)}</strong>
          </div>
          <Icon name="arrow" size={14} />
          <div className="journey-health-cell">
            <small>VERIFIED NOW</small>
            <strong className="verified">{formatHealth(evidence.verified)}</strong>
            <span>{evidence.realizedLift === null ? "Awaiting backend confirmation" : `+${evidence.realizedLift} realized`}</span>
          </div>
          <Icon name="arrow" size={14} />
          <div className="journey-health-cell">
            <small>PROJECTED</small>
            <strong className="projected">{formatHealth(evidence.projected)}</strong>
            <span>{evidence.remainingLift === null ? "Projection unavailable" : `+${evidence.remainingLift} available`}</span>
          </div>
        </div>
        <div className="journey-verify-meta">
          <span>{evidence.verifiedCount} verified · {evidence.groupsResolved} groups resolved · {evidence.relationshipsReady}/{evidence.relationshipsTotal} relationships ready</span>
        </div>
      </div>;
  }
}

function formatHealth(value: number | null) {
  return value === null || Number.isNaN(value) ? "—" : String(value);
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warn" | "good" | "muted" }) {
  return <div className={"journey-stat " + (tone ?? "muted")}>
    <small>{label}</small>
    <strong>{value}</strong>
  </div>;
}

function ApprovalWorkspace({ view, onOpenRemediation }: { view: WorkspaceViewState; onOpenRemediation: (stagedCiId?: string) => void }) {
  return <section className="workspace-grid approvals-focus">
    <div className="panel approval-list-panel">
      <div className="panel-heading">
        <div><span className="section-index">01</span><div><h2>Awaiting authorization</h2><p>Each approval is scoped to one staged CI and one simulation fingerprint.</p></div></div>
        <span className="panel-stat">{view.snapshot.approvals.length} OPEN</span>
      </div>
      <div className="approval-list">
        {view.snapshot.approvals.map(item => <article key={item.id}>
          <span className="ci-icon status-review"><Icon name="shield" size={15} /></span>
          <div>
            <small>{item.finding?.number || "IRE SIMULATION"} · {item.stagedCiId}</small>
            <strong>{item.ci.name}</strong>
            <p>{item.reason}</p>
            <code>{item.simulationFingerprint || "Fingerprint pending from ServiceNow"}</code>
          </div>
          <button className="primary-button" onClick={() => onOpenRemediation(item.stagedCiId)}>
            Review authorization <Icon name="arrow" size={15} />
          </button>
        </article>)}
        {!view.snapshot.approvals.length && <div className="workspace-empty">
          <Icon name="spark" size={20} />
          <strong>No approvals waiting</strong>
          <p>Mara pauses here only when a policy boundary requires human authorization.</p>
        </div>}
      </div>
    </div>
    <aside className="panel authorization-scope">
      <Icon name="shield" size={23} />
      <small>AUTHORIZATION SCOPE</small>
      <h2>One fingerprint. One CI. One execution.</h2>
      <p>Approval authorizes ServiceNow to resume Mara, execute exactly this staged record through IRE, and perform correlation-linked read-only verification.</p>
      <strong>Changes to staged data invalidate the approval.</strong>
    </aside>
  </section>;
}
