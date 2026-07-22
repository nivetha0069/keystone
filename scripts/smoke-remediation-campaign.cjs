const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveTypeScript(request, parent, isMain, options) {
  if ((request.startsWith("./") || request.startsWith("../")) && parent?.filename) {
    const candidate = path.resolve(path.dirname(parent.filename), request);
    if (!path.extname(candidate) && fs.existsSync(`${candidate}.ts`)) return `${candidate}.ts`;
  }
  return originalResolve.call(this, request, parent, isMain, options);
};
require.extensions[".ts"] = function loadTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const campaign = require("../app/lib/cmdb/remediation-campaign.ts");

async function main() {
const RUN = "e0ac4df32b82871060aefba6b891bf5b";
const fp = index => index.toString(16).padStart(64, "A").slice(-64).toUpperCase();
const sysId = index => index.toString(16).padStart(32, "0");
const cis = Array.from({ length: 22 }, (_, index) => ({
  id: sysId(index + 1), stagedCiId: sysId(index + 1), migrationRunId: RUN,
  name: `server-${String(index + 1).padStart(2, "0")}`, className: "cmdb_ci_linux_server",
  ip: `10.0.0.${index + 1}`, source: "fixture", operation: "UPDATE", confidence: 0.95,
  health: 80, updatedAt: "2026-07-22 12:00:00", status: "live", provenance: [],
})).reverse();
const health = { score: 80, grade: "B", ciCount: 22, duplicateCandidates: 0, reviewCount: 0,
  relationshipCount: 0, completeness: 80, correctness: 80, compliance: 80, duplicateRate: 0,
  staleRecords: 0, fixes: [] };
const base = { migrationRunId: RUN, cis, timeline: [], findings: [], reviews: [], health, relationships: [] };

const plan = campaign.planRemediationCampaign(base, undefined, 99);
assert.equal(plan.items.length, 20, "campaign is capped at 20");
assert.equal(plan.exclusions.length, 0, "campaign-cap overflow is not misclassified as blocked");
assert.equal(plan.deferred_count, 2, "overflow records are counted as deferred");
assert.deepEqual(plan.items.map(item => item.staged_ci_id), [...plan.items.map(item => item.staged_ci_id)].sort(), "membership is stable-sorted");
assert.equal(plan.max_items, 20);
const reordered = campaign.planRemediationCampaign({ ...base, cis: [...cis].reverse() }, plan.work_group_signature, 20);
assert.equal(reordered.campaign_id, plan.campaign_id, "campaign id is independent of input order");
assert.ok(plan.items.every(item => item.class_name === plan.items[0].class_name && item.staged_operation === plan.items[0].staged_operation), "planned group is homogeneous");
const mixedRunPlan = campaign.planRemediationCampaign({ ...base, cis: cis.map((ci, index) => index === 0 ? { ...ci, migrationRunId: sysId(999) } : ci) }, plan.work_group_signature, 20);
assert.ok(mixedRunPlan.exclusions.some(item => /different migration run/.test(item.reason)), "mixed-run records are excluded");
const provisionalInsertPlan = campaign.planRemediationCampaign({ ...base, cis: cis.slice(0, 5).map(ci => ({ ...ci, operation: "INSERT" })) }, undefined, 20);
assert.equal(provisionalInsertPlan.items.length, 5, "provisional INSERT records may be simulated so IRE can determine the authoritative operation");

let active = 0;
let maxActive = 0;
const generatedSimulationCorrelations = new Set();
const simulation = await campaign.simulateRemediationCampaign(base, {
  migration_run_id: RUN,
  work_group_signature: plan.work_group_signature,
  campaign_id: plan.campaign_id,
  staged_ci_ids: plan.items.map(item => item.staged_ci_id),
  limit: 20,
}, async (item, request) => {
  generatedSimulationCorrelations.add(request.correlation_id);
  active++;
  maxActive = Math.max(maxActive, active);
  await new Promise(resolve => setTimeout(resolve, 2));
  active--;
  const fail = item.staged_ci_id === plan.items[4].staged_ci_id;
  return fail
    ? { success: false, action: "simulate", state: "simulation_failed", error: { code: "IRE_FAILED", message: "isolated fixture failure" } }
    : { success: true, action: "simulate", state: "simulated_pending_approval", status: "matched", simulation_correlation_id: `ks-sim-${item.staged_ci_id}`, simulation_fingerprint: fp(Number.parseInt(item.staged_ci_id.slice(-2), 16) + 1) };
});
assert.equal(maxActive, 3, "simulation concurrency is exactly three");
assert.equal(simulation.items.length, 20);
assert.equal(simulation.summary.succeeded, 19);
assert.equal(simulation.summary.failed, 1);
assert.equal(generatedSimulationCorrelations.size, 20, "campaign correlations are unique even when sys_ids share prefixes");

let transportCalls = 0;
const transportSimulation = await campaign.simulateRemediationCampaign(base, {
  migration_run_id: RUN, work_group_signature: plan.work_group_signature, campaign_id: plan.campaign_id,
  staged_ci_ids: plan.items.map(item => item.staged_ci_id), limit: 20,
}, async item => {
  transportCalls++;
  if (item.staged_ci_id === plan.items[0].staged_ci_id) throw new Error("ambiguous transport failure");
  return { success: true, action: "simulate", state: "simulated_pending_approval", status: "matched" };
});
assert.equal(transportSimulation.items.length, 20, "halted simulations retain one result per manifest item");
assert.ok(transportCalls <= 3, "systemic transport failure halts after the concurrency window");
assert.equal(transportSimulation.halted.code, "UPSTREAM_UNREACHABLE");
assert.equal(transportSimulation.items[0].error_code, "UPSTREAM_UNREACHABLE");

const successful = plan.items.filter(item => item.staged_ci_id !== plan.items[4].staged_ci_id);
const findings = successful.map((item, index) => ({
  id: sysId(100 + index), number: `DWF${index}`, stagedCiId: item.staged_ci_id,
  type: "data_quality", recommendation: "Apply governed safe update",
}));
const reviews = findings.map((finding, index) => ({
  id: sysId(200 + index), findingId: finding.id, decision: "deferred", rationale: "Awaiting grouped approval", policyApproved: false,
}));
const timeline = successful.map((item, index) => ({
  id: sysId(300 + index), seq: index + 1, step: 5, name: "simulated", recordName: item.name,
  className: item.class_name, operation: "UPDATE", source: "Remediate", confidence: 0.95,
  time: `2026-07-22 12:${String(index).padStart(2, "0")}:00`, status: "complete",
  reasoning: JSON.stringify({ schema: "keystone.agent.v1", phase: "remediate", actor: "Remediate",
    decision_source: "deterministic", action: "ire_simulation_completed", status: "completed",
    summary: "Simulation completed", migration_run_id: RUN, staged_ci_id: item.staged_ci_id,
    finding_id: findings[index].id, simulation_correlation_id: `ks-sim-${item.staged_ci_id}`,
    simulation_fingerprint: fp(index + 1), operation: index === 0 ? "INSERT" : "UPDATE",
    strategy_id: index === 1 ? "normalize_known_class_alias" : undefined,
    mapping_version: index === 1 ? "class-alias-v1" : undefined,
    retry_count: index === 1 ? 1 : 0 }),
}));
timeline.push({
  id: sysId(450), seq: 90, step: 5, name: "simulation failed", recordName: plan.items[4].name,
  className: plan.items[4].class_name, operation: "ERROR", source: "Remediate", confidence: 0.95,
  time: "2026-07-22 12:59:00", status: "error",
  reasoning: JSON.stringify({ schema: "keystone.agent.v1", phase: "remediate", actor: "Remediate",
    decision_source: "deterministic", action: "ire_simulation_failed", status: "failed",
    summary: "Isolated fixture failure", migration_run_id: RUN, staged_ci_id: plan.items[4].staged_ci_id }),
});
const approvalSnapshot = { ...base, timeline, findings, reviews };
const manifest = campaign.prepareRemediationApprovalManifest(approvalSnapshot, {
  migration_run_id: RUN, work_group_signature: plan.work_group_signature, campaign_id: plan.campaign_id,
  staged_ci_ids: plan.items.map(item => item.staged_ci_id), limit: 20,
});
assert.equal(manifest.stage, "review_ready");
assert.equal(manifest.items.length, 18, "failed simulation and INSERT are excluded");
assert.ok(/^[0-9A-F]{64}$/.test(manifest.manifest_id));
assert.equal(campaign.approvalManifestHash(manifest.campaign_id, [...manifest.items].reverse()), manifest.manifest_id, "manifest hash is order-independent");
assert.equal(manifest.items[0].operation, "UPDATE");
assert.ok(manifest.items.some(item => item.strategy_id === "normalize_known_class_alias" && item.mapping_version === "class-alias-v1" && item.retry_count === 1));
assert.ok(manifest.exclusions.some(item => /INSERT/.test(item.reason)));

const missingReviewManifest = campaign.prepareRemediationApprovalManifest({ ...approvalSnapshot, reviews: reviews.filter(review => review.id !== manifest.items[0].review_decision_id) }, {
  migration_run_id: RUN, work_group_signature: plan.work_group_signature, campaign_id: plan.campaign_id,
  staged_ci_ids: plan.items.map(item => item.staged_ci_id), limit: 20,
});
assert.ok(missingReviewManifest.items.length < manifest.items.length, "missing deferred review excludes the item");

await assert.rejects(
  campaign.approveRemediationCampaign(approvalSnapshot, {
    migration_run_id: RUN, work_group_signature: plan.work_group_signature, campaign_id: plan.campaign_id,
    manifest_id: "F".repeat(64), staged_ci_ids: plan.items.map(item => item.staged_ci_id), limit: 20,
  }, async () => { throw new Error("must not be called"); }),
  error => error.code === "CAMPAIGN_MANIFEST_STALE",
);

const driftedTimeline = timeline.map(event => {
  const detail = JSON.parse(event.reasoning);
  return detail.staged_ci_id === manifest.items[0].staged_ci_id
    ? { ...event, reasoning: JSON.stringify({ ...detail, simulation_fingerprint: "E".repeat(64) }) }
    : event;
});
await assert.rejects(
  campaign.approveRemediationCampaign({ ...approvalSnapshot, timeline: driftedTimeline }, {
    migration_run_id: RUN, work_group_signature: plan.work_group_signature, campaign_id: plan.campaign_id,
    manifest_id: manifest.manifest_id, staged_ci_ids: plan.items.map(item => item.staged_ci_id), limit: 20,
  }, async () => { throw new Error("must not be called"); }),
  error => error.code === "CAMPAIGN_MANIFEST_STALE",
  "changed fingerprint invalidates the frozen manifest",
);

const approvalOrder = [];
let concurrentApprovals = 0;
let maxApprovals = 0;
const approved = await campaign.approveRemediationCampaign(approvalSnapshot, {
  migration_run_id: RUN, work_group_signature: plan.work_group_signature, campaign_id: plan.campaign_id,
  manifest_id: manifest.manifest_id, staged_ci_ids: plan.items.map(item => item.staged_ci_id), limit: 20,
}, async item => {
  concurrentApprovals++;
  maxApprovals = Math.max(maxApprovals, concurrentApprovals);
  approvalOrder.push(item.staged_ci_id);
  await new Promise(resolve => setTimeout(resolve, 1));
  concurrentApprovals--;
  return { success: true, action: "approve", state: "approved_for_execution", status: "approved" };
});
assert.equal(maxApprovals, 1, "approvals are strictly sequential");
assert.deepEqual(approvalOrder, manifest.items.map(item => item.staged_ci_id));
assert.equal(approved.items.length, 18);
assert.equal(approved.summary.approved, 18);

let systemicCalls = 0;
const systemicallyBlocked = await campaign.approveRemediationCampaign(approvalSnapshot, {
  migration_run_id: RUN, work_group_signature: plan.work_group_signature, campaign_id: plan.campaign_id,
  manifest_id: manifest.manifest_id, staged_ci_ids: plan.items.map(item => item.staged_ci_id), limit: 20,
}, async () => {
  systemicCalls++;
  return systemicCalls === 2
    ? { success: false, action: "approve", state: "blocked", error: { code: "FORBIDDEN", message: "role removed" } }
    : { success: true, action: "approve", state: "approved_for_execution", status: "approved" };
});
assert.equal(systemicCalls, 2, "systemic authorization failure halts the campaign");
assert.equal(systemicallyBlocked.halted.code, "FORBIDDEN");

const verifiedTimeline = [...timeline, ...manifest.items.map((item, index) => ({
  id: sysId(500 + index), seq: 100 + index, step: 7, name: "verification passed", recordName: item.name,
  className: "cmdb_ci_linux_server", operation: "NO_CHANGE", source: "Remediate", confidence: 1,
  time: `2026-07-22 13:${String(index).padStart(2, "0")}:00`, status: "complete",
  reasoning: JSON.stringify({ schema: "keystone.agent.v1", phase: "remediate", actor: "Remediate",
    decision_source: "deterministic", action: "verification_passed", status: "completed",
    summary: "Correlated verification passed", migration_run_id: RUN, staged_ci_id: item.staged_ci_id,
    finding_id: item.finding_id, simulation_correlation_id: item.simulation_correlation_id,
    simulation_fingerprint: item.simulation_fingerprint, execution_correlation_id: sysId(700 + index),
    execution_event_id: sysId(700 + index), target_ci_sys_id: sysId(800 + index), operation: "NO_CHANGE", retry_count: 0 }),
}))];
const status = campaign.remediationCampaignStatus({ ...approvalSnapshot, timeline: verifiedTimeline }, {
  migration_run_id: RUN, work_group_signature: plan.work_group_signature, campaign_id: plan.campaign_id,
  staged_ci_ids: plan.items.map(item => item.staged_ci_id), limit: 20,
});
assert.equal(status.summary.verified, 18);
assert.equal(status.summary.blocked, 2);
assert.equal(status.stage, "completed", "mixed campaigns complete when every item is verified or terminally blocked");

const route = fs.readFileSync(path.join(root, "app/api/cmdb/remediation-campaign/[action]/route.ts"), "utf8");
assert.match(route, /CMDB_AGENT_BATCH_APPROVAL_ENABLED/);
assert.equal(/invokeCampaignIre\("execute"|invokeCampaignIre\("verify"/.test(route), false, "campaign route never invokes Execute or Verify");
assert.match(route, /FORBIDDEN_EXECUTABLE_FIELDS/);
assert.match(route, /rejectExecutableFields\(incoming\)/);
assert.equal(/operation: item\.operation/.test(route), false, "campaign route never forwards a browser operation");

const dashboard = fs.readFileSync(path.join(root, "app/cmdb-dashboard.tsx"), "utf8");
assert.match(dashboard, /function AgentCampaignPanel/);
assert.match(dashboard, /Execute \+ Verify are automatic/);
assert.equal(/runIreAction\("execute"|runIreAction\("verify"/.test(dashboard), false, "UI never triggers Execute or Verify");

console.log("remediation campaign smoke passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
