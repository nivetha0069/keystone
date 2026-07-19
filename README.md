# CMDB Modernization Control Plane

A neutral, unnamed frontend for comprehending, prioritizing, and remediating CMDB migration runs. The dashboard reads four JSON resources and sends remediation proposals through an IRE-governed server route.

## Local development

```bash
npm install
copy .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

If the API variables are not configured, the dashboard automatically uses its built-in demo snapshot.

## API configuration

The upstream API base URL must expose:

- `/cis`
- `/timeline`
- `/relationships`
- `/health`

Set these server-side variables:

```text
CMDB_API_BASE_URL=https://your-api.example.com
CMDB_API_TOKEN=
CMDB_API_USERNAME=
CMDB_API_PASSWORD=
CMDB_REMEDIATE_URL=
CMDB_IMPORT_URL=
CMDB_IRE_BASE_URL=
CMDB_IRE_SIMULATE_URL=
CMDB_IRE_APPROVE_URL=
CMDB_IRE_EXECUTE_URL=
CMDB_IRE_VERIFY_URL=
```

Use either a bearer token or basic authentication. These credentials are only read by Next.js server routes and are never sent to the browser.

`CMDB_IMPORT_URL` must point to a ServiceNow scripted REST endpoint that lands uploads and URL-connector requests in a custom staging/import table. The gateway always adds `target=staging`, `mode=quarantine`, and `directCmdbWrite=false`.

The optional `CMDB_IRE_*` variables point to ServiceNow scripted REST actions for single-record IRE simulation, approval, execution, and verification. If per-action URLs are omitted, Keystone uses `CMDB_IRE_BASE_URL/ire/{action}` or falls back to `CMDB_API_BASE_URL/ire/{action}`. Execution requests are identifier-only; ServiceNow remains responsible for rebuilding the authoritative payload, validating approval/fingerprint freshness, and calling IRE.

Mara's LLM runtime belongs in ServiceNow Script Includes. The browser does not receive provider credentials or call a model. It reads Mara's run-scoped Event Ledger and finding records through the existing CMDB bridge.

## Deploy to Vercel

1. Push the `frontend` directory to a Git repository.
2. Import the repository into Vercel.
3. If this repository contains other folders, set the Vercel Root Directory to `frontend`.
4. Add the `CMDB_*` variables under Project Settings → Environment Variables.
5. Deploy.

Vercel detects the project as Next.js and runs `npm run build`. No Cloudflare runtime or custom output directory is required.
