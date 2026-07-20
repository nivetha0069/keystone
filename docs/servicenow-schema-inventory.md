# ServiceNow Schema Inventory

## Project
**Scope:** `x_kest_dotwalkers`

**Last Updated:** July 2026

---

# Purpose

This document describes the current ServiceNow schema used by the CMDB Migration & Intelligence platform.

It is intended to serve as the schema source of truth before implementation work begins.

The schema should be reviewed before introducing any new tables or fields.

---

# Architecture Overview

The application follows a staged migration pipeline.

```text
Upload
    ↓
Migration Run
    ↓
Staged CI Records
    ↓
Validation
    ↓
Findings
    ↓
Review Decisions
    ↓
IRE Simulation
    ↓
IRE Execution
    ↓
Event Ledger
```

Guiding principles:

- Never write directly to `cmdb_ci` or `cmdb_rel_ci`.
- Use ServiceNow IRE for CMDB creation and updates.
- Preserve uploaded source data.
- Keep staging records isolated until approved.
- Every major lifecycle action should be recorded in the Event Ledger.

---

# Existing Tables

## 1. Migration Run

**Table**

`x_kest_dotwalkers_migration_run`

### Purpose

Central orchestration record representing one migration lifecycle from ingestion through commit.

### Fields

| Label | Element | Type | Reference | Length | Required | Read Only | Default | Choices |
|-------|---------|------|-----------|-------:|----------|-----------|---------|---------|
| Summary | `summary` | String | — | 4000 | No | No | — | — |
| Initiated by | `initiated_by` | Reference | `sys_user` | 32 | No | No | — | — |
| Source system | `source_system` | Choice | — | 255 | No | No | `other` | servicenow, cloudquery, helix, csv, json, microsoft, ibm, other |
| Started | `started` | Date/Time | — | 40 | No | No | — | — |
| Completed | `completed` | Date/Time | — | 40 | No | No | — | — |
| Number | `number` | String | — | 40 | No | No | `javascript:getNextObjNumberPadded();` | — |
| Team prefix | `team_prefix` | String | — | 40 | No | No | — | — |
| State | `state` | Choice | — | 255 | No | No | `draft` | draft, ingesting, analyzing, simulated, awaiting_approval, committing, complete, failed |

### Relationships

- Referenced by every other table.

### Notes

- Hub table for the migration lifecycle.
- Number is generated automatically.
- No mandatory custom fields.

---

## 2. Staged CI Record

**Table**

`x_kest_dotwalkers_staged_ci_record`

### Purpose

Stores imported CI records before identification and reconciliation.

### Fields

| Label | Element | Type | Reference | Length | Required | Read Only | Default | Choices |
|-------|---------|------|-----------|-------:|----------|-----------|---------|---------|
| Confidence | `confidence` | Integer | — | 40 | No | No | — | — |
| Proposed class | `proposed_class` | String | — | 100 | No | No | — | — |
| Source Identifier | `source_identifier` | String | — | 100 | No | No | — | — |
| Identification Status | `identification_status` | Choice | — | 255 | No | No | pending | pending, match_found, new_ci, conflict, rejected |
| Number | `number` | String | — | 40 | No | No | `javascript:getNextObjNumberPadded();` | — |
| Migration Run | `migration_run` | Reference | `x_kest_dotwalkers_migration_run` | 32 | No | No | — | — |
| Payload | `payload` | String | — | 4000 | No | No | — | — |
| Team Prefix | `team_prefix` | String | — | 40 | No | No | — | — |
| Matched CI | `matched_ci` | Reference | `cmdb_ci` | 32 | No | No | — | — |

### Relationships

- Child of Migration Run
- Parent of Findings
- Referenced by Staged Relationships

### Notes

- Represents quarantined CIs before IRE.
- `matched_ci` represents the CI identified during identification/simulation.

---

## 3. Staged Relationship

**Table**

`x_kest_dotwalkers_staged_relationship`

### Purpose

Stores proposed relationships before committing them to CMDB.

| Label | Element | Type | Reference | Length | Required | Read Only | Default |
|-------|---------|------|-----------|-------:|----------|-----------|---------|
| Child CI | `child_ci` | Reference | `x_kest_dotwalkers_staged_ci_record` | 32 | No | No | — |
| Migration Run | `migration_run` | Reference | `x_kest_dotwalkers_migration_run` | 32 | No | No | — |
| Relationship Type | `relationship_type` | Reference | `cmdb_rel_type` | 32 | No | No | — |
| Team Prefix | `team_prefix` | String | — | 40 | No | No | — |
| Parent CI | `parent_ci` | Reference | `x_kest_dotwalkers_staged_ci_record` | 32 | No | No | — |
| Status | `status` | Choice | — | 255 | No | No | pending |

### Relationships

- Child of Migration Run
- References staged CI records

---

## 4. Finding

**Table**

`x_kest_dotwalkers_finding`

### Purpose

Stores validation findings and AI-generated recommendations.

| Label | Element | Type | Reference |
|-------|---------|------|-----------|
| Severity | `severity` | Choice | — |
| Recommendation | `recommendation` | String | — |
| Type | `type` | Choice | — |
| Number | `number` | String | — |
| Migration Run | `migration_run` | Reference | `x_kest_dotwalkers_migration_run` |
| Team Prefix | `team_prefix` | String | — |
| Staged CI | `staged_ci` | Reference | `x_kest_dotwalkers_staged_ci_record` |

### Relationships

- Child of Migration Run
- Parent of Review Decision

---

## 5. Review Decision

**Table**

`x_kest_dotwalkers_review_decision`

### Purpose

Captures reviewer approval, rejection, or deferral.

| Label | Element | Type | Reference |
|-------|---------|------|-----------|
| Decision | `decision` | Choice | — |
| Finding | `finding` | Reference | `x_kest_dotwalkers_finding` |
| Rationale | `rationale` | String | — |
| Decided By | `decided_by` | Reference | `sys_user` |
| Migration Run | `migration_run` | Reference | `x_kest_dotwalkers_migration_run` |
| Team Prefix | `team_prefix` | String | — |
| Policy Approved | `policy_approved` | Boolean | — |

---

## 6. Event Ledger

**Table**

`x_kest_dotwalkers_event_ledger`

### Purpose

Immutable audit history for migration playback.

| Label | Element | Type | Reference |
|-------|---------|------|-----------|
| Actor | `actor` | String | — |
| Sequence | `sequence` | Integer | — |
| Migration Run | `migration_run` | Reference | `x_kest_dotwalkers_migration_run` |
| Event Type | `event_type` | Choice | — |
| Team Prefix | `team_prefix` | String | — |
| Detail | `detail` | String | — |

---

## 7. AI Usage

**Table**

x_kest_dotwalkers_ai_usage

### Purpose

Stores sanitized per-call model usage for an existing Migration Run. This table
is the only approved schema exception added after the original six-table
inventory. It never stores prompts, responses, credentials, hidden reasoning,
or raw provider payloads.

### Fields

| Label | Element | Type | Reference |
|-------|---------|------|-----------|
| Migration Run | migration_run | Reference | x_kest_dotwalkers_migration_run |
| Team Prefix | team_prefix | String | - |
| Phase | phase | String/Choice | - |
| Model | model | String | - |
| Input Tokens | input_tokens | Integer | - |
| Output Tokens | output_tokens | Integer | - |
| Total Tokens | total_tokens | Integer | - |
| Duration | duration_ms | Integer | - |
| Status | status | String/Choice | - |
| Fallback Reason | fallback_reason | String | - |
| Provider Request ID | provider_request_id | String | - |
| Created | created | Date/Time | - |

Authorization requires the configured CMDB Bridge role and read access to the
referenced Migration Run. Team prefix is a partition filter only.

# Cross-Table Relationships

```text
Migration Run
│
├── Staged CI Record
│     ├── Finding
│     │      └── Review Decision
│     │
│     └── Staged Relationship
│
└── Event Ledger
```

---

# Cross-Table Observations

- `migration_run` is the central orchestration table.
- All tables contain `team_prefix` for logical partitioning.
- All staging occurs outside the CMDB.
- `matched_ci` is the only reference to an existing CMDB CI.
- Relationships reference staged records rather than live CMDB records.
- The Event Ledger provides an append-only audit history.
- No custom fields are mandatory.
- No custom fields are read-only.
- No display fields are currently defined.
- No unique constraints currently exist on custom fields.

---

# Schema Interpretation Rules

These interpretations should be used during implementation.

- `matched_ci` represents the CI returned from identification or simulation.
- `proposed_class` stores the proposed CMDB class as a string and is validated before execution.
- `source_identifier` is not globally unique and may appear in multiple migration runs.
- `actor` may represent a user, API, automation, AI agent, or IRE process.
- Staging tables intentionally allow incomplete records so validation can occur after ingestion.
- The authoritative CMDB remains the target system; staging tables are never treated as production CMDB data.
