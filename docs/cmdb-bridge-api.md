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
| `/api/cmdb/ire/execute` | `/ire/execute` | POST | Identifier-only status compatibility for the server-owned Phase D execution continuation; it cannot start IRE. |
| `/api/cmdb/ire/verify` | `/ire/verify` | POST | Identifier-only status compatibility for the correlated server-owned verification continuation; it cannot start Verify. |
| `/api/cmdb/remediation-campaign/plan` | existing GET resources | POST | Builds a stable homogeneous, server-derived plan of at most 20 staged CIs. |
| `/api/cmdb/remediation-campaign/simulate` | `/ire/simulate` | POST | Simulates plan items with concurrency capped at three and isolates item failures. |
| `/api/cmdb/remediation-campaign/prepare-approval` | existing GET resources + `/remediate` | POST | Creates missing identifier-bound deferred-review proposals, reloads authoritative evidence, and freezes a SHA-256 manifest for eligible `INSERT`, `UPDATE`, and `NO_CHANGE` items. |
| `/api/cmdb/remediation-campaign/approve` | `/ire/approve` | POST | After the server-only safety gate is opened, recomputes the manifest and submits individual fingerprint-bound approvals sequentially. It never calls Execute or Verify. |
| `/api/cmdb/remediation-campaign/status` | existing GET resources | POST | Reconstructs campaign execution and verification progress from persisted ServiceNow evidence. |

All read endpoints accept an optional `run` query parameter containing a `migration_run` sys_id.

The IRE action routes accept only identifiers and correlation metadata from the browser. In Phase D, browser calls to Execute and Verify are status-only. The successful prepared-approval Script Action is the only execution initiator. ServiceNow rebuilds and revalidates the payload from the exact persisted approval chain before calling IRE, then verifies the server-returned target through the same continuation.

## Phase E campaign contract

Campaign requests accept only the migration run, work-group signature, campaign
ID, frozen manifest ID, staged-record IDs, and the bounded limit. Classes,
mappings, operations, payloads, and CMDB values are reread and derived on the
server. The coordinator deduplicates and deterministically orders the selected
group, enforces a 20-item maximum, and accepts only fresh successful `INSERT`,
`UPDATE`, or `NO_CHANGE` simulations with an actionable finding, deferred review,
canonical 64-character fingerprint, and no blocker.

`INSERT` is additionally governed by `bounded-insert-v1`: the authoritative
simulation must report no existing CMDB match, the proposed class must be
`cmdb_ci_linux_server`, and the staged record must be complete and healthy.
Browser requests cannot supply the operation, class, policy version, identity
evidence, source identity, payload, or CMDB values. INSERT manifests use the
v2 hash domain and freeze the policy version plus `ire_unmatched` evidence.

The approval manifest is SHA-256 over sorted staged CI, finding, review,
simulation correlation, fingerprint, and operation tuples. The approval route
recomputes it from current ServiceNow evidence and rejects drift. One UX
confirmation fans out into sequential calls to the existing individual
`/ire/approve` contract; the Phase D continuation remains the sole owner of IRE
Execute and correlated Verify. The grouped approval route is disabled unless
the server-only `CMDB_AGENT_BATCH_APPROVAL_ENABLED=true` gate is explicitly
opened for an authorized manifest.

Manifest preparation may create a missing deferred review through the existing
identifier-only `/remediate` proposal contract. It never approves the review or
calls IRE. Proposal calls use deterministic campaign idempotency keys; after any
ambiguous response the coordinator reloads ServiceNow evidence instead of
blindly retrying.

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
- `/ire/execute`: `simulation_correlation_id` only, for status lookup; it cannot invoke IRE.
- `/ire/verify`: `execution_correlation_id` only, for status lookup; it cannot initiate verification.

The `/remediate` contract contains exactly `migration_run_id`, `staged_ci_id`,
`finding_id`, `correlation_id`, `idempotency_key`,
`simulation_correlation_id`, and the canonical 64-character
`simulation_fingerprint`; the gateway appends server-owned `mode=proposal`.
Legacy `{fixId, tool}` and browser-supplied decisions, rationale, class names,
mappings, CMDB values, strategies, operations, and payloads are rejected.

ServiceNow rereads the latest completed simulation and authoritative payload,
then returns the deterministic `review_decision_id`. An exact retry reuses that
deferred review; it never creates another review or approval event.

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
