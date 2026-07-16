# Handover: CMDB Modernization Control Plane

Paste this entire document into Claude as the project handover.

---

You are taking over an existing CMDB modernization frontend and ServiceNow integration project. Continue from the current implementation; do not restart or replace the established design.

## Critical naming instruction

The product has **not been named yet**.

- Do not use “Keystone” in product copy, UI labels, source tags, environment variables, API routes, documentation, or new filenames.
- The GitHub repository is currently named `keystone`, but that is only the repository name and is not approved product branding.
- Use neutral terms such as:
  - CMDB Modernization Control Plane
  - migration pipeline
  - staging pipeline
  - CMDB modernization
  - governed migration

## Product objective

The system converts messy source data into governed ServiceNow Configuration Items while preserving traceability and preventing direct CMDB writes.

The complete intended flow is:

1. Data arrives from CSV, spreadsheets, legacy tools, hierarchical systems, relational systems, or nested JSON.
2. Raw data lands in a custom staging table outside the CMDB.
3. An AI agent examines each row, maps fields, proposes a ServiceNow CI class, assigns a confidence score, and records its reasoning.
4. A confidence gate splits records into:
   - high confidence: continue automatically;
   - low confidence: human review queue;
   - broken records: error bucket.
5. Approved records pass through ServiceNow IRE.
6. IRE decides whether to insert, update, make no change, merge with an existing CI, or insert as incomplete.
7. Clean CIs and relationships land in the CMDB.
8. Every step writes an event-log record containing sequence, event name, CI class, operation, source, confidence, timestamp, and reasoning.
9. REST APIs expose the data to the frontend.
10. The frontend supports the CPR operating model:
    - Comprehend: understand what happened;
    - Prioritize: rank fixes by projected CMDB-health improvement;
    - Remediate: propose corrections and send them through IRE.

## Non-negotiable governance rule

**Nothing may write to a CMDB table except through ServiceNow IRE.**

The browser and AI tools may analyze data and create proposals. They must not directly insert, update, merge, or delete CMDB records.

## What currently exists

The frontend is a standard Next.js application prepared for Vercel.

Local project:

`C:\Users\NivethaSivakumar\Downloads\Keystone Modernize design themes (2)\frontend`

GitHub repository:

`https://github.com/nivetha0069/keystone`

Implementation branch:

`agent/vercel-ready-cmdb-frontend`

Implementation commit:

`33b6363`

The implementation was merged into `main` in merge commit `b2246cc`.

Merged pull request:

`https://github.com/nivetha0069/keystone/pull/1`

The branch is based directly on the repository's `main` branch and contains one clean implementation commit.

## Completed frontend functionality

### Comprehend

- KPI cards for:
  - CIs published;
  - duplicates merged;
  - records needing review;
  - relationships created.
- Seven-step run playback:
  - Intake
  - Staging
  - AI read
  - Confidence gate
  - IRE
  - CMDB
  - Event log
- Record-flow Sankey visualization.
- CI relationship graph.
- Configuration Item table.
- Search and review-queue filter.
- Clickable CI rows.
- Provenance drawer showing the complete processing path.
- Live API/demo-state indicator.

### Prioritize

- Overall CMDB health score and grade.
- Completeness, correctness, compliance, and duplicate-free dimensions.
- Ranked remediation recommendations.
- Projected percentage health improvement per fix.
- A recommended “best next move.”

### Remediate

- Agent-tool cards such as duplicate analyzer and IRE advisor.
- Change-proposal panel.
- Candidate-record count and projected health improvement.
- Evidence summary.
- Remediation submission through the server API proxy.
- Explicit IRE-only execution messaging.

### Responsive behavior

The dashboard has desktop, tablet, and mobile layouts.

## Important source files

- `app/cmdb-dashboard.tsx`
  - Main interactive dashboard.
  - Contains normalization logic for multiple possible API response shapes.
  - Contains Comprehend, Prioritize, Remediate, Sankey, graph, table, and provenance UI.
- `app/cmdb-data.ts`
  - Type definitions.
  - Demo CIs, timeline events, relationships, health score, and ranked fixes.
- `app/api/cmdb/[resource]/route.ts`
  - Server-side proxy for upstream API calls.
  - Keeps ServiceNow/API credentials out of the browser.
  - Accepts read resources and governed remediation proposals.
- `app/globals.css`
  - Complete dashboard styling and responsive rules.
- `app/page.tsx`
  - Dashboard entry page and page metadata.
- `app/layout.tsx`
  - Root metadata and global layout.
- `.env.example`
  - Required server-side environment variables.
- `vercel.json`
  - Vercel framework and build configuration.
- `README.md`
  - Local setup, API configuration, and Vercel deployment instructions.

## Runtime and deployment

The previous Cloudflare/vinext starter runtime was removed. The project now uses standard Next.js commands:

```bash
npm install
npm run dev
npm run build
npm start
npm run lint
```

Current important package scripts:

```json
{
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "test": "npm run build",
  "lint": "eslint app next.config.ts"
}
```

The production build and lint both pass.

To deploy on Vercel:

1. Import `https://github.com/nivetha0069/keystone`.
2. Deploy the PR branch or merge the PR into `main`.
3. Add the required environment variables in Vercel.
4. Let Vercel detect the project as Next.js.

No custom output directory or Cloudflare runtime is required.

## Environment variables

```text
CMDB_API_BASE_URL=https://your-api.example.com
CMDB_API_TOKEN=
CMDB_API_USERNAME=
CMDB_API_PASSWORD=
CMDB_REMEDIATE_URL=
```

Authentication behavior:

- `CMDB_API_TOKEN` produces a bearer authorization header.
- Otherwise, `CMDB_API_USERNAME` and `CMDB_API_PASSWORD` produce a basic authorization header.
- These values are read only by server-side Next.js routes.
- They must never be exposed as `NEXT_PUBLIC_*` variables.

If `CMDB_REMEDIATE_URL` is omitted, remediation uses:

```text
{CMDB_API_BASE_URL}/remediate
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

The server proxy calls the corresponding upstream resources:

```text
{CMDB_API_BASE_URL}/cis
{CMDB_API_BASE_URL}/timeline
{CMDB_API_BASE_URL}/relationships
{CMDB_API_BASE_URL}/health
```

Only these read resources are accepted:

```text
cis
timeline
relationships
health
```

The POST route only accepts `remediate`. It reconstructs the outgoing payload to enforce:

```json
{
  "fixId": "FIX-01",
  "tool": "Duplicate analyzer",
  "route": "IRE",
  "mode": "proposal"
}
```

Do not add a generic pass-through write endpoint.

## Expected logical API data

The frontend normalization functions already tolerate several wrapper and field-name variations, including `result`, `data`, `items`, `records`, and snake_case ServiceNow-style names.

### `/cis`

Minimum useful shape:

```json
[
  {
    "id": "CI-00482",
    "name": "pay-gw-lnx-03",
    "className": "Linux Server",
    "ip": "10.42.18.33",
    "source": "Legacy Inventory",
    "operation": "UPDATE",
    "confidence": 0.98,
    "health": 96,
    "updatedAt": "2026-07-16T06:09:12Z",
    "provenance": [
      {
        "label": "Raw record",
        "value": "SRC-88421",
        "detail": "legacy-export.csv row 4812"
      }
    ]
  }
]
```

Supported operations:

```text
INSERT
UPDATE
NO_CHANGE
INSERT_AS_INCOMPLETE
REVIEW
ERROR
```

### `/timeline`

```json
[
  {
    "id": "EV-01",
    "seq": 1,
    "step": 1,
    "name": "Source received",
    "recordName": "pay-gw-lnx-03",
    "className": "Unclassified",
    "operation": "NO_CHANGE",
    "source": "Legacy Inventory",
    "confidence": 0,
    "time": "2026-07-16T06:08:41.002Z",
    "status": "complete",
    "reasoning": "CSV batch accepted and checksummed."
  }
]
```

### `/relationships`

```json
[
  {
    "id": "REL-01",
    "source": "pay-gw-lnx-03",
    "target": "payments-db-01",
    "type": "Depends on",
    "confidence": 0.96
  }
]
```

### `/health`

```json
{
  "score": 78,
  "grade": "B",
  "ciCount": 842,
  "duplicatesMerged": 216,
  "reviewCount": 17,
  "relationshipCount": 389,
  "completeness": 82,
  "correctness": 91,
  "compliance": 96,
  "duplicateRate": 3.8,
  "staleRecords": 47,
  "fixes": [
    {
      "id": "FIX-01",
      "rank": 1,
      "title": "Collapse probable server duplicates",
      "description": "17 CI pairs share strong identity signals.",
      "impact": 6,
      "affected": 34,
      "tool": "Duplicate analyzer",
      "severity": "critical"
    }
  ]
}
```

## Demo fallback behavior

The frontend initially loads built-in demonstration data.

It requests all four read endpoints in parallel:

- If all four return usable data, the UI reports `Live API`.
- If any endpoint fails or lacks usable records, the UI retains demo data for that area and reports `Demo snapshot`.
- This behavior allows Vercel deployment before ServiceNow connectivity is finished.

Do not remove the fallback until the live APIs are proven reliable and a deliberate loading/error design has been agreed.

## Current ServiceNow state

The following backend pieces were reported as already working:

- source intake/import set;
- staging/import-set layer;
- IRE integration;
- CMDB publishing;
- event log;
- `/cis`;
- `/timeline`;
- `/relationships`;
- `/health`;
- agent functionality;
- IRE functionality.

The following areas were reported as incomplete:

- automatic AI CI-class decision;
- confidence gate;
- human review queue;
- wiring the frontend to the live API;
- full Prioritize backend logic;
- full Remediate backend execution.

The frontend contains the required UX and mock/normalization layer for these capabilities, but backend behavior must still be connected and verified.

## Data strategy decided so far

Do not try to ingest every public dataset previously researched. Most public vendor datasets are catalogs or telemetry, not actual deployed-company CMDB inventories.

The focused demonstration should use two source families:

### Microsoft public data

Use real public service/network metadata:

1. Microsoft 365 endpoint JSON:

```powershell
$id = [guid]::NewGuid()

Invoke-RestMethod "https://endpoints.office.com/endpoints/Worldwide?clientrequestid=$id" |
    ConvertTo-Json -Depth 20 |
    Set-Content data\raw\microsoft\m365-endpoints.json
```

2. Azure Service Tags JSON:

`https://www.microsoft.com/en-us/download/details.aspx?id=56519`

These demonstrate nested service, endpoint, URL, and IP-network structures. They are genuine Microsoft-published service metadata, not Microsoft's internal CMDB inventory.

### IBM-modeled legacy fixtures

IBM does not publish its internal deployed IMS/Db2 CMDB inventory.

Use synthetic migration fixtures based on IBM's documented structures:

IMS hierarchy:

```text
SYSTEM
 └── LPAR
      └── IMS_REGION
           └── DATABASE
                └── APPLICATION
```

Db2 relational fixture files:

```text
servers.csv
db2_subsystems.csv
databases.csv
applications.csv
relationships.csv
```

Be transparent that these are synthetic migration records modeled on official IBM hierarchical and relational examples. Do not describe them as IBM corporate inventory.

### Controlled dirty-data cases

Maintain a clean golden copy, then generate messy inputs that exercise the AI and IRE:

- renamed fields such as `Host IP`, `IP Addr`, and `ADDR`;
- class labels such as `linux srv`, `RHEL box`, and `lnx`;
- duplicate rows with hostname casing or spelling differences;
- missing serial numbers;
- RAM expressed as `16 GB`, `16384 MB`, and `16G`;
- broken parent references;
- conflicting IP addresses;
- missing CI classes;
- null required identifiers.

The demonstration should prove classification, confidence gating, review handling, relationship inference, deduplication, and IRE reconciliation.

## Recommended next work

Work in this order:

1. Review and merge draft PR #1.
2. Deploy the current branch to Vercel using demo mode.
3. Configure `CMDB_API_BASE_URL` and authentication in Vercel.
4. Test each server proxy route independently.
5. Verify the actual ServiceNow response shapes and adjust only the normalization layer if needed.
6. Replace hard-coded run metadata such as batch ID and instance display with API/config values.
7. Implement the AI classification output contract:
   - proposed CI class;
   - mapped fields;
   - confidence;
   - reasoning;
   - validation errors.
8. Implement confidence policies and the review queue.
9. Connect Prioritize recommendations to real health calculations.
10. Connect Remediate proposals to real agent tools while preserving IRE as the only write path.
11. Add authentication/authorization before enabling real remediation in a public Vercel deployment.
12. Add automated tests for API normalization and route write restrictions.

## Immediate technical cautions

- Never put ServiceNow credentials in browser code.
- Never create direct browser-to-ServiceNow CMDB table writes.
- Never allow arbitrary upstream paths through the API proxy.
- Never accept a client-provided execution route for remediation; the server must enforce `route: "IRE"`.
- Do not claim public Microsoft metadata is Microsoft’s internal CMDB.
- Do not claim synthetic IBM-modeled fixtures are IBM production data.
- Do not remove provenance or reasoning from the processing model.
- Do not introduce a final product name without explicit approval.
- Preserve the existing visual design unless specifically asked to redesign it.

## Validation already completed

The following checks passed on the current implementation:

```bash
npm run build
npm run lint
```

The production server was also tested:

- `/` returned HTTP 200;
- rendered metadata contained `CMDB Modernization Control Plane`;
- rendered output contained no old product-name references;
- `/api/cmdb/health` correctly returned HTTP 503 with a clear configuration error when `CMDB_API_BASE_URL` was absent;
- the dashboard falls back to demo mode when the live API is unavailable.

## Definition of success for the next phase

A successful next phase should demonstrate:

1. messy source records enter staging;
2. AI classifies and maps them with visible confidence and reasoning;
3. low-confidence records enter a real review queue;
4. approved records pass through IRE;
5. IRE outcomes appear in the event ledger;
6. the Vercel frontend displays live CIs, events, relationships, and health;
7. a remediation proposal can be created;
8. no CMDB mutation occurs outside IRE;
9. provenance remains visible from source record to final CI.

Before making changes, inspect the current branch and PR, run the existing build, and preserve the neutral naming and IRE governance constraints.

---
