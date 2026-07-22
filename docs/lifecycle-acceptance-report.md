# Autonomous Lifecycle Acceptance Report

Read-only report refreshed again on 2026-07-21 with:

```text
npm.cmd run acceptance:lifecycle:report
base: http://localhost:3001/api/cmdb
run: e0ac4df32b82871060aefba6b891bf5b
staged CI: 24ac4df32b82871060aefba6b891bf5c
```

No approval, Execute, Verify, or approval-triggering request was sent. The
harness fetched only `run`, `cis`, `timeline`, `findings`, `reviews`, `health`,
and `relationships` with GET.

| Check | Classification | Evidence |
|---|---|---|
| Read-only bridge access | STATIC PASS | Harness permits only the seven GET resources. |
| Automatic analysis evidence | FAIL | Analysis exists, but the historical Event Ledger sequence is still broken. |
| Deterministic work grouping | STATIC PASS | Three stable local groups reconstruct from live evidence. |
| Retry strategy and mapping version | FAIL | Deployed ledger has no `normalize_known_class_alias` plus mapping-version evidence. |
| One retry maximum | UNAVAILABLE | Deployed ledger exposes no retry counters. |
| Simulation fingerprint parity | FAIL | Six historical execution observations for the selected CI do not match the current canonical approval fingerprint. |
| Approval linkage | PASS | 23 approval events are backed by 5 findings and 5 review decisions. |
| Identifier-only approval contract | STATIC PASS | The Keystone route forwards only the exact eight binding identifiers/correlation fields and discards decision, rationale, operation, mapping, class, and payload data. |
| Identifier-only execution contract | STATIC PASS | The Keystone route discards class, values, and payload fields. |
| Exact execution-correlation verification | PASS | Three verification events match prior execution correlations. |
| Refresh reconstruction | STATIC PASS | Re-derivation from cloned GET evidence is identical. |
| Health attribution | UNAVAILABLE | The deployed health resource does not expose baseline, verified, or projected metrics. |
| Relationship readiness | PASS | 0/1 is ready using verified endpoint evidence only. |

The refreshed bridge counts were 2 CIs, 84 timeline events, 5 findings, 5
reviews, 1 relationship, and 3 deterministic work groups.

`STATIC PASS` proves a local contract or deterministic derivation. `PASS`
requires returned ServiceNow evidence. `UNAVAILABLE` means the resource lacks
the evidence needed to decide. `FAIL` means returned evidence violates or does
not satisfy the acceptance condition.

## Subsequent ServiceNow Validation

On 2026-07-21, the source-controlled Phase B3 simulation runtime was installed
in place and its server-side suites passed:

- `DotwalkersPhaseB3ATests`: 23/23
- `DotwalkersPhaseB3BTests`: 41/41

These tests cover deterministic class-alias selection, one retry maximum,
canonical fingerprints, identifier-only requests, structured blockers,
idempotent replay, compact Event Ledger evidence, and the thin `ire_simulate`
adapter. They invoked no live approval, Execute, Verify, event queue, or CMDB
write action. The table above remains the dated pre-Phase-B3 read-only baseline
until report mode is run again against refreshed lifecycle evidence.

## Phase C Installed Build Status

Phase C/C.1 was installed in place on 2026-07-21. The separate
`DotwalkersPhaseCTests.run()` suite passed 48/48 in ServiceNow;
`DotwalkersPhaseB3BTests.run()` remained byte-for-byte unchanged and passed
41/41. A fresh GET-only export then matched all six deployed Phase C source
records exactly. No live approval, event queue, Execute, Verify, or CMDB write
was sent.

The ledger-sequence correction was subsequently installed and verified: a new
simulation wrote started/completed sequences 64/65 and a GET-only reread found
the canonical 64-character fingerprint as the newest evidence. Phase C.1 then
bound that simulation to one deterministic deferred review through the existing
Record proposal path and was live-validated at 48/48. The prepared continuation
stops before Execute and Verify.

## Phase D Installed And Live-Validated Status

Phase D was installed on 2026-07-22. A post-install GET-only export returned
464 scoped records and 53 scripts with no unavailable tables and matched all 14
expected source records and settings. The live server-side gates passed B3A
23/23, B3B 41/41, Phase C 48/48, and Phase D 32/32.

After a separate four-value action-time authorization and final GET-only
freshness check, the server-owned continuation ran exactly once for staged CI
`24ac4df32b82871060aefba6b891bf5c`. It persisted:

- sequence 75, `ire_execution_claimed` (`ae2f810821219f2003778a902e1641cc`);
- sequence 76, `ire_execution_completed` (`9aa2865acbd61dfe4de94a48626070bc`);
- sequence 77, `ire_verification_claimed` (`fb004f38126b78c364af352ef2388ff2`);
- sequence 78, `verification_passed` (`c85513184138c3a8d9f084792895a1d9`).

IRE returned `NO_CHANGE` for target CI
`f41dd7bf168ec7109ae721961ee4da4f`; correlated verification passed with retry
count zero. A GET-only reread found 88 timeline events and confirmed the exact
approval, prepared-event, fingerprint, execution-event, target-CI, and
verification bindings. The broad acceptance report still flags older
pre-Phase-D ledger ordering and fingerprint mismatches; those historical
records do not conflict with the new sequences 75-78.

## Phase E Repository Build Status

Phase E implements the first Milestone 7 bulk-remediation loop without adding
ServiceNow schema or write APIs. The deterministic coordinator plans one stable
homogeneous group of at most 20 staged CIs, simulates with concurrency capped
at three, isolates record-level failures, and prepares fresh `INSERT`, `UPDATE`,
or `NO_CHANGE` evidence. A frozen SHA-256 manifest binds every staged CI to its finding,
deferred review, simulation correlation, canonical fingerprint, and operation.
`bounded-insert-v1` additionally requires an unmatched authoritative IRE
simulation, an allowlisted `cmdb_ci_linux_server` class, and a complete healthy
staged record. INSERT manifests freeze the policy and `ire_unmatched` evidence
in the v2 hash domain.

One UI confirmation is translated into sequential individual ServiceNow
approvals. The campaign route has no Execute or Verify invocation; Phase D owns
both operations and the UI reconstructs progress from Event Ledger evidence.
The local campaign smoke proves deterministic ordering and IDs, deduplication,
the 20-record cap, homogeneous selection, stable manifest hashing, concurrency
three, partial continuation, stale-manifest rejection, sequential approval,
duplicate-safe correlations, refresh reconstruction, and direct Execute/Verify
route exclusion.

Milestone 5 and Milestone 6 are complete. Milestone 7 is partially delivered
through this bounded campaign loop. A one-item UPDATE campaign completed one
approval, one server-owned Execute, and one correlated Verify; IRE returned
`NO_CHANGE` and verification passed. A separate individually authorized unique
Cloudflare CI completed a real INSERT and correlated Verify into
`cmdb_ci_linux_server` target `aedcafacf416475096f1afc526d5d742`.

The bounded INSERT acceptance then planned and simulated five records from run
`065821a42b1e835060aefba6b891bf53`. All five returned authoritative unmatched
INSERT results and froze manifest
`DF250504D415F29F812520E483858B899AE791D4034909EFA5831F2706BE860C`
for campaign `E13502447BB1861877644F6B`, with zero exclusions. No grouped INSERT
approval was sent and the server-only approval gate remained closed.

## CPR End-to-End Handoff Repair

A GET-only trace of stress run `065821a42b1e835060aefba6b891bf53`
showed successful Comprehend completion at Event Ledger sequence 18, followed
by no Mara or Prioritize evidence. The deployed shared Mara Script Action was
handling every event as a Phase D approval resume, so it rejected the normal
`comprehend_complete` token and left the run in `analyzing`.

The source-controlled repair restores explicit dual dispatch and adds a
completed-analysis recovery path. Agent Workspace now detects this evidence
gap, keeps Prioritize active instead of presenting Remediate as runnable, and
offers `Resume agents`. Recovery reuses persisted Comprehend evidence and must
not duplicate analysis or findings. The repair was installed in ServiceNow;
the stranded stress run resumed through Mara and Prioritize to
`awaiting_approval` without duplicate Comprehend analysis.
