// Derives the Mara mascot's user-visible state from real dashboard data.
//
// Kept in a separate module so it can be tested without React, and so the
// mascot never invents status the backend has not reported. Every branch here
// maps to a real signal the dashboard already computes.

import type { ConfigurationItem, HealthData, TimelineEvent } from "../../cmdb-data";
import { isDraftRunState, isTerminalRunState } from "./run-lifecycle";

export type MaraCompanionState =
  | "sleeping"
  | "inspecting"
  | "warning"
  | "awaiting_approval"
  | "blooming"
  | "error";

export type MaraSection = "import" | "runs" | "comprehend" | "live" | "hr" | "prioritize" | "remediate";

export type MaraFindingLike = { severity?: string; stagedCiId?: string };
export type MaraReviewLike = { decision?: string };

export type MaraDerivationInput = {
  section: MaraSection;
  activeRunId: string;
  runState: string;
  analysisState: "idle" | "starting" | "started" | "error";
  apiState: "connecting" | "live" | "partial" | "demo" | "error";
  timeline: TimelineEvent[];
  cis: ConfigurationItem[];
  health: HealthData;
  findings: MaraFindingLike[];
  reviews: MaraReviewLike[];
  topFixTitle?: string;
};

export type MaraDerivation = {
  state: MaraCompanionState;
  reviewCount: number;
  heldCiCount: number;
  hasVerificationLedger: boolean;
  latestLedgerName?: string;
  ciCount: number;
};

const SUCCESS_TERMINAL_STATES = new Set(["complete", "completed", "committed"]);
const FAILURE_TERMINAL_STATES = new Set(["failed", "error"]);

export function deriveMaraState(input: MaraDerivationInput): MaraDerivation {
  const runState = (input.runState || "").toLowerCase();
  const heldCiCount = input.cis.filter(ci => ci.status !== "live").length;
  const openReviews = input.reviews.filter(review => {
    const decision = (review.decision || "").toLowerCase();
    return !decision || decision === "pending" || decision === "deferred" || decision === "open";
  }).length;
  // Prefer the strongest real signal for how many records need attention.
  const reviewCount = Math.max(
    openReviews,
    heldCiCount,
    input.findings.length,
    input.health.reviewCount || 0,
  );
  const ledgerNames = input.timeline
    .filter(event => event.step === 6 || event.step === 7)
    .map(event => event.name);
  const hasVerificationLedger = ledgerNames.length > 0;
  const latestLedgerName = input.timeline.length
    ? input.timeline[input.timeline.length - 1].name
    : undefined;

  const base: Omit<MaraDerivation, "state"> = {
    reviewCount,
    heldCiCount,
    hasVerificationLedger,
    latestLedgerName,
    ciCount: input.cis.length,
  };

  if (!input.activeRunId) return { ...base, state: "sleeping" };

  const errored =
    input.analysisState === "error" ||
    FAILURE_TERMINAL_STATES.has(runState) ||
    (input.apiState === "error" && !isDraftRunState(runState));
  if (errored) return { ...base, state: "error" };

  if (runState === "awaiting_approval") return { ...base, state: "awaiting_approval" };

  // Warning overrides a "complete" state when unresolved review items remain.
  const terminalSuccess = SUCCESS_TERMINAL_STATES.has(runState);
  if (reviewCount > 0 && (terminalSuccess || !isDraftRunState(runState))) {
    return { ...base, state: "warning" };
  }

  if (terminalSuccess) return { ...base, state: "blooming" };

  const isWorking =
    input.analysisState === "starting" ||
    input.analysisState === "started" ||
    (Boolean(runState) && !isTerminalRunState(runState) && !isDraftRunState(runState)) ||
    input.apiState === "connecting";
  if (isWorking) return { ...base, state: "inspecting" };

  return { ...base, state: "sleeping" };
}

export function maraStateLabel(state: MaraCompanionState): string {
  switch (state) {
    case "sleeping": return "Resting";
    case "inspecting": return "Inspecting";
    case "warning": return "Attention needed";
    case "awaiting_approval": return "Awaiting decision";
    case "blooming": return "Verified";
    case "error": return "Interrupted";
  }
}

export type MaraMessage = { primary: string; secondary?: string };

export function buildMaraMessage(input: MaraDerivationInput, derivation: MaraDerivation): MaraMessage {
  const { state, reviewCount, ciCount, hasVerificationLedger, latestLedgerName } = derivation;

  const primary = (() => {
    switch (state) {
      case "sleeping":
        return "Bring me an estate when you're ready.";
      case "inspecting":
        return ciCount > 0
          ? `I'm watching the agents inspect ${ciCount} staged ${ciCount === 1 ? "record" : "records"}.`
          : "The agents are inspecting this migration run.";
      case "warning":
        return reviewCount === 1
          ? "1 record needs human attention."
          : `${reviewCount} records need human attention.`;
      case "awaiting_approval":
        return "The investigation is complete. A human decision is required.";
      case "blooming":
        return hasVerificationLedger
          ? "The repair was verified through IRE."
          : "The run is complete and the evidence is preserved.";
      case "error":
        return "Something interrupted the run. The existing evidence is still available.";
    }
  })();

  const secondary = (() => {
    switch (input.section) {
      case "import":
        return "Everything enters staging first. Nothing writes directly to CMDB.";
      case "comprehend":
        return reviewCount > 0 && state !== "warning"
          ? `${reviewCount} ${reviewCount === 1 ? "record is" : "records are"} being held for review.`
          : "This is where the agents explain what they found.";
      case "live":
        return latestLedgerName
          ? `Latest ledger entry: ${latestLedgerName}.`
          : "The newest agent decision will appear here.";
      case "hr":
        return "This is the team I supervise.";
      case "prioritize":
        return input.topFixTitle
          ? `Top priority: ${input.topFixTitle}.`
          : "The highest-risk findings should be handled first.";
      case "remediate":
        return "Simulation and approval happen before any governed write.";
    }
  })();

  return { primary, secondary };
}
