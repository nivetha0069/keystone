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
- Extend the Mara Script Action and `DotwalkersMaraAgent` for one bounded
  Execute plus immediate exact-correlation Verify.
- Extend the existing health read path with persisted projected/verified data.

Preserve deployed role, run-linkage, identifier-only, idempotency, concurrency,
approval, and verification controls. Add no schema or Event Ledger choices,
keep `/api/cmdb/*` compatibility, and make no direct `cmdb_ci*` or
`cmdb_rel_ci` writes.

## Validation Gate

Current server-side status:

- Phase B3A: 23/23
- Phase B3B: 41/41

Local validation includes smoke, acceptance report mode, lint, TypeScript, and
build. It sends no Approve, Execute, Verify, or approval-triggering request.

Live validation begins only after this explicit confirmation:

**Approve staged CI `<sys_id>` at simulation fingerprint `<fingerprint>` and
allow its automatic single Execute plus Verify continuation.**
