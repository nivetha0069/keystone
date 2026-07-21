// Derives the Run Journey (chapters) from the shared workspace view state.
//
// Pure mapper — no fetches, no new data sources. Every chapter narration,
// evidence row, and pause card is built from data the dashboard already
// polls. Never invents counts, never renders raw JSON.

import type { ActivityCard, PhaseStatus, WorkspaceViewState, WorkspacePhaseId } from "./workspace-view-state";
import type { AgentWorkGroup } from "./agent-workspace";
import type { WorkQueueItem } from "./work-queue";

export type JourneyChapterId = "comprehend" | "prioritize" | "remediate" | "verify";

export type JourneyPauseAction = "review_findings" | "open_approvals" | "open_remediation";

export type JourneyPause = {
  message: string;
  actions: JourneyPauseAction[];
};

export type JourneyEvidence =
  | { kind: "comprehend"; staged: number; ready: number; held: number }
  | { kind: "prioritize"; totalGroups: number; topGroups: AgentWorkGroup[] }
  | { kind: "remediate"; approvals: WorkQueueItem[]; executing: number; verified: number; totalApprovals: number }
  | {
      kind: "verify";
      baseline: number | null;
      verified: number | null;
      projected: number | null;
      realizedLift: number | null;
      remainingLift: number | null;
      relationshipsReady: number;
      relationshipsTotal: number;
      verifiedCount: number;
      groupsResolved: number;
    };

export type JourneyChapter = {
  id: JourneyChapterId;
  title: string;
  status: PhaseStatus;
  narration: string;
  beats: ActivityCard[];
  evidence: JourneyEvidence;
  pause?: JourneyPause;
  inspect: WorkspacePhaseId;
  isActive: boolean;
  updatedAt?: string;
};

export type RunJourney = {
  chapters: JourneyChapter[];
  activeChapter: JourneyChapterId;
  headline: string;
  narration: string;
  summary: string;
};

export function deriveRunJourney(view: WorkspaceViewState): RunJourney {
  const activeChapter = mapActiveChapter(view);
  const beatsByPhase = groupBeatsByPhase(view.activityCards);

  const chapters: JourneyChapter[] = [
    buildComprehendChapter(view, beatsByPhase.comprehend, activeChapter === "comprehend"),
    buildPrioritizeChapter(view, beatsByPhase.prioritize, activeChapter === "prioritize"),
    buildRemediateChapter(view, beatsByPhase.remediate, activeChapter === "remediate"),
    buildVerifyChapter(view, beatsByPhase.verify, activeChapter === "verify"),
  ];

  return {
    chapters,
    activeChapter,
    headline: view.mara.headline,
    narration: view.mara.message,
    summary: buildSummaryLine(view),
  };
}

function mapActiveChapter(view: WorkspaceViewState): JourneyChapterId {
  if (view.activePhase === "verify") return "verify";
  return view.activePhase;
}

function groupBeatsByPhase(cards: ActivityCard[]) {
  const buckets: Record<JourneyChapterId, ActivityCard[]> = {
    comprehend: [],
    prioritize: [],
    remediate: [],
    verify: [],
  };
  for (const card of cards) {
    if (card.phase === "remediate") {
      // Verification beats live under Verify; execution and approval under Remediate.
      const looksLikeVerify = /verif|read-back|verified/i.test(`${card.headline} ${card.summary} ${card.tool ?? ""}`);
      buckets[looksLikeVerify ? "verify" : "remediate"].push(card);
    } else {
      buckets[card.phase].push(card);
    }
  }
  return buckets;
}

function buildComprehendChapter(view: WorkspaceViewState, beats: ActivityCard[], isActive: boolean): JourneyChapter {
  const staged = view.queue.items.length;
  const ready = view.readyToSimulateCount;
  const held = view.heldCount;
  const status = view.comprehendStatus;
  const narration = status === "waiting"
    ? "I haven't started yet — waiting for staging."
    : status === "working"
      ? `I'm inspecting ${plural(staged, "staged record")}.`
      : `I inspected ${plural(staged, "staged record")}: ${ready} ready, ${held} held for review.`;
  return {
    id: "comprehend",
    title: "Comprehend",
    status,
    narration,
    beats,
    evidence: { kind: "comprehend", staged, ready, held },
    inspect: "comprehend",
    isActive,
    updatedAt: beats.at(-1)?.summary ? undefined : undefined,
  };
}

function buildPrioritizeChapter(view: WorkspaceViewState, beats: ActivityCard[], isActive: boolean): JourneyChapter {
  const totalGroups = view.workGroupCount;
  const topGroups = view.snapshot.groups.slice(0, 3);
  const status = view.prioritizeStatus;
  const narration = status === "waiting"
    ? "Waiting for Comprehend to finish."
    : status === "working"
      ? "I'm ranking the findings into bounded work groups."
      : totalGroups > 0
        ? `I ranked the findings into ${plural(totalGroups, "work group")}.`
        : "I finished ranking — no work groups yet.";
  return {
    id: "prioritize",
    title: "Prioritize",
    status,
    narration,
    beats,
    evidence: { kind: "prioritize", totalGroups, topGroups },
    inspect: "prioritize",
    isActive,
  };
}

function buildRemediateChapter(view: WorkspaceViewState, beats: ActivityCard[], isActive: boolean): JourneyChapter {
  const approvals = view.snapshot.approvals.slice(0, 3);
  const totalApprovals = view.approvalCount;
  const executing = view.queue.items.filter(item => item.bucket === "needs_verification").length;
  const verified = view.queue.items.filter(item => item.bucket === "verified").length;
  const status = view.remediateStatus;

  const pause: JourneyPause | undefined = view.requiresApproval
    ? {
        message: totalApprovals === 1
          ? "One record needs your review before I can continue."
          : `${totalApprovals} records need your review before I can continue.`,
        actions: ["review_findings", "open_approvals"],
      }
    : undefined;

  const narration = pause
    ? pause.message
    : status === "waiting"
      ? "Waiting for approved work to execute."
      : status === "working"
        ? "Approval received. I'm sending governed changes through IRE."
        : status === "complete"
          ? `I executed and verified ${plural(verified, "staged record")}.`
          : "I paused — the queue has no eligible work.";

  return {
    id: "remediate",
    title: "Remediate",
    status,
    narration,
    beats,
    evidence: { kind: "remediate", approvals, executing, verified, totalApprovals },
    pause,
    inspect: "remediate",
    isActive,
  };
}

function buildVerifyChapter(view: WorkspaceViewState, beats: ActivityCard[], isActive: boolean): JourneyChapter {
  const status = view.verifyStatus;
  const verifiedCount = view.queue.items.filter(item => item.bucket === "verified").length;
  const relationshipsReady = view.snapshot.relationships.ready;
  const relationshipsTotal = view.snapshot.relationships.total;
  const narration = status === "waiting"
    ? "Waiting for execution to complete."
    : status === "working"
      ? "The changes landed. I'm verifying the ServiceNow records now."
      : verifiedCount > 0
        ? `Verified ${plural(verifiedCount, "record")}. Evidence is preserved.`
        : "The run is complete. No records reached verification.";
  const groupsResolved = view.snapshot.groups.filter(group => group.realizedLift > 0).length;

  return {
    id: "verify",
    title: "Verify",
    status,
    narration,
    beats,
    evidence: {
      kind: "verify",
      baseline: view.health.baseline,
      verified: view.health.verified,
      projected: view.health.projected,
      realizedLift: view.health.realizedLift,
      remainingLift: view.health.remainingLift,
      relationshipsReady,
      relationshipsTotal,
      verifiedCount,
      groupsResolved,
    },
    inspect: "verify",
    isActive,
  };
}

function buildSummaryLine(view: WorkspaceViewState): string {
  const verified = view.queue.items.filter(item => item.bucket === "verified").length;
  const groups = view.workGroupCount;
  if (view.verifyStatus === "complete") return `${plural(verified, "record")} verified across ${plural(groups, "work group")}.`;
  if (view.requiresApproval) return `${view.approvalCount} awaiting approval · ${plural(groups, "work group")} ranked.`;
  if (view.remediateStatus === "working") return `${view.queue.items.filter(i => i.bucket === "needs_verification").length} executing · ${plural(groups, "work group")} ranked.`;
  if (view.prioritizeStatus === "complete") return `${plural(groups, "work group")} ranked · Remediate waiting.`;
  if (view.comprehendStatus === "working") return `${view.queue.items.length} staged records under inspection.`;
  return view.hasRun ? "Watching the run." : "No active run.";
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
