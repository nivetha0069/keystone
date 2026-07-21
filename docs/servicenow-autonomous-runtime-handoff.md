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

The Phase C baseline is installed and a fresh GET-only export matched all six
deployed sources. A corrective ledger-sequence and UI-freshness patch is now
source-controlled but is not yet redeployed. The installed Phase C test record
has sys_id `2a2cc9589316cf10410e383efaba102f`.

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
