const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const Module = require("node:module");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
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

const packetContract = require("../app/lib/cmdb/approval-packet.ts");
const RUN_ID = "e0ac4df32b82871060aefba6b891bf5b";
const WEB_PORT = numberArgument("--port", 3318);
const FIXTURE_PORT = numberArgument("--fixture-port", 4010);
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;

async function main() {
  const fixture = createFixture();
  const frozen = packetContract.prepareApprovalPacket(fixture.snapshot, { migration_run_id: RUN_ID });
  assert.equal(frozen.stage, "review_ready");
  assert.equal(frozen.items.length, 100);
  assert.equal(frozen.children.length, 5);
  assert.match(frozen.packet_hash, /^[0-9A-F]{64}$/);

  const demo = { runId: RUN_ID, packetId: frozen.packet_id, packetHash: frozen.packet_hash, records: frozen.items.length, children: frozen.children.length };
  if (process.argv.includes("--check")) {
    process.stdout.write(`${JSON.stringify(demo)}\n`);
    return;
  }

  const server = createFixtureServer(fixture, frozen);
  await listen(server, FIXTURE_PORT);
  ensureBuild();
  const child = launchKeystone();
  const stop = () => {
    server.close();
    if (!child.killed) child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  child.once("exit", code => {
    server.close();
    process.exitCode = code ?? 0;
  });

  console.log("");
  console.log("Keystone bounded approval packet demo");
  console.log(`  URL: ${WEB_ORIGIN}/?run=${RUN_ID}`);
  console.log(`  Packet: ${frozen.packet_id}`);
  console.log(`  Exact packet hash: ${frozen.packet_hash}`);
  console.log("  Flow: Plan packet -> Prepare packet -> Fill hash -> Authorize exact packet -> Approve -> watch Verify");
  console.log("  Safety: loopback fixture only; ServiceNow credentials and CMDB endpoints are removed from the child environment.");
  console.log("");
}

function createFixture() {
  const now = Date.now();
  const oldest = new Date(now - 2 * 60_000).toISOString();
  const recent = new Date(now - 60_000).toISOString();
  const cis = [];
  const findings = [];
  const reviews = [];
  const timeline = [];
  const rawCis = [];
  const rawFindings = [];
  const rawReviews = [];
  const rawTimeline = [];

  for (let index = 0; index < 100; index += 1) {
    const stagedCiId = sysId(index + 1);
    const findingId = sysId(1000 + index);
    const reviewId = sysId(2000 + index);
    const operation = "UPDATE";
    const name = `packet-server-${String(index + 1).padStart(3, "0")}`;
    const simulationFingerprint = fingerprint(index + 1);
    const simulationCorrelationId = `ks-sim-packet-${stagedCiId}`;
    const time = index === 0 ? oldest : recent;
    const detail = {
      schema: "keystone.agent.v1", phase: "remediate", actor: "Remediate",
      decision_source: "deterministic", action: "ire_simulation_completed", status: "completed",
      summary: "Simulation completed in the isolated packet demo",
      migration_run_id: RUN_ID, staged_ci_id: stagedCiId, finding_id: findingId,
      simulation_correlation_id: simulationCorrelationId, simulation_fingerprint: simulationFingerprint,
      operation, simulation_matched_ci: sysId(9000 + index), retry_count: 0,
    };
    cis.push({
      id: stagedCiId, stagedCiId, migrationRunId: RUN_ID, name, className: "cmdb_ci_linux_server",
      ip: `10.10.0.${(index % 250) + 1}`, source: "local-packet-fixture", operation: "UPDATE",
      confidence: 0.97, health: 90, updatedAt: recent, status: "live", provenance: [],
    });
    findings.push({
      id: findingId, number: `DWF-P-${String(index + 1).padStart(3, "0")}`,
      stagedCiId, type: "data_quality", severity: ["critical", "high", "medium", "low"][index % 4],
      recommendation: "Apply bounded safe update",
    });
    reviews.push({ id: reviewId, findingId, decision: "deferred", rationale: "Awaiting packet approval", policyApproved: false });
    timeline.push({
      id: sysId(3000 + index), seq: index + 1, step: 5, name: "simulated", recordName: name,
      className: "cmdb_ci_linux_server", operation, source: "Remediate", confidence: 0.97,
      time, status: "complete", reasoning: JSON.stringify(detail),
    });
    const reviewDetail = {
      schema: "keystone.agent.v1", phase: "remediate", actor: "Remediate",
      decision_source: "deterministic", action: "approval_review_deferred", status: "approval_required",
      summary: "Review bound to simulation in the isolated packet demo",
      migration_run_id: RUN_ID, staged_ci_id: stagedCiId, finding_id: findingId, review_decision_id: reviewId,
      simulation_correlation_id: simulationCorrelationId, simulation_fingerprint: simulationFingerprint,
    };
    timeline.push({
      id: sysId(4000 + index), seq: 106 + index, step: 5, name: "review deferred", recordName: name,
      className: "cmdb_ci_linux_server", operation, source: "Remediate", confidence: 0.97,
      time, status: "complete", reasoning: JSON.stringify(reviewDetail),
    });
    rawCis.push({
      sys_id: stagedCiId, migration_run_id: RUN_ID, display_name: name, proposed_class: "cmdb_ci_linux_server",
      ip_address: `10.10.0.${(index % 250) + 1}`, source: "local-packet-fixture", operation: "UPDATE",
      confidence: 0.97, health_score: 90, status: "ready", updated_at: recent,
    });
    rawFindings.push({
      sys_id: findingId, number: `DWF-P-${String(index + 1).padStart(3, "0")}`, staged_ci: stagedCiId,
      type: "data_quality", severity: ["critical", "high", "medium", "low"][index % 4],
      recommendation: "Apply bounded safe update",
    });
    rawReviews.push({ sys_id: reviewId, finding: findingId, decision: "deferred", rationale: "Awaiting packet approval", policy_approved: false });
    rawTimeline.push({
      sys_id: sysId(3000 + index), sequence: index + 1, event_type: "simulated", record_name: name,
      proposed_class: "cmdb_ci_linux_server", operation, actor: "Remediate", confidence: 0.97,
      sys_created_on: time, status: "complete", detail: JSON.stringify(detail),
    });
    rawTimeline.push({
      sys_id: sysId(4000 + index), sequence: 106 + index, event_type: "approved", record_name: name,
      proposed_class: "cmdb_ci_linux_server", operation, actor: "Remediate", confidence: 0.97,
      sys_created_on: time, status: "complete", detail: JSON.stringify(reviewDetail),
    });
  }

  const health = {
    score: 90, grade: "A", ciCount: 100, duplicateCandidates: 0, reviewCount: 100,
    relationshipCount: 0, completeness: 92, correctness: 90, compliance: 88,
    duplicateRate: 0, staleRecords: 0, fixes: [],
  };
  return {
    snapshot: { migrationRunId: RUN_ID, cis, timeline, findings, reviews, health, relationships: [] },
    raw: {
      cis: rawCis, timeline: rawTimeline, relationships: [], findings: rawFindings, reviews: rawReviews,
      health: { ...health, ci_count: 100, review_count: 100, relationship_count: 0 },
      run: {
        sys_id: RUN_ID, number: "RUN-PACKET-DEMO", state: "simulated", source_system: "isolated local fixture",
        started: new Date(now - 10 * 60_000).toISOString(), summary: "Milestone 8A end-to-end packet demo",
      },
    },
  };
}

function createFixtureServer(fixture, frozen) {
  let sequence = fixture.raw.timeline.length;
  const approved = new Map();
  const frozenItems = new Map(frozen.items.map(item => [item.staged_ci_id, item]));

  return http.createServer(async (request, response) => {
    const resource = new URL(request.url, `http://${request.headers.host}`).pathname.slice(1);
    if (request.method === "GET" && Object.hasOwn(fixture.raw, resource)) {
      return json(response, 200, { result: fixture.raw[resource] });
    }
    if (request.method === "POST" && resource === "ire/approve") {
      const body = await requestBody(request).catch(() => null);
      if (!body) return json(response, 400, { error: "Malformed demo approval request" });
      const item = frozenItems.get(String(body.staged_ci_id || "").toLowerCase());
      if (!item) return json(response, 404, { error: "Staged CI is outside the frozen demo packet" });
      const tokens = packetContract.packetApprovalTokens(frozen, item.staged_ci_id);
      if (body.correlation_id !== tokens.correlation_id || body.idempotency_key !== tokens.idempotency_key ||
          String(body.simulation_fingerprint || "").toUpperCase() !== item.simulation_fingerprint) {
        return json(response, 409, { error: "Demo approval binding does not match the exact frozen packet" });
      }
      let approvalEventId = approved.get(item.staged_ci_id);
      if (!approvalEventId) {
        approvalEventId = sysId(5000 + approved.size);
        approved.set(item.staged_ci_id, approvalEventId);
        sequence += 1;
        fixture.raw.timeline.push(rawEvent(sequence, approvalEventId, item, "approval_recorded", {
          finding_id: item.finding_id, review_decision_id: item.review_decision_id,
          correlation_id: tokens.correlation_id, idempotency_key: tokens.idempotency_key,
          simulation_correlation_id: item.simulation_correlation_id,
          simulation_fingerprint: item.simulation_fingerprint, approval_event_id: approvalEventId,
          decision: "approved", policy_approved: false,
        }));
        const ordinal = approved.size - 1;
        const executionEventId = sysId(6000 + ordinal);
        const targetCiSysId = sysId(9000 + ordinal);
        setTimeout(() => {
          sequence += 1;
          fixture.raw.timeline.push(rawEvent(sequence, executionEventId, item, "ire_execution_completed", {
            approval_event_id: approvalEventId, execution_correlation_id: executionEventId,
            execution_event_id: executionEventId, target_ci_sys_id: targetCiSysId,
            simulation_correlation_id: item.simulation_correlation_id,
            simulation_fingerprint: item.simulation_fingerprint,
          }));
        }, 400 + ordinal * 15);
        setTimeout(() => {
          sequence += 1;
          fixture.raw.timeline.push(rawEvent(sequence, sysId(7000 + ordinal), item, "verification_passed", {
            approval_event_id: approvalEventId, execution_correlation_id: executionEventId,
            execution_event_id: executionEventId, target_ci_sys_id: targetCiSysId,
            simulation_correlation_id: item.simulation_correlation_id,
            simulation_fingerprint: item.simulation_fingerprint,
          }));
        }, 1400 + ordinal * 25);
      }
      return json(response, 200, {
        success: true, action: "approve", state: "approved_for_execution", status: "approved",
        migration_run_id: RUN_ID, staged_ci_id: item.staged_ci_id,
        correlation_id: tokens.correlation_id, idempotency_key: tokens.idempotency_key,
        simulation_correlation_id: item.simulation_correlation_id,
        simulation_fingerprint: item.simulation_fingerprint,
        finding: { value: item.finding_id }, review_decision: { value: item.review_decision_id },
        playback_event_ids: [approvalEventId],
      });
    }
    if (request.method === "POST" && resource === "remediate") {
      return json(response, 409, { error: "All deferred reviews already exist in the demo fixture" });
    }
    return json(response, 404, { error: "Unknown isolated demo endpoint" });
  });
}

function rawEvent(sequence, id, item, action, extra) {
  const detail = {
    schema: "keystone.agent.v1", phase: "remediate", actor: "Remediate", decision_source: "deterministic",
    action, status: "completed", summary: `Demo ${action.replaceAll("_", " ")}`,
    migration_run_id: RUN_ID, staged_ci_id: item.staged_ci_id, operation: item.operation, ...extra,
  };
  return {
    sys_id: id, sequence, event_type: action === "approval_recorded" ? "approved" : action,
    record_name: item.name, proposed_class: "cmdb_ci_linux_server", operation: item.operation,
    actor: "Remediate", confidence: 1, sys_created_on: new Date().toISOString(), status: "complete",
    detail: JSON.stringify(detail),
  };
}

function launchKeystone() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CMDB_")));
  Object.assign(env, {
    CMDB_API_BASE_URL: FIXTURE_ORIGIN,
    CMDB_IRE_BASE_URL: FIXTURE_ORIGIN,
    CMDB_REMEDIATE_URL: `${FIXTURE_ORIGIN}/remediate`,
    CMDB_APPROVAL_PACKET_DEMO_MODE: "true",
  });
  const next = path.join(root, "node_modules", "next", "dist", "bin", "next");
  return spawn(process.execPath, [next, "start", "-H", "127.0.0.1", "-p", String(WEB_PORT)], {
    cwd: root, env, stdio: "inherit",
  });
}

function ensureBuild() {
  if (fs.existsSync(path.join(root, ".next", "BUILD_ID"))) return;
  console.log("No production build found; building the demo once...");
  const next = path.join(root, "node_modules", "next", "dist", "bin", "next");
  const result = spawnSync(process.execPath, [next, "build"], { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error("Keystone production build failed.");
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function requestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => {
      body += chunk;
      if (body.length > 64 * 1024) reject(new Error("Request too large"));
    });
    request.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch (error) { reject(error); }
    });
    request.on("error", reject);
  });
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function numberArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : fallback;
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${name} must be a valid unprivileged port.`);
  return value;
}

function sysId(index) {
  return index.toString(16).padStart(32, "0");
}

function fingerprint(index) {
  return index.toString(16).toUpperCase().padStart(64, "0");
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
