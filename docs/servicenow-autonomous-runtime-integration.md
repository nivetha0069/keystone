# ServiceNow Autonomous Runtime Integration Preparation

## Reconciliation Result

The full read-only scope export confirmed that the deployed application already
contains the IRE resources, Mara handoff, Event Ledger writer, and health route.
Keystone therefore source-controls in-place patches to those records rather
than a parallel lifecycle stack. Replace only the matching Script Include or
REST resource body; do not create duplicate records or deploy the ignored scope
export.

## Source-Controlled Runtime

1. `servicenow/DotwalkersAgentEventDetailService.js`
   Builds compact `keystone.agent.v1` Event Ledger detail. It allowlists fields
   and excludes prompts, source rows, credentials, and executable IRE payloads.
2. `servicenow/DotwalkersFailureStrategyService.js`
   Owns deterministic failure grouping, the only demo retry strategy
   (`normalize_known_class_alias`), mapping version `class-alias-v1`, one-retry
   enforcement, persisted-strategy reconstruction, and fingerprint material.

3. `servicenow/DotwalkersAgentSupport.phase-a.js`
   Adds compact autonomous detail while preserving the existing ledger writer.
4. `servicenow/DotwalkersIrePayloadService.phase-b3.js`
   Preserves server-authoritative payload construction and adds stable strategy
   reconstruction, error codes, and canonical fingerprint material.
5. `servicenow/DotwalkersIreSimulationService.phase-b3.js`
   Owns read-only simulation, deterministic blockers, fingerprinting,
   idempotency, compact evidence, and the shared Verify implementation.
6. `servicenow/ire_simulate.phase-b3.js`
   Thin identifier-only REST adapter over the shared simulation service.
7. `servicenow/DotwalkersPhaseATests.phase-a.js`,
   `servicenow/DotwalkersPhaseB3ATests.phase-b3.js`, and
   `servicenow/DotwalkersPhaseB3BTests.phase-b3.js`
   Preserve the installed server-side regression suites.

The Phase B3 payload supersedes the earlier Phase A payload source. Keep only
the Phase B3 payload in deployment handoffs to avoid duplicate class sources.

## Existing Artifacts To Patch

| Existing artifact | Preserve | Targeted change |
|---|---|---|
| `DotwalkersAgentSupport.log` | Event Ledger table, choices, sequencing, and writer authorization | Build compact `detail` with `DotwalkersAgentEventDetailService`; do not add choices or another writer. |
| `DotwalkersIrePayloadService` | Confidence threshold, allowlists, source identity, reference resolution, and server-built payload | Include server-owned strategy ID, mapping version, source class, and target class in canonical fingerprint material. Do not replace the service. |
| `DotwalkersIreSimulationService` | Validation, simulation, findings, and payload-service calls | Make this the single simulation/fingerprint authority. Apply `DotwalkersFailureStrategyService.decide` once for eligible alias failures and persist its evidence. |
| `ire_simulate` | Authentication, role/run linkage, identifier filtering, and response contract | Delegate canonical payload/fingerprint work to the simulation service; retire its local fingerprint only after parity tests pass. |
| `ire_execute` | Approval, duplicate, idempotency, concurrency, stale-data, and IRE-only mutation checks | Reconstruct the strategy and recompute through the same simulation service. Reject stale mapping, target, approval, action, or fingerprint evidence. |
| `ire_approve` | Authorization, target review, and approval evidence | Bind approval to one staged CI and fingerprint, then queue `x_kest_dotwalkers.mara.requested` with a compact resume token in `parm2`. |
| Mara Script Action | Existing event and background execution | Validate `parm2` and call the existing Mara agent in approval-resume mode. Ignore malformed, stale, or repeated tokens. |
| `DotwalkersMaraAgent` | Existing read-only loop and Prioritize handoff | Add a bounded deterministic resume path: at most 20 actions, one approved IRE record, immediate correlation-bound Verify, reread, and stop. |
| `ire_verify` | Read-only lookup and exact execution-correlation checks | Return compact verification and target-CI evidence for Event Ledger recording. |
| `DotwalkersBridgeService.getHealth` and `health` | Existing GET route and compatibility response | Return health metrics only from persisted evidence. Simulation changes projected health only. |

## Runtime Invariants

- Maximum 20 tool actions per Mara activation and one retry per work item.
- `normalize_known_class_alias` is the only demo retry strategy.
- Class mappings and IRE payloads are server-owned, never browser/model-owned.
- Every decision is `model`, `deterministic`, or `deterministic_fallback`.
- Approval authorizes exactly one staged CI at one simulation fingerprint.
- Automatic continuation executes one IRE record and immediately verifies with
  the returned execution correlation.
- Stale fingerprint, invalid target sys_id, repeated action, missing approval,
  stale mapping version, or correlation mismatch stops the loop.
- Preserve role/run-ownership checks, identifier-only requests, idempotency,
  concurrency, Event Ledger choices, and `/api/cmdb/*` compatibility.
- Add no ServiceNow schema and never write directly to `cmdb_ci*` or
  `cmdb_rel_ci`.

## Expected Event Sequence

```text
analysis_started -> analysis_completed -> work_grouped
retry_selected (only for an allowlisted alias; retry_count=1)
simulation_started -> simulation_completed -> approval_required
approval_recorded -> x_kest_dotwalkers.mara.requested (resume token)
execution_started -> ire_execution_completed
verification_started -> verification_passed
health_verified (only with exact-correlation evidence)
```

Existing `event_type` choices remain authoritative. Put more specific action
names in compact detail when there is no matching existing choice.

## Completed Validation

- Phase A payload and compact-detail tests: 34/34
- Shared read-only Verify service: 17/17
- Thin `ire_verify` adapter: 13/13
- Phase B3A simulation service: 23/23
- Phase B3B `ire_simulate` adapter and service contract: 41/41

No test sent a live Approve, Execute, Verify, approval-triggering event, or CMDB
write request.

## Deployment And Live Validation

1. Patch records by matching name and sys_id; create no duplicate REST
   resources or lifecycle services.
2. Run `npm.cmd run smoke:servicenow-runtime` locally and ServiceNow tests for
   fingerprint parity, one retry, approval binding, one-record resume, duplicate
   blocking, and exact-correlation verification.
3. Run `npm.cmd run acceptance:lifecycle:report` before any live action.
4. Obtain explicit action-time confirmation, approve one staged CI, observe one
   resume/Execute/Verify, and rerun report mode.

Required confirmation:

**Approve staged CI `<sys_id>` at simulation fingerprint `<fingerprint>` and
allow its automatic single Execute plus Verify continuation.**
