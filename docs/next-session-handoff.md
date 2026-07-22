# Keystone Next-Session Handoff

## Current state

Milestones 5, 6, 7, and 8A are complete and live-accepted. Phase E supports deterministic,
homogeneous campaigns of at most 20 staged CIs, simulation concurrency of
three, isolated failures, one allowlisted class-alias retry, frozen SHA-256
approval manifests, sequential individual ServiceNow approvals, and automatic
Phase D Execute/Verify continuation. The v1 packet layer composes at most five
children and 100 records behind `CMDB_AGENT_APPROVAL_PACKET_HASH`. Browser
Execute and Verify routes are status-only. ServiceNow and IRE retain all write
authority.

The working contract and endpoint details are in `docs/cmdb-bridge-api.md`.
The product roadmap is in `docs/keystone-agentic-cmdb-prd.md`. Live evidence is
in `docs/lifecycle-acceptance-report.md`.

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
packet panel select `Plan packet`, `Prepare packet`, `Use exact demo hash`, and
`Approve 100 individual chains`. The panel progresses to 100 approved and 100
verified records without requiring a ServiceNow instance.

This command is an isolated fixture demonstration, not a live acceptance path.
It removes inherited `CMDB_*` variables from the child application, supplies
only loopback bridge URLs, preauthorizes only the generated fixture packet
hash, and marks the panel as demo mode. The fixture emulates individual
approval and Phase D ledger evidence; it does not reach ServiceNow or a CMDB.
The production exact-hash authorization and all ServiceNow/Phase D authority
boundaries remain unchanged.

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
