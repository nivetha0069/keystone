// Pure helpers that decide what "Live IRE response" evidence, if any, is
// safe to show for the currently-selected staged CI. Written as a pure
// module so smoke tests can exercise it from Node.
//
// Contract:
//   - hasCiSpecificIreResponse: true only when the workbench holds an actual
//     per-CI simulation/approval/execution/verification response.
//   - classifySimulationFailure: distinguishes a *strategy/configuration*
//     failure (no supported deterministic remediation for this class alias)
//     from an IRE *execution* failure. Preserves the backend's exact message.
//   - buildRunSummaryChips: converts a Mara run-level observation blob into
//     compact chips ("8 ready", "2 held", ...) — never used as CI-specific
//     evidence.

import type { WorkbenchRecord } from "./work-queue";

export type SimulationFailureKind = "strategy" | "ineligible" | "execution" | "none";

export type SimulationFailureClassification = {
  kind: SimulationFailureKind;
  /** Exact backend message, preserved verbatim when available. */
  message: string;
  className?: string;
  strategy?: string;
  /** Confidence % of the staged CI at the moment of failure. */
  confidence?: number;
  /** Missing identifier hint list ("no host_name", "no ip_address", ...). */
  missingIdentifiers?: string[];
};

/** True when at least one CI-scoped IRE response is on the workbench. */
export function hasCiSpecificIreResponse(workbench: WorkbenchRecord | undefined | null): boolean {
  if (!workbench) return false;
  return Boolean(workbench.simulation || workbench.approval || workbench.execution || workbench.verification);
}

const STRATEGY_PATTERNS = [
  /no\s+supported\s+deterministic\s+remediation\s+strategy/i,
  /no\s+deterministic\s+strategy/i,
  /class\s+alias/i,
  /strategy\s+(is\s+)?unavailable/i,
  /strategy\s+not\s+registered/i,
];

const INELIGIBLE_PATTERNS = [
  /not\s+eligible\s+for\s+simulation/i,
  /ineligible\s+for\s+simulation/i,
  /eligibility\s+check\s+failed/i,
  /confidence\s+gate/i,
  /held\s+by\s+confidence/i,
  /missing\s+(required\s+)?identifier/i,
  /no\s+identifier/i,
  /insufficient\s+identifier/i,
];

/**
 * Inspect the workbench for the simulation failure kind. Strategy failures
 * come from the configuration layer (no allowlisted strategy for this CI's
 * class alias); IRE execution failures come from ServiceNow rejecting the
 * proposal. The two must be shown differently in the UI.
 */
export function classifySimulationFailure(
  workbench: WorkbenchRecord | undefined | null,
  ci?: { className?: string; confidence?: number; ip?: string; name?: string; status?: string } | null,
): SimulationFailureClassification {
  const sim = workbench?.simulation;
  if (!sim) return { kind: "none", message: "" };
  if (sim.success && !sim.error) return { kind: "none", message: "" };
  const message = (sim.error?.message || "").trim();
  const details = sim.error?.details;
  const detailText = typeof details === "string" ? details : Array.isArray(details) ? details.filter(x => typeof x === "string").join(" ") : "";
  const haystack = `${message} ${detailText}`.trim();
  const isStrategy = STRATEGY_PATTERNS.some(pattern => pattern.test(haystack));
  const isIneligible = !isStrategy && INELIGIBLE_PATTERNS.some(pattern => pattern.test(haystack));
  const confidencePct = typeof ci?.confidence === "number"
    ? (ci.confidence <= 1 ? Math.round(ci.confidence * 100) : Math.round(ci.confidence))
    : undefined;
  const missingIdentifiers = isIneligible
    ? [
        !ci?.ip && "no ip_address",
        !ci?.name && "no name / host_name",
        (ci as { serial_number?: string } | undefined)?.serial_number === undefined && "no serial_number",
      ].filter((entry): entry is string => Boolean(entry))
    : undefined;
  return {
    kind: isStrategy ? "strategy" : isIneligible ? "ineligible" : "execution",
    message: message || detailText || "Simulation failed.",
    className: ci?.className,
    strategy: isStrategy ? "unavailable" : undefined,
    confidence: confidencePct,
    missingIdentifiers,
  };
}

export type RunSummaryChip = { label: string; value: string; tone?: "warn" | "good" };

const CHIP_KEYS: Array<{ key: string; label: string; tone?: "warn" | "good" }> = [
  { key: "ready_count", label: "ready", tone: "good" },
  { key: "held_count", label: "held", tone: "warn" },
  { key: "review_count", label: "review", tone: "warn" },
  { key: "approved_count", label: "approved", tone: "good" },
  { key: "verified_count", label: "verified", tone: "good" },
  { key: "failed_count", label: "failed", tone: "warn" },
  { key: "duplicates_merged", label: "duplicates merged", tone: "good" },
  { key: "relationships_ready", label: "relationships ready" },
  { key: "relationships_total", label: "relationships total" },
];

/**
 * Extract compact chips from a Mara run-level observation blob. Returns
 * both the chips (for pretty display) and the raw JSON (for a collapsed
 * Technical evidence disclosure). Chips are ordered by CHIP_KEYS so the
 * output is stable across polls.
 */
export function buildRunSummaryChips(reasoning: string | undefined | null): { chips: RunSummaryChip[]; raw?: string } {
  const source = (reasoning || "").trim();
  if (!source) return { chips: [] };
  const jsonMatch = source.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { chips: [], raw: source };
  let parsed: Record<string, unknown> | null = null;
  try {
    const candidate = JSON.parse(jsonMatch[0]);
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>;
    }
  } catch { /* invalid JSON — chips stay empty, raw preserved */ }
  const raw = tryPretty(jsonMatch[0]);
  if (!parsed) return { chips: [], raw };
  const chips: RunSummaryChip[] = [];
  for (const { key, label, tone } of CHIP_KEYS) {
    const value = parsed[key];
    if (typeof value === "number" && Number.isFinite(value) && value !== 0) {
      chips.push({ label, value: String(value), ...(tone ? { tone } : {}) });
    }
  }
  return { chips, raw };
}

function tryPretty(json: string): string {
  try { return JSON.stringify(JSON.parse(json), null, 2); } catch { return json; }
}

/**
 * The strategy-failure card labels used by the UI. Exported so both the
 * dashboard and smoke tests reference the same strings.
 */
export const STRATEGY_FAILURE_CARD = {
  title: "Simulation failed",
  defaultMessage: "No supported deterministic remediation strategy exists for this class alias.",
  labels: {
    class: "Class",
    strategy: "Strategy",
    fingerprint: "Fingerprint",
    approval: "Approval",
    execution: "Execution",
    verification: "Verification",
  },
  defaults: {
    strategy: "unavailable",
    fingerprint: "not generated",
    approval: "not started",
    execution: "not started",
    verification: "not started",
  },
} as const;

export const CI_EVIDENCE_EMPTY_STATE = "No CI-specific IRE simulation response was recorded.";
