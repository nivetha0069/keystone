# Keystone Repository Guide

Keystone is a Next.js control plane for governed ServiceNow CMDB migration.
ServiceNow owns workflow evidence and IRE remains the only CI write path.

## Architecture

- Next.js 16 App Router and React 19.
- Main UI: `app/cmdb-dashboard.tsx`.
- Shared CMDB logic: `app/lib/cmdb`.
- Server-only compatibility and campaign routes: `app/api/cmdb`.
- ServiceNow Scripted REST resources and Script Includes: `servicenow`.
- Current implementation status: `docs/current-state.md`.
- Live operator sequence: `docs/live-demo-runbook.md`.

## Non-negotiable authority boundaries

- Never add a generic ServiceNow or CMDB write proxy.
- Never write directly to `cmdb_ci*` or `cmdb_rel_ci`.
- Browser mutation requests remain identifier-only.
- ServiceNow rebuilds authoritative payloads and revalidates class, policy,
  approval, correlation, fingerprint, and execution locks.
- IRE is the only CI mutation path.
- Packet routes approve but never call Execute or Verify.
- Phase D owns execution and correlated verification.
- Do not count staged operations as committed outcomes.
- Do not store model-provider credentials, full prompts, full source rows, or
  executable IRE payloads in the browser or Event Ledger.

## Current batching model

- campaigns: at most 20 homogeneous records;
- simulation concurrency: three;
- parent packets: at most five children and 100 records;
- larger runs: successive packets until every staged record is terminal;
- manual approval: one-time exact fresh parent hash in the UI;
- Mara autonomy: healthy unmatched INSERT only, gated by
  `CMDB_MARA_AUTONOMOUS_COMMIT_ENABLED=true`;
- UPDATE: human exact-hash approval;
- NO_CHANGE: non-mutating ServiceNow-owned reconciliation.

## Agent model

Mara is the supervisor. Router, Atlas, Scout, Weaver, and Sentry are reasoning
subagents. Ledger is shared audit memory. IRE is the governed execution engine.
Authoritative model execution belongs in ServiceNow.

## Demo fallback

The frontend may use built-in fixture data when live resources are unavailable.
The local approval-packet demo may emulate lifecycle evidence. Neither may be
described as a live ServiceNow CMDB commit.

## Required checks

Run focused checks for the code changed and preserve:

```text
npm.cmd run smoke:agent-workspace
npm.cmd run smoke:remediation-campaign
npm.cmd run smoke:approval-packet
npm.cmd run smoke:multi-packet-scale
npm.cmd run smoke:live-demo-readiness
npx.cmd tsc --noEmit --incremental false
npm.cmd run lint
npm.cmd run build
```

ServiceNow changes must also preserve the Phase A, Phase B3A, Phase B3B,
Phase C, and Phase D smoke suites documented in the live runbook.
