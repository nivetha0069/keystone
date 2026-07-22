// Shared navigation-order configuration.
//
// One source of truth for the sidebar, the PageNavigation prev/next controls,
// Mara, and any button that jumps between sections. Do not hardcode this list
// anywhere else — extend this module instead.

import type { IconName } from "../../icons";

export type NavSectionId =
  | "import" | "runs" | "summaries" | "workspace" | "approvals" | "comprehend"
  | "prioritize" | "remediate" | "verify" | "ai-usage";

export type NavItem = {
  id: NavSectionId;
  label: string;
  detail: string;
  icon: IconName;
  requiresRun: boolean;
  /** External navigation target (not a dashboard section). */
  external?: boolean;
  /** True when this is a deep CPR page that should offer "Back to Agent Workspace". */
  deepCpr?: boolean;
};

export const navigationItems: NavItem[] = [
  { id: "import",      label: "Import",           detail: "Bring data in",           icon: "upload",   requiresRun: false },
  { id: "runs",        label: "Runs queue",       detail: "Switch between runs",     icon: "clock",    requiresRun: false },
  { id: "summaries",   label: "Past summaries",   detail: "Recap of finished runs",  icon: "graph",    requiresRun: false },
  { id: "workspace",   label: "Agent Workspace",  detail: "Watch the run progress",  icon: "spark",    requiresRun: true },
  { id: "approvals",   label: "Approvals",        detail: "Authorize governed work", icon: "shield",   requiresRun: true },
  { id: "comprehend",  label: "Comprehend",       detail: "Understand staged data",  icon: "search",   requiresRun: true, deepCpr: true },
  { id: "prioritize",  label: "Prioritize",       detail: "Rank health lift",        icon: "graph",    requiresRun: true, deepCpr: true },
  { id: "remediate",   label: "Remediate",        detail: "Governed IRE workbench",  icon: "tool",     requiresRun: true, deepCpr: true },
  { id: "verify",      label: "Verify",           detail: "Inspect durable evidence",icon: "clock",    requiresRun: true, deepCpr: true },
  { id: "ai-usage",    label: "AI Usage",         detail: "Review model activity",   icon: "pulse",    requiresRun: false, external: true },
];

/** Ordered list of dashboard sections used by prev/next controls. */
export const navigationOrder: NavSectionId[] = [
  "import", "runs", "summaries", "workspace", "approvals", "comprehend", "prioritize", "remediate", "verify",
];

export function getNavItem(id: NavSectionId) {
  return navigationItems.find(item => item.id === id);
}

export function getPreviousSection(current: NavSectionId, opts?: { hasRun?: boolean }): NavSectionId | undefined {
  return findNeighbour(current, -1, opts);
}

export function getNextSection(current: NavSectionId, opts?: { hasRun?: boolean }): NavSectionId | undefined {
  return findNeighbour(current, +1, opts);
}

function findNeighbour(current: NavSectionId, delta: -1 | 1, opts?: { hasRun?: boolean }) {
  const index = navigationOrder.indexOf(current);
  if (index < 0) return undefined;
  for (let step = index + delta; step >= 0 && step < navigationOrder.length; step += delta) {
    const candidate = navigationOrder[step];
    const item = getNavItem(candidate);
    if (!item) continue;
    if (item.requiresRun && opts?.hasRun === false) continue;
    return candidate;
  }
  return undefined;
}

export function shouldShowBackToWorkspace(current: NavSectionId): boolean {
  const item = getNavItem(current);
  return Boolean(item?.deepCpr);
}

/**
 * Build the AI Usage href with the active run preserved. Returns undefined when
 * the caller passes an unknown section that isn't an external link.
 */
export function externalHrefFor(id: NavSectionId, runId: string | undefined): string | undefined {
  if (id !== "ai-usage") return undefined;
  return runId ? `/ai-usage?run=${encodeURIComponent(runId)}` : "/ai-usage";
}

/**
 * Update the URL search params to preserve `?run=<activeRunId>` when the
 * caller changes sections via internal state. Safe on server (no-ops).
 * Never triggers backend work.
 */
export function navigatePreservingRun(runId: string | undefined) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (runId) url.searchParams.set("run", runId);
  else url.searchParams.delete("run");
  window.history.replaceState({}, "", url);
}
