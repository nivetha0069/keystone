# CMDB Bridge API

Base path:

```text
/api/x_kest_dotwalkers/cmdb_bridge
```

The current Next.js compatibility routes proxy browser calls through `/api/cmdb/*` to this ServiceNow bridge. Preserve these routes while migration-run-specific APIs are introduced later.

## Endpoints

| Keystone route | ServiceNow route | Method | Current purpose |
|---|---|---:|---|
| `/api/cmdb/cis` | `/cis` | GET | Reads `x_kest_dotwalkers_staged_ci_record` and returns UI-shaped CI rows. |
| `/api/cmdb/timeline` | `/timeline` | GET | Reads `x_kest_dotwalkers_event_ledger` ordered by `sequence`. |
| `/api/cmdb/relationships` | `/relationships` | GET | Reads `x_kest_dotwalkers_staged_relationship`. |
| `/api/cmdb/health` | `/health` | GET | Aggregates staged records, staged relationships, and findings. |
| `/api/cmdb/import` | `/import` | POST | Creates a migration run and quarantined staged records. |
| `/api/cmdb/remediate` | `/remediate` | POST | Records an identifier-only proposal for one staged CI. Legacy fix/tool proposals remain compatible. It does not write to CMDB. |
| `/api/cmdb/ire/simulate` | `/ire/simulate` | POST | Requests non-mutating single-record IRE simulation. |
| `/api/cmdb/ire/approve` | `/ire/approve` | POST | Approves, rejects, or defers the single actionable remediation finding. |
| `/api/cmdb/ire/execute` | `/ire/execute` | POST | Requests approved single-record IRE execution by identifier only. |
| `/api/cmdb/ire/verify` | `/ire/verify` | POST | Verifies the CI returned by a specific execution correlation id. |

All read endpoints accept an optional `run` query parameter containing a `migration_run` sys_id.

The IRE action routes accept only identifiers and correlation metadata from the browser. Execute requests must not include target class, final operation, target CI, CMDB values, or an authoritative IRE payload. ServiceNow must rebuild and revalidate the payload from staged data and approval records before calling IRE.

## ServiceNow table usage

The lifecycle bridge uses the original six tables from `docs/servicenow-schema-inventory.md`:

- `x_kest_dotwalkers_migration_run`
- `x_kest_dotwalkers_staged_ci_record`
- `x_kest_dotwalkers_staged_relationship`
- `x_kest_dotwalkers_finding`
- `x_kest_dotwalkers_review_decision`
- `x_kest_dotwalkers_event_ledger`

The existing `x_kest_dotwalkers_ai_usage` table is the sole approved schema
exception and stores sanitized model-call accounting only.

The current bridge does not directly write to `cmdb_ci*` or `cmdb_rel_ci`.

## Choice-list constraints

These fields are backed by `sys_choice` records. Do not hardcode new values without adding the matching ServiceNow choices and updating consumers.

### `event_ledger.event_type`

Current choices:

- `ingested`
- `analyzed`
- `simulated`
- `approved`
- `committed`
- `error`

Current writers:

- `/import` writes `ingested`.
- `/remediate` writes `approved`.

Timeline step map:

```js
{ ingested: 1, analyzed: 3, simulated: 4, approved: 5, committed: 6, error: 7 }
```

Step 2 is intentionally unrepresented by the current taxonomy. The frontend fills missing playback stages as pending UI state; it does not require a new ServiceNow event type.

### `review_decision.decision`

Current choices:

- `approved`
- `rejected`
- `deferred`

`/remediate` writes `deferred` while the migration run moves to `awaiting_approval`.

### `finding.type`

Current choices:

- `duplicate`
- `missing_attribute`
- `orphan_rel`
- `class_mismatch`
- `data_quality`
- `summary`

`/health` excludes `summary` from the fixes list.

## Frontend normalization

`app/lib/cmdb/bridge-normalizers.ts` adapts current bridge quirks without changing ServiceNow scripts:

- `{ result: ... }` envelopes are unwrapped.
- CI `health` values of `ok`, `warning`, and `critical` map to numeric health scores.
- CI `confidence` of `0` remains unscored, and the UI displays it as pending.
- Health fix `impact` values of `high`, `medium`, and `low` map to numeric projected lift estimates.
- Fix descriptions are trimmed.
- Timeline event gaps are filled with pending playback rows so the existing seven-step UI remains stable.
- Timeline `failed` status maps to the frontend's `error` status.

## Known bridge limitations

- `/import` uses simple CSV splitting in the ServiceNow script. It is not safe for quoted commas, quoted newlines, or production CSV ingestion.
- `staged_ci_record.payload` is listed as `String(4000)` in the schema inventory. Verify practical truncation behavior before storing full row JSON for real staging.
- `/cis` currently returns `name` from `source_identifier`, so display names such as payload `name` may not appear unless the API adds a separate display field or includes payload-derived display data.
- `/relationships` falls back to `Depends on::Used by` when no `relationship_type` reference is set.
- `/health` is deterministic but coarse and currently uses only completeness, correctness, and compliance.
- The write endpoints hardcode `TEAM = 'THE_DOTWALKERS'`; treat this as simulated isolation for the hackathon slice.
- There is no pagination metadata yet, while `/cis`, `/relationships`, and `/timeline` use fixed limits.

## Milestone 4 IRE action contract

ServiceNow is authoritative for authentication, role checks, migration-run ownership, staged-record ownership, allowed classes, allowed attributes, approval state, idempotency, payload rebuild, IRE calls, and verification. `team_prefix` is only a partitioning attribute and must not be treated as authentication evidence.

Every IRE action receives:

```json
{
  "migration_run_id": "sys_id",
  "staged_ci_id": "sys_id",
  "correlation_id": "ks-action-...",
  "idempotency_key": "action:run:record:..."
}
```

Additional fields:

- `/ire/approve`: `decision`, `rationale`, optional `simulation_correlation_id`.
- `/ire/execute`: `simulation_correlation_id` only.
- `/ire/verify`: `execution_correlation_id` only.

The preferred `/remediate` contract contains `migration_run_id`,
`staged_ci_id`, optional `finding_id`, `correlation_id`, and
`idempotency_key`. Browser-supplied class names, mappings, CMDB values, and
payloads are discarded.

## Health progression

`/health` keeps the existing `score` field and may additionally return
`baseline_score`, `verified_score`, `projected_score`,
`dimension_scores`, and `work_group_impacts`.

Simulation affects readiness only. Realized health changes only after
verification tied to the exact execution correlation. Projected impacts are
deduplicated by staged CI and health dimension.

Simulation must generate a deterministic fingerprint from the authoritative staged record, update/version metadata, migration run, proposed class, normalized allowed attributes, source identity, and intended IRE operation/result classification. Execution must rebuild the payload and reject if the current fingerprint differs from the approved simulation fingerprint.

Approval must use one actionable `finding` for the staged CI remediation proposal. Repeated approval requests update or reuse the related `review_decision`; they must not create duplicate actionable findings for the same simulated remediation.

Verification must read back the target CI for the specific `execution_correlation_id`; it must not verify an older execution event for the same staged CI.

Derived state is reconstructed from `event_ledger`, the single actionable finding, and its review decision. No ServiceNow field or choice changes are required for the Milestone 4 state machine.

## Milestone 2 boundary

Milestone 2 should harden live event-ledger display and bridge contracts only. It should not begin CSV ingestion hardening, IRE execution, native agent execution, ServiceNow schema changes, or new ServiceNow choice creation.
