# Keystone Agentic CMDB PRD

## Document Control

**Date:** 2026-07-19

**Last progression update:** 2026-07-22

**Purpose:** Central product requirements document for Keystone's agentic CMDB migration experience.

**Companion architecture document:** `docs/keystone-technical-stack.md`

**Non-negotiable rule:** ServiceNow remains authoritative for governed CMDB mutation; Keystone must not write directly to `cmdb_ci*` or `cmdb_rel_ci`.

## 1. Executive Summary

Keystone is an AI-powered CMDB migration operations center for teams moving imperfect source-system data into ServiceNow CMDB safely. It is for CMDB administrators, CMDB architects, migration consultants, data source owners, and governance approvers who need to understand, prepare, simulate, approve, execute, and verify CMDB migration work without relying on record-by-record manual review.

The product is not a generic dashboard, chatbot, ServiceNow Discovery replacement, or direct CMDB writer. The core product value is that Keystone performs meaningful migration work within controlled boundaries: it analyzes source data, normalizes records, identifies findings, groups and prioritizes repeated problems, prepares safe IRE-backed operations, pauses for meaningful approval, executes only through ServiceNow IRE, and verifies the real result.

The web application is central because it is where users observe and direct the work. It should feel like an AI engineering workspace for CMDB migration: an active work queue, visible tool calls, evidence-backed decisions, failure investigation, approval gates, and verification summaries. ServiceNow remains authoritative for persisted migration state, staged records, findings, review decisions, event ledger playback, identity, permissions, IRE payload rebuild, IRE simulation, execution, and verification.

Keystone becomes meaningfully agentic when the system can continue through safe, non-mutating work without constant user clicks, while preserving hard controls around production CMDB changes. The model may reason, summarize, group, and plan, but deterministic services and ServiceNow decide what is valid, authorized, approved, executable, and verified.

## 2. Current-State Assessment

### Implemented Capabilities

- The repository is a Next.js application with a single-page CMDB control surface in `app/cmdb-dashboard.tsx`.
- The application exposes Import, Runs Queue, Past Summaries, Agent Workspace, Approvals, Comprehend, Prioritize, Remediate, Verify, and AI Usage surfaces.
- The app can read ServiceNow bridge resources through compatibility routes in `app/api/cmdb/[resource]/route.ts` for `cis`, `timeline`, `relationships`, and `health`.
- The app can submit import payloads to the ServiceNow bridge through `POST /api/cmdb/import`, preserving the safety posture that imports target staging rather than direct CMDB writes.
- The app can submit identifier-only remediation proposals through `POST /api/cmdb/remediate`. That path may create or bind review evidence but is not an IRE execution path.
- Milestone 4 added a proxy route in `app/api/cmdb/ire/[action]/route.ts` for `simulate`, `approve`, `execute`, and `verify`.
- The IRE proxy is intentionally identifier-only. It forwards `migration_run_id`, `staged_ci_id`, correlation/idempotency metadata, and action-specific approval or correlation fields. It does not forward final class, operation, target CI, CMDB values, or authoritative IRE payloads.
- Server-side ServiceNow credentials are configured through `.env.example` and described in `README.md`. Credentials remain server-side.
- The CMDB contracts in `app/lib/cmdb/contracts.ts` model migration runs, staged CIs, staged relationships, findings, review decisions, event ledger entries, health, and remediation proposals.
- `app/lib/cmdb/ire.ts` defines TypeScript contracts and preview helpers for the single-record IRE flow. Execution previews are explicitly rejected by validation because the browser must not authorize or submit executable payloads.
- `app/lib/cmdb/import-staging.ts` provides browser-side parsing and preview normalization for CSV and JSON imports.
- `app/lib/cmdb/comprehend-adapter.ts` maps live ServiceNow bridge data into the UI's current CI, relationship, timeline, and health shapes.
- The Agent Workspace derives its queue, lifecycle chapters, Mara summaries, blockers, and verification outcomes from current ServiceNow resources and Event Ledger evidence.
- Phase E campaigns plan homogeneous groups of at most 20, simulate at concurrency three, freeze canonical manifests, isolate failures, and fan one confirmation into sequential individual ServiceNow approvals.
- Milestone 8A packets compose at most five existing child manifests and 100 homogeneous records behind an exact server-only parent-hash gate. Packet routes never call Execute or Verify.
- The current UI issues a one-time exact-hash capability after the operator
  pastes the freshly prepared parent hash and the server recomputes the packet.
  No restart or hardcoded hash is required for the normal manual flow.
- Runs larger than 100 records continue through successive packets. Repository
  acceptance covers a 500-CI run advancing through five 100-record packets.
- Mara can autonomously simulate and drain healthy unmatched INSERT candidates
  when the per-run UI mode and server-only
  `CMDB_MARA_AUTONOMOUS_COMMIT_ENABLED` capability are both enabled. UPDATE,
  ambiguity, stale evidence, failures, and blockers stop for human review.
- Versioned ServiceNow simulation evidence binds proposed class, class policy,
  operation, target match, correlation, and fingerprint into generic mutation
  manifests. Keystone does not maintain a competing generic-class allowlist.
- Healthy NO_CHANGE records use ServiceNow-owned non-mutating target read-back
  and become terminal without approval or Execute.
- Past Summaries and Agent Workspace operation totals derive only from
  correlated terminal verification or reconciliation evidence and show the
  exact ServiceNow destination table.
- Prioritize and Remediate share capped health-opportunity presentation. At
  100%, recommendations are labeled as risk reduction and `Maintain 100%`.
- Agent Workspace can present a verified subset while explicitly deferring remaining work. That presentation state is local, non-authoritative, and states that ServiceNow was not changed for deferred records.
- `docs/system-architecture.md`, `docs/servicenow-schema-inventory.md`, `docs/servicenow-field-gap-matrix.md`, `docs/cmdb-bridge-api.md`, `docs/ire-flow.md`, and `docs/agent-harness.md` establish the core architecture and governance boundaries.
- Git history shows recent milestones focused on real ServiceNow-backed event semantics and the single-record IRE proxy contract. The latest reviewed commit before this PRD work is `6a4a562 Add single-record IRE proxy contract`.

### Partial Capabilities

- Comprehend combines ServiceNow-backed staged outcomes, timeline events,
  findings, confidence, provenance, Mara supervision, specialist activity, and
  recorded handoffs. Some source adapters and fallback narratives remain
  presentation-oriented.
- Prioritize uses deterministic ranking and capped health-opportunity
  presentation. The underlying ServiceNow health aggregation remains coarse.
- Remediate provides single-record, campaign, packet, and bounded autonomous
  healthy-INSERT workflows. Attribute editing and broad policy-driven UPDATE
  autonomy remain open.
- The IRE control loop is wired to the browser workbench. Execute and Verify
  browser routes are status-only; the ServiceNow-owned Phase D continuation
  performs both operations.
- Source-controlled ServiceNow artifacts and project-owned Phase B3A, B3B, C,
  and D acceptance suites cover the deployed endpoint and continuation
  contracts.

### Mocked Capabilities

- Demo data remains in `app/cmdb-data.ts`, including mock CIs, timeline events, relationships, and health data.
- The dashboard still falls back to mock data when no run is selected or when configured ServiceNow resources are unavailable.
- Demo fallback agent activity remains non-authoritative and must be labeled as
  fixture data rather than live ServiceNow evidence.
- Some import source presets and demo starters are local UX helpers rather than live source-system integrations.
- The Sankey and graph experiences can use demo fallback data when live run data is unavailable.

### Missing Capabilities

- A general repository-owned provider-neutral model runtime is not implemented;
  authoritative model execution intentionally belongs in ServiceNow.
- A deterministic evidence-derived work queue and bounded ServiceNow Mara loop
  exist. Broader remediation strategies remain open.
- The frontend single-record IRE workbench supports simulation, approval, and automatic Execute/Verify monitoring.
- Deterministic failure grouping and a one-attempt class-alias retry loop now exist; broader strategies remain deferred.
- Relationship promotion remains deferred; endpoint CIs must be verified first.
- Project-owned smoke and acceptance harnesses cover campaign orchestration, work queues, playback, ServiceNow Phase C/D contracts, idempotency, stale fingerprints, and verification correlation; a conventional unit-test runner remains open.
- Source-controlled ServiceNow Script Includes, Scripted REST resources, Script Actions, and export tooling are present; deployment still requires controlled promotion into the instance.
- No durable observability layer exists for detailed agent traces outside compact ServiceNow event ledger metadata.

### Technical Debt

- `npm run test` maps to `npm run build`, so the project has build verification but no real test suite.
- The generic CMDB route in `app/api/cmdb/[resource]/route.ts` contains commented-out legacy URL construction and some rough indentation.
- There are two normalization paths: older bridge normalizers in `app/lib/cmdb/bridge-normalizers.ts` and newer Comprehend adapters in `app/lib/cmdb/comprehend-adapter.ts`. This is manageable now but should be consolidated or clearly scoped.
- ServiceNow bridge limitations documented in `docs/cmdb-bridge-api.md` remain important: simple CSV parsing in the ServiceNow import script, `payload` and `detail` string-size constraints, coarse health, no pagination, and hardcoded team assumptions in some write endpoints.
- Documentation must continue to distinguish persisted live agent handoffs from
  demo fallback activity.

### Documentation And Code Discrepancies

- The docs correctly define ServiceNow as authoritative, but the UI still presents some agent-oriented experiences from static and derived data.
- Past Summaries and Agent Workspace Chapter 4 now share correlated terminal
  outcome derivation; staged operations do not count as committed.
- ServiceNow's health endpoint does not expose historical baseline, verified, and projected fields for the active demo run. Agent Workspace therefore labels its health progression as derived rather than reported.
- `docs/agent-harness.md` remains the provider-neutral authority boundary; deterministic queue and ServiceNow Mara evidence exist, while a general repository-owned provider adapter remains deferred.

### Milestone Status

- Milestones 0-1: Mostly complete. Architecture, schema inventory, contracts, IRE design, field-gap analysis, and agent harness design exist. Build and lint are currently clean.
- Milestone 2: Partially complete. Import staging and ServiceNow-backed data views exist, with safe demo fallback. Full production-grade ingestion, pagination, and source fixtures remain incomplete.
- Milestone 3: Partially complete. Comprehend and Live Ops views consume ServiceNow-backed run data and event ledger information. Prioritize is still mostly a health/fix presentation layer rather than a complete hybrid deterministic and agentic prioritization layer.
- Milestone 4: Complete. The fingerprint-bound Phase D continuation is deployed and live-validated; Execute and Verify are server-owned, correlated, and exposed to the browser only as status compatibility routes.
- Milestone 5: Complete. The single-record workbench supports simulation, fingerprint-bound approval, automatic continuation monitoring, blockers, correlations, and verification results.
- Milestone 6: Complete. The deterministic work queue and playback state reconstruct from ServiceNow evidence after refresh.
- Milestone 7: Complete and live-accepted. Phase E adds stable homogeneous planning, three-wide simulation, deterministic failure groups, one allowlisted bounded retry, frozen manifests, and sequential individual approvals for campaigns of at most 20 CIs. Live acceptance proved one resolved class-alias retry and one isolated missing-identity blocker without approval, Execute, Verify, or a CMDB write.
- Milestone 8A: Complete and live-accepted. Bounded approval packets let one explicit human confirmation authorize an exact parent hash covering up to five already-frozen 20-record campaign manifests and 100 homogeneous records. ServiceNow still records and enforces one individual approval and one Phase D continuation per CI. Live acceptance proved one exact-hash `INSERT` through correlated verification with the packet route invoking neither Execute nor Verify. No model receives approval or write authority.
- Post-8A demo readiness: Complete in the repository. The UI supports in-app
  exact-hash capability issuance, successive packets beyond 100 records,
  explicit ServiceNow commit labeling and target-table summaries, bounded Mara
  healthy-INSERT autonomy, generic class-bound simulation evidence,
  non-mutating NO_CHANGE reconciliation, two-refresh readiness checks, and
  truthful maximum-health presentation. The active 50-CI live run remains
  nonterminal until ServiceNow evidence reaches the stated success criteria.

The active same-day demo run `DMR0001066` is in progress rather than terminal:
20 of 50 Linux-server INSERT candidates have correlated ServiceNow verification,
14 await review, and 16 remain ready to simulate. A read-only packet plan
currently selects the next homogeneous 13-record slice. Full-run acceptance is
pending 50 verified target bindings and zero remaining lifecycle work.

## 3. User Personas

### CMDB Administrator

Owns day-to-day CMDB integrity. Needs to know which proposed changes are safe, which require review, and whether execution actually changed the expected CI through IRE.

### CMDB Architect

Owns class model, identification strategy, relationship quality, and governance boundaries. Needs evidence for class choices, identifier strategies, relationship risk, and Service Mapping readiness.

### Migration Consultant

Runs migration projects for customers. Needs fast intake, repeatable staging, issue grouping, a clear demo narrative, and confidence that migration work is auditable.

### Data Source Owner

Understands the source system, column meanings, export quirks, and data ownership. Needs clear feedback about missing identifiers, malformed values, unsupported classes, and source-specific quality issues.

### Approver Or Governance Lead

Approves meaningful CMDB changes. Needs concise evidence, risk context, simulation result, fingerprint freshness, execution scope, and post-execution verification before accepting or rejecting an action.

## 4. User Problems

- Source exports are inconsistent, incomplete, and hard to inspect manually.
- Teams struggle to determine the right CMDB class for records from legacy or ambiguous source systems.
- Missing identifiers, malformed serials, duplicate hostnames, and conflicting IDs repeatedly cause IRE failures.
- Findings arrive as a long list, but users need systemic patterns and prioritized work.
- Users cannot easily tell which records are safe to simulate, which require approval, and which are blocked.
- Manual record-by-record remediation is slow and error-prone.
- Teams lack confidence that an AI recommendation is grounded in source evidence and ServiceNow validation.
- It is difficult to prove what an AI system did, which data it used, who approved it, and what changed in ServiceNow.
- Verification often becomes an afterthought, making it hard to confirm that execution matched the approved intent.

## 5. Product Principles

- ServiceNow is authoritative for persisted migration state, identity, permissions, payload rebuild, IRE calls, approvals, event playback, execution, and verification.
- Agents perform work, not just text generation.
- Human approval is used only at governance boundaries.
- Every agent action is observable and tied to a real event, tool call, deterministic operation, ServiceNow API result, or approved model output.
- Every execution is reproducible and auditable.
- The browser and LLM never submit authoritative IRE payloads.
- Non-mutating work should continue autonomously when it is inside configured policy.
- The product should reduce user decisions, not create more review work.
- `team_prefix` is a partitioning attribute only, never authentication evidence.
- CMDB mutations must go through ServiceNow IRE and never direct writes to `cmdb_ci*` or `cmdb_rel_ci`.
- Schema expansion is a last resort during the hackathon.

## 6. End-to-End User Journey

### Upload And Intake

The user selects an existing migration run or uploads a source dataset through the import view. The browser parses CSV or JSON for preview and sends a staging request to `/api/cmdb/import`. Keystone's server route forwards the request to the configured ServiceNow import bridge with server-side credentials.

Persisted records: `migration_run`, `staged_ci_record`, `staged_relationship`, and `event_ledger`.

Failure paths: invalid file type, oversized upload, malformed CSV/JSON, missing ServiceNow configuration, ServiceNow bridge rejection, or partial staging failure.

### Comprehend

The Comprehend layer inspects source rows, source identity, inferred classes, field quality, duplicate candidates, and relationship clues. Today this appears in the UI through ServiceNow-backed staged data and adapter-derived outcomes. The target behavior is autonomous analysis with compact event ledger playback.

Persisted records: staged CIs, staged relationships, findings, and event ledger entries.

Failure paths: unsupported classes, missing identity, malformed identifiers, unknown attributes, orphan relationships, and conflicting source values.

### Prioritize

Deterministic scoring should calculate hard signals such as severity, identifier completeness, confidence, relationship impact, IRE blocking status, and approval requirement. The Prioritize agent then groups repeated issues, explains ordering, and selects the next safe work.

Persisted records: findings, review decisions where applicable, and event ledger entries.

Failure paths: insufficient evidence, ambiguous grouping, missing risk context, or blocked dependency records.

### Remediate And Simulate

The Remediation layer selects eligible staged CIs, asks ServiceNow to rebuild the authoritative operation, and invokes non-mutating IRE simulation through `/api/cmdb/ire/simulate`. The browser sends identifiers and correlation metadata only.

Persisted records: latest valid simulation event, compact simulation fingerprint, actionable finding, and event ledger entries.

Failure paths: missing approval context, invalid class, disallowed attribute, stale staged data, failed IRE simulation, missing identity, duplicate candidate, or ServiceNow role failure.

### Failure Investigation And Retry

When simulations fail, the Remediation agent groups similar failures and investigates likely root causes. It may select only explicitly allowed alternative strategies, such as using a stronger allowed identifier. It must request deterministic backend rebuild and ServiceNow revalidation before re-simulation.

Persisted records: event ledger entries and updated or related findings. Detailed reasoning should live outside compact ServiceNow event detail unless a schema expansion is explicitly approved.

Failure paths: no allowed retry strategy, low confidence, protected service impact, or repeated failure after retry.

### Approval

When governance approval is required, Keystone presents one actionable finding and its simulation evidence. Approval calls `/api/cmdb/ire/approve`, which must create or update a single related `review_decision` rather than creating duplicate findings for repeated approval requests.

Persisted records: one actionable finding, current review decision, simulation fingerprint, correlation metadata, and event ledger entry.

Failure paths: unauthorized approver, stale simulation, duplicate idempotency key, rejected decision, or insufficient rationale.

### Execution

Execution calls `/api/cmdb/ire/execute` with identifiers and correlation metadata only. ServiceNow reloads the staged record, rebuilds the authoritative payload, revalidates permissions, checks approval, checks the approved simulation fingerprint, enforces idempotency and execution locks, and calls `sn_cmdb.IdentificationEngine.createOrUpdateCI(...)` or the approved enhanced equivalent.

Persisted records: execution event tied to the execution correlation ID and compact result metadata.

Failure paths: missing approval, stale fingerprint, duplicate execution, concurrent execution, ServiceNow IRE error, disallowed class or attribute, or missing role.

### Verification

Verification calls `/api/cmdb/ire/verify` with the execution correlation ID. ServiceNow ties verification to the specific execution, reads back the CI, compares expected and actual class and identifiers, records discrepancies, and returns a verification result.

Persisted records: verification event tied to the execution correlation ID.

Failure paths: wrong execution correlation, missing execution, target CI not found, class mismatch, identifier mismatch, or ambiguous read-back.

## 7. Functional Requirements

### Ingestion And Staging

- `FR-ING-001`: Keystone must accept CSV and JSON source data for staging preview.
- `FR-ING-002`: Keystone must preserve original source values and source provenance.
- `FR-ING-003`: Keystone must route imports to ServiceNow staging and must not write directly to production CMDB tables.
- `FR-ING-004`: Keystone must expose the returned migration run identifier and make the run selectable.
- `FR-ING-005`: Keystone must show partial import failures without discarding successfully staged records.
- `FR-ING-006`: Keystone must clearly distinguish browser preview parsing from authoritative ServiceNow staging.

### Comprehend

- `FR-COM-001`: Keystone must inspect staged records and identify proposed CMDB classes.
- `FR-COM-002`: Keystone must preserve confidence, evidence, and source field provenance for class and field decisions.
- `FR-COM-003`: Keystone must detect missing identifiers, malformed values, duplicates, class mismatches, orphan relationships, and unsupported classes.
- `FR-COM-004`: Keystone must record user-readable lifecycle events for meaningful analysis steps.
- `FR-COM-005`: Comprehend outputs must map into existing `staged_ci_record`, `staged_relationship`, `finding`, and `event_ledger` records.
- `FR-COM-006`: The Comprehend agent must not write directly to production CMDB tables.

### Prioritize

- `FR-PRI-001`: Keystone must calculate deterministic priority signals before agent explanation.
- `FR-PRI-002`: Keystone must group related findings into systemic patterns.
- `FR-PRI-003`: Keystone must identify whether each work item is simulation-ready, blocked, approval-required, or deferred.
- `FR-PRI-004`: Keystone must not let model confidence override deterministic severity or policy.
- `FR-PRI-005`: Keystone must continue using `finding` and `review_decision` unless a concrete schema limitation is proven.

### Remediate

- `FR-REM-001`: Keystone must provide a constrained remediation tool layer for staged CIs and findings.
- `FR-REM-002`: The Remediation agent may request previews, simulation, approval, execution, verification, and event recording.
- `FR-REM-003`: The Remediation agent must never receive a generic CMDB write tool.
- `FR-REM-004`: Retry strategies must be selected only from explicitly allowed alternatives.
- `FR-REM-005`: Low-confidence, ambiguous, protected, or policy-breaking actions must pause for human review.
- `FR-REM-006`: The agent must summarize what changed and what remains unresolved after each verified execution.

### IRE Control Loop

- `FR-IRE-001`: Keystone must support single-staged-CI simulation through `/api/cmdb/ire/simulate`.
- `FR-IRE-002`: Keystone must support approval through `/api/cmdb/ire/approve`.
- `FR-IRE-003`: Keystone must support execution through `/api/cmdb/ire/execute`.
- `FR-IRE-004`: Keystone must support verification through `/api/cmdb/ire/verify`.
- `FR-IRE-005`: Browser execute requests must be identifier-only and must not include final operation, target class, target CI, CMDB values, or authoritative payload.
- `FR-IRE-006`: ServiceNow must rebuild the payload for simulation and execution from authoritative staged data.
- `FR-IRE-007`: ServiceNow must generate a deterministic simulation fingerprint from staged record identity and version metadata, migration run, proposed class, normalized allowed attributes, source identity, and intended operation or result classification.
- `FR-IRE-008`: Execution must reject stale approvals when the rebuilt fingerprint does not match the approved simulation fingerprint.
- `FR-IRE-009`: Simulation, approval, execution, and verification must use correlation and idempotency metadata.
- `FR-IRE-010`: Execution must prevent duplicate or concurrent commits for the same staged CI.
- `FR-IRE-011`: Verification must be tied to the specific execution correlation ID.

### Approval

- `FR-GOV-001`: Approval must apply to one actionable finding and one simulated operation.
- `FR-GOV-002`: Repeated approval requests must not create duplicate findings.
- `FR-GOV-003`: Approval must capture decision, rationale, actor, correlation ID, and simulation fingerprint.
- `FR-GOV-004`: Rejection and deferral must be visible in the work queue and activity playback.

### Verification

- `FR-VER-001`: Verification must read back the resulting CI from ServiceNow.
- `FR-VER-002`: Verification must compare expected and actual class, key identifiers, and operation result.
- `FR-VER-003`: Verification must record discrepancies clearly and attach them to the execution correlation ID.
- `FR-VER-004`: Keystone must not mark work as verified based on an older or unrelated execution.

### Agent Work Queue

- `FR-WQ-001`: Keystone must expose an agent-owned work queue derived from existing records and event ledger entries.
- `FR-WQ-002`: The work queue must show running, queued, completed, failed, blocked, approval-required, and verified items.
- `FR-WQ-003`: The work queue must identify the owning layer or agent for each item.
- `FR-WQ-004`: Safe non-mutating work may progress without user interaction.
- `FR-WQ-005`: Work queue states must be derivable without new ServiceNow fields during the hackathon.

### Activity Playback

- `FR-UI-001`: Keystone must translate event ledger entries into user-readable agent activity.
- `FR-UI-002`: Keystone must distinguish reasoning, tool execution, ServiceNow calls, IRE simulation, approval, execution, verification, retry, failure, and completion.
- `FR-UI-003`: Keystone must not fabricate progress with timers or fake statuses for an active run.
- `FR-UI-004`: Every visible activity must correspond to a real event, deterministic operation, tool call, ServiceNow result, or labeled planned demo fixture.

### Provenance

- `FR-PROV-001`: Keystone must preserve source row, source system, source identity, normalized values, proposed class, and evidence.
- `FR-PROV-002`: Keystone must show enough provenance for an approver to understand why an action is proposed.
- `FR-PROV-003`: Keystone must keep full payload dumps out of compact ServiceNow event detail.

### Error Handling

- `FR-ERR-001`: Keystone must show missing configuration errors without falling into misleading live states.
- `FR-ERR-002`: Keystone must surface ServiceNow bridge errors with action, status, and retry guidance.
- `FR-ERR-003`: Keystone must separate partial data availability from total run failure.
- `FR-ERR-004`: Keystone must make stale fingerprint, duplicate idempotency, missing approval, and wrong verification correlation understandable to users.

### Demo Fallback

- `FR-FBK-001`: Keystone may retain demo fallback for local development and presentations.
- `FR-FBK-002`: Demo fallback must be visually distinguishable from a live ServiceNow run.
- `FR-FBK-003`: Agentic demo events must be backed by real code paths or clearly labeled as fixture-driven.

## 8. Agent Tool Contracts

The agent tool layer should be deterministic, typed, and usable without an agent. Browser UI, scripts, and a future Remediation Agent should call the same tools.

### Read Tools

`getMigrationRun`

- Input authority: migration run identifier supplied by user selection or queue context.
- Output shape: run metadata, state, source label, counts, and access decision.
- Guardrails: ServiceNow validates role and ownership.

`getStagedCi`

- Input authority: migration run identifier and staged CI identifier.
- Output shape: staged CI summary, source identity, proposed class, allowed normalized attributes, current findings, and latest lifecycle state.
- Guardrails: ServiceNow validates run membership and attribute visibility.

`getFindings`

- Input authority: migration run identifier, optional staged CI identifier, filters.
- Output shape: findings, severity, confidence, evidence, review decisions, related staged records.
- Guardrails: no invented findings; derived grouping must reference persisted findings.

`getRelationships`

- Input authority: migration run identifier.
- Output shape: staged and matched relationship graph, endpoint states, risk hints.
- Guardrails: inferred source relationships must not be presented as Service Mapping-discovered runtime dependencies.

`getEligibleWork`

- Input authority: migration run identifier and optional policy profile.
- Output shape: ordered work items with derived state, blockers, suggested next tool, and approval requirement.
- Guardrails: deterministic eligibility rules take precedence over model ranking.

### Preview And Simulation Tools

`buildIreOperationPreview`

- Input authority: staged CI identifier and migration run identifier.
- Output shape: non-authoritative preview of class, identifiers, allowed attributes, blockers, and intended operation classification.
- Guardrails: preview is informational only; it is not executable authority.

`simulateStagedCi`

- Input authority: staged CI identifier, migration run identifier, correlation ID, idempotency key.
- Output shape: simulation status, result classification, candidate match, actionable finding reference, compact fingerprint reference, and event reference.
- Guardrails: ServiceNow rebuilds payload, validates roles/classes/attributes, calls non-mutating IRE, and stores compact metadata.

`inspectSimulationFailure`

- Input authority: simulation correlation ID, staged CI identifier, migration run identifier.
- Output shape: failure category, evidence, related failures, allowed retry options.
- Guardrails: may not invent unsupported retry strategies.

### Approval Tools

`requestApproval`

- Input authority: staged CI identifier, migration run identifier, finding identifier, simulation correlation ID, decision request metadata.
- Output shape: current review decision, approval status, rationale, actor, and event reference.
- Guardrails: one actionable finding; no duplicate findings for repeated approval requests; agent cannot approve its own high-risk action.

`checkApproval`

- Input authority: staged CI identifier, migration run identifier, finding identifier, simulation correlation ID.
- Output shape: approval state, actor, decision timestamp, fingerprint match status.
- Guardrails: ServiceNow is authoritative for review decision.

### Execute And Verify Tools

`executeApprovedCi`

- Input authority: staged CI identifier, migration run identifier, simulation correlation ID, execution correlation ID, idempotency key.
- Output shape: execution status, target CI reference, operation classification, event reference, and next verification action.
- Guardrails: identifier-only request; ServiceNow rebuilds payload, validates approval and fingerprint freshness, enforces idempotency and execution locks, and calls IRE.

`verifyExecutedCi`

- Input authority: staged CI identifier, migration run identifier, execution correlation ID, verification correlation ID, idempotency key.
- Output shape: verification status, matched CI, class check, identifier check, discrepancies, event reference.
- Guardrails: verification must tie to the specific execution correlation ID.

### Event Tool

`recordAgentEvent`

- Input authority: migration run identifier, staged CI or finding reference, compact event type, actor, summary, and correlation ID.
- Output shape: event ledger entry.
- Guardrails: compact metadata only; no full prompts, full payloads, credentials, or large source rows.

## 9. State Model

The work-item lifecycle should be derived from existing records and events rather than new fields.

| State | Derived From |
| --- | --- |
| `queued` | Staged record exists and no analysis event has started. |
| `analyzing` | Recent Comprehend event indicates active analysis. |
| `normalized` | Staged CI has normalized payload and class proposal. |
| `finding_generated` | One or more findings exist for the staged CI. |
| `prioritized` | Finding has deterministic priority metadata or appears in health/fix output. |
| `eligible_for_simulation` | Required identifiers, class, and allowed attributes are present. |
| `simulating` | Simulation event with active correlation exists without terminal result. |
| `simulation_passed` | Latest valid simulation event succeeded and produced a fingerprint. |
| `simulation_failed` | Latest simulation event failed or returned blocking errors. |
| `investigating` | Failure inspection or retry analysis event exists. |
| `awaiting_approval` | Actionable finding exists and no approving review decision exists. |
| `approved` | Current review decision approves the latest valid simulation fingerprint. |
| `executing` | Execution event started for the execution correlation ID. |
| `committed` | Execution event reports IRE commit success. |
| `verifying` | Verification event started for the execution correlation ID. |
| `verified` | Verification event tied to the execution correlation ID succeeded. |
| `blocked` | Latest event or finding indicates no allowed next action. |
| `rejected` | Current review decision is rejected or deferred. |

Milestone 4's single-record lifecycle states remain a subset of this model: `not_simulated`, `simulation_failed`, `simulated_pending_approval`, `approved_for_execution`, `execution_rejected_stale_simulation`, `executing`, `executed_pending_verification`, `verified`, and `verification_failed`.

Authoritative sources:

- Simulation result: latest valid ServiceNow simulation event and compact fingerprint for the staged CI.
- Approval: single actionable finding plus current `review_decision`.
- Execution: ServiceNow IRE execution event tied to an execution correlation ID.
- Verification: ServiceNow read-back result tied to the same execution correlation ID.
- Playback: ordered `event_ledger` entries.

## 10. UX Requirements

The web application should show an active migration workspace, not a collection of static metric cards.

- Active agent: show which layer is currently working, what it is doing, and what tool or ServiceNow endpoint it is using.
- Current task: show the selected staged CI or finding, the next action, blockers, and evidence.
- Queued tasks: show ordered upcoming work with eligibility and approval requirements.
- Completed tasks: show simulation, approval, execution, and verification outcomes.
- Tool usage: show concise tool call names, correlation IDs, and status, with details available on demand.
- IRE simulation: show non-mutating result, candidate match, confidence, blockers, and fingerprint freshness status.
- Failure investigation: group repeated failures and explain the shared cause and allowed retry options.
- Retry: show what changed in the proposed strategy, why it is allowed, and the new simulation result.
- Approval requests: present the actionable finding, source evidence, simulation result, risk level, and decision controls.
- Execution: show that ServiceNow rebuilt and executed the operation through IRE, not through a browser-submitted payload.
- Verification: show the read-back result and whether it matched the approved operation.
- Post-action summary: explain what changed, what remains unresolved, and what the agent will do next.

Visible activity must be grounded. Demo fixtures are acceptable only when clearly separated from live run behavior.

## 11. Trust And Safety Requirements

- ServiceNow must validate authenticated identity, scoped roles, migration-run ownership, staged-record ownership, allowed classes, allowed attributes, approval state, and idempotency.
- `team_prefix` must be used for partitioning and filtering only.
- Credentials must remain server-side and out of browser payloads.
- Authorization headers and secrets must be redacted from logs.
- The integration account should use least-privileged scoped roles.
- Browser execute requests must remain identifier-only.
- ServiceNow must rebuild authoritative payloads for simulation and execution.
- Simulation fingerprints must protect execution freshness.
- Duplicate idempotency keys must return prior results or safe rejections.
- Concurrent execution must be rejected or locked server-side.
- Low-confidence, ambiguous, protected, or policy-breaking operations must require human approval or remain blocked.
- Agents must not approve their own high-risk actions.
- Event ledger entries must support audit and playback without storing full prompts, full model responses, full source rows, full IRE payloads, or credentials.

## 12. Non-Functional Requirements

- Latency: UI interactions should respond immediately with pending states; ServiceNow-backed operations should show progress and correlation IDs.
- Resilience: partial ServiceNow resource failures should degrade visibly without replacing live runs with misleading demo data.
- Traceability: each important step must have a correlation ID and event trail.
- Structured output: agent and deterministic service outputs must use typed fields rather than free-form text as authority.
- Provider fallback: the agent harness should support model-provider substitution without changing the ServiceNow authority boundary.
- Safe retries: retries must be idempotent and bounded by allowed strategies.
- Partial failure handling: batch or queue work must continue safe items while isolating failed or blocked items.
- UI responsiveness: the workbench must remain usable during polling and long-running operations.
- Deterministic recovery: after refresh, Keystone must derive current state from ServiceNow records and events.
- Compatibility: existing `/api/cmdb/*` routes must keep working while the IRE routes are added.

## 13. Success Metrics

- Percent of uploaded records analyzed without user interaction.
- Percent of staged CIs with source provenance preserved.
- Percent of findings grouped into systemic patterns.
- Percent of staged CIs automatically classified with acceptable confidence.
- Percent of records marked simulation-ready automatically.
- Percent of simulation failures grouped by shared cause.
- Percent of simulation failures autonomously investigated.
- Percent of failures resolved by an allowed retry strategy.
- Number of human interruptions per migration run.
- Percent of approved operations successfully verified.
- Reduction in manual record-by-record review.
- Time from upload to approval-ready remediation plan.
- Time from approval to verified execution.
- Percent of visible activity backed by event ledger entries or tool results.

## 14. Scope

### Hackathon Must-Have

- Wire the UI to the Milestone 4 single-record IRE endpoints.
- Add a selected-staged-CI IRE panel for simulate, approve, execute, and verify.
- Keep execute requests identifier-only.
- Show fingerprint freshness, approval state, execution correlation, and verification state.
- Derive a compact work queue from current staged records, findings, review decisions, and event ledger entries.
- Add deterministic grouping for at least one repeated failure pattern.
- Present an agent-like remediation loop driven by real endpoint calls and event ledger playback.
- Use a realistic fixture or live run that includes duplicates, missing identifiers, malformed values, and at least one failed simulation.
- Retain ServiceNow as the authority for validation, payload rebuild, IRE calls, and verification.
- Run build and lint before the demo branch is merged.

### Hackathon Stretch

- Add an actual provider-neutral model adapter for summaries or failure explanations.
- Add batch simulation for eligible records while preserving single-record execution approval.
- Add a retry strategy selector for explicitly allowed identifier alternatives.
- Add richer relationship risk and Service Mapping readiness warnings.
- Add route-level tests for IRE request sanitization and required field validation.
- Add a compact local integration test harness using mocked ServiceNow responses.

### Post-Hackathon

- OAuth, SSO, delegated user authorization, and per-user ServiceNow attribution.
- Full provider-neutral agent runtime with durable traces outside compact ServiceNow event detail.
- Relationship promotion through approved ServiceNow mechanisms.
- Production ingestion connectors for source systems.
- Pagination, filtering, and large-run performance hardening.
- Schema changes only if compact event detail and existing findings/review decisions cannot support real audit needs.
- Multi-record approval policies and protected-service risk scoring.

### Explicit Non-Goals

- Replacing ServiceNow Discovery or Service Mapping.
- Writing directly to `cmdb_ci*` or `cmdb_rel_ci`.
- Letting an LLM construct authoritative IRE payloads.
- Letting an agent bypass validation, approval, fingerprint checks, or idempotency.
- Publishing or changing Identification Rules or Reconciliation Rules.
- Adding recommendation, agent trace, workflow state, or migration event tables during the hackathon without a proven need.
- Building a generic chatbot as the primary experience.

## 15. Revised Milestone Plan

### Milestone 5: Single-Record Remediation Workbench

**Status: Complete.** The browser no longer initiates Execute or Verify. A successful fingerprint-bound approval starts the server-owned Phase D continuation, and the workbench monitors persisted evidence through correlated verification.

- Objective: Make the Milestone 4 IRE control loop usable from the Keystone web app.
- User-visible outcome: A user selects one staged CI, runs simulation, reviews the actionable finding, approves or rejects, executes an approved operation, and verifies the result.
- Backend work: Harden `/api/cmdb/ire/[action]/route.ts` validation, normalize IRE responses, and add local request-shape tests if time allows.
- Frontend work: Add an IRE lifecycle panel, correlation display, idempotency handling for buttons, stale simulation errors, and verification summary.
- ServiceNow work: Confirm response fields and error codes for all four deployed IRE endpoints.
- Agent work: None required; expose deterministic tools that a future agent can call.
- Dependencies: Deployed ServiceNow endpoints and known response shapes.
- Acceptance criteria: Browser execute payload contains only identifiers and correlation metadata; stale simulation, duplicate idempotency, missing approval, and wrong verification correlation are visible and understandable.
- Risks: Endpoint response mismatch, missing compact fingerprint metadata, or insufficient event detail size.
- Deferred: Batch execution, relationship promotion, autonomous retry.

### Milestone 6: Derived Agent Work Queue And Playback

**Status: Complete.** Queue buckets, blockers, correlations, and lifecycle playback are deterministically reconstructed from staged records, findings, reviews, and Event Ledger evidence.

- Objective: Convert staged records, findings, review decisions, and event ledger entries into an agent-owned work queue.
- User-visible outcome: Users can see what the system is doing, what is queued, what is blocked, and what requires approval.
- Backend work: Add selectors or adapter utilities that derive lifecycle state from existing records and events.
- Frontend work: Replace static remediation cards with a queue, active task panel, and evidence-backed activity playback.
- ServiceNow work: Ensure event ledger entries have enough compact metadata for derivation.
- Agent work: Script deterministic queue progression for safe non-mutating steps.
- Dependencies: Stable event types and IRE endpoint metadata.
- Acceptance criteria: Refreshing the page reconstructs the same queue state from ServiceNow data.
- Risks: Event detail size and inconsistent event types.
- Deferred: Full model-driven orchestration.

### Milestone 7: Deterministic Failure Grouping And Retry Loop

**Status: Complete and live-accepted.** The bounded campaign coordinator plans stable homogeneous groups of at most 20, simulates at concurrency three, isolates item failures, classifies persisted failures into eligible, blocked, and exhausted groups, and permits exactly one sequential retry using `normalize_known_class_alias` with `class-alias-v1`. The UI exposes the failure group, investigation evidence, retry budget, mapping version, and re-simulation result. Missing identity and unsupported failures remain blocked. The coordinator also freezes a canonical SHA-256 manifest and fans one confirmation into sequential Phase D approvals. `bounded-insert-v1` admits unmatched, complete `cmdb_ci_linux_server` INSERT simulations while freezing policy and identity evidence in the manifest. Live run `DMR0001064` proved `CLASS_ALIAS_RETRY_AVAILABLE`, exact idempotent replay, a single successful alias retry, and an isolated `MISSING_IDENTITY` blocker.

- Objective: Demonstrate that Keystone can investigate repeated IRE failures and retry with allowed strategies.
- User-visible outcome: A set of failed simulations is grouped by shared cause; Keystone selects an allowed alternative and re-simulates.
- Backend work: Add deterministic failure classifiers and allowed retry strategy definitions.
- Frontend work: Add failure group panel, investigation timeline, retry evidence, and re-simulation results.
- ServiceNow work: Confirm simulation errors include enough structured detail.
- Agent work: Agent or scripted planner chooses among allowed strategies; deterministic services enforce the choice.
- Dependencies: Fixture data with realistic repeated failures.
- Acceptance criteria: At least one failure group is resolved by an allowed retry and one remains blocked for approval or data correction.
- Risks: IRE errors may be too unstructured for reliable grouping.
- Deferred: Broad retry strategy catalog and provider/model-selected explanations. Neither gains write authority.

### Milestone 8A: Bounded Approval Packets

**Status: Complete and live-accepted.** A packet is a
governance envelope over several completed Phase E campaign manifests. It is
not a larger IRE request and does not let an agent approve its own work.

- Objective: Reduce hundreds of repetitive approval clicks while preserving exact, individually auditable ServiceNow enforcement.
- User-visible outcome: Keystone prepares several homogeneous 20-record campaigns, shows aggregate risk and exclusions, and asks for one confirmation over an exact parent packet.
- Initial bound: 100 records per packet across at most five children, composed only from frozen campaign manifests whose combined item count remains within the configured cap.
- Parent hash: SHA-256 over the versioned policy, run ID, deterministic ordered child manifest IDs and hashes, item counts, operation families, and expiry/freshness boundary.
- Approval authority: A human explicitly confirms the exact packet hash and scope. The AI may explain, prioritize, simulate, and prepare the packet but cannot confirm it.
- Execution: The server recomputes the packet and every child manifest, then fans out sequential individual ServiceNow approvals. Existing Phase D continuation alone owns one IRE Execute and one correlated Verify per CI.
- Drift behavior: Any changed manifest, fingerprint, identity evidence, operation, policy, membership, or freshness boundary blocks that child and prevents it from inheriting authorization.
- Failure behavior: Isolated CI failures remain isolated; ambiguous post-approval or post-IRE outcomes are reconciled from persisted evidence and never blindly retried. Systemic authorization/configuration failures halt the packet.
- Refresh behavior: Packet, child-campaign, approval, execution, verification, and blocker progress reconstruct entirely from ServiceNow evidence.
- Acceptance criteria: One confirmation over a frozen multi-manifest packet creates at most one individual approval chain per included CI, never invokes Execute/Verify from the packet route, and proves exact terminal Phase D correlation for every successful item.
- Deferred: Unbounded packets, autonomous/model approval, mixed-risk packets, relationship promotion, and bypass of individual ServiceNow audit records.

### Milestone 8: Provider-Neutral Agent Harness

- Objective: Add a minimal agent orchestration layer without changing authority boundaries.
- User-visible outcome: Users see Comprehend, Prioritize, and Remediation agents progress safe work with real tool calls.
- Backend work: Define provider adapter, typed tool registry, structured outputs, and bounded execution loop.
- Frontend work: Show model reasoning summaries separately from deterministic tool results.
- ServiceNow work: No schema changes by default; continue compact event ledger metadata.
- Agent work: Implement Comprehend summaries, Prioritize grouping explanations, and Remediation planning for allowed actions.
- Dependencies: Milestone 6 queue, completed Milestone 7 failure tools, and the Milestone 8A packet boundary for high-volume approval UX.
- Acceptance criteria: Agent output cannot execute without ServiceNow validation and approval checks.
- Risks: Nondeterministic model output, overlong traces, or provider-specific coupling.
- Deferred: Long-running background workers and production scheduling.

### Milestone 9: Relationship And Service Impact Readiness

- Objective: Use relationship context to assess migration and remediation risk.
- User-visible outcome: Users understand whether an operation affects relationships, orphan records, or Service Mapping readiness.
- Backend work: Add relationship readiness scoring and endpoint dependency checks.
- Frontend work: Add graph-based risk annotations and relationship-blocked states.
- ServiceNow work: Continue staging relationships; do not promote relationships until endpoint CIs are verified.
- Agent work: Explain relationship blockers and recommend data-source fixes.
- Dependencies: Reliable staged relationship data.
- Acceptance criteria: Keystone prevents relationship promotion until endpoint CIs are executed and verified.
- Risks: Confusing source-file relationships with runtime Service Mapping dependencies.
- Deferred: Native Service Mapping replacement.

## 16. Demo Narrative

The live narrative must follow `docs/live-demo-runbook.md` and distinguish
persisted evidence from projections:

1. Import a realistic dataset into ServiceNow staging; explain that staging is
   quarantine and not a direct CMDB write.
2. Open the returned migration run and show live ServiceNow instance/run
   identity.
3. Comprehend displays real staged records, normalized identity/class evidence,
   findings, and Event Ledger activity.
4. Prioritize displays deterministic work groups and projected health lift.
5. Remediate selects one homogeneous group and requests non-mutating ServiceNow
   IRE simulations, capped at concurrency three.
6. Eligible failures may consume exactly one allowlisted class-alias retry;
   missing identity and unsupported failures remain blocked.
7. Keystone plans and prepares bounded child manifests and one parent packet
   without approving, executing, or verifying any record.
8. The user reviews the complete membership, exclusions, samples, operation
   family, risk summary, expiry, and full parent hash.
9. The operator separately authorizes that exact fresh packet hash through the
   server-only gate.
10. One UI confirmation fans out sequential individual ServiceNow approvals.
11. Existing Phase D claims each approved chain, performs one server-owned IRE
    execution, and verifies only the returned target using exact correlation.
12. Agent Workspace refreshes from ServiceNow evidence and Mara summarizes
    verified operations, target CIs, blockers, and deferred work.
13. Baseline, verified-now, and projected health are shown with an explicit
    `reported` or `derived` source label.
14. The process repeats for additional homogeneous groups until the intended
    demo scope has zero pending lifecycle work.

For the active run, 20 records currently satisfy step 12 and 30 remain. The
presentation-only completed-results control may showcase those 20 while
disclosing the 30 deferred records, but it is not full-run completion. Any
fixture event must be clearly labeled fixture-only, and Past Summaries staged
operation totals must not be used as proof of committed records.

## 17. Risks And Tradeoffs

- Limited hackathon time favors a single-record vertical slice over broad but shallow autonomy.
- Small fixture datasets may make the product feel scripted unless the dirty-data cases are realistic.
- Agent nondeterminism can undermine trust unless deterministic services own validation and execution boundaries.
- ServiceNow IRE API behavior and response shapes may vary between `identifyCI`, `identifyCIEnhanced`, REST query, and enhanced REST endpoints.
- ServiceNow role configuration can block demos if not validated early.
- Existing `payload` and `event_ledger.detail` string sizes may constrain compact metadata.
- Relationship promotion is important but should remain deferred until endpoint CIs are verified.
- Overbuilding the visual experience before the control loop works would risk a polished but hollow demo.
- Adding schema too early would increase deployment and governance risk.
- Demo fallback is useful, but it can damage credibility if users cannot distinguish fixture activity from live ServiceNow-backed activity.

## 18. Open Questions

- What are the exact response shapes and error fields for the four deployed ServiceNow IRE endpoints?
- Which 10 classes and 19 attributes are currently allowlisted in ServiceNow?
- Which users or roles can approve high-risk actions during the hackathon demo?
- Will the hackathon demo use a real LLM agent, a deterministic scripted agent, or a hybrid with model-generated summaries only?
- What fixture dataset will best demonstrate repeated failures, allowed retry, approval, execution, and verification?
- Does the existing 4,000-character `event_ledger.detail` field reliably hold compact fingerprint and lifecycle metadata?
- How should IRE simulation result classifications map to UI states and finding types?
- How should protected services or high-impact relationships be identified without Service Mapping replacement claims?
- Should ServiceNow update-set or script artifacts be source-controlled in this repository?
- Should `/api/cmdb/remediate` remain as a proposal route after the IRE workbench exists, or should it become a compatibility wrapper over the deterministic tool layer?
- Which provider should be used first for the minimal agent harness, and what is the fallback behavior when no model is configured?

## Final Assessment

### Does The Current Architecture Support The Vision?

Yes. The core governed vertical slice is implemented and live-accepted:
ServiceNow owns staging, findings, reviews, Event Ledger, simulation, approval,
IRE execution, and verification; Keystone owns the evidence-backed user
experience and bounded identifier-only orchestration. The immediate risk is no
longer missing architecture. It is completing and rehearsing the live dataset,
keeping every packet fresh and exactly authorized, and ensuring summary views
do not overstate staged operations as verified commits.

### Five Most Important Changes Required

1. Complete the remaining simulations and exact-hash packet approvals for the
   active 50-record demo run.
2. Change Past Summaries to count correlated verified outcomes rather than
   staged operation types.
3. Add a terminal live-demo acceptance check requiring zero pending work and
   exact target-CI bindings after refresh.
4. Rehearse exact-hash expiry, restart, systemic-stop, and ambiguous-response
   recovery before presenting.
5. Preserve and extend the existing route, campaign, packet, Phase D, and
   browser regression gates as the demo workflow evolves.

### Highest-Impact Achievable Hackathon Scope

The highest-impact achievable scope is now a real 50-record homogeneous
ServiceNow migration with visible staging, deterministic analysis, bounded
simulation, one exact packet authorization at a time, sequential individual
approvals, Phase D execution, and correlated verification. If the entire run
cannot reach terminal evidence before presentation, the truthful fallback is
the already verified 20-record slice plus an explicitly labeled fixture-only
100-record packet demonstration.

### Features To Reject Or Defer

- Direct CMDB write tools.
- Generic chatbot-first interface.
- New ServiceNow recommendation, agent trace, or workflow state tables during the hackathon.
- Relationship promotion before endpoint CIs are verified.
- Service Mapping replacement claims.
- Identification Rule or Reconciliation Rule authoring.
- Fully autonomous execution of ambiguous or protected operations.
- Large multi-record execution before the single-record fingerprint, approval, idempotency, and verification loop is proven.

### Recommended Next Codex Implementation Prompt

```text
Prepare Keystone for the live 50-CI demo.

Read docs/live-demo-runbook.md, docs/next-session-handoff.md,
docs/lifecycle-acceptance-report.md, docs/ire-flow.md, and
docs/cmdb-bridge-api.md completely.

First, fix Past Summaries so operation totals are derived only from correlated
verified outcomes, with pending and deferred work shown separately. Add a
terminal demo readiness check for the active run that requires exact verified
target bindings and zero awaiting-approval, ready-to-simulate, executing,
blocked, or reconciliation-required records after refresh.

Preserve the server-validated one-time exact packet-hash gate, initiated by a
separate explicit UI authorization action, sequential individual
ServiceNow approvals, status-only browser Execute/Verify routes, and Phase D as
the only IRE execution and verification owner. Add no ServiceNow schema or
direct CMDB write path. Run the campaign, packet, queue, playback, Phase A-D,
TypeScript, lint, and production-build gates before declaring the run demo
ready.
```
