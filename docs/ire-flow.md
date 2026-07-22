# IRE Flow

## Boundary

IRE authority stays inside ServiceNow. Keystone may preview, validate, and explain payload shape, but it must not independently decide or execute final CMDB operations.

`app/lib/cmdb/ire.ts` is limited to:

- TypeScript contracts
- payload-preview helpers
- local validation of required preview fields
- interfaces for future ServiceNow-backed calls

It must not call `sn_cmdb.IdentificationEngine`, store credentials, decide final authoritative operations, or write to CMDB tables.

## Authoritative payload construction

The external client must never be trusted to submit the final authoritative IRE payload. For simulation and execution, ServiceNow must rebuild or revalidate the payload from approved records in:

- `x_kest_dotwalkers_migration_run`
- `x_kest_dotwalkers_staged_ci_record`
- `x_kest_dotwalkers_finding`
- `x_kest_dotwalkers_review_decision`

The preview payload shown by Keystone is informational. ServiceNow remains responsible for final class validation, field allowlists, source values, data source selection, and IRE API invocation.

## Single-record first

The first executable vertical slice should support one staged CI record at a time:

1. Load one `staged_ci_record` within the user's `team_prefix` and migration run.
2. Validate source identity and proposed class.
3. Confirm any required finding/review decision.
4. Run identification simulation without modifying the CMDB.
5. Record compact lifecycle events in `event_ledger`.
6. Request approval if needed.
7. Execute approved records through IRE.
8. Parse the IRE result and read the CI back.
9. Record verification results.

Batch execution is deferred until single-record simulation, approval, execution, and verification are proven.

## Simulation versus execution

Simulation/identification must not modify the CMDB. It is not a fake boolean around execution.

The confirmed scoped server APIs are:

- Simulation: `sn_cmdb.IdentificationEngine.identifyCI(...)` or `identifyCIEnhanced(...)`.
- Execution: `sn_cmdb.IdentificationEngine.createOrUpdateCI(...)` or `createOrUpdateCIEnhanced(...)`.

Use the non-enhanced APIs by default. Use enhanced APIs only when the target instance supports them and enhanced options are intentionally needed.

The browser must never submit the final operation, target class, target CI, CMDB values, or authoritative IRE payload for execution. In Phase D, browser Execute and Verify requests are identifier-only status lookups; they cannot initiate either action. The successfully prepared Mara continuation rereads the exact persisted approval chain, rebuilds and revalidates the payload, performs one IRE commit, and verifies only the server-returned target.

## Simulation freshness, idempotency, and concurrency

Each simulation must generate a deterministic fingerprint from:

- staged record sys_id and update/version metadata
- migration run
- proposed class
- normalized allowed attributes
- source identity
- intended IRE operation or result classification

Execution must rebuild the same authoritative inputs and reject the request if the fingerprint no longer matches the approved simulation. Record compact fingerprint and correlation metadata in `event_ledger.detail` and/or the single actionable finding/review context.

All simulation, approval, execution, and verification requests must carry a correlation/idempotency identifier. ServiceNow must use those identifiers to make retries safe and to prevent duplicate execution caused by double-clicks or concurrent requests.

Verification must be tied to the specific execution correlation id. It must not verify an older execution for the same staged record.

## Match concepts

Contracts distinguish three concepts without adding ServiceNow fields in Milestone 1:

- `candidate_matched_ci`: a deterministic lookup candidate before IRE simulation.
- `simulation_matched_ci`: a CI identified by non-mutating simulation/identification.
- `executed_target_ci`: the CI returned and verified after approved IRE execution.

The current schema has only `staged_ci_record.matched_ci`. During early milestones, detailed transitions should be represented through compact `event_ledger` entries and the final ServiceNow implementation should avoid overloading that field without clear interpretation.

## Approval flow

Approval is represented through `finding` and `review_decision`:

- one actionable `finding` explains the proposed single-record remediation.
- `review_decision` records approve/reject/defer, reviewer, rationale, and policy approval.
- repeated approval requests reuse or update the related review decision and must not create duplicate actionable findings.
- IRE execution must require an explicit human or policy approval for low-confidence or material changes.

## Single-record lifecycle state machine

Authoritative sources:

- simulation result: latest valid ServiceNow simulation event and compact fingerprint for the staged CI
- approval: the single actionable finding plus its current review decision
- execution: ServiceNow IRE execution event tied to an execution correlation id
- verification: ServiceNow read-back result tied to the same execution correlation id
- playback: ordered `event_ledger` entries

Derived states, without adding fields:

- `not_simulated`
- `simulation_failed`
- `simulated_pending_approval`
- `approved_for_execution`
- `execution_rejected_stale_simulation`
- `executing`
- `executed_pending_verification`
- `verified`
- `verification_failed`

`team_prefix` is a partitioning attribute, not authentication evidence. ServiceNow must validate authenticated identity, roles, migration-run ownership, staged-record ownership, allowed classes, and allowed attributes before any simulation, approval, execution, or verification action.

## Relationship promotion

Relationships are processed after CI endpoint execution and verification:

1. Resolve parent and child staged records.
2. Confirm each endpoint has a verified production `cmdb_ci` result.
3. Validate source, normalized, and proposed relationship types.
4. Validate direction against `cmdb_rel_type` and business rules.
5. Promote in a separate governed ServiceNow phase.
6. Record result events.

Do not directly write to `cmdb_rel_ci` unless a later platform-specific review approves that approach. Prefer ServiceNow-supported relationship handling through IRE or governed application services.

## Event ledger detail

Use `event_ledger` for compact lifecycle events such as:

- `ire_simulation_started`
- `ire_simulation_completed`
- `review_requested`
- `review_approved`
- `ire_execution_started`
- `ire_execution_completed`
- `verification_passed`
- `verification_failed`

`detail` should contain small playback metadata, not full source rows, complete model responses, or large IRE payloads/results.

## Agent Integration Boundary

Milestone 4 exposes a deterministic remediation tool layer that a future Remediation Agent can orchestrate.

The endpoints must remain usable without an agent.

The future Remediation Agent may:

- request simulation;
- interpret simulation results;
- request approval;
- check approval;
- initiate approved execution;
- request verification.

The agent may not:

- construct the authoritative IRE payload;
- override validation;
- approve its own high-risk action;
- bypass the simulation fingerprint;
- write directly to CMDB tables.
