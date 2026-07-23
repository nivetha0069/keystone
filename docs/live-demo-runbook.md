# Keystone Live End-to-End Demo Runbook

## Purpose

This runbook is the authoritative same-day path for demonstrating a real
ServiceNow-backed migration. It is not the fixture-only
`demo:approval-packet` flow. A successful live demo must show persisted
ServiceNow evidence for staging, simulation, approval, Phase D execution, and
correlated verification.

ServiceNow remains authoritative. Keystone never writes directly to
`cmdb_ci*` or `cmdb_rel_ci`, the browser never submits an executable payload,
and the approval-packet route never calls Execute or Verify. Existing Phase D
owns one IRE execution and one correlated verification per approved CI.

For generated runs larger than the same-day 50-CI checkpoint, follow
`docs/generated-demo-migration.md`. A parent packet contains at most 100
records, but the run continues through newly prepared packets until every
staged CI has an evidence-backed terminal outcome.

## Current live checkpoint — 2026-07-22

Migration run `DMR0001066`
(`31b134742b96875060aefba6b891bfcb`) currently shows:

| Evidence-backed state | Count |
|---|---:|
| Staged `cmdb_ci_linux_server` INSERT candidates | 33 |
| Staged `cmdb_ci_server` INSERT candidates | 17 |
| Correlated ServiceNow verification passed | 20 |
| Verified INSERT target CIs | 20 |
| Awaiting review in Agent Workspace | 14 |
| Ready for simulation | 16 |
| Executing | 0 |
| Blocked | 0 |

A GET-backed `plan-packet` check currently selects the next homogeneous slice
of 13 simulated Linux-server INSERT records. Planning is read-only. Packet
approval is disarmed until the operator pastes the exact freshly prepared
64-character parent hash and selects `Authorize exact packet` in the UI.
Do not reuse an earlier hash: packet membership, fingerprints, and the
30-minute freshness boundary are part of the authorization.

The Agent Workspace `View completed results` control is presentation-only. It
truthfully presents the 20 verified records while leaving 30 records unchanged
in ServiceNow. It is not evidence that the full run completed.

## Preflight

Complete these checks before presenting:

1. Confirm `.env.local` points to the intended ServiceNow instance and contains
   only server-side credentials.
2. Confirm no packet is already authorized. The UI must show exact
   authorization as waiting until the operator reviews and confirms the fresh
   packet hash.
3. Start Keystone and open the intended run URL.
4. Confirm the header says `Live API`, shows run `DMR0001066`, and names the
   expected ServiceNow instance.
5. Refresh evidence and confirm there are no connectivity, authorization,
   configuration, or run-state errors.
6. Run the repository gates:

   ```text
   npm.cmd run smoke:agent-workspace
   npm.cmd run smoke:approval-packet
   npx tsc --noEmit --incremental false
   npm.cmd run lint
   npm.cmd run build
   ```

7. Keep the exact-hash authorization step separate from preparation. Never
   preauthorize a guessed or historical hash.

## Live demo sequence

### 1. Import and stage

- Import the chosen dataset into ServiceNow staging.
- Open the returned migration run.
- Explain that import targets quarantine/staging and performs no direct CMDB
  write.

### 2. Comprehend and prioritize

- Show the staged CI count, normalization, class and identity evidence,
  findings, and deterministic work groups.
- Show that current state reconstructs after refresh from ServiceNow resources
  and Event Ledger evidence.

### 3. Simulate eligible work

- In Remediate, use the bounded Agent Campaign flow for records that are ready
  to simulate.
- Simulation may run three-wide, but it remains non-mutating.
- Resolve only ServiceNow-accepted classes and allowlisted retry groups. Missing identity, unsupported classes,
  exhausted retry budgets, and ambiguous evidence remain blocked.
- A current simulation persists its proposed class, class-policy version,
  operation, target match, fingerprint, and correlation. A legacy generic
  simulation receives one fresh simulation before packet preparation.
- `NO_CHANGE` never enters a mutation packet. ServiceNow reads back the matched
  target; success is terminal without approval, Execute, or a CMDB write, and
  failed or ambiguous reconciliation is blocked.
- Continue until the intended homogeneous records have fresh completed
  simulations.

### 4. Plan and prepare one bounded packet

- Select `Plan packet`. Planning performs reads only.
- Review the homogeneous class and operation family, child manifests,
  exclusions, aggregate operation/risk counts, deterministic samples, and
  expiry.
- Select `Prepare packet`. Preparation may bind only missing deferred reviews;
  it does not approve, execute, verify, or initiate simulation.
- Copy the complete 64-character packet hash and note the expiry time.
- Stop here. Preparation is not authorization.

### 5. Obtain exact authorization

- The operator must explicitly authorize the exact displayed packet hash and
  stated record scope.
- Paste the complete uppercase hash into the packet confirmation field.
- Select `Authorize exact packet`. Keystone recomputes the packet server-side
  before creating a one-time capability bound to the exact run, packet ID,
  hash, membership, child manifests, fingerprints, operations, policy, and
  expiry. This action does not call IRE and does not execute or verify a CI.
- Confirm all three checklist items are green. If recomputation detects any
  change or expiration, stop and prepare a new packet.

### 6. Approve and observe Phase D

- Keep the complete packet hash in the confirmation field.
- Submit the single packet confirmation once.
- The one-time authorization is consumed as approval begins; no restart or
  manual gate cleanup is required.
- Keystone fans out individual approvals sequentially. ServiceNow still
  persists one auditable approval chain per CI.
- Continue after isolated record rejection. Stop on authorization,
  configuration, connectivity, or run-state failure.
- Never retry an ambiguous response blindly. Refresh and continue only when the
  exact persisted approval chain reconciles.
- Phase D, not the packet route, claims and performs each IRE execution and
  correlated verification.

### 7. Verify the real result

- Return to Agent Workspace and refresh evidence.
- Open Chapter 4, Verify.
- Show Mara's verification summary, verified operation counts, target CI count,
  class counts, blockers, and correlated ServiceNow read-back.
- Show baseline, verified-now, and projected health. When ServiceNow does not
  supply historical health fields, Keystone labels the progression as derived
  from staged CI health plus realized and remaining work-group lift.
- Repeat simulation, packet preparation, exact authorization, approval, and
  verification for additional homogeneous slices until the intended scope is
  terminal.

For `DMR0001066`, keep the scopes separate: process the current 13-record
`cmdb_ci_linux_server` packet first, clear its gate after terminal evidence,
then freshly simulate and prepare the 17-record `cmdb_ci_server` packet. Each
packet needs its own freshly displayed hash and separate authorization.

## Success criteria

A full 50-CI demonstration is complete only when live evidence reports:

- 50 verified records;
- 50 verified target CI bindings for this all-INSERT dataset;
- 0 awaiting approval;
- 0 ready to simulate;
- 0 executing;
- no unresolved blocker or reconciliation-required state; and
- two GET-only refreshes reconstruct the same terminal outcome and binding sets
  from ServiceNow evidence.

Run the terminal check only after all lifecycle work appears complete:

```text
npm.cmd run verify:live-demo -- --run 31b134742b96875060aefba6b891bfcb --expected-total 50 --expect INSERT=50
```

It fails on missing or duplicate terminal outcomes, approval or Phase D
correlation gaps, malformed targets, duplicate INSERT bindings, nonterminal
lifecycle work, or an unstable second refresh.

Healthy `NO_CHANGE` records in other datasets must be presented as reconciled
existing CIs, not as new inserts. Only verified `INSERT` and `UPDATE` outcomes
should be described as CMDB mutations.

## Stop conditions

Stop the live mutation path and preserve evidence when:

- the prepared packet is expired;
- the recomputed hash differs from the authorized hash;
- packet membership, identity evidence, operation, policy, or fingerprint
  drifts;
- ServiceNow authentication, role, connectivity, or run-state checks fail;
- an ambiguous response cannot be reconciled to the exact persisted chain; or
- the UI count disagrees with ServiceNow verification evidence.

The presentation-only completed-results view may still be used to explain the
verified subset, but it must disclose the number of deferred records and that
ServiceNow was not changed for them.

## Fixture fallback

If the live instance is unavailable, run `npm run demo:approval-packet`. That
isolated loopback fixture can demonstrate the 100-record packet UI and progress
reconstruction, but it must be introduced as a local fixture. It sends no
ServiceNow approval, Execute, Verify, or CMDB write.

## Truthful summary contract

Past Summaries and Chapter 4 derive `Inserted` and `Updated` only from an exact
approval-backed Phase D execution plus matching verification. `Reconciled`
requires `reconciliation_passed`. Awaiting approval, ready to simulate,
executing/verifying, blocked/failed, and remaining work remain separate.
