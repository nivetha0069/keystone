# ServiceNow Field-Gap Matrix

Source of truth: `docs/servicenow-schema-inventory.md`.

No ServiceNow table or field changes are approved in Milestone 1. This matrix classifies gaps against the current six-table schema and prefers documentation or application logic over new fields where safe.

## Classification legend

- Required now: needed for Milestone 1 contracts/docs or safe interpretation of existing data.
- Required before IRE execution: needed before Milestone 4 can execute a real approved record.
- Future enhancement: useful after the first vertical slice proves out.
- Unnecessary: should not be added for the initial vertical slice.

## `x_kest_dotwalkers_migration_run`

| Existing field | Current use | Intended need | Classification | Recommendation |
|---|---|---|---|---|
| `summary` | Human-readable run summary | Run name, source file summary, error summary | Required now | Use for compact run description only. Do not overload with large artifacts. |
| `initiated_by` | User reference | Requested by / actor attribution | Required now | Use as requester where available. |
| `source_system` | Source choice | CSV/JSON/source-family tracking | Required now | Use existing choices; map browser CSV imports to `csv`. |
| `started` | Run start timestamp | Lifecycle timing | Required now | Use as run start. |
| `completed` | Run completion timestamp | Lifecycle timing | Required now | Use when complete/failed. |
| `number` | Generated run number | Display identifier | Required now | Use as stable display id. |
| `team_prefix` | Logical tenant/team partition | Data isolation | Required now | Required in all API filters and writes. |
| `state` | Run lifecycle choice | CPR run state | Required now | Map app states to existing choices. Do not add choices yet. |
| Missing counts | Totals/ready/review/success/failed | Dashboard metrics | Future enhancement | Derive by querying child records/events first. |
| Missing health scores | Current/projected health | Prioritize UX | Future enhancement | Calculate deterministically in app/API until persistence is justified. |
| Missing correlation id | Traceability | Request tracing | Future enhancement | Store compact correlation id in event detail for now. |

## `x_kest_dotwalkers_staged_ci_record`

| Existing field | Current use | Intended need | Classification | Recommendation |
|---|---|---|---|---|
| `confidence` | Integer confidence | Classification/validation confidence | Required now | Normalize UI/API contracts to a 0-100 integer when persisting. |
| `proposed_class` | Proposed CMDB class string | Class mapping | Required now | Validate against allowed classes before IRE simulation/execution. |
| `source_identifier` | Source identifier, not globally unique | `source_name`, `source_native_key`, `source_record_id` | Required now | Use as best available stable native key/display identifier. Preserve detailed source identity in `payload` within size limits. |
| `identification_status` | Pending/match/new/conflict/rejected | Candidate identity state | Required now | Use for deterministic identification state, not final execution state. |
| `number` | Generated staged record number | Display identifier | Required now | Use as display id. |
| `migration_run` | Parent run | Run ownership | Required now | Required in all queries and writes. |
| `payload` | Quarantined source payload | Raw row JSON, normalized row JSON, source row number, parser version | Required now | Use only after verifying 4000-char practical limit. Do not use for full files. |
| `team_prefix` | Logical tenant/team partition | Data isolation | Required now | Required in all API filters and writes. |
| `matched_ci` | Existing CI reference from identification/simulation | Candidate/simulation/executed CI distinctions | Required before IRE execution | Keep one field for now. Contracts distinguish `candidate_matched_ci`, `simulation_matched_ci`, and `executed_target_ci`; do not add fields in Milestone 1. |
| Missing execution status | IRE execution lifecycle | Execution UI/filtering | Required before IRE execution | Derive from `event_ledger` and `review_decision` initially; add field only if query performance/workflow requires it. |
| Missing raw/normalized split fields | Audit and mapping display | Source-to-target mapping | Future enhancement | Prefer payload plus parser metadata until size/query needs justify fields. |

## `x_kest_dotwalkers_staged_relationship`

| Existing field | Current use | Intended need | Classification | Recommendation |
|---|---|---|---|---|
| `parent_ci` | Parent staged CI reference | Relationship endpoint | Required before IRE execution | Use only after endpoint staged CIs are verified as CMDB CIs. |
| `child_ci` | Child staged CI reference | Relationship endpoint | Required before IRE execution | Use only after endpoint staged CIs are verified as CMDB CIs. |
| `relationship_type` | Resolved `cmdb_rel_type` reference | Normalized/proposed relationship type | Required before IRE execution | Validate direction/type before promotion. |
| `migration_run` | Parent run | Run ownership | Required now | Required in all queries and writes. |
| `team_prefix` | Logical tenant/team partition | Data isolation | Required now | Required in all API filters and writes. |
| `status` | Relationship lifecycle | Pending/review/executed state | Required before IRE execution | Verify choices before Milestone 7. |
| Missing raw type strings | `source_relationship_type`, `normalized_relationship_type`, `proposed_relationship_type` | Explainability | Required before relationship promotion | Preserve in contracts and compact evidence, but do not add fields now. |
| Missing endpoint target CI refs | Final `cmdb_ci` references | Promotion/verification | Required before relationship promotion | Resolve through verified staged CI execution results; add fields only if needed later. |

## `x_kest_dotwalkers_finding`

| Existing field | Current use | Intended need | Classification | Recommendation |
|---|---|---|---|---|
| `severity` | Finding severity | Prioritization/display | Required now | Use existing choice values after verifying choices. |
| `recommendation` | Recommendation text | Finding/recommendation/AI summary body | Required now | Store concise recommendation or summary text only. |
| `type` | Finding type choice | `record_type` discriminator | Required now | Use existing `type` as record kind where choices allow. Prefer adding choices later over a new table. |
| `number` | Generated finding number | Display identifier | Required now | Use as display id. |
| `migration_run` | Parent run | Run ownership | Required now | Required in all queries and writes. |
| `team_prefix` | Logical tenant/team partition | Data isolation | Required now | Required in all API filters and writes. |
| `staged_ci` | Related staged CI | Record-specific finding | Required now | Use when finding applies to a single staged record. |
| Missing evidence field | Evidence list | Auditability | Required now | Keep evidence compact in `recommendation` or event metadata until fields are justified. |
| Missing agent metadata | Agent id/version/model | AI traceability | Future enhancement | Store essential metadata in compact event details initially. No `agent_trace` table. |

## `x_kest_dotwalkers_review_decision`

| Existing field | Current use | Intended need | Classification | Recommendation |
|---|---|---|---|---|
| `decision` | Approval/reject/defer | Human/policy gate | Required before IRE execution | Use as authoritative approval gate. |
| `finding` | Reviewed finding | Review context | Required before IRE execution | Tie approvals to a finding that explains the decision. |
| `rationale` | Reviewer rationale | Audit evidence | Required before IRE execution | Keep concise. |
| `decided_by` | User reference | Reviewer attribution | Required before IRE execution | Use for human approval. |
| `migration_run` | Parent run | Run ownership | Required now | Required in all queries and writes. |
| `team_prefix` | Logical tenant/team partition | Data isolation | Required now | Required in all API filters and writes. |
| `policy_approved` | Policy approval flag | Automated approval support | Required before IRE execution | Use only for explicit policy approvals. |

## `x_kest_dotwalkers_event_ledger`

| Existing field | Current use | Intended need | Classification | Recommendation |
|---|---|---|---|---|
| `actor` | User/API/agent/IRE label | Actor attribution | Required now | Use compact actor identifiers. |
| `sequence` | Ordering | Playback order | Required now | Order by sequence, then platform timestamp. |
| `migration_run` | Parent run | Run ownership | Required now | Required in all queries and writes. |
| `event_type` | Lifecycle event type | Playback/Sankey/audit | Required now | Use a controlled event taxonomy in application logic. |
| `team_prefix` | Logical tenant/team partition | Data isolation | Required now | Required in all API filters and writes. |
| `detail` | Compact event detail | Playback/audit metadata | Required now | Store only small lifecycle metadata. Do not store full CSV rows or full model responses. |
| Platform `sys_created_on` | Not listed as custom field | Event timestamp | Required now | Verify availability and use instead of adding a custom timestamp. |
| Missing status/error fields | IRE lifecycle display | Simulation/execution status | Required before IRE execution | Store compact status/error summaries in `detail` for now. |

## Deferred or unnecessary tables

| Proposed table | Classification | Recommendation |
|---|---|---|
| `migration_event` | Unnecessary | Existing `event_ledger` already satisfies the ledger role. |
| `recommendation` | Unnecessary now | Use `finding.type` and `finding.recommendation` until recommendation lifecycle requires separation. |
| `agent_trace` | Unnecessary now | Use compact finding/event metadata until model audit volume, token metrics, or trace replay require a dedicated table. |
