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
  later explicitly confirmed slice.
- Extend the existing health read path with persisted projected/verified data.

Preserve deployed role, run-linkage, identifier-only, idempotency, concurrency,
approval, and verification controls. Add no schema or Event Ledger choices,
keep `/api/cmdb/*` compatibility, and make no direct `cmdb_ci*` or
`cmdb_rel_ci` writes.

## Validation Gate

Current server-side status:

- Phase B3A: 23/23
- Phase B3B: 41/41
- Phase C: 36/36 in the separate test-only Script Include

The Phase C baseline and ledger-sequence correction are installed. A fresh
GET-only reread verified new simulation sequences 64/65 and the canonical
fingerprint. Phase C.1 adds the explicit deterministic deferred-review binding
and expands the same test record from 36 to 48 tests; that patch is not yet
installed. The test record sys_id is `2a2cc9589316cf10410e383efaba102f`.

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
