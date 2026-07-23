# Keystone Next-Session Handoff

## Current state

Milestones 5, 6, 7, and 8A are complete and live-accepted. Phase E supports deterministic,
homogeneous campaigns of at most 20 staged CIs, simulation concurrency of
three, isolated failures, one allowlisted class-alias retry, frozen SHA-256
approval manifests, sequential individual ServiceNow approvals, and automatic
Phase D Execute/Verify continuation. The v2 packet layer composes at most five
children and 100 records behind a one-time, UI-initiated exact-hash capability
that the server issues only after recomputing the frozen packet. Browser
Execute and Verify routes are status-only. ServiceNow and IRE retain all write
authority. Versioned ServiceNow simulation evidence now binds the exact
server-derived class into generic mutation manifests, and Phase D revalidates
that evidence. Keystone does not mirror ServiceNow's generic-class allowlist.

The working contract and endpoint details are in `docs/cmdb-bridge-api.md`.
The product roadmap is in `docs/keystone-agentic-cmdb-prd.md`. Live evidence is
in `docs/lifecycle-acceptance-report.md`.

Recent commits `f93be30` and `33e97c8` complete the current demo story:
successive packets for runs larger than 100 records, in-app one-time exact-hash
authorization, explicit ServiceNow commit labeling and destination tables,
bounded Mara autonomy for healthy unmatched insertions, evidence-backed
subagent handoffs, and truthful maximum-health presentation. Past Summaries and
Chapter 4 derive Inserted, Updated, and Reconciled only from correlated
terminal evidence; staged operations never inflate committed totals.

The root `README.md` now describes the product, setup, architecture, manual and
autonomous flows, batching model, existing-CI behavior, and validation commands.
`docs/current-state.md` is the concise implementation/status index.

## Same-day live-demo checkpoint

The active live run is `DMR0001066`
(`31b134742b96875060aefba6b891bfcb`) with 33 staged
`cmdb_ci_linux_server` and 17 staged `cmdb_ci_server` INSERT candidates.
Current ServiceNow-backed Agent Workspace evidence reports:

- 20 correlated verifications passed;
- 20 verified INSERT target CIs;
- 14 records awaiting review;
- 16 records ready to simulate;
- 0 executing and 0 blocked; and
- derived health progression `85 -> 87.3 -> 96`, explicitly labeled as
  derived because the health endpoint does not report historical score fields.

A read-only `plan-packet` call currently selects the next homogeneous slice of
13 simulated INSERT records. `approval_enabled` is false until the exact fresh
packet hash is separately authorized through the server-only environment gate.
The remaining records have not been committed merely because the UI can show
completed results.

Follow `docs/live-demo-runbook.md` for the live sequence and stop conditions.
A truthful full-run claim requires 50 verified target bindings and zero
awaiting-review, ready-to-simulate, executing, blocked, or reconciliation-
required records after refresh.

The safe continuation is to prepare and stop on the fresh 13-record Linux
hash. After separate exact-hash authorization, reach 33 verified Linux INSERTs
and clear the gate. Then deploy the v2 simulation evidence, freshly simulate
all 17 generic-server records (including the one legacy simulation), prepare
and stop on the new 17-record hash, and require a second exact-hash
authorization. Neither slice is migrated until Phase D and correlated
verification complete.

Final acceptance uses two GET-only refreshes:

```text
npm.cmd run verify:live-demo -- --run 31b134742b96875060aefba6b891bfcb --expected-total 50 --expect INSERT=50
```

## Generated multi-packet demo path

The product-level run size is not limited to the 50-record same-day checkpoint
or the 100-record parent-packet bound. `docs/generated-demo-migration.md`
documents the priority path for materializing any generated company fixture
into a fresh, complete identity namespace and landing it in ServiceNow staging.
The staging CLI is dry-run until its exact file SHA-256 is confirmed and cannot
approve or execute IRE.

Repository scale acceptance proves that a 500-CI homogeneous run selects 100
records across five children, excludes those records after terminal evidence,
and then selects the next 100 while retaining the remaining 300. The
`verify:live-demo` command derives expected total from the staged run when
`--expected-total` is omitted; explicit operation mixes remain available for
controlled demonstrations.

## Current UI and operation behavior

- Remediate is ordered as Agent Campaign -> Bounded Approval Packet -> Ranked
  remediation focus -> staged CI lifecycle.
- Simulation, planning, preparation, and authorization are labeled as
  non-committing. `Commit N CIs to ServiceNow` is the mutation boundary.
- Manual exact-hash authorization occurs entirely in the UI. No restart or
  hardcoded hash is required for the normal flow.
- Mara's autonomous mode is armed per run in the UI and additionally requires
  `CMDB_MARA_AUTONOMOUS_COMMIT_ENABLED=true` for live mutation.
- Mara automatically handles only healthy unmatched INSERT candidates.
  UPDATE, ambiguity, stale evidence, drift, failure, and blocker states stop
  for human review. NO_CHANGE is reconciled without a mutation.
- IRE simulation finding an existing CI is not an expected HTTP 409. It should
  return UPDATE or NO_CHANGE evidence. A generic 409 represents a conflict or
  blocker that must be investigated.
- Prioritize and Remediate cap displayed lift to the remaining headroom. At
  100%, recommendations show `Health at maximum`, `Risk reduction`, and
  `Maintain 100%`.
- Comprehend presents Mara as supervisor, Router/Atlas/Scout/Weaver/Sentry as
  reasoning subagents, Ledger as shared audit memory, and IRE as the execution
  engine.

## Completed live acceptance

- Five distinct bounded INSERTs from run `065821a42b1e835060aefba6b891bf53`
  were individually approved, executed through server-owned Phase D, and
  correlated Verify passed for every target.
- Failure-loop run `DMR0001064`
  (`cdcdc8bc93d60b50410e383efaba105c`) proved the exact two-step alias contract.
- Event sequence 44 persisted `CLASS_ALIAS_RETRY_AVAILABLE` for staged CI
  `c1cdccbc93d60b50410e383efaba10b2`.
- Replaying the same idempotency key returned the same blocker without another
  ledger event.
- Event sequence 45 persisted `MISSING_IDENTITY` for staged CI
  `09cdccbc93d60b50410e383efaba10b3`.
- Campaign `2FDDC906DE059210B4F13701` consumed exactly one sequential retry using
  `normalize_known_class_alias` and `class-alias-v1`.
- Events 46–47 completed non-mutating INSERT simulation with `retry_count=1`
  and fingerprint
  `02C56D74BE1C7EDFEDB527BE33C316A31A2F6FD9CB4EACD8288D73DF9D547A9C`.
- The missing-identity CI remained blocked. That acceptance performed no
  approval, Execute, Verify, or CMDB write.
- Packet `D0C641EADD8E04BAADC9EB04` for run
  `e0ac4df32b82871060aefba6b891bf5b` was approved only after explicit human
  authorization of exact parent hash
  `DC6E599FF11D13201A3F6F428D3E6C27DFF2120CD624E85F407F3E2570FAC89D`.
- ServiceNow sequence 87 recorded the individual packet approval, sequence 92
  completed the server-owned IRE `INSERT`, and sequence 94 passed correlated
  verification for target CI `faab20b022de0b505a8cdde22cb29aac`.
- The packet route called neither Execute nor Verify, refresh reconstructed
  `1 verified / 0 blocked / 1 total`, and the exact-hash gate was cleared after
  terminal evidence was captured.

## Milestone 8A repository implementation

The immediate product problem is approval volume. A 2,000-CI run can produce
100 separate 20-record manifests, which is operationally safer than bulk IRE
but still requires too many confirmations.

The repository now implements a parent approval packet that:

1. Collects several fresh, frozen, homogeneous Phase E manifests.
2. Caps total membership at 100 records while retaining the
   20-record child-campaign limit.
3. Computes a canonical SHA-256 parent hash over versioned policy, run ID,
   ordered child manifest hashes, item counts, operation families, and expiry.
4. Shows aggregate operation/risk counts, blockers, exclusions, and sampled
   record evidence before confirmation.
5. Requires one explicit human confirmation naming the exact packet hash and
   scope.
6. Recomputes the packet and every child manifest immediately before fan-out.
7. Creates at most one individually auditable ServiceNow approval chain per CI.
8. Never calls Execute or Verify from the packet route; existing Phase D owns
   both actions and their correlation.
9. Halts on systemic failures, isolates record failures, and reconciles
   ambiguous outcomes from persisted evidence without blind retries.
10. Reconstructs all packet progress after refresh from ServiceNow evidence.

The AI may plan, group, prioritize, explain, simulate, and prepare this packet.
It must never approve the packet, approve individual records, call a
write-capable Execute endpoint, or directly write CMDB tables.

## Timer-safe local approval-packet demo

Run `npm run demo:approval-packet`, then open the printed localhost URL. In the
packet panel select `Plan packet`, `Prepare packet`, `Fill exact demo hash`,
`Authorize exact packet`, and `Approve 100 individual chains`. The panel
progresses to 100 approved and 100
verified records without requiring a ServiceNow instance.

This command is an isolated fixture demonstration, not a live acceptance path.
It removes inherited `CMDB_*` variables from the child application, supplies
only loopback bridge URLs, preauthorizes only the generated fixture packet
hash, and marks the panel as demo mode. The fixture emulates individual
approval and Phase D ledger evidence; it does not reach ServiceNow or a CMDB.
The production exact-hash authorization and all ServiceNow/Phase D authority
boundaries remain unchanged.

This fixture is the fallback presentation, not the preferred live demo. The
preferred same-day path is the active ServiceNow run described above.

## Completed live packet acceptance sequence

The live run followed the required sequence: GET-only planning, identifier-only
preparation, exact parent-hash review, explicit operator authorization, one
confirmation, ServiceNow-owned individual approval, Phase D Execute/Verify,
GET-only reconstruction, and immediate removal of the temporary hash gate.

## Required regression gates

Preserve Phase A 34/34, Phase B3A 23/23, Phase B3B 41/41, Phase C 48/48,
Phase D 32/32, campaign/queue/playback smoke suites, typecheck, lint, and the
production build. Do not add ServiceNow schema or a direct CMDB-write API by
default.
