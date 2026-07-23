const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadScriptInclude(fileName, exportName) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'servicenow', fileName), 'utf8');
  const context = vm.createContext({
    Class: {
      create() {
        return function ServiceNowClass() {
          if (typeof this.initialize === 'function') this.initialize();
        };
      },
    },
  });
  vm.runInContext(source, context, { filename: fileName });
  return context[exportName];
}

function readServiceNowSource(fileName) {
  return fs.readFileSync(path.join(__dirname, '..', 'servicenow', fileName), 'utf8');
}

function registeredTests(source) {
  const list = source.match(/var tests = \[([\s\S]*?)\];/);
  assert.ok(list, 'Expected a registered test list');
  return [...list[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

const FailureStrategy = loadScriptInclude(
  'DotwalkersFailureStrategyService.js',
  'DotwalkersFailureStrategyService',
);
const strategy = new FailureStrategy();

const selected = strategy.decide(
  {
    error_code: 'INVALID_CLASS',
    source_class: 'Linux Server',
    field: 'class',
  },
  0,
);
assert.equal(selected.status, 'selected');
assert.equal(selected.decision_source, 'deterministic');
assert.equal(selected.strategy_id, 'normalize_known_class_alias');
assert.equal(selected.mapping_version, 'class-alias-v1');
assert.equal(selected.target_class, 'cmdb_ci_linux_server');
assert.equal(selected.retry_count, 1);
assert.equal(selected.max_retries, 1);
assert.match(strategy.fingerprintMaterial(selected), /normalize_known_class_alias\|class-alias-v1/);

assert.equal(strategy.decide({ source_class: 'Linux Server' }, 1).status, 'blocked');
assert.equal(strategy.decide({ source_class: 'Unknown Appliance' }, 0).status, 'blocked');
assert.equal(strategy.reconstruct(selected).target_class, 'cmdb_ci_linux_server');
assert.throws(
  () => strategy.reconstruct({ ...selected, mapping_version: 'stale' }),
  /mapping version is stale/,
);
assert.throws(
  () => strategy.reconstruct({ ...selected, strategy_id: 'model_selected' }),
  /Unsupported persisted retry strategy/,
);

const EventDetail = loadScriptInclude(
  'DotwalkersAgentEventDetailService.js',
  'DotwalkersAgentEventDetailService',
);
const detail = JSON.parse(
  new EventDetail().build({
    phase: 'remediate',
    actor: 'Mara',
    decision_source: 'deterministic',
    action: 'ire_simulate',
    status: 'approval_required',
    summary: 'Simulation completed and requires approval.',
    migration_run_id: 'run_sys_id',
    staged_ci_id: 'staged_sys_id',
    strategy_id: selected.strategy_id,
    mapping_version: selected.mapping_version,
    retry_count: selected.retry_count,
    max_retries: selected.max_retries,
    simulation_correlation_id: 'sim-correlation',
    simulation_fingerprint: 'sha256-fingerprint',
    target_ci_sys_id: 'target_sys_id',
    baseline_score: 61.28,
    verified_score: 63.14,
    projected_score: 70.07,
    prompt: 'must not be serialized',
    ire_payload: { forbidden: true },
    credentials: 'must not be serialized',
  }),
);
assert.equal(detail.schema, 'keystone.agent.v1');
assert.equal(detail.mapping_version, 'class-alias-v1');
assert.equal(detail.retry_count, 1);
assert.equal(detail.max_retries, 1);
assert.equal(detail.target_ci_sys_id, 'target_sys_id');
assert.equal(detail.baseline_score, 61.3);
assert.equal(detail.verified_score, 63.1);
assert.equal(detail.projected_score, 70.1);
assert.equal(detail.prompt, undefined);
assert.equal(detail.ire_payload, undefined);
assert.equal(detail.credentials, undefined);

const simulationSource = readServiceNowSource('DotwalkersIreSimulationService.phase-b3.js');
const payloadSource = readServiceNowSource('DotwalkersIrePayloadService.phase-b3.js');
const b3aSource = readServiceNowSource('DotwalkersPhaseB3ATests.phase-b3.js');
const b3bSource = readServiceNowSource('DotwalkersPhaseB3BTests.phase-b3.js');
const adapterSource = readServiceNowSource('ire_simulate.phase-b3.js');
const adapterExecutable = adapterSource.replace(/^\s*\/\/.*$/gm, '');

assert.match(simulationSource, /this\.ERROR_CODE_MAP = \{/);
assert.match(simulationSource, /_handleBlocker: function/);
assert.match(simulationSource, /CLASS_ALIAS_RETRY_AVAILABLE/);
assert.match(simulationSource, /MISSING_IDENTITY/);
assert.match(simulationSource, /_findBlockedSimulation: function/);
assert.match(simulationSource, /error && error\.error_code/);
assert.match(simulationSource, /SIMULATION_EVIDENCE_VERSION = 'keystone\.simulation\.v2'/);
assert.match(simulationSource, /CLASS_POLICY_VERSION = 'servicenow-allowlisted-class-v1'/);
assert.match(simulationSource, /_validateSimulationClassEvidence: function/);
assert.match(simulationSource, /reconciliation_passed/);
assert.match(simulationSource, /reconciliation_failed/);
const reconciliationSource = simulationSource.slice(
  simulationSource.indexOf('_reconcileNoChange: function'),
  simulationSource.indexOf('_findBlockedSimulation: function'),
);
assert.match(reconciliationSource, /target\.get\(targetCiId\)/, 'NO_CHANGE performs a server-owned target read-back');
assert.equal(/createOrUpdateCI|_createOrUpdateCi|approval_recorded|approval_resume/.test(reconciliationSource), false,
  'NO_CHANGE reconciliation performs no approval, Execute, or CMDB write');
assert.match(payloadSource, /strategyError\.error_code = retryCount > 0/);
assert.match(payloadSource, /_hasAliasRetryAvailable: function/);
assert.match(payloadSource, /_validateUsableIdentity: function/);
assert.match(payloadSource, /_validateAliasRetryCandidate: function/);
assert.equal(registeredTests(b3aSource).length, 23);
assert.equal(registeredTests(b3bSource).length, 41);
assert.match(adapterSource, /svc\.simulate\(body, \{ mode: 'interactive' \}\)/);
for (const field of ['class_policy_version', 'evidence_version', 'target_ci_sys_id']) {
  assert.ok(adapterSource.includes(field), `ire_simulate forwards ${field}`);
}
for (const forbidden of ['GlideRecord', 'GlideAggregate', 'sn_cmdb', 'createOrUpdateCI']) {
  assert.equal(adapterExecutable.includes(forbidden), false, `ire_simulate contains ${forbidden}`);
}

console.log('ServiceNow runtime helper smoke checks passed.');
