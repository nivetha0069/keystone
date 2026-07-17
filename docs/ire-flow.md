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

Before finalizing the Script Include, confirm the exact scoped APIs available in the target instance and release. Execution must use `sn_cmdb.IdentificationEngine.createOrUpdateCI(source, JSON.stringify(payload))` or an appropriate enhanced API only when the instance supports it and its options are needed.

## Match concepts

Contracts distinguish three concepts without adding ServiceNow fields in Milestone 1:

- `candidate_matched_ci`: a deterministic lookup candidate before IRE simulation.
- `simulation_matched_ci`: a CI identified by non-mutating simulation/identification.
- `executed_target_ci`: the CI returned and verified after approved IRE execution.

The current schema has only `staged_ci_record.matched_ci`. During early milestones, detailed transitions should be represented through compact `event_ledger` entries and the final ServiceNow implementation should avoid overloading that field without clear interpretation.

## Approval flow

Approval is represented through `finding` and `review_decision`:

- `finding` explains the issue, recommendation, or AI summary.
- `review_decision` records approve/reject/defer, reviewer, rationale, and policy approval.
- IRE execution must require an explicit human or policy approval for low-confidence or material changes.

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
