"use client";

import { useCallback, useMemo, useState } from "react";
import type { ConfigurationItem, HealthData, Relationship, TimelineEvent } from "./cmdb-data";
import { Icon } from "./icons";
import type { CprPhaseId } from "./lib/cmdb/agent-workspace";
import type { RemediationFinding, RemediationReview } from "./lib/cmdb/comprehend-adapter";
import {
  deriveWorkspaceViewState,
  type ApiState,
  type WorkspacePhaseId,
  type WorkspaceViewState,
} from "./lib/cmdb/workspace-view-state";

type WorkspaceFocus = "overview" | "approvals";

const WORKSPACE_TABS: Array<{ id: WorkspacePhaseId | "overview"; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "comprehend", label: "Comprehend" },
  { id: "prioritize", label: "Prioritize" },
  { id: "remediate", label: "Remediate" },
  { id: "verify", label: "Verify" },
];

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

  const [tab, setTab] = useState<WorkspacePhaseId | "overview">("overview");
  const [autopilot, setAutopilot] = useState(true);
  const [lastActivePhase, setLastActivePhase] = useState<WorkspacePhaseId>(view.activePhase);

  if (autopilot && view.activePhase !== lastActivePhase) {
    setLastActivePhase(view.activePhase);
    if (tab !== view.activePhase) setTab(view.activePhase);
  }

  const sourceLabel = props.apiState === "live" || props.apiState === "partial"
    ? "SERVICENOW-BACKED AUTONOMY"
    : props.apiState === "connecting"
      ? "CONNECTING TO SERVICENOW"
      : props.runLabel
        ? "SERVICENOW EVIDENCE UNAVAILABLE"
        : "DEMO FALLBACK";

  const selectTab = useCallback((next: WorkspacePhaseId | "overview") => {
    setAutopilot(false);
    setTab(next);
  }, []);

  const resumeAutopilot = useCallback(() => {
    setAutopilot(true);
    setTab(view.activePhase);
  }, [view.activePhase]);

  const openPhase = useCallback((phase: WorkspacePhaseId) => {
    if (phase === "verify") {
      if (props.onOpenVerify) props.onOpenVerify();
      else props.onOpenEvidence();
      return;
    }
    props.onOpenPhase(phase);
  }, [props]);

  return <div className="page agent-workspace-page">
    <section className="workspace-command">
      <div>
        <div className="workspace-kicker"><span className={"api-dot " + props.apiState} /> {sourceLabel}</div>
        <h1>{props.focus === "approvals" ? "Governed approvals" : "Agent Workspace"}</h1>
        <p>{view.snapshot.objective}</p>
      </div>
      <div className={"agent-now " + view.snapshot.status}>
        <span><Icon name={view.snapshot.status === "approval_required" ? "shield" : "spark"} size={18} /></span>
        <div>
          <small>{view.snapshot.activeAgent.toUpperCase()} / {view.snapshot.decisionSource.replaceAll("_", " ")}</small>
          <strong className="agent-action-text">{view.snapshot.activeAction}</strong>
        </div>
        <i />
      </div>
    </section>

    <nav className="workspace-tabs" role="tablist" aria-label="Workspace phase navigation">
      {WORKSPACE_TABS.map(item => {
        const status = tabStatus(item.id, view);
        const active = tab === item.id;
        const highlight = autopilot && item.id !== "overview" && view.activePhase === item.id;
        return <button
          key={item.id}
          role="tab"
          aria-selected={active}
          className={"workspace-tab" + (active ? " active" : "") + (highlight ? " highlight" : "") + " status-" + status}
          onClick={() => selectTab(item.id)}
        >
          <span className="workspace-tab-label">{item.label}</span>
          <small className="workspace-tab-status">{tabStatusLabel(status)}</small>
        </button>;
      })}
      <div className="workspace-tab-actions">
        <button
          type="button"
          className={"autopilot-toggle" + (autopilot ? " active" : "")}
          aria-pressed={autopilot}
          onClick={() => (autopilot ? setAutopilot(false) : resumeAutopilot())}
          title={autopilot ? "Autopilot follows the active phase" : "Resume the live journey"}
        >
          <span className="autopilot-dot" />
          {autopilot ? "Autopilot" : "Resume live journey"}
        </button>
      </div>
    </nav>

    <section className="cpr-rail panel" aria-label="CPR phase progress">
      {view.snapshot.phases.map((phase, index) => <button
        key={phase.id}
        className={"cpr-phase " + phase.state + (autopilot && view.activePhase === phase.id ? " highlight" : "")}
        onClick={() => openPhase(phase.id)}
      >
        <span>{String(index + 1).padStart(2, "0")}</span>
        <div>
          <small>{phase.state.replaceAll("_", " ")}</small>
          <strong>{phase.label}</strong>
          <p>{phase.summary}</p>
        </div>
        <Icon name="chevron" size={15} />
      </button>)}
    </section>

    {props.focus === "approvals"
      ? <ApprovalWorkspace view={view} onOpenRemediation={props.onOpenRemediation} />
      : <WorkspaceOverview
          view={view}
          autopilot={autopilot}
          activeTab={tab}
          onOpenRemediation={props.onOpenRemediation}
          onOpenEvidence={props.onOpenEvidence}
          onOpenPhase={openPhase}
          onRefresh={props.onRefresh}
        />}
  </div>;
}

function tabStatus(id: WorkspacePhaseId | "overview", view: WorkspaceViewState) {
  if (id === "overview") return "overview";
  if (id === "comprehend") return view.comprehendStatus;
  if (id === "prioritize") return view.prioritizeStatus;
  if (id === "remediate") return view.remediateStatus;
  return view.verifyStatus;
}

function tabStatusLabel(status: string) {
  if (status === "approval_required") return "Approval";
  if (status === "working") return "Live";
  if (status === "complete") return "Done";
  if (status === "blocked") return "Blocked";
  if (status === "unknown") return "—";
  if (status === "overview") return "";
  return "Waiting";
}

function WorkspaceOverview(props: {
  view: WorkspaceViewState;
  autopilot: boolean;
  activeTab: WorkspacePhaseId | "overview";
  onOpenRemediation: (stagedCiId?: string) => void;
  onOpenEvidence: () => void;
  onOpenPhase: (phase: WorkspacePhaseId) => void;
  onRefresh: () => void;
}) {
  const { view } = props;
  return <>
    <HealthStrip view={view} />

    <LiveAgentPlanPanel view={view} />

    <section className="workspace-grid">
      <div className="panel work-groups-panel">
        <div className="panel-heading">
          <div>
            <span className="section-index">01</span>
            <div><h2>Ranked work groups</h2><p>Repeated findings become one bounded agent strategy.</p></div>
          </div>
          <button className="icon-command" title="Refresh ServiceNow evidence" aria-label="Refresh ServiceNow evidence" onClick={props.onRefresh}>
            <Icon name="refresh" size={16} />
          </button>
        </div>
        <div className="work-group-list">
          {view.snapshot.groups.map(group => <article key={group.id} className="work-group-row">
            <span className="work-priority">{group.priority}</span>
            <div className="work-group-copy">
              <small>{group.signature}</small>
              <strong>{group.title}</strong>
              <p>{group.blocker || (group.strategy ? "Allowlisted strategy: " + group.strategy : "Awaiting deterministic strategy evidence.")}</p>
            </div>
            <div className="work-group-impact">
              <small>IMPACT</small>
              <strong>+{group.projectedLift}</strong>
              <span>{group.realizedLift} verified</span>
            </div>
            <div className="work-group-state">
              <small>{group.affected} affected</small>
              <span className={group.blocker ? "blocked" : "ready"}>
                {group.blocker ? "Blocked" : group.strategy ? "Retry eligible" : "Observed"}
              </span>
            </div>
          </article>)}
          {!view.snapshot.groups.length && <EmptyWorkspaceState title="No finding groups yet" detail="Mara is waiting for persisted ServiceNow findings and health evidence." />}
        </div>
      </div>

      <aside className="workspace-side">
        <GovernancePanel view={view} onOpenRemediation={props.onOpenRemediation} />
        <ActivityStreamPanel view={view} onOpenEvidence={props.onOpenEvidence} />
      </aside>
    </section>
  </>;
}

function HealthStrip({ view }: { view: WorkspaceViewState }) {
  const { health, snapshot } = view;
  const showValue = (value: number | null) => value === null || Number.isNaN(value) ? "—" : String(value);
  const realized = health.realizedLift;
  const remaining = health.remainingLift;
  return <section className="workspace-health">
    <div className="health-stage baseline">
      <small>BASELINE</small>
      <strong>{showValue(health.baseline)}</strong>
      <span>Before verified work</span>
    </div>
    <Icon name="arrow" size={18} />
    <div className="health-stage verified">
      <small>VERIFIED NOW</small>
      <strong>{showValue(health.verified)}</strong>
      <span>{realized === null ? "Awaiting backend confirmation" : `+${realized} realized`}</span>
    </div>
    <Icon name="arrow" size={18} />
    <div className="health-stage projected">
      <small>PROJECTED</small>
      <strong>{showValue(health.projected)}</strong>
      <span>{remaining === null ? "Projection unavailable" : `+${remaining} available`}</span>
    </div>
    <div className="relationship-readiness">
      <small>RELATIONSHIP READINESS</small>
      <strong>{snapshot.relationships.ready}<span> / {snapshot.relationships.total}</span></strong>
      <p>{snapshot.relationships.blocked} held until both endpoints verify</p>
    </div>
  </section>;
}

function LiveAgentPlanPanel({ view }: { view: WorkspaceViewState }) {
  const hasData = view.activityCards.length > 0 || view.requiresApproval;
  return <section className="panel live-plan-panel">
    <div className="panel-heading compact">
      <div><span className="section-index">02</span><div><h2>Live agent plan</h2><p>Recorded activity — not chain-of-thought.</p></div></div>
      <span className={"plan-source-pill " + (hasData ? "live" : "empty")}>{hasData ? "Event Ledger" : "Awaiting data"}</span>
    </div>
    {hasData ? <div className="live-plan-grid">
      <PlanCell label="Current phase" value={phaseLabelForId(view.activePhase)} />
      <PlanCell label="Current agent" value={view.currentAgent || "—"} />
      <PlanCell label="Current tool" value={view.currentTool ?? "—"} />
      <PlanCell label="Current action" value={truncate(view.currentAction, 120)} />
      <PlanCell label="Latest completed result" value={truncate(view.latestResult, 130)} />
      <PlanCell label="Next phase" value={view.nextPhase ? phaseLabelForId(view.nextPhase) : view.nextAction} />
    </div> : <div className="live-plan-empty">
      <Icon name="clock" size={22} />
      <strong>Waiting for recorded activity</strong>
      <p>The Event Ledger has not published a durable decision for this run yet.</p>
    </div>}
  </section>;
}

function PlanCell({ label, value }: { label: string; value: string }) {
  return <div className="live-plan-cell">
    <small>{label.toUpperCase()}</small>
    <strong>{value}</strong>
  </div>;
}

function ActivityStreamPanel({ view, onOpenEvidence }: { view: WorkspaceViewState; onOpenEvidence: () => void }) {
  const events = [...view.activityCards].slice(-8).reverse();
  const [expanded, setExpanded] = useState<string | null>(null);
  return <section className="panel activity-stream">
    <div className="panel-heading compact">
      <div>
        <span className="section-index">03</span>
        <div><h2>Activity stream</h2><p>Durable decisions and tool evidence.</p></div>
      </div>
      <button className="icon-command" title="Open full evidence" aria-label="Open full evidence" onClick={onOpenEvidence}>
        <Icon name="clock" size={16} />
      </button>
    </div>
    <div className="activity-stream-list">
      {events.map(card => {
        const isOpen = expanded === card.id;
        const ledgerItem = view.queue.items.find(item => item.latestEvent?.id === card.id);
        return <article key={card.id} className={"activity-row " + card.status + (isOpen ? " open" : "")}>
          <button className="activity-row-top" onClick={() => setExpanded(current => (current === card.id ? null : card.id))} aria-expanded={isOpen}>
            <span className={"event-status " + card.status} />
            <div className="activity-row-copy">
              <small>#{card.seq} · {card.actor} · {card.tool ?? card.phase}</small>
              <strong>{card.headline}</strong>
              <p>{truncate(card.summary, 200)}</p>
            </div>
            <span className={"activity-status-pill " + card.status}>{card.status}</span>
          </button>
          {isOpen && <div className="activity-row-detail">
            <dl>
              <dt>Affected CI</dt><dd>{ledgerItem?.ci?.name ?? "—"}</dd>
              <dt>Finding IDs</dt><dd>{ledgerItem?.finding?.number ?? "—"}</dd>
              <dt>Phase</dt><dd>{card.phase}</dd>
              <dt>Sequence</dt><dd>#{card.seq}</dd>
            </dl>
            <details className="activity-technical">
              <summary>Technical evidence</summary>
              <pre>{card.technical}</pre>
            </details>
          </div>}
        </article>;
      })}
      {!events.length && <EmptyWorkspaceState title="Activity stream is quiet" detail="No Event Ledger entries have been published for this run yet." />}
    </div>
  </section>;
}

function GovernancePanel({ view, onOpenRemediation }: { view: WorkspaceViewState; onOpenRemediation: (stagedCiId?: string) => void }) {
  const nextApproval = view.snapshot.approvals[0];
  return <section className={"panel approval-summary tone-" + view.governance.tone + (view.requiresApproval ? " required" : "")}>
    <div>
      <span><Icon name="shield" size={17} /></span>
      <div>
        <small>{view.governance.title.toUpperCase()}</small>
        <strong>{nextApproval ? nextApproval.ci.name : view.governance.title}</strong>
      </div>
    </div>
    <p>{view.governance.message}</p>
    {nextApproval && <button className="primary-button full" onClick={() => onOpenRemediation(nextApproval.stagedCiId)}>
      Review approval <Icon name="arrow" size={15} />
    </button>}
  </section>;
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
        {!view.snapshot.approvals.length && <EmptyWorkspaceState title="No approvals waiting" detail="Mara pauses here only when a policy boundary requires human authorization." />}
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

function EmptyWorkspaceState({ title, detail }: { title: string; detail: string }) {
  return <div className="workspace-empty"><Icon name="spark" size={20} /><strong>{title}</strong><p>{detail}</p></div>;
}

function phaseLabelForId(id: WorkspacePhaseId | undefined) {
  if (!id) return "—";
  const labels: Record<WorkspacePhaseId, string> = {
    comprehend: "Comprehend",
    prioritize: "Prioritize",
    remediate: "Remediate",
    verify: "Verify",
  };
  return labels[id];
}

function truncate(value: string | undefined, limit: number) {
  if (!value) return "—";
  return value.length > limit ? value.slice(0, limit - 1) + "…" : value;
}
