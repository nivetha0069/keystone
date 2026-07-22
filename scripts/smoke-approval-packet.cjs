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
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const packet = require("../app/lib/cmdb/approval-packet.ts");

async function main() {
  const RUN = "e0ac4df32b82871060aefba6b891bf5b";
  const NOW = Date.parse("2026-07-22T12:20:00Z");
  const sysId = index => index.toString(16).padStart(32, "0");
  const fingerprint = index => index.toString(16).padStart(64, "A").slice(-64).toUpperCase();
  const cis = [];
  const findings = [];
  const reviews = [];
  const timeline = [];
  for (let index = 0; index < 105; index++) {
    const stagedId = sysId(index + 1);
    const findingId = sysId(1000 + index);
    const reviewId = sysId(2000 + index);
    const operation = index % 3 === 0 ? "NO_CHANGE" : "UPDATE";
    cis.push({
      id: stagedId, stagedCiId: stagedId, migrationRunId: RUN,
      name: `packet-server-${String(index + 1).padStart(3, "0")}`,
      className: "cmdb_ci_linux_server", ip: `10.10.0.${(index % 250) + 1}`,
      source: "packet-fixture", operation: "UPDATE", confidence: 0.97,
      health: 90, updatedAt: "2026-07-22 12:00:00", status: "live", provenance: [],
    });
    findings.push({ id: findingId, number: `DWF-P-${index}`, stagedCiId: stagedId, type: "data_quality", severity: ["critical", "high", "medium", "low"][index % 4], recommendation: "Apply bounded safe update" });
    reviews.push({ id: reviewId, findingId, decision: "deferred", rationale: "Awaiting packet approval", policyApproved: false });
    timeline.push({
      id: sysId(3000 + index), seq: index + 1, step: 5, name: "simulated", recordName: cis[index].name,
      className: cis[index].className, operation, source: "Remediate", confidence: 0.97,
      time: index === 0 ? "2026-07-22T12:00:00Z" : "2026-07-22T12:05:00Z", status: "complete",
      reasoning: JSON.stringify({ schema: "keystone.agent.v1", phase: "remediate", actor: "Remediate", decision_source: "deterministic",
        action: "ire_simulation_completed", status: "completed", summary: "Simulation completed",
        migration_run_id: RUN, staged_ci_id: stagedId, finding_id: findingId,
        simulation_correlation_id: `ks-sim-packet-${stagedId}`, simulation_fingerprint: fingerprint(index + 1),
        operation, simulation_matched_ci: sysId(9000 + index), retry_count: 0 }),
    });
    timeline.push({
      id: sysId(4000 + index), seq: 106 + index, step: 5, name: "review deferred", recordName: cis[index].name,
      className: cis[index].className, operation, source: "Remediate", confidence: 0.97,
      time: index === 0 ? "2026-07-22T12:00:00Z" : "2026-07-22T12:05:00Z", status: "complete",
      reasoning: JSON.stringify({ schema: "keystone.agent.v1", phase: "remediate", actor: "Remediate", decision_source: "deterministic",
        action: "approval_review_deferred", status: "approval_required", summary: "Review bound to simulation",
        migration_run_id: RUN, staged_ci_id: stagedId, finding_id: findingId, review_decision_id: reviewId,
        simulation_correlation_id: `ks-sim-packet-${stagedId}`, simulation_fingerprint: fingerprint(index + 1) }),
    });
  }
  const health = { score: 90, grade: "A", ciCount: cis.length, duplicateCandidates: 0, reviewCount: reviews.length,
    relationshipCount: 0, completeness: 90, correctness: 90, compliance: 90, duplicateRate: 0, staleRecords: 0, fixes: [] };
  const snapshot = { migrationRunId: RUN, cis: [...cis].reverse(), timeline: [...timeline].reverse(), findings, reviews, health, relationships: [] };

  const plan = packet.planApprovalPacket(snapshot);
  assert.equal(plan.preparable_count, 100, "packet is capped at 100 records");
  assert.equal(plan.children.length, 5, "packet has at most five child manifests");
  assert.ok(plan.children.every(child => child.item_count === 20), "every full child retains the Phase E 20-record bound");
  assert.equal(plan.deferred_count, 5, "overflow remains deferred");
  assert.equal(plan.class_name, "cmdb_ci_linux_server");
  assert.equal(plan.operation_family, "safe-update");
  assert.deepEqual(plan.children.flatMap(child => child.items.map(item => item.staged_ci_id)), [...plan.children.flatMap(child => child.items.map(item => item.staged_ci_id))].sort());

  const frozen = packet.prepareApprovalPacket(snapshot, { migration_run_id: RUN }, NOW);
  assert.equal(frozen.stage, "review_ready");
  assert.equal(frozen.items.length, 100);
  assert.equal(frozen.children.length, 5);
  assert.equal(frozen.expires_at, "2026-07-22T12:30:00.000Z", "expiry derives from oldest included simulation");
  assert.match(frozen.packet_id, /^[0-9A-F]{24}$/);
  assert.match(frozen.packet_hash, /^[0-9A-F]{64}$/);
  assert.equal(frozen.aggregate.operations.UPDATE + frozen.aggregate.operations.NO_CHANGE, 100);
  assert.equal(Object.values(frozen.aggregate.risks).reduce((sum, value) => sum + value, 0), 100);
  assert.equal(frozen.samples.length, 10);
  for (const child of frozen.children) assert.ok(frozen.samples.some(sample => sample.child_campaign_id === child.campaign_id), "sample covers every child");

  const reordered = packet.prepareApprovalPacket({ ...snapshot, cis: [...snapshot.cis].reverse(), timeline: [...snapshot.timeline].reverse() }, { migration_run_id: RUN }, NOW);
  assert.equal(reordered.packet_id, frozen.packet_id, "packet id is independent of input order");
  assert.equal(reordered.packet_hash, frozen.packet_hash, "parent hash is independent of input order");
  assert.deepEqual(reordered.samples, frozen.samples, "evidence sampling is stable");
  assert.notEqual(packet.approvalPacketHash(RUN, frozen.children.map((child, index) => index ? child : { ...child, manifest_id: "F".repeat(64) }), frozen.expires_at), frozen.packet_hash, "parent hash binds child hashes");
  assert.notEqual(packet.approvalPacketHash(RUN, frozen.children, "2026-07-22T12:31:00.000Z"), frozen.packet_hash, "parent hash binds expiry");

  const selection = {
    migration_run_id: RUN, packet_id: frozen.packet_id, packet_hash: frozen.packet_hash,
    child_manifest_ids: frozen.children.map(child => child.manifest_id),
    staged_ci_ids: frozen.items.map(item => item.staged_ci_id),
  };
  const expired = packet.prepareApprovalPacket(snapshot, selection, Date.parse("2026-07-22T12:30:00Z"));
  assert.equal(expired.stage, "expired", "packet expires exactly at its boundary");

  const driftedTimeline = timeline.map(event => {
    const detail = JSON.parse(event.reasoning);
    return detail.staged_ci_id === frozen.items[0].staged_ci_id
      ? { ...event, reasoning: JSON.stringify({ ...detail, simulation_fingerprint: "E".repeat(64) }) }
      : event;
  });
  assert.throws(() => packet.prepareApprovalPacket({ ...snapshot, timeline: driftedTimeline }, selection, NOW), error => ["PACKET_STALE", "PACKET_HASH_STALE", "PACKET_MEMBERSHIP_CHANGED", "PACKET_CHILD_DRIFT"].includes(error.code), "fingerprint drift invalidates the packet");

  const staleReviewTimeline = timeline.filter(event => {
    const detail = JSON.parse(event.reasoning);
    return detail.staged_ci_id !== frozen.items[0].staged_ci_id || detail.action !== "approval_review_deferred";
  });
  assert.equal(packet.pendingApprovalPacketProposals({ ...snapshot, timeline: staleReviewTimeline }).length, 1, "an old deferred review cannot satisfy a newer simulation binding");

  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const approved = await packet.approveApprovalPacket(snapshot, selection, async item => {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    return item.staged_ci_id === frozen.items[2].staged_ci_id
      ? { success: false, action: "approve", state: "approved_for_execution", error: { code: "STALE_SIMULATION", message: "isolated drift" } }
      : { success: true, action: "approve", state: "approved_for_execution", status: "approved" };
  }, async () => snapshot, NOW);
  assert.equal(calls, 100, "record failures remain isolated");
  assert.equal(maxActive, 1, "packet approval fan-out is strictly sequential");
  assert.equal(approved.items.filter(item => item.success).length, 99);

  let systemicCalls = 0;
  const halted = await packet.approveApprovalPacket(snapshot, selection, async () => {
    systemicCalls++;
    return systemicCalls === 2
      ? { success: false, action: "approve", state: "approved_for_execution", error: { code: "FORBIDDEN", message: "role removed" } }
      : { success: true, action: "approve", state: "approved_for_execution", status: "approved" };
  }, async () => snapshot, NOW);
  assert.equal(systemicCalls, 2, "systemic failure halts fan-out");
  assert.equal(halted.halted.code, "FORBIDDEN");

  const approvalEvent = (item, index, packetValue = frozen) => {
    const tokens = packet.packetApprovalTokens(packetValue, item.staged_ci_id);
    return {
      id: sysId(5000 + index), seq: 5000 + index, step: 5, name: "approved", recordName: item.name,
      className: "cmdb_ci_linux_server", operation: item.operation, source: "Remediate", confidence: 1,
      time: "2026-07-22T12:10:00Z", status: "complete",
      reasoning: JSON.stringify({ schema: "keystone.agent.v1", phase: "remediate", actor: "Remediate", decision_source: "deterministic",
        action: "approval_recorded", status: "completed", summary: "Exact simulation approval recorded",
        migration_run_id: RUN, staged_ci_id: item.staged_ci_id, finding_id: item.finding_id,
        review_decision_id: item.review_decision_id, correlation_id: tokens.correlation_id, idempotency_key: tokens.idempotency_key,
        simulation_correlation_id: item.simulation_correlation_id, simulation_fingerprint: item.simulation_fingerprint,
        approval_event_id: sysId(5000 + index), decision: "approved", policy_approved: false }),
    };
  };

  const firstApproval = approvalEvent(frozen.items[0], 0);
  const duplicateSnapshot = { ...snapshot, timeline: [...timeline, firstApproval] };
  let duplicateCalls = 0;
  const duplicate = await packet.approveApprovalPacket(duplicateSnapshot, selection, async () => {
    duplicateCalls++;
    return { success: true, action: "approve", state: "approved_for_execution", status: "approved" };
  }, async () => duplicateSnapshot, NOW);
  assert.equal(duplicateCalls, 99, "exact persisted approval is skipped on duplicate click");
  assert.equal(duplicate.items[0].reconciled, true);

  let ambiguousCalls = 0;
  const ambiguous = await packet.approveApprovalPacket(snapshot, selection, async () => {
    ambiguousCalls++;
    return ambiguousCalls === 1
      ? { success: false, action: "approve", state: "approved_for_execution", error: { code: "UPSTREAM_UNREACHABLE", message: "timeout" } }
      : { success: true, action: "approve", state: "approved_for_execution", status: "approved" };
  }, async () => duplicateSnapshot, NOW);
  assert.equal(ambiguousCalls, 100, "ambiguous first outcome is reconciled, not retried");
  assert.equal(ambiguous.items[0].reconciled, true);
  assert.equal(ambiguous.halted, undefined);

  const allApprovals = frozen.items.map((item, index) => approvalEvent(item, index));
  const verifiedEvents = frozen.items.map((item, index) => ({
    id: sysId(7000 + index), seq: 7000 + index, step: 7, name: "verification passed", recordName: item.name,
    className: "cmdb_ci_linux_server", operation: item.operation, source: "Remediate", confidence: 1,
    time: "2026-07-22T12:15:00Z", status: "complete",
    reasoning: JSON.stringify({ schema: "keystone.agent.v1", phase: "remediate", actor: "Remediate", decision_source: "deterministic",
      action: index === 1 ? "ire_execution_reconciliation_required" : "verification_passed",
      status: index === 1 ? "blocked" : "completed", summary: "Phase D terminal evidence",
      migration_run_id: RUN, staged_ci_id: item.staged_ci_id, finding_id: item.finding_id,
      approval_event_id: allApprovals[index].id, simulation_correlation_id: item.simulation_correlation_id,
      simulation_fingerprint: item.simulation_fingerprint, execution_correlation_id: sysId(8000 + index),
      target_ci_sys_id: sysId(9000 + index), error_code: index === 1 ? "EXECUTION_RECONCILIATION_REQUIRED" : undefined }),
  }));
  const statusSnapshot = { ...snapshot, timeline: [...timeline, ...allApprovals, ...verifiedEvents] };
  const status = packet.approvalPacketStatus(statusSnapshot, selection, NOW);
  assert.equal(status.aggregate.verified, 99);
  assert.equal(status.aggregate.blocked, 1);
  assert.equal(status.stage, "completed");
  assert.ok(status.items.every(item => item.execution_correlation_id), "status retains exact Phase D correlation");
  const recovered = packet.recoverLatestApprovalPacketSelection(statusSnapshot);
  assert.equal(recovered.packet_id, frozen.packet_id);
  assert.equal(recovered.packet_hash, frozen.packet_hash);

  const route = fs.readFileSync(path.join(root, "app/api/cmdb/remediation-campaign/[action]/route.ts"), "utf8");
  assert.match(route, /CMDB_AGENT_APPROVAL_PACKET_HASH/);
  assert.match(route, /"plan-packet"/);
  assert.match(route, /"prepare-packet"/);
  assert.match(route, /"approve-packet"/);
  assert.match(route, /"packet-status"/);
  assert.equal(/invokeCampaignIre\("execute"|invokeCampaignIre\("verify"/.test(route), false, "packet route never invokes Execute or Verify");
  const dashboard = fs.readFileSync(path.join(root, "app/cmdb-dashboard.tsx"), "utf8");
  assert.match(dashboard, /function ApprovalPacketPanel/);
  assert.match(dashboard, /complete packet hash/);
  assert.equal(/runIreAction\("execute"|runIreAction\("verify"/.test(dashboard), false, "packet UI cannot initiate Execute or Verify");

  console.log("approval packet smoke passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
