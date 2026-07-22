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
const recovery = require("../app/lib/cmdb/remediation-campaign-recovery.ts");
const { normalizeComprehendTimeline } = require("../app/lib/cmdb/comprehend-adapter.ts");

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
const legacyDetail = campaign.parseCampaignEventDetail(JSON.stringify({
  action: "ire_simulation_completed", status: "completed", staged_ci_id: cis[0].id,
  simulation_fingerprint: "A".repeat(64), operation: "INSERT",
}));
assert.equal(legacyDetail.action, "ire_simulation_completed", "deployed pre-envelope simulation evidence remains reconstructable");
assert.equal(campaign.parseCampaignEventDetail('{"action":"untrusted_action"}'), null, "unknown legacy actions remain rejected");
const normalizedLegacyTimeline = normalizeComprehendTimeline({ result: [{
  sys_id: sysId(999), sequence: 1, event_name: "simulated", record_name: "Remediate",
  detail: JSON.stringify({ action: "ire_simulation_completed", staged_ci_id: cis[0].id, operation: "INSERT" }),
}] });
assert.equal(JSON.parse(normalizedLegacyTimeline[0].reasoning).action, "ire_simulation_completed", "timeline normalization preserves pre-envelope lifecycle JSON");

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
    simulation_matched_ci: "",
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
assert.equal(manifest.items.length, 19, `failed simulation is excluded while an unmatched allowlisted INSERT is eligible: ${JSON.stringify(manifest.exclusions)}`);
assert.ok(/^[0-9A-F]{64}$/.test(manifest.manifest_id));
assert.equal(campaign.approvalManifestHash(manifest.campaign_id, [...manifest.items].reverse()), manifest.manifest_id, "manifest hash is order-independent");
assert.ok(manifest.items.some(item => item.operation === "UPDATE"));
assert.ok(manifest.items.some(item => item.strategy_id === "normalize_known_class_alias" && item.mapping_version === "class-alias-v1" && item.retry_count === 1));
const insertManifestItem = manifest.items.find(item => item.operation === "INSERT");
assert.equal(insertManifestItem.policy_version, campaign.CAMPAIGN_INSERT_POLICY_VERSION);
assert.equal(insertManifestItem.identity_evidence, "ire_unmatched");

const missingReviewManifest = campaign.prepareRemediationApprovalManifest({ ...approvalSnapshot, reviews: reviews.filter(review => review.id !== manifest.items[0].review_decision_id) }, {
  migration_run_id: RUN, work_group_signature: plan.work_group_signature, campaign_id: plan.campaign_id,
  staged_ci_ids: plan.items.map(item => item.staged_ci_id), limit: 20,
});
assert.ok(missingReviewManifest.items.length < manifest.items.length, "missing deferred review excludes the item");
const pendingProposals = campaign.pendingRemediationReviewProposals({ ...approvalSnapshot, reviews: [] }, {
  migration_run_id: RUN, work_group_signature: plan.work_group_signature, campaign_id: plan.campaign_id,
  staged_ci_ids: plan.items.map(item => item.staged_ci_id), limit: 20,
});
assert.equal(pendingProposals.length, 19, "fresh safe UPDATE and INSERT simulations without reviews become deterministic proposal requests");
assert.ok(pendingProposals.every(item => /^[0-9A-F]{64}$/.test(item.simulation_fingerprint)));
assert.equal(pendingProposals.some(item => item.staged_ci_id === successful[0].staged_ci_id), true, "unmatched allowlisted INSERT simulations create review proposals");
assert.equal(campaign.pendingRemediationReviewProposals(approvalSnapshot, {
  migration_run_id: RUN, work_group_signature: plan.work_group_signature, campaign_id: plan.campaign_id,
  staged_ci_ids: plan.items.map(item => item.staged_ci_id), limit: 20,
}).length, 0, "existing reviews make proposal preparation idempotent");

const matchedInsertTimeline = timeline.map(event => {
  const detail = JSON.parse(event.reasoning);
  return detail.staged_ci_id === successful[0].staged_ci_id
    ? { ...event, reasoning: JSON.stringify({ ...detail, simulation_matched_ci: sysId(901) }) }
    : event;
});
const matchedInsertManifest = campaign.prepareRemediationApprovalManifest({ ...approvalSnapshot, timeline: matchedInsertTimeline }, {
  migration_run_id: RUN, work_group_signature: plan.work_group_signature, campaign_id: plan.campaign_id,
  staged_ci_ids: plan.items.map(item => item.staged_ci_id), limit: 20,
});
assert.equal(matchedInsertManifest.items.some(item => item.operation === "INSERT"), false, "INSERT is rejected when IRE reports an existing match");
assert.ok(matchedInsertManifest.exclusions.some(item => /existing CMDB match/.test(item.reason)));

const unsupportedCi = { ...cis[0], className: "cmdb_ci_database", operation: "INSERT" };
const unsupportedFinding = { id: sysId(950), number: "DWF950", stagedCiId: unsupportedCi.stagedCiId, type: "data_quality", recommendation: "Review new CI" };
const unsupportedReview = { id: sysId(951), findingId: unsupportedFinding.id, decision: "deferred", rationale: "Awaiting approval", policyApproved: false };
const unsupportedEvent = {
  id: sysId(952), seq: 1, step: 5, name: "simulated", recordName: unsupportedCi.name,
  className: unsupportedCi.className, operation: "INSERT", source: "Remediate", confidence: 0.95,
  time: "2026-07-22 12:00:00", status: "complete",
  reasoning: JSON.stringify({ schema: "keystone.agent.v1", phase: "remediate", actor: "Remediate",
    decision_source: "deterministic", action: "ire_simulation_completed", status: "completed",
    summary: "Simulation completed", migration_run_id: RUN, staged_ci_id: unsupportedCi.stagedCiId,
    finding_id: unsupportedFinding.id, simulation_correlation_id: "ks-sim-unsupported",
    simulation_fingerprint: fp(950), operation: "INSERT", simulation_matched_ci: "", retry_count: 0 }),
};
const unsupportedSnapshot = { ...base, cis: [unsupportedCi], timeline: [unsupportedEvent], findings: [unsupportedFinding], reviews: [unsupportedReview] };
const unsupportedPlan = campaign.planRemediationCampaign(unsupportedSnapshot, undefined, 1);
const unsupportedManifest = campaign.prepareRemediationApprovalManifest(unsupportedSnapshot, {
  migration_run_id: RUN, work_group_signature: unsupportedPlan.work_group_signature, campaign_id: unsupportedPlan.campaign_id,
  staged_ci_ids: unsupportedPlan.items.map(item => item.staged_ci_id), limit: 1,
});
assert.equal(unsupportedManifest.stage, "blocked");
assert.ok(unsupportedManifest.exclusions.some(item => /not allowlisted/.test(item.reason)), "INSERT class allowlist is enforced");
assert.notEqual(
  campaign.approvalManifestHash(manifest.campaign_id, manifest.items),
  campaign.approvalManifestHash(manifest.campaign_id, manifest.items.map(item => item.operation === "INSERT" ? { ...item, policy_version: "" } : item)),
  "INSERT policy evidence is frozen into the v2 manifest hash",
);

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
assert.equal(approved.items.length, 19);
assert.equal(approved.summary.approved, 19);

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
assert.equal(status.summary.verified, 19);
assert.equal(status.summary.blocked, 1);
assert.equal(status.stage, "completed", "mixed campaigns complete when every item is verified or terminally blocked");

const fullyVerifiedTimeline = [...timeline.filter(event => event !== timeline[timeline.length - 1]), ...plan.items.map((item, index) => ({
  id: sysId(600 + index), seq: 200 + index, step: 7, name: "verification passed", recordName: item.name,
  className: "cmdb_ci_linux_server", operation: "INSERT", source: "Remediate", confidence: 1,
  time: `2026-07-22 14:${String(index).padStart(2, "0")}:00`, status: "complete",
  reasoning: JSON.stringify({ schema: "keystone.agent.v1", phase: "remediate", actor: "Remediate",
    decision_source: "deterministic", action: "verification_passed", status: "completed",
    summary: "Correlated verification passed", migration_run_id: RUN, staged_ci_id: item.staged_ci_id,
    simulation_correlation_id: `ks-sim-${item.staged_ci_id}`, simulation_fingerprint: fp(index + 1),
    execution_correlation_id: sysId(900 + index), execution_event_id: sysId(900 + index),
    target_ci_sys_id: sysId(1000 + index), operation: "INSERT", retry_count: 0 }),
}))];
const advancedFindings = plan.items.map((item, index) => ({
  id: sysId(1200 + index), number: `DWF-ADV-${index}`, stagedCiId: item.staged_ci_id,
  type: "data_quality", recommendation: "Approved campaign remediation",
}));
const advancedReviews = advancedFindings.map((finding, index) => ({
  id: sysId(1300 + index), findingId: finding.id, decision: "approved",
  rationale: "Frozen campaign approval accepted", policyApproved: false,
}));
const fullyVerifiedSnapshot = {
  ...approvalSnapshot,
  timeline: fullyVerifiedTimeline,
  findings: advancedFindings,
  reviews: advancedReviews,
};
const replannedAfterCompletion = campaign.planRemediationCampaign(fullyVerifiedSnapshot, plan.work_group_signature, 20);
assert.notDeepEqual(replannedAfterCompletion.items.map(item => item.staged_ci_id), plan.items.map(item => item.staged_ci_id),
  "completed records leave the simulation plan and later records take their place");
const reconstructed = campaign.remediationCampaignStatus(fullyVerifiedSnapshot, {
  migration_run_id: RUN, work_group_signature: plan.work_group_signature, campaign_id: plan.campaign_id,
  staged_ci_ids: plan.items.map(item => item.staged_ci_id), limit: 20,
});
assert.equal(reconstructed.items.length, 20, "status retains every frozen campaign member after queue advancement");
assert.equal(reconstructed.summary.verified, 20);
assert.equal(reconstructed.stage, "completed");
const recovered = recovery.recoverLatestCampaignPlan(RUN, cis, plan.items.map((item, index) => ({
  id: sysId(1500 + index), seq: 300 + index, step: 7, name: "verification passed", recordName: item.name,
  className: item.class_name, operation: "INSERT", source: "Remediate", confidence: 1,
  time: `2026-07-22 15:${String(index).padStart(2, "0")}:00`, status: "complete",
  reasoning: JSON.stringify({ action: "verification_passed", migration_run_id: RUN,
    staged_ci_id: item.staged_ci_id, correlation_id: `ks-campaign:${plan.campaign_id}:approve:${index}` }),
})));
assert.equal(recovered.campaign_id, plan.campaign_id, "refresh recovery discovers the persisted campaign id");
assert.equal(recovered.items.length, 20, "refresh recovery retains the frozen staged CI membership");
assert.equal(recovered.work_group_signature, plan.work_group_signature, "refresh recovery rebuilds the stable homogeneous signature");
await assert.rejects(async () => campaign.remediationCampaignStatus(fullyVerifiedSnapshot, {
  migration_run_id: RUN, work_group_signature: plan.work_group_signature, campaign_id: "F".repeat(24),
  staged_ci_ids: plan.items.map(item => item.staged_ci_id), limit: 20,
}), error => error.code === "CAMPAIGN_STALE", "status rejects a campaign id that does not bind the frozen membership");
await assert.rejects(async () => campaign.remediationCampaignStatus(fullyVerifiedSnapshot, {
  migration_run_id: RUN, work_group_signature: plan.work_group_signature, campaign_id: plan.campaign_id,
  staged_ci_ids: [...plan.items.slice(0, -1).map(item => item.staged_ci_id), sysId(9999)], limit: 20,
}), error => error.code === "CAMPAIGN_MEMBERSHIP_CHANGED", "status rejects a frozen item missing from the authoritative run");

const route = fs.readFileSync(path.join(root, "app/api/cmdb/remediation-campaign/[action]/route.ts"), "utf8");
assert.match(route, /CMDB_AGENT_BATCH_APPROVAL_ENABLED/);
assert.equal(/invokeCampaignIre\("execute"|invokeCampaignIre\("verify"/.test(route), false, "campaign route never invokes Execute or Verify");
assert.match(route, /FORBIDDEN_EXECUTABLE_FIELDS/);
assert.match(route, /rejectExecutableFields\(incoming\)/);
assert.match(route, /"identity_evidence"/);
assert.match(route, /"source_identifier"/);
assert.match(route, /"policy_version"/);
assert.match(route, /invokeCampaignProposal/);
assert.match(route, /loadCampaignSnapshot\(selection\.migration_run_id\)/, "proposal preparation reloads authoritative ServiceNow evidence");
assert.equal(/operation: item\.operation/.test(route), false, "campaign route never forwards a browser operation");

const dashboard = fs.readFileSync(path.join(root, "app/cmdb-dashboard.tsx"), "utf8");
assert.match(dashboard, /function AgentCampaignPanel/);
assert.match(dashboard, /Execute \+ Verify are automatic/);
assert.match(dashboard, /This manifest will create/);
assert.match(dashboard, /authoritative unmatched-identity evidence/);
assert.match(dashboard, /recoverLatestCampaignPlan/);
assert.match(dashboard, /Campaign progress restored from persisted ServiceNow/);
assert.equal(/runIreAction\("execute"|runIreAction\("verify"/.test(dashboard), false, "UI never triggers Execute or Verify");

console.log("remediation campaign smoke passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
