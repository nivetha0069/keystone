const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const DEFAULT_BASE = "http://localhost:3001/api/cmdb";
const DEFAULT_RUN = "e0ac4df32b82871060aefba6b891bf5b";
const DEFAULT_STAGED_CI = "24ac4df32b82871060aefba6b891bf5c";

const options = parseArgs(process.argv.slice(2));
if (options.execute || options.approve || options.autoExecute) {
  throw new Error("This harness is read-only. Approval-triggered auto-execution or direct Execute requires explicit action-time confirmation outside this script.");
}

installTypeScriptLoader();

const {
  normalizeComprehendCis,
  normalizeComprehendTimeline,
  normalizeComprehendRelationships,
  normalizeComprehendHealth,
  normalizeRemediationFindings,
  normalizeRemediationReviews,
} = require("../app/lib/cmdb/comprehend-adapter.ts");
const { deriveRemediationWorkQueue } = require("../app/lib/cmdb/work-queue.ts");
const { deriveAgentWorkspaceSnapshot, parseAgentEventDetail } = require("../app/lib/cmdb/agent-workspace.ts");
const { runMaraAudit, normalizeMaraRun } = require("../app/lib/cmdb/mara-audit.ts");
const { sanitizeIreRequest } = require("../app/api/cmdb/ire/[action]/route.ts");

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function main() {
  const raw = {};
  for (const resource of ["run", "cis", "timeline", "findings", "reviews", "health", "relationships"]) {
    raw[resource] = await get(resource);
  }

  const run = normalizeMaraRun(raw.run);
  const cis = normalizeComprehendCis(raw.cis);
  const timeline = normalizeComprehendTimeline(raw.timeline);
  const findings = normalizeRemediationFindings(raw.findings);
  const reviews = normalizeRemediationReviews(raw.reviews);
  const health = normalizeComprehendHealth(raw.health);
  const relationships = normalizeComprehendRelationships(raw.relationships);
  const queue = deriveRemediationWorkQueue({ cis, timeline, findings, reviews, healthFixes: health.fixes });
  const snapshot = deriveAgentWorkspaceSnapshot({
    runLabel: run?.number || options.run,
    runState: run?.state,
    cis,
    timeline,
    relationships,
    findings,
    reviews,
    health,
    queue,
  });
  const reconstructed = deriveAgentWorkspaceSnapshot({
    runLabel: run?.number || options.run,
    runState: run?.state,
    cis: JSON.parse(JSON.stringify(cis)),
    timeline: JSON.parse(JSON.stringify(timeline)),
    relationships: JSON.parse(JSON.stringify(relationships)),
    findings: JSON.parse(JSON.stringify(findings)),
    reviews: JSON.parse(JSON.stringify(reviews)),
    health: JSON.parse(JSON.stringify(health)),
    queue: deriveRemediationWorkQueue({ cis, timeline, findings, reviews, healthFixes: health.fixes }),
  });
  const detailEvents = timeline.flatMap(event => {
    const detail = parseAgentEventDetail(event.reasoning);
    return detail ? [{ event, detail }] : [];
  });
  const audit = runMaraAudit({ timeline, cis, findings, reviews, run });
  const checks = [
    check("read-only", "Read-only bridge access", "pass", "Fetched only GET resources from the compatibility bridge."),
    automaticAnalysisCheck(timeline, audit),
    deterministicWorkGroupingCheck(snapshot),
    retryStrategyCheck(detailEvents, timeline),
    retryLimitCheck(detailEvents, timeline),
    simulationFingerprintParityCheck(detailEvents, timeline),
    approvalLinkageCheck(timeline, findings, reviews),
    identifierOnlyApprovalCheck(),
    identifierOnlyExecuteCheck(),
    executionVerificationCheck(timeline),
    refreshReconstructionCheck(snapshot, reconstructed),
    healthAttributionCheck(snapshot, health, timeline),
    relationshipReadinessCheck(snapshot, relationships),
  ];

  const failures = checks.filter(item => item.status === "fail");
  const classifiedChecks = checks.map(item => ({
    ...item,
    classification: acceptanceClassification(item),
  }));
  console.log(JSON.stringify({
    base: options.base,
    run: options.run,
    staged_ci: options.stagedCi,
    counts: {
      cis: cis.length,
      timeline: timeline.length,
      findings: findings.length,
      reviews: reviews.length,
      relationships: relationships.length,
      groups: snapshot.groups.length,
    },
    checks: classifiedChecks,
  }, null, 2));

  if (failures.length && !options.report) {
    throw new Error(`Autonomous lifecycle acceptance failed ${failures.length} check(s): ${failures.map(item => item.id).join(", ")}`);
  }
}

function acceptanceClassification(item) {
  const staticChecks = new Set([
    "read-only",
    "work-grouping",
    "identifier-only-approval",
    "identifier-only-execute",
    "refresh-reconstruction",
  ]);
  if (item.status === "unverifiable") return "UNAVAILABLE";
  if (item.status === "fail" || item.status === "warn") return "FAIL";
  return staticChecks.has(item.id) ? "STATIC PASS" : "PASS";
}

async function get(resource) {
  const url = new URL(`${options.base.replace(/\/$/, "")}/${resource}`);
  if (options.run) url.searchParams.set("run", options.run);
  const response = await fetch(url, { method: "GET", headers: { accept: "application/json" } });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}: ${text.slice(0, 400)}`);
  }
  return parsed;
}

function automaticAnalysisCheck(timeline, audit) {
  const hasAnalysis = timeline.some(event => event.step >= 3 && /comprehend|router|atlas|scout|weaver|sentry|ledger/i.test(`${event.source} ${event.reasoning}`));
  const failedAudit = audit.checks.filter(item => item.status === "fail" && ["sequence", "flow", "coverage", "gate"].includes(item.id));
  if (hasAnalysis && !failedAudit.length) return check("analysis", "Automatic analysis evidence", "pass", "Ledger contains ordered Comprehend/Mara analysis evidence.");
  if (hasAnalysis) return check("analysis", "Automatic analysis evidence", "warn", "Analysis evidence exists, but some Mara audit checks still need ServiceNow evidence.", failedAudit.map(item => item.summary));
  return check("analysis", "Automatic analysis evidence", "fail", "No automatic analysis evidence was found in the Event Ledger.");
}

function deterministicWorkGroupingCheck(snapshot) {
  const signatures = snapshot.groups.map(group => group.signature);
  if (!snapshot.groups.length) return check("work-grouping", "Deterministic work grouping", "fail", "No work groups were derived from ServiceNow evidence.");
  if (new Set(signatures).size !== signatures.length) return check("work-grouping", "Deterministic work grouping", "fail", "Duplicate work-group signatures were derived.");
  return check("work-grouping", "Deterministic work grouping", "pass", `${snapshot.groups.length} stable work group(s) derived from current evidence.`);
}

function retryStrategyCheck(detailEvents, timeline) {
  const text = ledgerText(timeline);
  const strategy = detailEvents.find(({ detail }) => detail.strategy_id === "normalize_known_class_alias") || /normalize_known_class_alias/.test(text);
  const mapping = detailEvents.find(({ detail }) => detail.mapping_version) || /\bmapping_version=class-alias-v\d+\b/.test(text);
  if (strategy && mapping) return check("retry-strategy", "Retry strategy and mapping version", "pass", "Deterministic class-alias strategy and mapping version are present.");
  return check("retry-strategy", "Retry strategy and mapping version", "fail", "Missing deterministic class-alias strategy or mapping-version evidence.");
}

function retryLimitCheck(detailEvents, timeline) {
  const retryCounts = detailEvents.flatMap(({ detail }) => typeof detail.retry_count === "number" ? [detail.retry_count] : []);
  const maxRetries = detailEvents.flatMap(({ detail }) => typeof detail.max_retries === "number" ? [detail.max_retries] : []);
  for (const match of ledgerText(timeline).matchAll(/\b(?:retry_count|max_retries)=(-?\d+)/g)) {
    const value = Number(match[1]);
    if (match[0].startsWith("retry_count")) retryCounts.push(value);
    else maxRetries.push(value);
  }
  if ([...retryCounts, ...maxRetries].some(value => value > 1)) return check("retry-limit", "One retry maximum", "fail", "Retry evidence exceeds the demo limit of one retry.");
  if (retryCounts.length || maxRetries.length) return check("retry-limit", "One retry maximum", "pass", "Retry evidence is bounded to one retry.");
  return check("retry-limit", "One retry maximum", "unverifiable", "No retry-count evidence is available yet.");
}

function simulationFingerprintParityCheck(detailEvents, timeline) {
  const grouped = evidenceByStagedCi(detailEvents, timeline);
  const checked = [];
  const failures = [];
  for (const [stagedCiId, evidence] of grouped) {
    if (!evidence.approvals.length && !evidence.executions.length) continue;
    checked.push(stagedCiId);
    const approved = evidence.approvals.at(-1);
    const simulation = evidence.simulations.find(item => same(item.simulationCorrelation, approved?.simulationCorrelation)) || evidence.simulations.at(-1);
    if (!simulation?.fingerprint || !approved?.fingerprint || simulation.fingerprint !== approved.fingerprint) {
      failures.push(`${stagedCiId}: simulation and approval fingerprints differ or are missing`);
    }
    for (const execution of evidence.executions) {
      if (approved?.fingerprint && execution.fingerprint && approved.fingerprint !== execution.fingerprint) {
        failures.push(`${stagedCiId}: execution fingerprint does not match approval`);
      }
    }
  }
  if (failures.length) return check("fingerprint-parity", "Simulation fingerprint parity", "fail", "Fingerprint parity failed.", failures);
  if (checked.length) return check("fingerprint-parity", "Simulation fingerprint parity", "pass", `Fingerprint parity checked for ${checked.length} staged CI(s).`);
  return check("fingerprint-parity", "Simulation fingerprint parity", "unverifiable", "No approved simulation evidence is available yet.");
}

function approvalLinkageCheck(timeline, findings, reviews) {
  const approvals = timeline.filter(event => /approv/i.test(`${event.name} ${event.reasoning}`));
  if (!approvals.length) return check("approval-linkage", "Approval linkage", "unverifiable", "No approval evidence is available yet.");
  if (!findings.length || !reviews.length) return check("approval-linkage", "Approval linkage", "fail", "Approval events exist without exposed finding/review resources.");
  return check("approval-linkage", "Approval linkage", "pass", `${approvals.length} approval event(s) backed by ${findings.length} finding(s) and ${reviews.length} review decision(s).`);
}

function identifierOnlyExecuteCheck() {
  const sanitized = sanitizeIreRequest("execute", {
    migration_run_id: options.run,
    staged_ci_id: options.stagedCi,
    correlation_id: "ks-execute-acceptance",
    idempotency_key: `execute:${options.run}:${options.stagedCi}:acceptance`,
    simulation_correlation_id: "ks-simulate-acceptance",
    target_class: "cmdb_ci_linux_server",
    payload: { values: { name: "must-not-pass" } },
    values: { serial_number: "must-not-pass" },
  });
  assert.deepEqual(Object.keys(sanitized).sort(), ["correlation_id", "idempotency_key", "migration_run_id", "simulation_correlation_id", "staged_ci_id"]);
  assert.equal(JSON.stringify(sanitized).includes("must-not-pass"), false);
  return check("identifier-only-execute", "Identifier-only execution contract", "pass", "Browser Execute requests discard target class, values, and payload fields.");
}

function identifierOnlyApprovalCheck() {
  const sanitized = sanitizeIreRequest("approve", {
    migration_run_id: options.run,
    staged_ci_id: options.stagedCi,
    finding_id: "33333333333333333333333333333333",
    review_decision_id: "44444444444444444444444444444444",
    correlation_id: "ks-approve-acceptance",
    idempotency_key: `approve:${options.run}:${options.stagedCi}:acceptance`,
    simulation_correlation_id: "ks-simulate-acceptance",
    simulation_fingerprint: "A".repeat(64),
    decision: "approved",
    rationale: "must-not-pass",
    operation: "UPDATE",
    mapping: { source: "must-not-pass" },
    payload: { values: { name: "must-not-pass" } },
  });
  assert.deepEqual(Object.keys(sanitized).sort(), [
    "correlation_id", "finding_id", "idempotency_key", "migration_run_id", "review_decision_id",
    "simulation_correlation_id", "simulation_fingerprint", "staged_ci_id",
  ]);
  assert.equal(JSON.stringify(sanitized).includes("must-not-pass"), false);
  return check("identifier-only-approval", "Identifier-only approval contract", "pass", "Browser Approval requests forward only exact binding identifiers and correlation metadata.");
}

function executionVerificationCheck(timeline) {
  const grouped = evidenceByStagedCi([], timeline);
  const checked = [];
  const failures = [];
  for (const [stagedCiId, evidence] of grouped) {
    for (const verification of evidence.verifications) {
      checked.push(stagedCiId);
      if (!verification.executionCorrelation) failures.push(`${stagedCiId}: verification is missing execution_correlation_id`);
      if (!evidence.executions.some(execution => same(execution.executionCorrelation, verification.executionCorrelation))) {
        failures.push(`${stagedCiId}: verification does not match a prior execution correlation`);
      }
    }
  }
  if (failures.length) return check("execution-verification", "Exact execution-correlation verification", "fail", "Verification correlation checks failed.", failures);
  if (checked.length) return check("execution-verification", "Exact execution-correlation verification", "pass", `Verified exact execution correlations for ${checked.length} staged CI event(s).`);
  return check("execution-verification", "Exact execution-correlation verification", "unverifiable", "No verification evidence is available yet.");
}

function refreshReconstructionCheck(snapshot, reconstructed) {
  if (JSON.stringify(snapshot) !== JSON.stringify(reconstructed)) {
    return check("refresh-reconstruction", "Refresh reconstruction", "fail", "Agent Workspace reconstruction is not deterministic from fetched evidence.");
  }
  return check("refresh-reconstruction", "Refresh reconstruction", "pass", "Agent Workspace snapshot reconstructs deterministically from ServiceNow evidence.");
}

function healthAttributionCheck(snapshot, health, timeline) {
  const hasVerification = /verification.*(?:passed|verified|successful)|verified_score/i.test(ledgerText(timeline));
  const failures = [];
  if (snapshot.health.verified > snapshot.health.projected) failures.push("verified health exceeds projected health");
  if (!hasVerification && health.verifiedScore !== undefined && health.baselineScore !== undefined && health.verifiedScore > health.baselineScore) {
    failures.push("verified health increased without verification evidence");
  }
  if (failures.length) return check("health-attribution", "Health attribution", "fail", "Health evidence violates simulation/verification boundaries.", failures);
  const metrics = ["baselineScore", "verifiedScore", "projectedScore"].filter(key => health[key] !== undefined);
  return check("health-attribution", "Health attribution", metrics.length ? "pass" : "unverifiable", metrics.length ? `Health metrics present: ${metrics.join(", ")}.` : "Health metrics were not exposed by ServiceNow yet.");
}

function relationshipReadinessCheck(snapshot, relationships) {
  if (!relationships.length) return check("relationship-readiness", "Relationship readiness", "unverifiable", "No staged relationships are available.");
  if (snapshot.relationships.total !== relationships.length) return check("relationship-readiness", "Relationship readiness", "fail", "Relationship readiness count does not match normalized relationships.");
  return check("relationship-readiness", "Relationship readiness", "pass", `${snapshot.relationships.ready}/${snapshot.relationships.total} relationships are ready from verified endpoint evidence only.`);
}

function evidenceByStagedCi(detailEvents, timeline) {
  const grouped = new Map();
  const add = (item) => {
    const stagedCiId = item.stagedCiId || "unknown";
    const current = grouped.get(stagedCiId) || { simulations: [], approvals: [], executions: [], verifications: [] };
    current[item.kind].push(item);
    grouped.set(stagedCiId, current);
  };

  for (const { event, detail } of detailEvents) {
    const item = {
      stagedCiId: detail.staged_ci_id,
      fingerprint: detail.simulation_fingerprint,
      simulationCorrelation: detail.simulation_correlation_id,
      executionCorrelation: detail.execution_correlation_id || detail.execution_event_id,
    };
    const text = `${detail.action} ${detail.status} ${event.name}`.toLowerCase();
    if (/simulat/.test(text)) add({ ...item, kind: "simulations" });
    if (/approv/.test(text)) add({ ...item, kind: "approvals" });
    if (/execut|commit/.test(text)) add({ ...item, kind: "executions" });
    if (/verif/.test(text)) add({ ...item, kind: "verifications" });
  }

  for (const event of timeline) {
    const evidence = eventEvidence(event);
    if (!evidence.stagedCiId) continue;
    const text = `${event.name} ${event.reasoning}`.toLowerCase();
    if (/simulat/.test(text)) add({ ...evidence, kind: "simulations" });
    if (/approv/.test(text)) add({ ...evidence, kind: "approvals" });
    if (/execut|commit/.test(text)) add({ ...evidence, kind: "executions" });
    if (/verif/.test(text)) add({ ...evidence, kind: "verifications" });
  }
  return grouped;
}

function eventEvidence(event) {
  return {
    stagedCiId: readToken(event.reasoning, "staged_ci_id"),
    fingerprint: readToken(event.reasoning, "simulation_fingerprint") || readToken(event.reasoning, "fingerprint"),
    simulationCorrelation: readToken(event.reasoning, "simulation_correlation_id"),
    executionCorrelation: readToken(event.reasoning, "execution_correlation_id") || readToken(event.reasoning, "execution_event_id"),
  };
}

function readToken(value, key) {
  return value.match(new RegExp(`(?:"?${key}"?\\s*[:=]\\s*"?)([a-zA-Z0-9:._-]+)`, "i"))?.[1];
}

function ledgerText(timeline) {
  return timeline.map(event => `${event.name} ${event.reasoning}`).join("\n");
}

function same(left, right) {
  return Boolean(left && right && left === right);
}

function check(id, title, status, summary, evidence = []) {
  return { id, title, status, summary, evidence };
}

function parseArgs(argv) {
  const options = { base: DEFAULT_BASE, run: DEFAULT_RUN, stagedCi: DEFAULT_STAGED_CI };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--base") options.base = argv[++index];
    else if (arg === "--run") options.run = argv[++index];
    else if (arg === "--staged-ci") options.stagedCi = argv[++index];
    else if (arg === "--report") options.report = true;
    else if (arg === "--execute") options.execute = true;
    else if (arg === "--approve") options.approve = true;
    else if (arg === "--auto-execute") options.autoExecute = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function installTypeScriptLoader() {
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
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
      fileName: filename,
    }).outputText;
    module._compile(output, filename);
  };
}
