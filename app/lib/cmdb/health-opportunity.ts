import type { HealthFix } from "../../cmdb-data";

export type HealthOpportunityItem = {
  fix: HealthFix;
  displayedLift: number;
  projectedScore: number;
};

export type HealthOpportunity = {
  currentScore: number;
  remainingHeadroom: number;
  availableLift: number;
  atMaximum: boolean;
  items: HealthOpportunityItem[];
};

export function deriveHealthOpportunity(score: number, fixes: HealthFix[]): HealthOpportunity {
  const currentScore = clampScore(score);
  const remainingHeadroom = 100 - currentScore;
  let unallocated = remainingHeadroom;
  let projectedScore = currentScore;
  const items = fixes
    .map((fix, index) => ({ fix, index }))
    .sort((left, right) => safeRank(left.fix.rank) - safeRank(right.fix.rank) || left.index - right.index)
    .map(({ fix }) => {
      const displayedLift = Math.min(safeImpact(fix.impact), unallocated);
      unallocated -= displayedLift;
      projectedScore += displayedLift;
      return { fix, displayedLift, projectedScore };
    });

  return {
    currentScore,
    remainingHeadroom,
    availableLift: remainingHeadroom - unallocated,
    atMaximum: remainingHeadroom === 0,
    items,
  };
}

function clampScore(value: number) {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
}

function safeImpact(value: number) {
  return Math.max(0, Number.isFinite(value) ? value : 0);
}

function safeRank(value: number) {
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}
