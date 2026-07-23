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
  "mapping_version": "class-alias-v1",
  "retry_count": 1,
  "max_retries": 1,
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

## Bounded Packet Handoff

When Remediate is paused for approval, Agent Workspace may route the user to
`Review next bounded packet`. That control may trigger only the existing
identifier-only packet preparation flow for the active migration run. It does
not carry browser-derived class, operation, strategy, mapping, fingerprint,
policy, payload, or CMDB values.

Packet preparation may create missing deferred reviews and freeze eligible
fresh child manifests. It never approves, executes, verifies, or initiates
simulation. Approval remains locked until the operator enters the complete
recomputed parent hash and the server issues a one-time capability through the
separate `Authorize exact packet` UI action.

## Presentation-Only Completion

`View completed results` is a local presentation state. It may advance the
visible story to Verify while pending records remain, but it must:

- disclose verified and deferred counts;
- state that ServiceNow was not changed for deferred work;
- preserve the real queue and ServiceNow evidence;
- offer a route back to the remaining work; and
- never reject reviews, approve records, execute IRE, or persist a false run
  completion state.

A refresh reconstructs the authoritative queue from ServiceNow. The
presentation state is not an approval, lifecycle event, or source of truth.

## Verification Summary And Health Progression

Verify summarizes only correlated ServiceNow outcomes: verified count,
`INSERT`/`UPDATE`/`NO_CHANGE` counts, target CI bindings, blockers, and class
counts. Pending or deferred work remains separately disclosed.

When the health resource reports baseline, verified, and projected scores,
Agent Workspace labels them as reported. When those historical fields are
absent, the UI may derive a labeled progression from average staged-CI health,
realized work-group lift, and remaining work-group lift. Derived projected
health is an opportunity estimate, not proof of a completed CMDB mutation.

Past Summaries currently uses staged operation totals and is not authoritative
for committed counts. Use Agent Workspace Chapter 4 and exact Phase D
verification evidence for live acceptance.

## ServiceNow Integration Gate

Before deployment, integrate these source-controlled services with the existing
shared IRE lifecycle service and prove:

1. strategy reconstruction and fingerprint parity;
2. one retry maximum;
3. automatic resume after approval for one record;
4. exact execution-correlation verification;
5. compact Event Ledger playback after refresh;
6. no direct cmdb_ci or cmdb_rel_ci writes.
