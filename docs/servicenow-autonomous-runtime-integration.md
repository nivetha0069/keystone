# ServiceNow Autonomous Runtime Integration Preparation

## Reconciliation Result

The full read-only scope export confirmed that the deployed application already
contains the IRE resources, Mara handoff, Event Ledger writer, and health route.
Keystone therefore source-controls in-place patches to those records rather
than a parallel lifecycle stack. Replace only the matching Script Include or
REST resource body; do not create duplicate records or deploy the ignored scope
export.

The fresh Phase D export confirmed there is no standalone
`DotwalkersIreVerificationService`; the deployed equivalent is
`DotwalkersIreSimulationService.verifyExecution`. Phase D keeps verification in
that existing service.

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
10. `servicenow/ire_execute.phase-d.js` and
    `servicenow/ire_verify.phase-d.js`
    Are in-place, status-only compatibility adapters. Browser calls cannot
    start Execute or Verify.
11. `servicenow/run_dotwalkers_mara.phase-c.js` and
    `servicenow/DotwalkersMaraAgent.phase-c.js`
    Extend the existing prepared continuation into the deterministic Phase D
    method without entering the LLM loop.
12. `servicenow/DotwalkersPhaseDTests.phase-d.js`
    Is the installed 32-test, test-only Script Include with sys_id
    `4b9cb8a893520750410e383efaba1092`.

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
| `ire_execute` | Existing `/ire/execute` compatibility path | Replace the deployed browser-triggered writer with the status-only Phase D adapter. The Mara prepared continuation is the only execution initiator. |
| `ire_approve` | Authorization, target review, and approval evidence | Bind approval to one staged CI and fingerprint, then queue `x_kest_dotwalkers.mara.requested` with a compact resume token in `parm2`. |
| Mara Script Action | Existing event and background execution | Validate `parm2` and call the existing Mara agent in approval-resume mode. Ignore malformed, stale, or repeated tokens. |
| `DotwalkersMaraAgent` | Existing read-only loop and Prioritize handoff | Preserve `prepareApprovalResume(binding)` and add `continueApprovalResume(prepared)`, a deterministic non-LLM delegation to the existing simulation service. |
| `ire_verify` | Existing `/ire/verify` compatibility path | Replace the deployed interactive writer with a status-only adapter. Correlated verification is invoked directly by the server-owned continuation. |
| `DotwalkersBridgeService.getHealth` and `health` | Existing GET route and compatibility response | Return health metrics only from persisted evidence. Simulation changes projected health only. |

## Runtime Invariants

- Maximum 20 tool actions per Mara activation and one retry per work item.
- `normalize_known_class_alias` is the only demo retry strategy.
- Class mappings and IRE payloads are server-owned, never browser/model-owned.
- Every decision is `model`, `deterministic`, or `deterministic_fallback`.
- Approval authorizes exactly one staged CI at one simulation fingerprint.
- Phase C prepares an approved continuation but does not Execute or Verify.
- Phase D rereads the complete Phase C chain, recomputes the canonical
  fingerprint without `identifyCI`, atomically claims one IRE call, and invokes
  one correlated verification.
- Stale fingerprint, invalid target sys_id, repeated action, missing approval,
  stale mapping version, or correlation mismatch stops the loop.
- Preserve role/run-ownership checks, identifier-only requests, idempotency,
  concurrency, Event Ledger choices, and `/api/cmdb/*` compatibility.
- Add no ServiceNow schema and never write directly to `cmdb_ci*` or
  `cmdb_rel_ci`.
- A pre-invocation failure records `EXECUTION_PRECOMMIT_FAILED` and permits one
  deterministic retry claim. Any exception or invalid response after
  `createOrUpdateCI` is invoked records reconciliation-required evidence and
  permanently disables blind retry.
- Verification mismatch is terminal and never repeats Execute. A verification
  read transport failure permits one deterministic verification retry without
  another IRE call.

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
-> ire_execution_claimed
-> exactly one createOrUpdateCI
-> ire_execution_completed
-> ire_verification_claimed
-> verification_passed or verification_failed
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
- Phase C/C.1 approval, deferred-review binding, and Mara preparation: 48/48
  live-validated in ServiceNow
- Phase D atomic Execute and correlated Verify: 32/32 locally in the separate
  test-only suite

No test sent a live Approve, Execute, Verify, approval-triggering event, or CMDB
write request. Phase D tests override all live dependencies at the instance
method boundary while the production wrapper retains the single existing
`createOrUpdateCI` call.

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

Required action-time confirmation must name all four persisted identifiers:

**For staged CI `24ac4df32b82871060aefba6b891bf5c`, canonical simulation
fingerprint `8E080D7595B72AB11893B32EFDBEC60A215E0C33C47F83F0106384AB07CCE67D`,
approval event `495c623d6523bb79b494287d0f0b51ed`, and
`approval_resume_prepared` event `1b43ac6e2e86d25abbb64faaad77ecf3`,
authorize exactly one IRE Execute plus one correlated Verify.**

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
64/65. Phase C/C.1 was subsequently installed and live-validated at 48/48; its
approved continuation is confirmed to stop at `approval_resume_prepared`.

`approval_recorded`, `approval_handoff_queued`,
`approval_review_deferred`,
`approval_handoff_retry_claimed`, `approval_handoff_failed`,
`approval_resume_claimed`, `approval_resume_prepared`, and
`approval_resume_failed` are compact `detail.action` values. They are not new
`event_type` choices.

## Phase D Build-Only Deployment Manifest

Fresh GET-only export:
`x_kest_dotwalkers-2026-07-22T01-05-13-230Z` (462 records, 52 scripts,
zero unavailable tables). Patch existing records only.

| Table | Record | sys_id | Phase D action |
|---|---|---|---|
| `sys_script_include` | `DotwalkersAgentEventDetailService` | `1b4cb6842b52cb1060aefba6b891bf78` | Patch compact correlation/claim fields. |
| `sys_script_include` | `DotwalkersIrePayloadService` | `9040783b930e8710410e383efaba10e7` | Validate unchanged prerequisite. |
| `sys_script_include` | `DotwalkersIreSimulationService` | `cf883837938e8710410e383efaba104e` | Patch in-place Phase D authority, claims, Execute, and Verify. |
| `sys_script_include` | `DotwalkersMaraAgent` | `7a36feeb2b86071060aefba6b891bfb4` | Patch deterministic continuation method. |
| `sysevent_script_action` | `Run Dotwalkers Mara` | `895b3eeb2bc6071060aefba6b891bfa1` | Patch prepared-to-Phase-D continuation. |
| `sys_ws_operation` | `ire_execute` | `5228b47d79f84099a3d1a4e5767cedf0` | Replace with status-only compatibility adapter. |
| `sys_ws_operation` | `ire_verify` | `9e9b5cd7f60c4201b4bbc648d64dc43d` | Replace with status-only compatibility adapter. |
| `sys_script_include` | `DotwalkersPhaseDTests` | `4b9cb8a893520750410e383efaba1092` | Installed test-only record. |
| `sys_script_include` | `DotwalkersPhaseCTests` | `2a2cc9589316cf10410e383efaba102f` | Validate unchanged at 48/48. |
| `sysevent_register` | `x_kest_dotwalkers.mara.requested` | `f51b36eb2bc6071060aefba6b891bf30` | GET-only validation; do not change. |

Do not create schema, choices, indexes, event registrations, REST resources, or
parallel runtime Script Includes.

## Installation And GET-Only Validation

Installation requires a later explicit gate. Then:

1. Patch the six existing Phase D script records above by exact sys_id,
   validate the payload-service prerequisite without changing it, and create
   only the test-only Phase D Script Include.
2. Run B3A 23/23, B3B exactly 41/41, Phase C 48/48, and Phase D 32/32.
3. Do not trigger approval, Mara, Execute, Verify, or CMDB writes during
   installation validation.

After installation, use GET only to confirm exact script hashes, active flags,
record sys_ids, unchanged event registrations/choices, and unchanged B3B test
source. Confirm the most recent lifecycle still stops at
`approval_resume_prepared`. Live action remains blocked until the four-value
confirmation above is repeated at action time.
