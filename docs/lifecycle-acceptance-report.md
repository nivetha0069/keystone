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
route exclusion. It also proves deterministic failure grouping, one eligible
class-alias group, one missing-identity blocker, exact `class-alias-v1` evidence,
sequential retry correlation/idempotency, and refusal after the one-retry budget
is exhausted.

Milestone 5, Milestone 6, and Milestone 7 are complete. The bounded campaign
loop is live-accepted for UPDATE/NO_CHANGE, bounded INSERT, and deterministic
failure handling. A one-item UPDATE campaign completed one
approval, one server-owned Execute, and one correlated Verify; IRE returned
`NO_CHANGE` and verification passed. A separate individually authorized unique
Cloudflare CI completed a real INSERT and correlated Verify into
`cmdb_ci_linux_server` target `aedcafacf416475096f1afc526d5d742`.

The bounded INSERT acceptance then planned and simulated five records from run
`065821a42b1e835060aefba6b891bf53`. All five returned authoritative unmatched
INSERT results and froze manifest
`DF250504D415F29F812520E483858B899AE791D4034909EFA5831F2706BE860C`
for campaign `E13502447BB1861877644F6B`, with zero exclusions. After explicit
authorization, the campaign submitted one individual approval per item; each
Phase D continuation performed at most one server-owned IRE INSERT and one
correlated Verify. All five verified against distinct `cmdb_ci_linux_server`
targets: `388d7b64e0d20b501135ca100a1c0a0e`,
`237db764e7d20b50a7a91805e5735765`,
`677db764b4d20b5041765485f0f4108f`,
`ab7db7643cd20b5086b23c13099755ba`, and
`277db764b1d20b5021e447f8414017ab`.

### Milestone 7 failure-loop acceptance repair

The first controlled live failure-loop run, `DMR0001064`
(`cdcdc8bc93d60b50410e383efaba105c`), staged exactly two records and performed
no approval, Execute, Verify, or CMDB write. It exposed two cross-layer defects:
Comprehend held the known `linux srv` alias at confidence 0 before IRE strategy
selection, while the identity-empty record reached IRE and collapsed to generic
`IRE_SIMULATION_FAILED`. The campaign endpoint consequently returned one
`unknown` blocked group and no retry-eligible alias group.

The repository repair makes known aliases an evidence-bound two-step protocol:
the first call persists `CLASS_ALIAS_RETRY_AVAILABLE`, an exact idempotency
replay remains blocked, and only a later server-generated retry key may consume
`normalize_known_class_alias` / `class-alias-v1`. A payload preflight now emits
`MISSING_IDENTITY` before confidence or IRE identification and does not count a
staging source identifier as CMDB identity. Live acceptance was rerun after
the updated payload and simulation Script Includes were deployed.

The post-deployment rerun passed on the same two-record run. Event Ledger
sequence 44 persisted `CLASS_ALIAS_RETRY_AVAILABLE` for staged CI
`c1cdccbc93d60b50410e383efaba10b2`; an exact idempotency replay returned the
same blocker without creating another ledger event. Sequence 45 persisted
`MISSING_IDENTITY` for staged CI `09cdccbc93d60b50410e383efaba10b3`.
Campaign `2FDDC906DE059210B4F13701` then consumed exactly one sequential alias
retry. Sequences 46–47 recorded simulation start and completion with
`normalize_known_class_alias`, mapping `class-alias-v1`, `retry_count=1`,
operation `INSERT`, and canonical fingerprint
`02C56D74BE1C7EDFEDB527BE33C316A31A2F6FD9CB4EACD8288D73DF9D547A9C`.
The missing-identity record remained isolated in a blocked group. No approval,
Execute, Verify, or CMDB write was performed.

## Milestone 8A Repository Build Status

Milestone 8A now adds a deterministic parent approval packet over at most five
existing 20-record Phase E manifests and 100 homogeneous records. The parent
SHA-256 binds the v2 policy, migration run, ordered child campaign/manifest
hashes, item counts, operation families, and a freshness boundary derived as
30 minutes after the oldest included completed simulation.

Planning is GET-backed and preparation may create only missing identifier-bound
deferred reviews through the existing proposal contract. Approval remains
locked unless the operator authorizes the exact recomputed parent hash through
the UI's separate one-time authorization action. Fan-out is sequential and individual, duplicate-safe packet
approvals are reconciled from Event Ledger evidence, and the packet route has
no Execute or Verify invocation. Phase D retains the only execution and
correlated verification authority.

Local smoke coverage proves the 100/5/20 bounds, deterministic hash and sample
selection, expiry, drift rejection, sequential approval, isolated failures,
systemic halt, ambiguous-outcome reconciliation, duplicate-click safety, and
refresh reconstruction.

### Live exact-hash acceptance

Live acceptance completed on 2026-07-22 for migration run
`e0ac4df32b82871060aefba6b891bf5b` and packet
`D0C641EADD8E04BAADC9EB04`. The operator explicitly authorized parent hash
`DC6E599FF11D13201A3F6F428D3E6C27DFF2120CD624E85F407F3E2570FAC89D`.
The packet contained one homogeneous `INSERT` for staged CI
`6cac4df32b82871060aefba6b891bf5c`; `web-prod-01` remained excluded because it
belonged to a different operation-risk family.

ServiceNow Event Ledger sequence 87 recorded the exact packet approval,
sequence 92 recorded server-owned `ire_execution_completed`, and sequence 94
recorded `verification_passed`. The IRE `INSERT` created target CI
`faab20b022de0b505a8cdde22cb29aac`. The packet route invoked neither Execute
nor Verify; existing Phase D performed both actions. Refresh reconstructed
`1 verified`, `0 blocked`, and `1 total` from ServiceNow evidence. The temporary
exact-hash gate was cleared immediately after terminal evidence was captured.

### Local demo acceptance (fixture only)

The timer-safe harness `npm run demo:approval-packet` was exercised through the
in-app browser on 2026-07-22. The real packet UI planned and froze 100 records
across five 20-record children, required the complete 64-character fixture
hash, submitted 100 sequential individual fixture approvals, and reconstructed
100 verified with zero blockers. Browser console errors were zero.

This is repository/demo evidence only. The launcher removes inherited
`CMDB_*` configuration and exposes only loopback fixture endpoints, so this run
sent no ServiceNow approval, Execute, Verify, or CMDB write. Live fan-out still
requires separate authorization naming the exact fresh production packet hash.

## Current Live Demo Progression — 2026-07-22

The current same-day demo run is ServiceNow migration run `DMR0001066`
(`31b134742b96875060aefba6b891bfcb`). This checkpoint is a progress report,
not terminal acceptance for all 50 records.

GET-backed Agent Workspace evidence currently reconstructs:

| State | Count |
|---|---:|
| Staged `cmdb_ci_linux_server` INSERT candidates | 33 |
| Staged `cmdb_ci_server` INSERT candidates | 17 |
| Correlated verification passed | 20 |
| Verified INSERT target bindings | 20 |
| Awaiting review | 14 |
| Ready to simulate | 16 |
| Executing | 0 |
| Blocked | 0 |

A read-only `plan-packet` request returned packet ID
`2B8E91AA395698EBF848A02E`, one 13-record homogeneous child, no deferred
members in that selected group, and `approval_enabled: false`. The remaining
records were not approved or mutated by that check. Packet approval still
requires a separately authorized exact fresh parent hash.

Agent Workspace Chapter 4 reports 20 verified ServiceNow read-backs, 20
INSERTs, 20 target CIs, and zero blockers. It also displays derived health
`85 -> 87.3 -> 96` with `+2.3` realized and `+8.7` remaining. This health
progression is explicitly labeled as derived from staged CI health plus
realized and remaining work-group lift; it is not represented as a historical
ServiceNow health series.

The presentation-only completed-results route was browser-validated. It shows
20 verified and 30 deferred while stating that ServiceNow was not changed for
the deferred records. It does not alter reviews or lifecycle evidence.

Terminal acceptance for the full dataset remains pending. It requires 50
verified target bindings, zero pending lifecycle work, and identical outcome
and binding sets after two GET-only refreshes. Past Summaries and Chapter 4 now
derive committed totals only from correlated terminal evidence. The intended
final composition is 33 verified Linux-server INSERTs and 17 verified generic-
server INSERTs; this paragraph does not claim that the remaining live work has
already executed.

Repository acceptance now covers `keystone.simulation.v2` class evidence,
generic ServiceNow-accepted classes, Phase D class revalidation, legacy generic
simulation refresh, class/policy/fingerprint drift rejection, non-mutating
`NO_CHANGE` reconciliation, and the GET-only `verify:live-demo` two-refresh
terminal gate. These are source-controlled test results, not evidence that the
new ServiceNow scripts have already been deployed to the live instance.

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

## Post-Acceptance Demo Readiness Update

Repository commits `f93be30` and `33e97c8` add the current presentation and
operator workflow without changing the recorded live acceptance totals:

- migration runs can continue through successive 100-record packets;
- manual exact-hash authorization is issued in the UI after server
  recomputation and requires no restart;
- every mutating control explicitly says it commits CIs to ServiceNow while
  simulation, planning, preparation, and authorization remain labeled as
  non-mutating;
- Agent Workspace, Past Summaries, and completed-group views expose the exact
  evidence-backed ServiceNow destination table;
- Mara can autonomously drain only healthy unmatched INSERT candidates when
  the live server capability is enabled;
- Comprehend presents Mara as supervisor, five reasoning subagents, recorded
  handoffs, Ledger as shared audit memory, and IRE as the execution engine;
- Prioritize and Remediate cap projected lift at 100% and use risk-reduction
  language when no health headroom remains; and
- the generated-dataset path materializes fresh namespaces for repeatable demos
  and preserves separate file-hash staging and packet-hash mutation authority.

Focused Agent Workspace, Remediation Campaign, TypeScript, lint, production
build, and browser checks passed after these changes. This repository
validation does not advance `DMR0001066`; only new correlated ServiceNow
evidence can change its live acceptance totals.
