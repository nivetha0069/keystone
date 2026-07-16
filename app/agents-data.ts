import type { IconName } from "./icons";

export type AgentStanding = "exemplary" | "solid" | "watch";

export type Agent = {
  id: string;
  codename: string;
  role: string;
  focus: string;
  tenure: string;
  tasksToday: number;
  accuracy: number;
  status: "active" | "coaching";
  standing: AgentStanding;
  spark: number[];
  skills: { label: string; value: number }[];
  review: { cycle: string; summary: string; wins: string[]; growth: string[] };
};

export const agents: Agent[] = [
  {
    id: "AGT-01", codename: "Atlas", role: "Classification agent", focus: "Reads raw records, decides the CI class",
    tenure: "142 days", tasksToday: 1248, accuracy: 97.4, status: "active", standing: "exemplary",
    spark: [88, 90, 91, 93, 92, 95, 94, 96, 97, 97],
    skills: [
      { label: "Accuracy", value: 97 }, { label: "Speed", value: 88 }, { label: "Calibration", value: 94 },
      { label: "Consistency", value: 92 }, { label: "Escalation", value: 90 },
    ],
    review: {
      cycle: "CYCLE 07 · QUARTERLY",
      summary: "Atlas classified 48,120 records this cycle with zero governance exceptions. Stated confidence tracks observed accuracy within ±1.2 points — the best calibration on the team.",
      wins: ["Zero mis-routed CI classes across six source families", "Self-flagged 41 ambiguous records before the gate had to"],
      growth: ["Trim reasoning depth on trivial NO_CHANGE records", "Adopt the new storage-class taxonomy next cycle"],
    },
  },
  {
    id: "AGT-02", codename: "Sentry", role: "Confidence gatekeeper", focus: "Holds low-confidence records for humans",
    tenure: "142 days", tasksToday: 1248, accuracy: 98.1, status: "active", standing: "solid",
    spark: [95, 96, 95, 97, 96, 97, 98, 97, 98, 98],
    skills: [
      { label: "Accuracy", value: 98 }, { label: "Speed", value: 95 }, { label: "Calibration", value: 91 },
      { label: "Consistency", value: 96 }, { label: "Escalation", value: 88 },
    ],
    review: {
      cycle: "CYCLE 07 · QUARTERLY",
      summary: "Sentry held 17 of 1,248 records at the gate; every hold was upheld by human reviewers. Slightly conservative near the 95% threshold — a fair trade for a payments estate.",
      wins: ["100% of holds upheld on human review", "Cut mean gate latency to 3ms"],
      growth: ["Loosen the hold margin on well-known source families", "Surface hold reasons in plainer language"],
    },
  },
  {
    id: "AGT-03", codename: "Ledger", role: "Reconciliation proposer", focus: "Assembles IRE payloads, never writes directly",
    tenure: "98 days", tasksToday: 1231, accuracy: 96.6, status: "active", standing: "solid",
    spark: [92, 93, 95, 94, 96, 95, 96, 97, 96, 97],
    skills: [
      { label: "Accuracy", value: 96 }, { label: "Speed", value: 90 }, { label: "Calibration", value: 92 },
      { label: "Consistency", value: 94 }, { label: "Escalation", value: 93 },
    ],
    review: {
      cycle: "CYCLE 07 · QUARTERLY",
      summary: "Ledger submitted 1,231 IRE payloads with a 99.2% first-pass acceptance rate. Identity evidence packets are consistently complete; serial + FQDN pairing is now standard.",
      wins: ["99.2% first-pass IRE acceptance", "Eliminated malformed payloads entirely since cycle 05"],
      growth: ["Batch small NO_CHANGE submissions to cut IRE round-trips", "Enrich payloads with cloud-identity signals"],
    },
  },
  {
    id: "AGT-04", codename: "Weaver", role: "Relationship miner", focus: "Infers depends-on edges between CIs",
    tenure: "61 days", tasksToday: 389, accuracy: 88.1, status: "coaching", standing: "watch",
    spark: [93, 92, 91, 92, 90, 89, 90, 88, 87, 88],
    skills: [
      { label: "Accuracy", value: 88 }, { label: "Speed", value: 93 }, { label: "Calibration", value: 82 },
      { label: "Consistency", value: 85 }, { label: "Escalation", value: 79 },
    ],
    review: {
      cycle: "CYCLE 07 · QUARTERLY",
      summary: "Weaver's edge precision slipped from 93.2% to 88.1% after the NetBox feed changed shape. On a retraining plan with weekly calibration checks; volume is throttled until precision recovers past 92%.",
      wins: ["Found 58 real dependencies humans had never documented", "Fastest inference latency on the team"],
      growth: ["Re-anchor on the updated NetBox schema", "Escalate low-confidence edges instead of guessing"],
    },
  },
  {
    id: "AGT-05", codename: "Scout", role: "Duplicate analyzer", focus: "Hunts identity collisions before they land",
    tenure: "119 days", tasksToday: 216, accuracy: 95.8, status: "active", standing: "solid",
    spark: [90, 92, 93, 92, 94, 95, 94, 96, 95, 96],
    skills: [
      { label: "Accuracy", value: 96 }, { label: "Speed", value: 84 }, { label: "Calibration", value: 90 },
      { label: "Consistency", value: 91 }, { label: "Escalation", value: 92 },
    ],
    review: {
      cycle: "CYCLE 07 · QUARTERLY",
      summary: "Scout merged 216 duplicate pairs this run and prevented an estimated 17.3% inventory inflation. Evidence packets are thorough; merge proposals read like case files.",
      wins: ["216 merges, zero contested by reviewers", "Caught a serial-number collision across two source families"],
      growth: ["Speed up pairwise comparison on large batches", "Propose merge batches instead of single pairs"],
    },
  },
];

export type HrFeedItem = { icon: IconName; tone: "lime" | "green" | "amber" | "coral" | "muted"; time: string; text: string };

export const hrFeed: HrFeedItem[] = [
  { icon: "award", tone: "lime", time: "06:04", text: "Issued commendation to Atlas — 30 days without a governance exception." },
  { icon: "book", tone: "amber", time: "05:58", text: "Enrolled Weaver in relationship-precision retraining; edge precision dipped to 88.1%." },
  { icon: "target", tone: "green", time: "05:41", text: "Completed quarterly calibration review for Sentry — gate thresholds re-certified." },
  { icon: "clock", tone: "muted", time: "05:22", text: "Approved Scout's downtime window for index rebuild (22:00–22:20 UTC)." },
  { icon: "alert", tone: "coral", time: "04:57", text: "Filed drift notice on Weaver; escalation rate rose 2.1 points week-over-week." },
  { icon: "users", tone: "muted", time: "04:30", text: "No new hires this cycle. Two candidate agents remain in the evaluation sandbox." },
  { icon: "heart", tone: "green", time: "04:02", text: "Team pulse check: 4 of 5 agents operating inside healthy confidence bands." },
];

export const maraDuties = [
  "Spot-checking 12 of Atlas's recent classifications…",
  "Reading Weaver's overnight retraining transcript…",
  "Comparing Sentry's stated confidence to observed outcomes…",
  "Drafting cycle 08 review templates…",
  "Auditing Ledger's IRE acceptance-rate trend…",
  "Sampling Scout's merge evidence packets…",
];
