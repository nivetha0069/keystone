# Keystone Current State

Last updated: 2026-07-22

## Product status

Keystone is demoable as a governed, end-to-end ServiceNow CI migration control
plane. The implemented path covers:

- quarantine/staging intake;
- ServiceNow-backed Comprehend evidence;
- deterministic findings, identity, class, relationship, and health views;
- ranked health opportunity below 100% and risk-reduction language at 100%;
- single-record and grouped non-mutating IRE simulation;
- homogeneous 20-record campaigns with simulation concurrency capped at three;
- parent approval packets of up to five children and 100 records;
- in-app, one-time authorization of the exact freshly prepared packet hash;
- sequential individual ServiceNow approvals;
- server-owned Phase D IRE execution and correlated verification;
- terminal summaries derived only from correlated outcomes;
- exact ServiceNow destination-table reporting;
- successive packet planning for runs larger than 100 records;
- versioned, ServiceNow-derived class evidence for generic accepted classes;
- non-mutating reconciliation for healthy existing CIs;
- bounded Mara autonomy for healthy unmatched insertion candidates; and
- a GET-only, two-refresh terminal readiness check.

The application does not yet provide an attribute editing/remediation studio.
It can identify and govern records that require remediation, but correcting
arbitrary staged attribute values remains follow-on work.

## User experience

The main navigation follows the migration story:

```text
Import -> Runs queue -> Agent Workspace -> Approvals
       -> Comprehend -> Prioritize -> Remediate -> Verify
```

Remediate presents:

1. the derived run queue;
2. Agent Campaign;
3. Bounded Approval Packet;
4. ranked remediation focus;
5. staged CIs and the IRE lifecycle.

Every action is labeled to distinguish non-mutating simulation and preparation
from the final ServiceNow CMDB commit boundary.

Prioritize and Remediate share one health-opportunity derivation. Numerical
lift is capped to the remaining headroom. At 100% health, recommendations
remain visible as risk-reduction work and show `Maintain 100%`.

## Mara migration modes

**Approval required** is the default. Mara may plan, simulate, reconcile
records that need no change, and prepare evidence. A human must authorize the
exact packet hash before a mutation.

**Autonomous healthy CIs** is enabled per run in the UI. With the server-only
`CMDB_MARA_AUTONOMOUS_COMMIT_ENABLED=true` capability, Mara can:

1. simulate every normally eligible group;
2. prepare the next healthy insertion packet;
3. start the ServiceNow approval/Phase D chains;
4. monitor correlated verification;
5. continue with the next packet; and
6. stop on an exception.

Autonomy excludes updates, ambiguous identity, stale evidence, class or policy
drift, failures, and blockers. Those conditions require human review.

## Agent model

Mara is the supervisor. Router, Atlas, Scout, Weaver, and Sentry are reasoning
subagents. Their activity and handoffs are evidence-backed through ServiceNow.
Ledger is shared audit memory, and IRE is the governed execution engine.

Model routing and credentials stay in ServiceNow. The frontend does not call an
LLM provider or store model secrets.

## Existing-CI behavior

An existing ServiceNow CI is not treated as an insertion failure:

- changed target -> approved `UPDATE`;
- already-current target -> non-mutating reconciliation;
- ambiguous or stale evidence -> blocked;
- unmatched identity -> insertion candidate.

Insertion approval requires a blank authoritative `simulation_matched_ci`.
Keystone excludes a staged insertion when ServiceNow simulation reports an
existing match.

## Scale behavior

The packet bound is not a run bound. A homogeneous 500-record run is drained
through five 100-record parent packets, each composed of five 20-record child
campaigns. Mixed classes and operation-risk families are separated. Every next
packet is rebuilt from fresh ServiceNow evidence so completed records are not
selected again.

Generated fixtures under `outputs/company-stress-fixtures` must be materialized
into a fresh namespace before an insertion-oriented demo. Staging requires the
exact generated file SHA-256 and remains non-mutating to the CMDB.

## Live evidence checkpoint

The last documented live checkpoint for `DMR0001066`
(`31b134742b96875060aefba6b891bfcb`) remains:

| Evidence-backed state | Count |
|---|---:|
| Staged CIs | 50 |
| Correlated verified insertions | 20 |
| Awaiting review | 14 |
| Ready to simulate | 16 |
| Executing | 0 |
| Blocked | 0 |

This checkpoint does not change when frontend code or documentation changes.
It must be refreshed from ServiceNow before a presentation. A full-run claim
requires 50 terminal target bindings and zero remaining lifecycle work.

## Recent implementation changes

- `f93be30` scaled and clarified the ServiceNow migration flow, including
  generated demo data, successive packets, in-app authorization, and clearer
  commit labeling.
- `33e97c8` added bounded autonomous migration controls, Mara’s subagent
  presentation, shared health-opportunity logic, and truthful maximum-health
  language.

## Last focused validation

The most recently run focused gates passed:

- Agent Workspace smoke;
- Remediation Campaign smoke;
- TypeScript;
- ESLint;
- production build; and
- live browser checks for Prioritize and Remediate with zero console errors.

Before a release or live mutation session, run the complete ServiceNow phase,
campaign, packet, playback, readiness, TypeScript, lint, and production build
suite documented in `docs/live-demo-runbook.md`.

## Remaining work

- Complete the active live run and pass the two-refresh readiness command.
- Add governed staged-attribute editing and re-simulation.
- Promote verified staged relationships through a separately governed phase.
- Harden production CSV parsing, pagination, and large-run API behavior.
- Expand autonomy only through explicit policy and approval design; updates
  remain human-approved today.
- Replace coarse health aggregation when richer authoritative ServiceNow health
  dimensions become available.

