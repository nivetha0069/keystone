# ServiceNow Autonomous Runtime Handoff

This handoff keeps ServiceNow authoritative for identity, ownership, orchestration, IRE payload rebuild, simulation, approval, execution, verification, idempotency, concurrency, and durable evidence. Keystone remains a read-only projection and identifier-only action surface.

## Deploy Script Includes

- Deploy `DotwalkersAgentEventDetailService` and `DotwalkersFailureStrategyService` as scoped Script Includes.
- Wire `DotwalkersAgentEventDetailService.build(...)` into the existing Event Ledger writer so `detail` stores compact `keystone.agent.v1` JSON without adding `event_type` choices.
- Wire `DotwalkersFailureStrategyService.decide(...)` into the shared IRE lifecycle service before simulation retry. Include `strategy_id`, `mapping_version`, `retry_count`, `max_retries`, and `simulation_fingerprint` in lifecycle detail.

## Bounded Mara Loop

Implement the single-record loop inside ServiceNow:

1. Observe the migration run, staged CI, findings, reviews, and latest ledger entries.
2. Decide the next safe action using ServiceNow evidence and deterministic policy first.
3. Validate authenticated user, role, run ownership, staged-record ownership, allowed class, allowed attributes, source identity, and current fingerprint.
4. Use only server-side tools to simulate or execute through IRE; the browser supplies identifiers and correlation metadata only.
5. Record compact Event Ledger detail with sequence ordering, strategy/fingerprint/correlation metadata, target CI sys_id after execution, and health metrics only when verified.
6. Reread the exact ServiceNow records and stop after one action unless a single approved resume is required.

## Approval Resume

- Approval authorizes exactly one staged CI at exactly one successful simulation fingerprint.
- After approval, ServiceNow may automatically resume Mara once for that staged CI only.
- Execution idempotency must derive from `migration_run`, `staged_ci`, `simulation_fingerprint`, and action name.
- Reject execution on stale fingerprint, mismatched staged CI, missing approval, invalid target sys_id, duplicate execution, missing ownership, or policy failure.
- Verification must read back the CI tied to the exact `execution_correlation_id`; do not verify an older execution for the same staged record.

## Health And Relationships

- Return `baseline_score`, `verified_score`, `projected_score`, `dimension_scores`, and `work_group_impacts` only from real ServiceNow evidence.
- Simulation may increase readiness and projected health, but must not increase verified health.
- Verified health may increase only after exact execution-correlation verification.
- Relationship readiness is read-only until both staged endpoints have verified production CI evidence. Do not promote relationships or write `cmdb_rel_ci` in this demo slice.

## Remaining Deployment Work

- Deploy both helper services and connect them to the shared IRE lifecycle service.
- Prove strategy reconstruction and simulation/execution fingerprint parity.
- Prove automatic single-record resume after approval.
- Prove one retry maximum and deterministic class-alias retry behavior.
- Prove exact execution-correlation verification and refresh playback from Event Ledger.
- Preserve the no-direct-write boundary for `cmdb_ci*` and `cmdb_rel_ci`.
