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
8. `servicenow/ire_approve.phase-c.js`,
   `servicenow/remediate.phase-c.js`,
   `servicenow/run_dotwalkers_mara.phase-c.js`, and
   `servicenow/DotwalkersMaraAgent.phase-c.js`
   Are complete in-place Phase C patch sources for exact approval binding,
   recoverable handoff, token claiming, and preparation-only Mara resume.
9. `servicenow/DotwalkersPhaseCTests.phase-c.js`
   Is the separate 48-test, test-only Script Include. Phase B3B remains
   byte-for-byte unchanged at 41 registrations.

The Phase B3 payload supersedes the earlier Phase A payload source. Keep only
the Phase B3 payload in deployment handoffs to avoid duplicate class sources.

## Existing Artifacts To Patch

| Existing artifact | Preserve | Targeted change |
|---|---|---|
| `DotwalkersAgentSupport.log` | Event Ledger table, choices, sequencing, and writer authorization | Build compact `detail` with `DotwalkersAgentEventDetailService`; do not add choices or another writer. |
| `DotwalkersIrePayloadService` | Confidence threshold, allowlists, source identity, reference resolution, and server-built payload | Include server-owned strategy ID, mapping version, source class, and target class in canonical fingerprint material. Do not replace the service. |
| `DotwalkersIreSimulationService` | Validation, simulation, findings, and payload-service calls | Make this the single simulation/fingerprint authority. Apply `DotwalkersFailureStrategyService.decide` once for eligible alias failures and persist its evidence. |
| `ire_simulate` | Authentication, role/run linkage, identifier filtering, and response contract | Delegate canonical payload/fingerprint work to the simulation service; retire its local fingerprint only after parity tests pass. |
| `remediate` | Existing POST resource, authentication, and ACL authorization | Replace the legacy `{fixId, tool}` writer with an identifier-only adapter over deterministic deferred-review binding. |
| `ire_execute` | Approval, duplicate, idempotency, concurrency, stale-data, and IRE-only mutation checks | Reconstruct the strategy and recompute through the same simulation service. Reject stale mapping, target, approval, action, or fingerprint evidence. |
| `ire_approve` | Authorization, target review, and approval evidence | Bind approval to one staged CI and fingerprint, then queue `x_kest_dotwalkers.mara.requested` with a compact resume token in `parm2`. |
| Mara Script Action | Existing event and background execution | Validate `parm2` and call the existing Mara agent in approval-resume mode. Ignore malformed, stale, or repeated tokens. |
| `DotwalkersMaraAgent` | Existing read-only loop and Prioritize handoff | Add `prepareApprovalResume(binding)`, which validates compact server-owned binding and stops before the LLM loop, Prioritize, Execute, or Verify. |
| `ire_verify` | Read-only lookup and exact execution-correlation checks | Return compact verification and target-CI evidence for Event Ledger recording. |
| `DotwalkersBridgeService.getHealth` and `health` | Existing GET route and compatibility response | Return health metrics only from persisted evidence. Simulation changes projected health only. |

## Runtime Invariants

- Maximum 20 tool actions per Mara activation and one retry per work item.
- `normalize_known_class_alias` is the only demo retry strategy.
- Class mappings and IRE payloads are server-owned, never browser/model-owned.
- Every decision is `model`, `deterministic`, or `deterministic_fallback`.
- Approval authorizes exactly one staged CI at one simulation fingerprint.
- Phase C prepares an approved continuation but does not Execute or Verify.
- Stale fingerprint, invalid target sys_id, repeated action, missing approval,
  stale mapping version, or correlation mismatch stops the loop.
- Preserve role/run-ownership checks, identifier-only requests, idempotency,
  concurrency, Event Ledger choices, and `/api/cmdb/*` compatibility.
- Add no ServiceNow schema and never write directly to `cmdb_ci*` or
  `cmdb_rel_ci`.

## Expected Event Sequence

```text
ire_simulation_completed
-> approval_recorded
-> approval_handoff_queued
-> x_kest_dotwalkers.mara.requested
   parm1=<migration_run_id>
   parm2=<approval_event_sys_id>
-> approval_resume_claimed
-> prepareApprovalResume
-> approval_resume_prepared
-> STOP
```

Existing `event_type` choices remain authoritative. Put more specific action
names in compact detail when there is no matching existing choice.

## Completed Validation

- Phase A payload and compact-detail tests: 34/34
- Shared read-only Verify service: 17/17
- Thin `ire_verify` adapter: 13/13
- Phase B3A simulation service: 23/23
- Phase B3B `ire_simulate` adapter and service contract: 41/41
- Phase C approval binding and Mara preparation: 36/36 in ServiceNow
- Phase C.1 deferred-review binding: 48 tests expected after deployment; the
  original 36 remain registered and unchanged in behavior

No test sent a live Approve, Execute, Verify, approval-triggering event, or CMDB
write request.

## Deployment And Live Validation

1. Patch records by matching name and sys_id; create no duplicate REST
   resources or lifecycle services.
2. Run `npm.cmd run smoke:servicenow-runtime` locally and ServiceNow tests for
   fingerprint parity, one retry, approval binding, one-record resume, duplicate
   blocking, and exact-correlation verification.
3. Run `npm.cmd run acceptance:lifecycle:report` before any live action.
4. Obtain explicit action-time confirmation, record one deferred proposal, and
   verify its exact review/ledger binding through GET-only evidence. Live
   approval remains a later separate gate.

Required confirmation:

**Approve staged CI `<sys_id>` at simulation fingerprint `<fingerprint>` and
allow its automatic single Execute plus Verify continuation.**

## Phase C Deployment Manifest

| Table | Record | sys_id |
|---|---|---|
| `sys_script_include` | `DotwalkersAgentEventDetailService` | `1b4cb6842b52cb1060aefba6b891bf78` |
| `sys_script_include` | `DotwalkersIreSimulationService` | `cf883837938e8710410e383efaba104e` |
| `sys_ws_operation` | `remediate` | `7bc8ac4793ca4790410e383efaba10cc` |
| `sys_ws_operation` | `ire_approve` | `8a0393d9b4b9473da9ca706d46f40f22` |
| `sysevent_script_action` | `Run Dotwalkers Mara` | `895b3eeb2bc6071060aefba6b891bfa1` |
| `sys_script_include` | `DotwalkersMaraAgent` | `7a36feeb2b86071060aefba6b891bfb4` |
| `sys_script_include` | `DotwalkersPhaseCTests` (test-only) | `2a2cc9589316cf10410e383efaba102f` |
| `sysevent_register` | `x_kest_dotwalkers.mara.requested` (verify only) | `f51b36eb2bc6071060aefba6b891bf30` |

The Phase C baseline above was installed in place on 2026-07-21 and a fresh
GET-only export matched all six deployed source records exactly. The subsequent
ledger-sequence corrective patch was installed and verified with new sequences
64/65. The Phase C.1 `/remediate`, service, and expanded 48-test patch remains
source-controlled only; it does not authorize a live proposal or approval.

`approval_recorded`, `approval_handoff_queued`,
`approval_review_deferred`,
`approval_handoff_retry_claimed`, `approval_handoff_failed`,
`approval_resume_claimed`, `approval_resume_prepared`, and
`approval_resume_failed` are compact `detail.action` values. They are not new
`event_type` choices.
