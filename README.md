# Keystone

Keystone is a governed ServiceNow CMDB migration control plane. It turns
staged infrastructure data into an evidence-backed migration run that can be
understood, prioritized, simulated, approved, executed through ServiceNow IRE,
and verified from the target CMDB.

The application is designed for both a guided operator demo and a bounded
autonomous workflow led by Mara. It can process large files in successive
batches; the 100-CI packet size is a governance boundary, not a migration-run
limit.

## What Keystone does

Keystone provides one operational view across the migration lifecycle:

```text
Source file or connector
        |
        v
ServiceNow quarantine and staging
        |
        v
Comprehend: classify, normalize, inspect identity and relationships
        |
        v
Prioritize: rank remaining health opportunity or operational risk
        |
        v
Remediate: simulate through IRE and group eligible records
        |
        v
Exact packet approval or bounded Mara autonomy
        |
        v
ServiceNow Phase D -> IRE create/update -> correlated read-back
        |
        v
Agent Workspace, Verify, and Past Summaries
```

Keystone never treats a staged operation as proof of a CMDB result. Inserted,
updated, and reconciled totals come only from correlated terminal ServiceNow
evidence.

## How existing CIs are handled

ServiceNow IRE determines the authoritative operation during non-mutating
simulation:

| IRE outcome | Keystone behavior | CMDB mutation |
|---|---|---:|
| No matching CI | Prepare an insertion candidate | Only after governed approval or eligible Mara autonomy |
| Existing CI with changes | Prepare an update candidate | Only after exact human approval |
| Existing CI already current | Read back and reconcile the target | None |
| Ambiguous, stale, unsupported, or failed | Block and preserve evidence | None |

An insertion packet requires explicit unmatched-identity evidence. If
ServiceNow reports an existing match, Keystone excludes the record from the
insertion scope. A generic HTTP 409 is therefore a conflict or stale-evidence
condition, not the expected response for an ordinary existing-CI match.

## Product surfaces

- **Import** lands data in ServiceNow quarantine/staging. It does not write to
  a CMDB target table.
- **Runs queue** switches between migration runs and their persisted state.
- **Agent Workspace** presents the end-to-end run story and correlated
  verification results.
- **Approvals** exposes governed decisions without moving write authority into
  the browser.
- **Comprehend** shows staged records, relationships, findings, agent activity,
  and recorded subagent handoffs.
- **Prioritize** ranks health opportunity below 100%. At 100%, recommendations
  are presented as risk reduction with “Maintain 100%,” never as impossible
  additional lift.
- **Remediate** plans campaigns, simulates every eligible group, prepares
  bounded packets, supports exact-hash approval, and monitors the IRE lifecycle.
- **Verify** and **Past Summaries** show only evidence-backed terminal outcomes,
  including the exact ServiceNow destination table.
- **AI Usage** reports sanitized model-call accounting from ServiceNow.

## Mara and the agent team

Mara is the migration supervisor. Router, Atlas, Scout, Weaver, and Sentry are
specialized reasoning agents whose actions and handoffs are reconstructed from
ServiceNow evidence.

- **Router** directs the next safe specialist step.
- **Atlas** evaluates class and attribute evidence.
- **Scout** investigates identity and duplicate signals.
- **Weaver** examines relationship evidence.
- **Sentry** applies deterministic confidence and policy gates.
- **Ledger** is shared audit memory, not a reasoning agent.
- **IRE** is the governed ServiceNow execution engine, not an agent.

Model execution belongs in ServiceNow Script Includes. The browser receives no
model-provider credentials, cannot manufacture authoritative payloads, and
cannot call CMDB tables directly.

## Manual and autonomous migration modes

Remediate starts in **Approval required** mode:

1. Plan the agent campaign.
2. Simulate all eligible groups. Simulation does not commit to the CMDB.
3. Plan and prepare a bounded approval packet.
4. Review and paste the complete fresh 64-character packet hash.
5. Authorize that exact packet in the UI.
6. Select **Commit N CIs to ServiceNow**.
7. Observe ServiceNow-owned Phase D execution and correlated verification.
8. Repeat with the next packet until the run is terminal.

With **Autonomous healthy CIs** enabled, **Start autonomous migration** asks
Mara to simulate, prepare, commit, monitor, and advance through successive
packets. Live autonomous mutation additionally requires:

```text
CMDB_MARA_AUTONOMOUS_COMMIT_ENABLED=true
```

Autonomy is deliberately narrow. Mara may commit only healthy, freshly
simulated, unmatched insertion candidates. Updates, ambiguity, stale evidence,
policy drift, failures, and blockers stop for human review. Records that need
no change are reconciled without a write.

## Batching and large migrations

Keystone separates run scale from approval scope:

- one child campaign contains at most 20 homogeneous records;
- simulation concurrency is capped at three within a group;
- one parent packet contains at most five children and 100 records;
- a 500-CI homogeneous run is processed as successive packets until all 500
  records have terminal evidence;
- mixed classes or operation-risk families are separated into their own
  packets;
- completed records are excluded when the next packet is planned.

Generated demo datasets must use a fresh identity namespace before an
insertion-oriented presentation. See
[Generated Dataset to ServiceNow Migration](docs/generated-demo-migration.md).

## Authority and safety boundaries

- ServiceNow owns migration state, class policy, authoritative payload rebuild,
  approvals, execution locks, IRE invocation, and verification.
- IRE is the only CI mutation path.
- Browser requests are identifier-only and never contain an executable CMDB
  payload.
- Planning, preparation, simulation, and exact-hash authorization are
  non-mutating.
- Manual packet authority is one-time, exact-hash, membership-bound, and
  expiry-bound.
- The packet route creates individual approvals but never invokes Execute or
  Verify.
- Phase D performs at most one IRE action and one correlated verification per
  approved CI.
- Ambiguous responses are reconciled from persisted evidence and are never
  blindly retried.
- No browser or Next.js route writes directly to `cmdb_ci*` or `cmdb_rel_ci`.

## Architecture

```text
Next.js 16 + React 19 browser UI
        |
        v
Server-only /api/cmdb compatibility and campaign routes
        |
        v
ServiceNow scoped application x_kest_dotwalkers
        |
        +-- migration_run
        +-- staged_ci_record
        +-- staged_relationship
        +-- finding
        +-- review_decision
        +-- event_ledger
        +-- ai_usage
        |
        v
ServiceNow IRE identification, create/update, and read-back verification
        |
        v
cmdb_ci subclasses
```

The application includes a demo fallback for UI development. A fallback
snapshot or local approval-packet fixture must never be described as a live
ServiceNow commit.

## Local setup

Requirements:

- Node.js 22.13 or newer
- npm
- optional ServiceNow bridge credentials for live data

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

For the repository’s established demo port:

```powershell
npm run dev -- -H 127.0.0.1 -p 3330
```

## Environment configuration

Use either a bearer token or basic authentication. All credentials remain on
the Next.js server.

```text
CMDB_API_BASE_URL=
CMDB_API_TOKEN=
CMDB_API_USERNAME=
CMDB_API_PASSWORD=

CMDB_IMPORT_URL=
CMDB_REMEDIATE_URL=
CMDB_IRE_BASE_URL=
CMDB_IRE_SIMULATE_URL=
CMDB_IRE_APPROVE_URL=
CMDB_IRE_EXECUTE_URL=
CMDB_IRE_VERIFY_URL=

CMDB_AGENT_BATCH_APPROVAL_ENABLED=false
CMDB_MARA_AUTONOMOUS_COMMIT_ENABLED=false
CMDB_AGENT_APPROVAL_PACKET_HASH=
```

The current UI issues its normal exact-hash authorization in-app. Keep the
legacy `CMDB_AGENT_APPROVAL_PACKET_HASH` empty unless a controlled compatibility
workflow explicitly requires it.

## Generated demo data

Create a fresh, complete namespace from a generated catalog:

```powershell
npm run fixtures:migration-demo -- `
  --input outputs/company-stress-fixtures/microsoft/microsoft-workflow.json `
  --namespace msft-demo-20260722-01 `
  --count 500 `
  --class cmdb_ci_linux_server
```

Inspect the staging request without sending it:

```powershell
npm run stage:migration-demo -- `
  --file outputs/servicenow-demo-imports/microsoft-workflow-msft-demo-20260722-01.json `
  --run-name DEMO-MSFT-500-20260722
```

The command sends only after the exact displayed file SHA-256 is supplied with
`--confirm-sha256`. Staging still cannot approve or execute IRE.

## Verification and development gates

Focused checks:

```powershell
npm run smoke:agent-workspace
npm run smoke:remediation-campaign
npm run smoke:approval-packet
npm run smoke:multi-packet-scale
npm run smoke:live-demo-readiness
npx tsc --noEmit --incremental false
npm run lint
npm run build
```

Terminal live-readiness verification performs two GET-only refreshes:

```powershell
npm run verify:live-demo -- --run <MIGRATION_RUN_SYS_ID>
```

For a known operation mix:

```powershell
npm run verify:live-demo -- `
  --run <MIGRATION_RUN_SYS_ID> `
  --expected-total 500 `
  --expect INSERT=500
```

Do not claim an all-insert result unless ServiceNow simulation and correlated
verification actually prove it.

## Current project status

The current implementation supports the full governed CI path from staging
through correlated ServiceNow verification, manual exact-hash packets,
successive packet processing, generic ServiceNow-accepted classes with
versioned simulation evidence, non-mutating existing-CI reconciliation, and
bounded Mara autonomy for healthy insertions.

The current live acceptance checkpoint remains evidence-bound and is not
automatically advanced by UI work. See [Current State](docs/current-state.md)
and the [Live Demo Runbook](docs/live-demo-runbook.md).

Major follow-on work includes editable attribute remediation, governed
relationship promotion, production-grade CSV parsing and pagination, broader
policy-driven update autonomy, and completing the active live run to its
terminal readiness target.

## Documentation map

- [Current State](docs/current-state.md)
- [Live Demo Runbook](docs/live-demo-runbook.md)
- [Generated Dataset Migration](docs/generated-demo-migration.md)
- [Agent Workspace Contract](docs/agent-workspace-contract.md)
- [Autonomous Agent Experience](docs/autonomous-agent-experience.md)
- [CMDB Bridge API](docs/cmdb-bridge-api.md)
- [IRE Flow](docs/ire-flow.md)
- [System Architecture](docs/system-architecture.md)
- [Lifecycle Acceptance Report](docs/lifecycle-acceptance-report.md)
- [Product Requirements and Roadmap](docs/keystone-agentic-cmdb-prd.md)
- [ServiceNow Runtime Integration](docs/servicenow-autonomous-runtime-integration.md)
