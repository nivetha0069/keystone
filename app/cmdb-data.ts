export type Operation = "INSERT" | "UPDATE" | "NO_CHANGE" | "INSERT_AS_INCOMPLETE" | "REVIEW" | "ERROR";

export type ConfigurationItem = {
  id: string;
  stagedCiId?: string;
  migrationRunId?: string;
  name: string;
  className: string;
  ip: string;
  source: string;
  operation: Operation;
  confidence: number;
  health: number;
  updatedAt: string;
  status: "live" | "review" | "incomplete";
  provenance: { label: string; value: string; detail?: string }[];
};

export type TimelineEvent = {
  id: string;
  seq: number;
  step: number;
  name: string;
  recordName: string;
  className: string;
  operation: Operation;
  source: string;
  confidence: number;
  time: string;
  status: "complete" | "active" | "review" | "error";
  reasoning: string;
};

export type Relationship = {
  id: string;
  source: string;
  target: string;
  sourceLabel?: string;
  targetLabel?: string;
  type: string;
  confidence: number;
};

export type HealthFix = {
  id: string;
  rank: number;
  title: string;
  description: string;
  impact: number;
  affected: number;
  tool: string;
  severity: "critical" | "high" | "medium";
};

export type HealthData = {
  score: number;
  grade: string;
  ciCount: number;
  duplicateCandidates: number;
  reviewCount: number;
  relationshipCount: number;
  completeness: number;
  correctness: number;
  compliance: number;
  duplicateRate: number;
  staleRecords: number;
  fixes: HealthFix[];
};

export const mockCis: ConfigurationItem[] = [
  {
    id: "CI-00482", name: "pay-gw-lnx-03", className: "Linux Server", ip: "10.42.18.33",
    source: "Baxter Inventory", operation: "UPDATE", confidence: 0.98, health: 96,
    updatedAt: "06:09:12", status: "live",
    provenance: [
      { label: "Raw record", value: "BAX-88421", detail: "Baxter Inventory · row 4,812" },
      { label: "AI classification", value: "cmdb_ci_linux_server", detail: "Kernel signature + hostname pattern" },
      { label: "Confidence gate", value: "98% · passed", detail: "Auto threshold: 95%" },
      { label: "IRE result", value: "UPDATE", detail: "Matched on serial + FQDN" },
      { label: "CMDB sys_id", value: "18d2f0c7db103010", detail: "Source tagged Migration Pipeline" },
    ],
  },
  {
    id: "CI-00483", name: "payments-db-01", className: "Oracle Database", ip: "10.42.21.8",
    source: "Legacy CMDB", operation: "NO_CHANGE", confidence: 0.97, health: 92,
    updatedAt: "06:09:10", status: "live",
    provenance: [
      { label: "Raw record", value: "LEG-20338", detail: "Legacy CMDB export · row 2,338" },
      { label: "AI classification", value: "cmdb_ci_db_ora_instance", detail: "Oracle service and listener fields" },
      { label: "Confidence gate", value: "97% · passed", detail: "Auto threshold: 95%" },
      { label: "IRE result", value: "NO_CHANGE", detail: "Existing CI already current" },
    ],
  },
  {
    id: "CI-00484", name: "edge-lb-prod-02", className: "Load Balancer", ip: "10.42.9.14",
    source: "NetBox", operation: "INSERT", confidence: 0.96, health: 89,
    updatedAt: "06:09:08", status: "live",
    provenance: [
      { label: "Raw record", value: "NBX-19002", detail: "NetBox · device 19,002" },
      { label: "AI classification", value: "cmdb_ci_lb", detail: "Vendor model and VIP attributes" },
      { label: "Confidence gate", value: "96% · passed", detail: "Auto threshold: 95%" },
      { label: "IRE result", value: "INSERT", detail: "No identifier match found" },
    ],
  },
  {
    id: "CI-00485", name: "sap-app-eu-04", className: "Application Server", ip: "10.51.6.24",
    source: "Spreadsheet", operation: "REVIEW", confidence: 0.76, health: 64,
    updatedAt: "06:08:59", status: "review",
    provenance: [
      { label: "Raw record", value: "XLS-00371", detail: "estate-q3.xlsx · row 371" },
      { label: "AI classification", value: "cmdb_ci_app_server", detail: "Inferred from owner and role text" },
      { label: "Confidence gate", value: "76% · held", detail: "Needs human approval" },
      { label: "IRE result", value: "Not submitted", detail: "Quarantined before CMDB write" },
    ],
  },
  {
    id: "CI-00486", name: "fileshare-nyc-12", className: "Windows Server", ip: "10.60.2.111",
    source: "SCCM", operation: "UPDATE", confidence: 0.99, health: 94,
    updatedAt: "06:08:57", status: "live",
    provenance: [
      { label: "Raw record", value: "SCCM-77129", detail: "SCCM discovery dump" },
      { label: "AI classification", value: "cmdb_ci_win_server", detail: "OS family + domain membership" },
      { label: "Confidence gate", value: "99% · passed", detail: "Auto threshold: 95%" },
      { label: "IRE result", value: "UPDATE", detail: "Matched on serial number" },
    ],
  },
  {
    id: "CI-00487", name: "mq-cluster-node-b", className: "Linux Server", ip: "10.42.32.5",
    source: "Baxter Inventory", operation: "INSERT_AS_INCOMPLETE", confidence: 0.68, health: 51,
    updatedAt: "06:08:49", status: "incomplete",
    provenance: [
      { label: "Raw record", value: "BAX-88429", detail: "Baxter Inventory · row 4,820" },
      { label: "AI classification", value: "cmdb_ci_linux_server", detail: "Linux signals present; model ambiguous" },
      { label: "Confidence gate", value: "68% · exception", detail: "Missing serial and FQDN" },
      { label: "IRE result", value: "INSERT_AS_INCOMPLETE", detail: "Could not establish identity" },
    ],
  },
];

export const mockTimeline: TimelineEvent[] = [
  { id: "EV-01", seq: 1, step: 1, name: "Source received", recordName: "pay-gw-lnx-03", className: "Unclassified", operation: "NO_CHANGE", source: "Baxter Inventory", confidence: 0, time: "06:08:41.002", status: "complete", reasoning: "CSV batch accepted; 1,248 rows fingerprinted and checksummed." },
  { id: "EV-02", seq: 2, step: 2, name: "Staged safely", recordName: "pay-gw-lnx-03", className: "Unclassified", operation: "NO_CHANGE", source: "Baxter Inventory", confidence: 0, time: "06:08:41.108", status: "complete", reasoning: "Raw values preserved in the staging table. No CMDB access occurred." },
  { id: "EV-03", seq: 3, step: 3, name: "AI classified", recordName: "pay-gw-lnx-03", className: "Linux Server", operation: "NO_CHANGE", source: "Baxter Inventory", confidence: 0.98, time: "06:08:41.318", status: "complete", reasoning: "Linux kernel signature, hostname convention, and 9/10 mapped attributes support cmdb_ci_linux_server." },
  { id: "EV-04", seq: 4, step: 4, name: "Confidence passed", recordName: "pay-gw-lnx-03", className: "Linux Server", operation: "NO_CHANGE", source: "Baxter Inventory", confidence: 0.98, time: "06:08:41.321", status: "complete", reasoning: "98% exceeds the configured 95% automatic processing threshold." },
  { id: "EV-05", seq: 5, step: 5, name: "IRE reconciled", recordName: "pay-gw-lnx-03", className: "Linux Server", operation: "UPDATE", source: "Baxter Inventory", confidence: 0.98, time: "06:08:41.704", status: "complete", reasoning: "IRE matched an existing CI on serial number and FQDN; duplicate creation was prevented." },
  { id: "EV-06", seq: 6, step: 6, name: "CMDB published", recordName: "pay-gw-lnx-03", className: "Linux Server", operation: "UPDATE", source: "Migration Pipeline", confidence: 0.98, time: "06:08:41.908", status: "complete", reasoning: "IRE applied governed attribute updates and tagged the configured discovery source." },
  { id: "EV-07", seq: 7, step: 7, name: "Ledger sealed", recordName: "pay-gw-lnx-03", className: "Linux Server", operation: "UPDATE", source: "Migration Pipeline", confidence: 0.98, time: "06:08:41.912", status: "complete", reasoning: "The complete decision trail is immutable and linked to batch CMDB-BATCH-019." },
];

export const mockRelationships: Relationship[] = [
  { id: "REL-01", source: "pay-gw-lnx-03", target: "payments-db-01", type: "Depends on", confidence: 0.96 },
  { id: "REL-02", source: "edge-lb-prod-02", target: "pay-gw-lnx-03", type: "Routes to", confidence: 0.92 },
  { id: "REL-03", source: "sap-app-eu-04", target: "payments-db-01", type: "Reads from", confidence: 0.78 },
  { id: "REL-04", source: "mq-cluster-node-b", target: "pay-gw-lnx-03", type: "Exchanges with", confidence: 0.73 },
  { id: "REL-05", source: "fileshare-nyc-12", target: "sap-app-eu-04", type: "Supports", confidence: 0.88 },
];

export const mockHealth: HealthData = {
  score: 78,
  grade: "B",
  ciCount: 842,
  duplicateCandidates: 216,
  reviewCount: 17,
  relationshipCount: 389,
  completeness: 82,
  correctness: 91,
  compliance: 96,
  duplicateRate: 3.8,
  staleRecords: 47,
  fixes: [
    { id: "FIX-01", rank: 1, title: "Collapse probable server duplicates", description: "17 CI pairs share serial, FQDN, or cloud identity signals.", impact: 6, affected: 34, tool: "Duplicate analyzer", severity: "critical" },
    { id: "FIX-02", rank: 2, title: "Complete missing ownership", description: "41 production CIs have no support group or business owner.", impact: 4, affected: 41, tool: "Ownership resolver", severity: "high" },
    { id: "FIX-03", rank: 3, title: "Review incomplete IRE inserts", description: "12 records could not be uniquely identified by IRE.", impact: 3, affected: 12, tool: "IRE advisor", severity: "high" },
    { id: "FIX-04", rank: 4, title: "Refresh stale infrastructure", description: "47 CIs have not been observed in more than 90 days.", impact: 2, affected: 47, tool: "Staleness investigator", severity: "medium" },
  ],
};
