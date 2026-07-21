# ServiceNow Scope Export

Run a sanitized, read-only export of the Dotwalkers scoped application:

```powershell
npm.cmd run export:servicenow
```

Defaults:

- Scope: `x_kest_dotwalkers`
- Credentials: `.env.local`
- Output: timestamped directory under `outputs/servicenow-export/`
- Transport: ServiceNow Table API `GET` only

The export contains a complete `sys_metadata` index and detailed records for
Script Includes, Scripted REST APIs and resources, Business Rules, Script
Actions, event registrations, scheduled scripts, ACLs, UI Actions, Client
Scripts, and system-property metadata.

Script bodies are stored as individual `.js` files with SHA-256 hashes in each
directory's `index.json`. Known configured credentials and credential-like
literals are redacted. The exporter never requests the `sys_properties.value`
field or credential-bearing tables.

Options:

```powershell
npm.cmd run export:servicenow -- --scope x_kest_dotwalkers --limit 100
npm.cmd run export:servicenow -- --output outputs/another-export-root
npm.cmd run export:servicenow -- --help
```

Generated exports remain under the ignored `outputs/` directory and are not
included in commits by default.
