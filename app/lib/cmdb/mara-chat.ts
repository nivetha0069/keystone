// Mara's conversational layer.
//
// Mara answers questions about the run the operator is looking at, and she
// answers them from evidence the dashboard has already derived. She never
// invents a number: every sentence below is assembled from `WorkspaceViewState`,
// so anything she claims can be found on a surface the operator can open.
//
// The same `MaraChatContext` is what the ServiceNow advisory endpoint receives,
// so a live ServiceNow answer and a locally grounded answer are computed from
// identical figures — the backend can narrate better, but it cannot disagree
// about the counts.
//
// Kept free of React and DOM so it can be smoke tested directly (npm run
// smoke:mara-chat).

import type {
  ApiState,
  MaraActionKey,
  PhaseStatus,
  WorkspaceHealthView,
  WorkspacePhaseId,
  WorkspaceViewState,
} from "./workspace-view-state";

export type MaraChatIntent =
  | "status"
  | "next_step"
  | "held"
  | "approvals"
  | "counts"
  | "health"
  | "evidence"
  | "verification"
  | "sources"
  | "capability"
  | "identity"
  | "help";

export type MaraChatSource = "run_evidence" | "servicenow" | "pending";

export type MaraChatCounts = {
  staged: number;
  verified: number;
  executing: number;
  readyToSimulate: number;
  held: number;
  approvals: number;
  workGroups: number;
  relationships: number;
  reviewHeld: number;
  simulationFailed: number;
};

export type MaraChatContext = {
  runId: string;
  runLabel: string;
  runState: string;
  hasRun: boolean;
  apiState: ApiState;
  demoMode: boolean;
  activePhase: WorkspacePhaseId;
  phases: Record<WorkspacePhaseId, PhaseStatus>;
  counts: MaraChatCounts;
  health: WorkspaceHealthView;
  governance: WorkspaceViewState["governance"];
  currentAgent: string;
  currentAction: string;
  nextAction: string;
  latestResult: string;
  maraHeadline: string;
  maraMessage: string;
  /** Newest first, capped — the operator-facing summaries, never raw JSON. */
  recentEvents: Array<{ seq: number; actor: string; headline: string; summary: string; status: string }>;
  /** Why records are being held, grouped by the reason the queue recorded. */
  holdReasons: Array<{ reason: string; count: number }>;
  /** Ranked work groups, largest first. */
  workGroups: Array<{ title: string; affected: number; blocker?: string }>;
  /** Source systems the staged records came from, largest first. */
  sources: Array<{ name: string; count: number }>;
};

export type MaraChatAnswer = {
  intent: MaraChatIntent;
  text: string;
  /** Short "where this came from" lines shown under the answer. */
  evidence: string[];
  actions: MaraActionKey[];
};

export type MaraChatTurn = {
  id: string;
  role: "user" | "mara";
  text: string;
  evidence?: string[];
  actions?: MaraActionKey[];
  source?: MaraChatSource;
  intent?: MaraChatIntent;
};

const RECENT_EVENT_LIMIT = 4;
const GROUP_LIMIT = 4;
const SOURCE_LIMIT = 5;
const HOLD_REASON_LIMIT = 4;

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export function buildMaraChatContext(
  view: WorkspaceViewState,
  options: { apiState: ApiState; demoMode: boolean },
): MaraChatContext {
  const items = view.queue.items;
  const heldItems = items.filter(item => item.bucket === "blocked" || item.bucket === "simulation_failed");

  return {
    runId: view.runId,
    runLabel: view.runLabel,
    runState: view.runState,
    hasRun: view.hasRun,
    apiState: options.apiState,
    demoMode: options.demoMode,
    activePhase: view.activePhase,
    phases: {
      comprehend: view.comprehendStatus,
      prioritize: view.prioritizeStatus,
      remediate: view.remediateStatus,
      verify: view.verifyStatus,
    },
    counts: {
      staged: items.length,
      verified: items.filter(item => item.bucket === "verified").length,
      executing: items.filter(item => item.bucket === "needs_verification").length,
      readyToSimulate: view.readyToSimulateCount,
      held: view.heldCount,
      approvals: view.approvalCount,
      workGroups: view.workGroupCount,
      relationships: view.snapshot.relationships.total,
      reviewHeld: items.filter(item => item.bucket === "blocked").length,
      simulationFailed: items.filter(item => item.bucket === "simulation_failed").length,
    },
    health: view.health,
    governance: view.governance,
    currentAgent: view.currentAgent,
    currentAction: view.currentAction,
    nextAction: view.nextAction,
    latestResult: view.latestResult,
    maraHeadline: view.mara.headline,
    maraMessage: view.mara.message,
    recentEvents: [...view.activityCards]
      .slice(-RECENT_EVENT_LIMIT)
      .reverse()
      .map(card => ({
        seq: card.seq,
        actor: card.actor,
        headline: card.headline,
        summary: card.summary,
        status: card.status,
      })),
    holdReasons: groupCounts(heldItems.map(item => item.reason).filter(Boolean)).slice(0, HOLD_REASON_LIMIT),
    workGroups: [...view.snapshot.groups]
      .sort((a, b) => b.affected - a.affected)
      .slice(0, GROUP_LIMIT)
      .map(group => ({ title: group.title, affected: group.affected, blocker: group.blocker })),
    sources: groupCounts(items.map(item => item.ci.source).filter(Boolean))
      .slice(0, SOURCE_LIMIT)
      .map(entry => ({ name: entry.reason, count: entry.count })),
  };
}

function groupCounts(values: string[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

type IntentRule = { intent: MaraChatIntent; patterns: RegExp[] };

// Ordered most specific first: the first rule that matches wins, so "why is
// this blocked" resolves to `held` rather than the broader `status`.
const INTENT_RULES: IntentRule[] = [
  {
    intent: "capability",
    patterns: [
      /\b(can|could|will|would)\s+you\b.*\b(approve|fix|execute|commit|write|push|delete|merge)\b/,
      /\b(just )?(do|fix|approve|execute|commit) (it|them|this|that|everything)\b/,
      /\bwhat can you do\b/,
      /\bare you allowed\b/,
      /\bwho approves\b/,
    ],
  },
  {
    intent: "held",
    patterns: [
      /\b(held|holding|blocked|blocker|stuck|why not|excluded|untouched|left out|skipped|refus)/,
      /\bwhat('s| is) wrong\b/,
      /\bneeds? (human )?(attention|review)\b/,
    ],
  },
  {
    intent: "approvals",
    patterns: [/\bapprov/, /\bauthoriz/, /\bsign ?off\b/, /\bpacket\b/, /\bdecision\b/],
  },
  {
    intent: "verification",
    patterns: [/\bverif/, /\bread ?back\b/, /\bcommitted\b/, /\bdone\b.*\?/, /\bfinished\b/, /\bcomplete\b/],
  },
  {
    intent: "health",
    patterns: [/\bhealth\b/, /\bscore\b/, /\bgrade\b/, /\blift\b/, /\bquality\b/, /\bimprove/],
  },
  {
    intent: "sources",
    patterns: [/\bsource\b/, /\bsources\b/, /\bwhere did .*(data|record|ci)/, /\bwhich system/, /\bimported from\b/],
  },
  {
    intent: "evidence",
    patterns: [
      /\b(ledger|evidence|audit|trail|log|history)\b/,
      /\bwhat (just )?happened\b/,
      /\bwhat (have|did) you (been )?(do|done|doing)\b/,
      /\bprove\b/,
      /\bwhy did you\b/,
    ],
  },
  {
    intent: "next_step",
    patterns: [/\bnext\b/, /\bwhat should i\b/, /\bwhat do i (do|need)\b/, /\bwhat now\b/, /\baction\b/],
  },
  {
    intent: "counts",
    patterns: [/\bhow many\b/, /\bcount\b/, /\bnumber of\b/, /\btotal\b/, /\bbreakdown\b/, /\bhow much\b/],
  },
  {
    intent: "identity",
    patterns: [/\bwho are you\b/, /\bwhat are you\b/, /\byour name\b/, /\bwhat is mara\b/, /\bhello\b/, /\bhi\b/],
  },
  {
    intent: "status",
    patterns: [
      /\bstatus\b/,
      /\bhow('s| is) (it|the run|things)\b/,
      /\bwhere (are|is|does|do)\b/,
      /\bstands?\b/,
      /\bprogress\b/,
      /\bsummar/,
      /\bwhat('s| is) happening\b/,
    ],
  },
];

export function classifyMaraQuestion(question: string): MaraChatIntent {
  const text = question.toLowerCase().trim();
  if (!text) return "help";
  for (const rule of INTENT_RULES) {
    if (rule.patterns.some(pattern => pattern.test(text))) return rule.intent;
  }
  return "help";
}

// ---------------------------------------------------------------------------
// Grounded answers
// ---------------------------------------------------------------------------

export function answerFromRunEvidence(question: string, context: MaraChatContext): MaraChatAnswer {
  const intent = classifyMaraQuestion(question);
  if (!context.hasRun) return noRunAnswer(intent);

  switch (intent) {
    case "status": return statusAnswer(context);
    case "next_step": return nextStepAnswer(context);
    case "held": return heldAnswer(context);
    case "approvals": return approvalsAnswer(context);
    case "counts": return countsAnswer(context);
    case "health": return healthAnswer(context);
    case "evidence": return evidenceAnswer(context);
    case "verification": return verificationAnswer(context);
    case "sources": return sourcesAnswer(context);
    case "capability": return capabilityAnswer(context);
    case "identity": return identityAnswer(context);
    case "help": return helpAnswer(context);
  }
}

function noRunAnswer(intent: MaraChatIntent): MaraChatAnswer {
  return {
    intent,
    text: "No run is open yet, so I have nothing to read from. Stage an estate through Import and I'll start reporting on it — I only speak from a run's own evidence.",
    evidence: [],
    actions: ["start_rescue"],
  };
}

function statusAnswer(context: MaraChatContext): MaraChatAnswer {
  const { counts } = context;
  const lines = [
    `${context.runLabel || "This run"} is ${describeRunState(context)}. ${phaseSentence(context)}`,
    `${counts.staged} staged ${plural(counts.staged, "record")}: ${counts.verified} verified, ${counts.executing} executing, ${counts.readyToSimulate} ready to simulate, ${counts.held} held.`,
  ];
  if (counts.approvals > 0) {
    lines.push(`${counts.approvals} ${plural(counts.approvals, "approval")} ${counts.approvals === 1 ? "is" : "are"} waiting on you before I can continue.`);
  }
  if (context.latestResult && context.latestResult !== "—") lines.push(`Last completed step: ${context.latestResult}`);
  return {
    intent: "status",
    text: lines.join(" "),
    evidence: [sourceLine(context), `Run state: ${context.runState || "unreported"}`],
    actions: counts.approvals > 0 ? ["open_approvals", "watch_activity"] : ["watch_activity", "open_evidence"],
  };
}

function nextStepAnswer(context: MaraChatContext): MaraChatAnswer {
  const { counts } = context;
  if (counts.approvals > 0) {
    return {
      intent: "next_step",
      text: `${counts.approvals} ${plural(counts.approvals, "record")} ${counts.approvals === 1 ? "needs" : "need"} your authorization. Each approval is scoped to one staged CI and one simulation fingerprint, so approving one never widens into the rest of the run. After you authorize, ServiceNow executes and verifies without me asking again.`,
      evidence: [context.governance.title, sourceLine(context)],
      actions: ["open_approvals", "review_findings"],
    };
  }
  if (counts.readyToSimulate > 0) {
    return {
      intent: "next_step",
      text: `${counts.readyToSimulate} ${plural(counts.readyToSimulate, "record")} ${counts.readyToSimulate === 1 ? "is" : "are"} eligible for governed simulation. Simulation is non-mutating — it establishes identity and a fingerprint, nothing is written to the CMDB until an approval exists.`,
      evidence: [`Next action: ${context.nextAction}`, sourceLine(context)],
      actions: ["open_remediation", "watch_activity"],
    };
  }
  if (counts.executing > 0) {
    return {
      intent: "next_step",
      text: `Nothing needs you right now — ${counts.executing} ${plural(counts.executing, "record")} ${counts.executing === 1 ? "is" : "are"} mid-flight through IRE and I'm waiting on the correlated read-back.`,
      evidence: [`Next action: ${context.nextAction}`, sourceLine(context)],
      actions: ["watch_activity", "open_evidence"],
    };
  }
  if (counts.held > 0) {
    return {
      intent: "next_step",
      text: `The autonomous work is finished. What's left is ${counts.held} held ${plural(counts.held, "record")} that need a human decision — I won't move those on my own.`,
      evidence: [context.governance.title, sourceLine(context)],
      actions: ["review_findings", "open_approvals"],
    };
  }
  return {
    intent: "next_step",
    text: `Nothing is waiting on you. ${context.nextAction}.`,
    evidence: [`Current phase: ${phaseLabel(context.activePhase)}`, sourceLine(context)],
    actions: ["open_evidence", "watch_activity"],
  };
}

function heldAnswer(context: MaraChatContext): MaraChatAnswer {
  const { counts, holdReasons } = context;
  if (counts.held === 0 && counts.simulationFailed === 0) {
    return {
      intent: "held",
      text: "Nothing is held right now. No record in this run is sitting behind the confidence gate or a failed simulation.",
      evidence: [sourceLine(context)],
      actions: ["watch_activity", "open_evidence"],
    };
  }
  const lines = [
    `${counts.held} ${plural(counts.held, "record")} ${counts.held === 1 ? "is" : "are"} held: ${counts.reviewHeld} behind a review or policy blocker and ${counts.simulationFailed} on a failed simulation.`,
  ];
  if (holdReasons.length) {
    lines.push("The reasons recorded against them:");
    // The reason text is quoted because it is the queue's own wording and often
    // carries a finding-level count of its own. Quoting keeps that number from
    // being read as a second, contradicting claim about how many are held.
    for (const entry of holdReasons) {
      lines.push(`• ${entry.count} ${plural(entry.count, "record")} held for: "${entry.reason}"`);
    }
  }
  lines.push("Held records are deliberate. I keep them out of every packet rather than guessing at an identity the source never supplied.");
  return {
    intent: "held",
    text: lines.join("\n"),
    evidence: [context.governance.title, sourceLine(context)],
    actions: ["review_findings", "open_evidence"],
  };
}

function approvalsAnswer(context: MaraChatContext): MaraChatAnswer {
  const { counts } = context;
  if (counts.approvals === 0) {
    return {
      intent: "approvals",
      text: `Nothing is waiting for approval. ${context.governance.message}`,
      evidence: [context.governance.title, sourceLine(context)],
      actions: ["watch_activity", "open_evidence"],
    };
  }
  return {
    intent: "approvals",
    text: `${counts.approvals} ${plural(counts.approvals, "approval")} ${counts.approvals === 1 ? "is" : "are"} open. ${context.governance.message} I can prepare, simulate, and freeze a packet, but the authorization itself is yours — I have no path to a CMDB write without it.`,
    evidence: [context.governance.title, sourceLine(context)],
    actions: ["open_approvals", "review_findings"],
  };
}

function countsAnswer(context: MaraChatContext): MaraChatAnswer {
  const { counts } = context;
  const lines = [
    `${counts.staged} staged ${plural(counts.staged, "record")} in ${context.runLabel || "this run"}.`,
    `Verified ${counts.verified} · executing ${counts.executing} · ready to simulate ${counts.readyToSimulate} · held ${counts.held}.`,
  ];
  if (counts.workGroups > 0) {
    lines.push(`They're ranked into ${counts.workGroups} bounded work ${plural(counts.workGroups, "group")}:`);
    for (const group of context.workGroups) {
      lines.push(`• ${group.title} — ${group.affected} ${plural(group.affected, "record")}${group.blocker ? ` (blocked: ${group.blocker})` : ""}.`);
    }
  }
  if (counts.relationships > 0) lines.push(`${counts.relationships} staged ${plural(counts.relationships, "relationship")} came with them.`);
  return {
    intent: "counts",
    text: lines.join("\n"),
    evidence: [sourceLine(context)],
    actions: ["inspect_run", "open_evidence"],
  };
}

function healthAnswer(context: MaraChatContext): MaraChatAnswer {
  const { health } = context;
  if (health.source === "unavailable" || health.baseline === null) {
    return {
      intent: "health",
      text: "No health reading has been reported for this run yet. I'd rather say nothing than quote a score the backend hasn't produced.",
      evidence: [sourceLine(context)],
      actions: ["inspect_run", "watch_activity"],
    };
  }
  const lines = [
    `CMDB health started at ${health.baseline} and reads ${health.verified ?? health.baseline} now, with ${health.projected ?? health.baseline} projected once the ranked work is finished.`,
  ];
  if (health.realizedLift !== null) lines.push(`That's ${signed(health.realizedLift)} points realized so far${health.remainingLift !== null ? ` and ${signed(health.remainingLift)} still available` : ""}.`);
  lines.push(health.source === "reported"
    ? "Those figures come from ServiceNow, not from my own arithmetic."
    : "These are derived from the run's own verified outcomes because the backend didn't report scores directly.");
  return {
    intent: "health",
    text: lines.join(" "),
    evidence: [`Health source: ${health.source}`, sourceLine(context)],
    actions: ["inspect_run", "open_remediation"],
  };
}

function evidenceAnswer(context: MaraChatContext): MaraChatAnswer {
  if (!context.recentEvents.length) {
    return {
      intent: "evidence",
      text: "The Event Ledger has no entries for this run yet. Once the agents act, every decision lands there and I'll read it back to you.",
      evidence: [sourceLine(context)],
      actions: ["open_evidence", "watch_activity"],
    };
  }
  const lines = ["Here are the most recent ledger entries, newest first:"];
  for (const event of context.recentEvents) {
    lines.push(`• ${event.actor}: ${event.headline}${event.summary && event.summary !== "—" ? ` — ${event.summary}` : ""}`);
  }
  lines.push("Every one of those is a stored ServiceNow event, not a summary I wrote after the fact.");
  return {
    intent: "evidence",
    text: lines.join("\n"),
    evidence: [`Currently: ${context.currentAgent} — ${context.currentAction}`, sourceLine(context)],
    actions: ["open_evidence", "watch_activity"],
  };
}

function verificationAnswer(context: MaraChatContext): MaraChatAnswer {
  const { counts } = context;
  if (counts.verified === 0) {
    return {
      intent: "verification",
      text: `Nothing has reached correlated verification yet. ${phaseSentence(context)}`,
      evidence: [`Verify phase: ${context.phases.verify}`, sourceLine(context)],
      actions: ["watch_activity", "open_evidence"],
    };
  }
  const untouched = Math.max(0, counts.staged - counts.verified - counts.executing);
  return {
    intent: "verification",
    text: `${counts.verified} of ${counts.staged} staged ${plural(counts.staged, "record")} ${counts.verified === 1 ? "has" : "have"} passed correlated read-back — the CMDB record was read back against the exact execution correlation, not just assumed to have landed.${counts.executing > 0 ? ` ${counts.executing} more ${counts.executing === 1 ? "is" : "are"} still in flight.` : ""}${untouched > 0 ? ` ${untouched} ${plural(untouched, "record")} ${untouched === 1 ? "was" : "were"} never eligible and remain untouched.` : ""}`,
    evidence: [`Verify phase: ${context.phases.verify}`, sourceLine(context)],
    actions: ["open_evidence", "open_ai_usage"],
  };
}

function sourcesAnswer(context: MaraChatContext): MaraChatAnswer {
  if (!context.sources.length) {
    return {
      intent: "sources",
      text: "No source system is recorded against the staged records in this run.",
      evidence: [sourceLine(context)],
      actions: ["inspect_run"],
    };
  }
  const lines = [`The staged records in ${context.runLabel || "this run"} came from ${context.sources.length} source ${plural(context.sources.length, "system")}:`];
  for (const source of context.sources) lines.push(`• ${source.name} — ${source.count} ${plural(source.count, "record")}.`);
  lines.push("Everything landed in quarantined staging first. Nothing was written straight to the CMDB.");
  return {
    intent: "sources",
    text: lines.join("\n"),
    evidence: [sourceLine(context)],
    actions: ["inspect_run", "open_evidence"],
  };
}

function capabilityAnswer(context: MaraChatContext): MaraChatAnswer {
  return {
    intent: "capability",
    text: [
      "I can read this run, rank findings into bounded work groups, run non-mutating IRE simulations, and freeze an approval packet. I can't approve one.",
      "Authorization is a human act here: each approval is bound to one staged CI and one simulation fingerprint, and IRE is the only write path into the CMDB. If the evidence drifts after you authorize, the write is refused rather than retried.",
      context.counts.approvals > 0
        ? `Right now ${context.counts.approvals} ${plural(context.counts.approvals, "packet")} ${context.counts.approvals === 1 ? "is" : "are"} prepared and waiting for you.`
        : "Nothing is waiting on your authorization at the moment.",
    ].join(" "),
    evidence: [context.governance.title, sourceLine(context)],
    actions: context.counts.approvals > 0 ? ["open_approvals", "open_evidence"] : ["open_evidence", "watch_activity"],
  };
}

function identityAnswer(context: MaraChatContext): MaraChatAnswer {
  return {
    intent: "identity",
    text: `I'm Mara — I supervise the agents working this CMDB migration and I answer only from what this run has actually recorded. ${context.hasRun ? `Right now: ${context.maraMessage}` : "Open a run and I'll tell you where it stands."}`,
    evidence: [sourceLine(context)],
    actions: ["watch_activity", "open_evidence"],
  };
}

function helpAnswer(context: MaraChatContext): MaraChatAnswer {
  return {
    intent: "help",
    text: [
      "I couldn't map that to something this run records, so I'd rather not guess.",
      `What I can answer from ${context.runLabel || "this run"}: where it stands, what needs you next, why records are held, what's waiting for approval, how many records are in each state, the health reading, what the source systems were, and what the Event Ledger says.`,
    ].join(" "),
    evidence: [sourceLine(context)],
    actions: ["watch_activity", "open_evidence"],
  };
}

// ---------------------------------------------------------------------------
// Suggested prompts
// ---------------------------------------------------------------------------

export function suggestedQuestions(context: MaraChatContext): string[] {
  if (!context.hasRun) return ["What can you do?", "Who are you?"];
  const suggestions: string[] = [];
  if (context.counts.approvals > 0) suggestions.push("What needs my approval?");
  if (context.counts.held > 0) suggestions.push("Why are records held?");
  suggestions.push("Where does the run stand?");
  if (context.counts.verified > 0) suggestions.push("What's been verified?");
  suggestions.push("What happened most recently?");
  if (context.health.source !== "unavailable") suggestions.push("How is CMDB health?");
  suggestions.push("What should I do next?");
  return suggestions.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeRunState(context: MaraChatContext): string {
  const state = (context.runState || "").toLowerCase();
  if (!state) return "open";
  if (state === "awaiting_approval") return "paused at a human decision";
  if (state === "analyzing") return "being analyzed";
  if (state === "committed" || state === "complete" || state === "completed") return "complete";
  if (state === "failed" || state === "error") return "interrupted";
  return `in state "${context.runState}"`;
}

function phaseSentence(context: MaraChatContext): string {
  return `${phaseLabel(context.activePhase)} is the active phase (${context.phases[context.activePhase]}).`;
}

function phaseLabel(phase: WorkspacePhaseId): string {
  switch (phase) {
    case "comprehend": return "Comprehend";
    case "prioritize": return "Prioritize";
    case "remediate": return "Remediate";
    case "verify": return "Verify";
  }
}

function sourceLine(context: MaraChatContext): string {
  if (context.demoMode || context.apiState === "demo") return "Read from the demo snapshot for this run.";
  if (context.apiState === "partial") return "Read from this run's ServiceNow evidence (some endpoints are incomplete).";
  if (context.apiState === "error") return "Read from the last ServiceNow evidence this session received.";
  return "Read from this run's ServiceNow evidence.";
}

function plural(count: number, word: string): string {
  if (count === 1) return word;
  if (word.endsWith("y")) return `${word.slice(0, -1)}ies`;
  if (word.endsWith("s")) return `${word}es`;
  return `${word}s`;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}
