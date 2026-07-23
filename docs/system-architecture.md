# Keystone System Architecture

## Scope and source of truth

Keystone is an external CMDB migration control plane for the
Import -> Comprehend -> Prioritize -> Remediate -> Verify lifecycle. The
current ServiceNow schema source of truth is
`docs/servicenow-schema-inventory.md`. Current lifecycle, packet, autonomy, and
readiness behavior is summarized in `docs/current-state.md`.

Existing ServiceNow scope: `x_kest_dotwalkers`.

Existing tables:

- `x_kest_dotwalkers_migration_run`
- `x_kest_dotwalkers_staged_ci_record`
- `x_kest_dotwalkers_staged_relationship`
- `x_kest_dotwalkers_finding`
- `x_kest_dotwalkers_review_decision`
- `x_kest_dotwalkers_event_ledger`

The staging tables are the system of record for migration workflow state. The CMDB remains the system of record for production configuration items. Keystone must never write directly to `cmdb_ci` or `cmdb_rel_ci` from external application code.

`x_kest_dotwalkers_ai_usage` is the single approved schema extension and stores
sanitized model-call accounting.

## Runtime architecture

```text
Browser
  |
  | HTTPS
  v
Keystone Next.js application
  |
  | server-side API gateway
  | auth, identifier validation, compatibility routing, campaign coordination
  v
ServiceNow Scripted REST API and Script Includes
  |
  +--> migration_run
  +--> staged_ci_record
  +--> staged_relationship
  +--> finding
  +--> review_decision
  +--> event_ledger
  +--> ai_usage
  |
  v
ServiceNow IRE simulation / identification
  |
  v
Finding + review_decision approval gate
  |
  v
ServiceNow IRE execution
  |
  v
CMDB CI records and later governed relationships
```

Mara, Router, Atlas, Scout, Weaver, and Sentry run or are represented through
ServiceNow-owned agent evidence. Ledger is shared audit memory. IRE is the
execution engine. No model-provider credential or authoritative agent loop
belongs in the browser.

The existing `/api/cmdb/*` compatibility routes support read resources,
identifier-only lifecycle actions, campaigns, approval packets, autonomous
packet coordination, and the demo fallback. They are not generic ServiceNow
write proxies.

## CPR lifecycle mapping

### Comprehend

Comprehend shows how uploaded data moved through staging, validation, class proposal, identification, review, IRE lifecycle, and verification. It should be driven by `event_ledger` compact lifecycle events and staged records when live data is available. Demo data remains an intentional fallback until live APIs are proven reliable.

### Prioritize

Prioritize ranks work using deterministic application logic. Displayed health
lift is capped to the remaining 0-100 headroom and allocated in ranked order.
At 100%, recommendations remain visible as risk reduction with no numerical
lift claim. A `finding` record may represent a finding, recommendation, or AI
summary through its `type` and compact recommendation text.

### Remediate

Remediate simulates and coordinates governed actions without submitting an
authoritative final IRE payload. ServiceNow rebuilds and revalidates payloads
from staged and approved evidence. Campaigns contain at most 20 homogeneous
records; parent packets contain at most five children and 100 records. Larger
runs continue through successive packets.

Manual mode requires an in-app one-time authorization bound to the exact
freshly prepared parent hash. Autonomous mode may commit only healthy unmatched
insertion candidates when the server-only capability is enabled. Updates and
exceptions remain human-governed.

## ServiceNow orchestration boundary

ServiceNow orchestration is implemented in Script Includes and application
services called by Scripted REST resources. Avoid migration orchestration in
Business Rules so execution remains explicit, testable, replayable, and tied
to user or policy approval.

## Event ledger usage

`x_kest_dotwalkers_event_ledger` is the migration playback and audit ledger. Use it for compact lifecycle metadata:

- event type
- sequence
- actor
- migration run
- team prefix
- concise detail for playback, evidence pointer, correlation id, status, and small summaries

Do not store full CSV rows, complete source files, full model responses, or large business artifacts in `event_ledger.detail`.

## Relationship promotion

Relationship work is deferred until endpoint CIs have been executed and verified. The intended sequence is:

1. Stage CI records.
2. Simulate/identify one CI record.
3. Approve through finding/review decision.
4. Execute through IRE.
5. Verify the returned CMDB CI.
6. Resolve staged relationship endpoints to verified `cmdb_ci` references.
7. Validate relationship type and direction.
8. Promote relationships through a governed ServiceNow phase.

## Service Mapping boundary

Native Service Mapping implementation is deferred. Keystone may preserve application-service hints, entry-point candidates, ports, protocols, and dependency source strings in staging payloads or compact findings, but it must clearly distinguish inferred Keystone relationships from ServiceNow-discovered Service Maps.

## Milestone 0 findings

Repository state after reconciliation:

- Working repo: `C:\Users\alexn\Documents\Repos\Hackathon\keystone`
- Branch: `main`, fast-forwarded to `origin/main`
- Preserved untracked files: `AGENTS.md`, `docs/servicenow-schema-inventory.md`
- Dependencies installed with `npm.cmd ci`
- `npm.cmd run build` baseline: passed
- `npm.cmd run lint` baseline: failed before Milestone 1 edits with three existing errors:
  - `app/hr-view.tsx`: two `react/no-unescaped-entities` errors
  - `app/live-view.tsx`: one `react-hooks/purity` error for `Date.now()` during render
- Dependency audit after install: 4 vulnerabilities reported by npm, 1 low and 3 moderate

Storage-limit findings from the schema inventory:

- `staged_ci_record.payload` is listed as `String` length `4000`. This is not safe as a long-term store for complete source rows plus normalized row JSON if rows can be wide. Milestone 1 does not change the field type; Milestone 3 must verify practical instance behavior before real CSV staging.
- `event_ledger.detail` is listed as `String` with no length in the inventory. Treat it as compact lifecycle metadata only. Do not store full CSV rows, complete model responses, or large artifacts there. Milestone 2 should verify actual dictionary length/type before relying on it for playback detail.
