# Autonomous Lifecycle Acceptance Report

Read-only report refreshed on 2026-07-21 with:

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
| Automatic analysis evidence | FAIL | Analysis exists, but the historical Event Ledger sequence is broken. |
| Deterministic work grouping | STATIC PASS | Two stable local groups reconstruct from live evidence. |
| Retry strategy and mapping version | FAIL | Deployed ledger has no `normalize_known_class_alias` plus mapping-version evidence. |
| One retry maximum | UNAVAILABLE | Deployed ledger exposes no retry counters. |
| Simulation fingerprint parity | FAIL | The selected CI has missing or different simulation, approval, and execution fingerprints. |
| Approval linkage | PASS | 18 approval events are backed by 3 findings and 4 review decisions. |
| Identifier-only approval contract | STATIC PASS | The Keystone route forwards only the exact eight binding identifiers/correlation fields and discards decision, rationale, operation, mapping, class, and payload data. |
| Identifier-only execution contract | STATIC PASS | The Keystone route discards class, values, and payload fields. |
| Exact execution-correlation verification | PASS | Three verification events match prior execution correlations. |
| Refresh reconstruction | STATIC PASS | Re-derivation from cloned GET evidence is identical. |
| Health attribution | UNAVAILABLE | The deployed health resource does not expose baseline, verified, or projected metrics. |
| Relationship readiness | PASS | 0/1 is ready using verified endpoint evidence only. |

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

Phase C was installed in place on 2026-07-21. The separate
`DotwalkersPhaseCTests.run()` suite passed 36/36 in ServiceNow;
`DotwalkersPhaseB3BTests.run()` remained byte-for-byte unchanged and passed
41/41. A fresh GET-only export then matched all six deployed Phase C source
records exactly. No live approval, event queue, Execute, Verify, or CMDB write
was sent.

The ledger-sequence correction was subsequently installed and verified: a new
simulation wrote started/completed sequences 64/65 and a GET-only reread found
the canonical 64-character fingerprint as the newest evidence. Phase C.1 is
now source-controlled to bind that simulation to one deterministic deferred
review through the existing Record proposal path. Its expanded 48-test suite
and `/remediate` patch are build-only until the next deployment gate. Explicit
action-time confirmation remains required before recording the proposal or any
approval.
