# ServiceNow Autonomous Runtime Handoff

The full scope export confirms that the deployed ServiceNow application already
contains the IRE resources, payload and simulation services, Mara event handoff,
Event Ledger writer, and health route. Keystone stores tested in-place patch
sources for those same records; it does not define a parallel runtime.

Use `docs/servicenow-autonomous-runtime-integration.md` for the in-place patch
list and `docs/lifecycle-acceptance-report.md` for acceptance classifications.

## Source-Controlled Records

- `servicenow/DotwalkersAgentEventDetailService.js`
- `servicenow/DotwalkersFailureStrategyService.js`
- `servicenow/DotwalkersAgentSupport.phase-a.js`
- `servicenow/DotwalkersIrePayloadService.phase-b3.js`
- `servicenow/DotwalkersIreSimulationService.phase-b3.js`
- `servicenow/ire_simulate.phase-b3.js`
- `servicenow/DotwalkersPhaseATests.phase-a.js`
- `servicenow/DotwalkersPhaseB3ATests.phase-b3.js`
- `servicenow/DotwalkersPhaseB3BTests.phase-b3.js`
- `servicenow/ire_approve.phase-c.js`
- `servicenow/remediate.phase-c.js`
- `servicenow/run_dotwalkers_mara.phase-c.js`
- `servicenow/DotwalkersMaraAgent.phase-c.js`
- `servicenow/DotwalkersPhaseCTests.phase-c.js`
- `servicenow/ire_execute.phase-d.js`
- `servicenow/ire_verify.phase-d.js`
- `servicenow/DotwalkersPhaseDTests.phase-d.js`

The first helper creates compact, allowlisted `AgentEventDetailV1` evidence. The
second owns deterministic work grouping, the single class-alias retry strategy,
mapping version, one-retry limit, reconstruction, and fingerprint material.
The helpers themselves write no records. The patched support and simulation
services continue using the existing authorized finding and Event Ledger paths;
simulation never commits a CMDB record.

## Patch Existing ServiceNow Records

- Wire compact detail into the existing `DotwalkersAgentSupport.log` path.
- Extend the existing `DotwalkersIrePayloadService`; retain confidence,
  reference-resolution, allowlist, and payload-building behavior.
- Make `DotwalkersIreSimulationService` the shared simulation/fingerprint
  authority for `ire_simulate` and `ire_execute`.
- Bind `ire_approve` to one staged CI plus fingerprint and queue the existing
  `x_kest_dotwalkers.mara.requested` event with a validated resume token.
- Extend the Mara Script Action and `DotwalkersMaraAgent` only through
  concurrency-safe token claim and preparation. Execute and Verify remain a
  later explicitly confirmed slice. Phase D now source-controls that slice but
  remains uninstalled and untriggered.
- Extend the existing health read path with persisted projected/verified data.

Preserve deployed role, run-linkage, identifier-only, idempotency, concurrency,
approval, and verification controls. Add no schema or Event Ledger choices,
keep `/api/cmdb/*` compatibility, and make no direct `cmdb_ci*` or
`cmdb_rel_ci` writes.

## Validation Gate

Current server-side status:

- Phase B3A: 23/23
- Phase B3B: 41/41
- Phase C/C.1: 48/48 live-validated
- Phase D: 32/32 locally in a separate test-only Script Include

The Phase C baseline and ledger-sequence correction are installed. A fresh
GET-only reread verified new simulation sequences 64/65 and the canonical
fingerprint. Phase C.1 adds the explicit deterministic deferred-review binding
and expands the same test record from 36 to 48 tests; it is installed and
live-validated. The test record sys_id is `2a2cc9589316cf10410e383efaba102f`.

Phase C.1 keeps Record proposal explicit. The existing `/remediate` resource
accepts only run, staged CI, finding, proposal correlation/idempotency, and the
current simulation correlation/fingerprint. It delegates to the existing
simulation service, which atomically creates one deferred review and one
compact `approval_review_deferred` marker before setting the run to
`awaiting_approval`.

Local validation includes smoke, acceptance report mode, lint, TypeScript, and
build. It sends no Approve, Execute, Verify, or approval-triggering request.

Live validation begins only after this explicit confirmation:

**Approve staged CI `<sys_id>` at simulation fingerprint `<fingerprint>` and
allow its automatic single Execute plus Verify continuation.**

## Recoverable Phase C Handoff

The approval request carries only run, staged CI, finding, review, correlation,
idempotency, simulation correlation, and canonical 64-hex fingerprint fields.
The server rereads all records, rebuilds the authoritative payload bundle,
reconstructs persisted strategy evidence, and recomputes the fingerprint
without `identifyCI`.

The deterministic `approval_recorded` Event Ledger `sys_id` is the atomic
approval claim. A queue failure records only `MARA_EVENT_QUEUE_FAILED`; an
exact retry uses a deterministic retry-claim record and never creates another
approval event. The Script Action rereads `parm2`, validates the complete
binding, atomically claims it, calls `prepareApprovalResume` once, records
prepared or sanitized terminal failure evidence, and stops.

```text
ire_simulation_completed
-> approval_recorded
-> approval_handoff_queued
-> x_kest_dotwalkers.mara.requested(parm1=run, parm2=approval_event)
-> approval_resume_claimed
-> prepareApprovalResume
-> approval_resume_prepared
-> STOP
```

## Phase D Build-Only Handoff

The fresh GET-only scope export on 2026-07-22 found the deployed `ire_execute`
still using a legacy 32-character fingerprint, browser-triggered execution,
query-then-insert concurrency, and raw IRE failure detail. The deployed
`ire_verify` was server-derived but interactive and non-atomic. Phase D replaces
those resources in place with status-only adapters and extends the existing
`DotwalkersIreSimulationService`; it creates no parallel runtime API or service.

The deterministic execution claim sys_id binds run, staged CI, approval event,
prepared event, simulation correlation, and canonical fingerprint. The claim is
inserted with `setNewGuidValue` before the single IRE call. A successful result
is the only source of target CI and operation. Completed exact replay returns
the persisted result; conflicting replay stops.

Retry rules are fixed before deployment:

- one pre-invocation execution retry through a deterministic retry claim;
- no automatic retry after IRE invocation begins or its result is ambiguous;
- one transient verification-read retry through a deterministic verification
  retry claim;
- no second Execute after verification transport failure or mismatch.

Expected later sequence:

```text
approval_resume_prepared
-> ire_execution_claimed
-> exactly one createOrUpdateCI
-> ire_execution_completed
-> ire_verification_claimed
-> verification_passed or verification_failed
-> STOP
```

Install nothing and trigger nothing until the action-time confirmation names:

- staged CI `24ac4df32b82871060aefba6b891bf5c`;
- fingerprint `8E080D7595B72AB11893B32EFDBEC60A215E0C33C47F83F0106384AB07CCE67D`;
- approval event `495c623d6523bb79b494287d0f0b51ed`;
- prepared event `1b43ac6e2e86d25abbb64faaad77ecf3`;
- and explicitly authorizes exactly one IRE Execute plus one correlated Verify.
