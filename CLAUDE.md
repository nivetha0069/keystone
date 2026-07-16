# CLAUDE.md — CMDB Modernization Control Plane (keystone)

A neutral Next.js frontend for comprehending, prioritizing, and remediating CMDB migration runs,
backed by ServiceNow. Deployable to Vercel before ServiceNow connectivity is finished.

## Architecture

- Next.js 16 (App Router, Turbopack). Single page ([app/page.tsx](app/page.tsx)) rendering
  [app/cmdb-dashboard.tsx](app/cmdb-dashboard.tsx).
- Demo data and types live in [app/cmdb-data.ts](app/cmdb-data.ts).
- Server proxy: [app/api/cmdb/[resource]/route.ts](app/api/cmdb/%5Bresource%5D/route.ts).
  Credentials are server-side only and never reach the browser.

## Environment variables (server-side)

```text
CMDB_API_BASE_URL   # base URL exposing /cis /timeline /relationships /health
CMDB_API_TOKEN      # bearer token, OR:
CMDB_API_USERNAME
CMDB_API_PASSWORD
CMDB_REMEDIATE_URL  # optional; defaults to {CMDB_API_BASE_URL}/remediate
```

## Frontend API routes

The browser calls:

```text
GET  /api/cmdb/cis
GET  /api/cmdb/timeline
GET  /api/cmdb/relationships
GET  /api/cmdb/health
POST /api/cmdb/remediate
```

The proxy forwards GETs to `{CMDB_API_BASE_URL}/{resource}` for exactly these read resources:
`cis`, `timeline`, `relationships`, `health`. The POST route accepts only `remediate` and
reconstructs the outgoing payload to enforce:

```json
{ "fixId": "FIX-01", "tool": "Duplicate analyzer", "route": "IRE", "mode": "proposal" }
```

**Do not add a generic pass-through write endpoint.** IRE is the only write path.

## Expected logical API data

The normalization functions in `cmdb-dashboard.tsx` tolerate wrapper variations
(`result`, `data`, `items`, `records`) and snake_case ServiceNow-style field names.

Supported IRE operations: `INSERT`, `UPDATE`, `NO_CHANGE`, `INSERT_AS_INCOMPLETE`, `REVIEW`, `ERROR`.

Minimum useful shapes (see the mock data in `app/cmdb-data.ts` for full examples):

- `/cis` — array of `{ id, name, className, ip, source, operation, confidence, health, updatedAt, provenance[] }`
- `/timeline` — array of `{ id, seq, step (1–7), name, recordName, className, operation, source, confidence, time, status, reasoning }`
- `/relationships` — array of `{ id, source, target, type, confidence }`
- `/health` — object with `score, grade, ciCount, duplicatesMerged, reviewCount, relationshipCount, completeness, correctness, compliance, duplicateRate, staleRecords, fixes[]`
  where each fix is `{ id, rank, title, description, impact, affected, tool, severity }`

## Demo fallback behavior

The frontend loads built-in demo data first, then requests all four read endpoints in parallel:

- All four return usable data → UI reports **Live API**.
- Any endpoint fails or lacks usable records → demo data is kept for that area and the UI reports
  **Demo snapshot**.

This allows Vercel deployment before ServiceNow connectivity is finished.
**Do not remove the fallback** until the live APIs are proven reliable and a deliberate
loading/error design has been agreed.

## Current ServiceNow state

Reported working: source intake/import set, staging layer, IRE integration, CMDB publishing,
event log, `/cis`, `/timeline`, `/relationships`, `/health`, agent functionality, IRE functionality.

Reported incomplete:

- automatic AI CI-class decision;
- confidence gate;
- human review queue;
- wiring the frontend to the live API;
- full Prioritize backend logic;
- full Remediate backend execution.

The frontend already contains the UX and mock/normalization layer for these capabilities; backend
behavior must still be connected and verified.

## Data strategy decided so far

Do not try to ingest every public dataset previously researched. Most public vendor datasets are
catalogs or telemetry, not actual deployed-company CMDB inventories.

The focused demonstration should use two source families:

<!-- NOTE: the original decision record was truncated at this point. The demo data in
app/cmdb-data.ts models two apparent families — (1) legacy/manual inventory exports
(Baxter Inventory CSV, Legacy CMDB export, spreadsheet) and (2) automated discovery
systems (NetBox, SCCM) — but confirm the intended two families with Nyra before
building ingestion around them. -->
