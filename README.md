# Keystone CMDB Modernization Control Plane

Keystone is a governed CMDB migration operations center for comprehending,
prioritizing, remediating, approving, and verifying ServiceNow migration runs.
ServiceNow remains the workflow and CMDB authority, and IRE remains the only CI
write path.

## Local development

```bash
npm install
copy .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

If the API variables are not configured, the dashboard automatically uses its built-in demo snapshot.

For a real ServiceNow-backed presentation, follow
[`docs/live-demo-runbook.md`](docs/live-demo-runbook.md). Do not present the
fixture fallback or the presentation-only completed-results view as a live
CMDB commit.

## Current live-demo checkpoint

As of 2026-07-22, run `DMR0001066`
(`31b134742b96875060aefba6b891bfcb`) has 20 correlated, verified ServiceNow
INSERTs from 33 staged Linux-server and 17 staged generic-server candidates.
Fourteen records await review and 16 remain ready for simulation. The next
read-only packet plan selects 13
homogeneous records. A full 50-CI claim is not valid until ServiceNow evidence
reports 50 verified targets and zero pending, ready, executing, blocked, or
reconciliation-required records.

The server-side packet hash gate is intentionally single-use. Leave
`CMDB_AGENT_APPROVAL_PACKET_HASH` empty until an operator separately authorizes
the exact freshly prepared packet hash.

Final validation is GET-only and compares two refreshes:

```bash
npm run verify:live-demo -- --run 31b134742b96875060aefba6b891bfcb --expected-total 50 --expect INSERT=50
```

## Fixture-only approval packet demo

```bash
npm run demo:approval-packet
```

This loopback fixture demonstrates the bounded-packet UI without reaching
ServiceNow. It must not be described as a live CMDB migration.

## API configuration

The upstream API base URL must expose:

- `/cis`
- `/timeline`
- `/relationships`
- `/health`

Set these server-side variables:

```text
CMDB_API_BASE_URL=https://your-api.example.com
CMDB_API_TOKEN=
CMDB_API_USERNAME=
CMDB_API_PASSWORD=
CMDB_REMEDIATE_URL=
CMDB_IMPORT_URL=
CMDB_IRE_BASE_URL=
CMDB_IRE_SIMULATE_URL=
CMDB_IRE_APPROVE_URL=
CMDB_IRE_EXECUTE_URL=
CMDB_IRE_VERIFY_URL=
CMDB_AGENT_APPROVAL_PACKET_HASH=
```

Use either a bearer token or basic authentication. These credentials are only read by Next.js server routes and are never sent to the browser.

`CMDB_IMPORT_URL` must point to a ServiceNow scripted REST endpoint that lands uploads and URL-connector requests in a custom staging/import table. The gateway always adds `target=staging`, `mode=quarantine`, and `directCmdbWrite=false`.

Generated stress fixtures should be materialized into a fresh identity namespace
before an INSERT-oriented demo. See
[`docs/generated-demo-migration.md`](docs/generated-demo-migration.md):

```text
npm.cmd run fixtures:migration-demo -- --input <catalog-data-file> --namespace <fresh-key> --count 500 --class cmdb_ci_linux_server
npm.cmd run stage:migration-demo -- --file <prepared-file>
```

The staging command is dry-run until the exact displayed file SHA-256 is
confirmed. Approval packets remain separately governed by freshly prepared
64-character hashes. The 100-record packet cap is per packet, not per run.

The optional `CMDB_IRE_*` variables point to ServiceNow scripted REST actions for single-record IRE simulation, approval, execution, and verification. If per-action URLs are omitted, Keystone uses `CMDB_IRE_BASE_URL/ire/{action}` or falls back to `CMDB_API_BASE_URL/ire/{action}`. Execution requests are identifier-only; ServiceNow remains responsible for rebuilding the authoritative payload, validating approval/fingerprint freshness, and calling IRE.

Mara's LLM runtime belongs in ServiceNow Script Includes. The browser does not receive provider credentials or call a model. It reads Mara's run-scoped Event Ledger and finding records through the existing CMDB bridge.

## Deploy to Vercel

1. Push the `frontend` directory to a Git repository.
2. Import the repository into Vercel.
3. If this repository contains other folders, set the Vercel Root Directory to `frontend`.
4. Add the `CMDB_*` variables under Project Settings → Environment Variables.
5. Deploy.

Vercel detects the project as Next.js and runs `npm run build`. No Cloudflare runtime or custom output directory is required.
