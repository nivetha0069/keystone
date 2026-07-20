# Agent Workspace Contract

The Agent Workspace is a derived projection. A refresh must reproduce it from
ServiceNow run, staged CI, finding, review, health, relationship, and Event
Ledger resources. It does not own workflow state.

## Agent Event Detail V1

Existing Event Ledger choices remain unchanged. Agent metadata is compact JSON
inside the detail field:

~~~json
{
  "schema": "keystone.agent.v1",
  "phase": "remediate",
  "actor": "Mara",
  "decision_source": "deterministic",
  "action": "normalize_known_class_alias",
  "status": "completed",
  "summary": "Mapped Linux Srv to the allowed Linux server class.",
  "staged_ci_id": "sys_id",
  "finding_id": "sys_id",
  "strategy_id": "normalize_known_class_alias",
  "simulation_correlation_id": "ks-simulate-...",
  "simulation_fingerprint": "hash",
  "health_impact": 2
}
~~~

Decision source must be model, deterministic, or deterministic_fallback.
Summaries are display text; tool outputs and correlations remain authoritative.

## Bounded Retry

DotwalkersFailureStrategyService owns the demo allowlist and mapping version.
Simulation and execution must both include its fingerprint material. Mara may
retry one record once, sequentially. A second failure becomes Blocked.

The browser never supplies a class mapping, final CMDB values, retry authority,
or an IRE payload. It sends identifiers and correlation metadata only.

## Approval Resume

Approval authorizes one staged CI at one simulation fingerprint. The
ServiceNow background handoff may then resume Mara for exactly one IRE
execution and correlation-linked verification. A stale fingerprint, mismatched
record, missing approval, invalid target sys_id, repeated action, or policy
failure stops the loop.

The manual Execute and Verify controls remain an advanced recovery surface, not
the normal workspace path.

## ServiceNow Integration Gate

Before deployment, integrate these source-controlled services with the existing
shared IRE lifecycle service and prove:

1. strategy reconstruction and fingerprint parity;
2. one retry maximum;
3. automatic resume after approval for one record;
4. exact execution-correlation verification;
5. compact Event Ledger playback after refresh;
6. no direct cmdb_ci or cmdb_rel_ci writes.
