# Autonomous Lifecycle Acceptance Report

Read-only report captured on 2026-07-20 with:

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
