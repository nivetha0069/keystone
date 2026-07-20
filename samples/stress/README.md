# Company-Separated Stress Fixtures

Keystone's generated stress fixtures model one source organization per import. They never mix companies in a migration run and never claim to represent a company's private infrastructure.

## Generate

```powershell
npm.cmd run fixtures:stress
```

The default command writes four independent company packs to `outputs/company-stress-fixtures`:

- `microsoft`: Microsoft 365 endpoint and Azure Service Tag structures.
- `ibm`: IMS hierarchy and Db2 relational structures.
- `cloudflare`: edge network, ASN, prefix, and route structures.
- `fastly`: application-service, component-health, and incident structures.

Each company contains:

| Tier | CIs | Relationships | Intended use |
|---|---:|---:|---|
| `smoke` | 100 | 160 | Parser and quick Comprehend check |
| `workflow` | 500 | 900 | Full Comprehend and Prioritize workflow |
| `pdi` | 2,000 | 4,200 | Progressive ServiceNow development-instance stress test |
| `local` | 10,000 | 25,000 | Local parser, adapter, and UI load testing only |

An optional `soak` tier contains 50,000 CIs and 125,000 relationships:

```powershell
node scripts/generate-company-stress-fixtures.mjs --include-soak
```

## Golden Truth

Every `<company>-<tier>.json` has a matching `<company>-<tier>.expected.json`. The expected file records every row's injected mutation, expected gate, finding type, and expected IRE outcome.

The deterministic distribution is:

| Category | Share | Expected handling |
|---|---:|---|
| Clean controls | 50% | Auto-eligible |
| Exact duplicates | 10% | Deduplicate / `NO_CHANGE` |
| Missing identifiers | 8% | Human review; no IRE |
| Malformed network values | 6% | Error; no IRE |
| Orphan parents | 6% | Human review; no IRE |
| Legacy field aliases | 10% | Normalize and continue |
| Class aliases | 5% | Normalize approved class |
| Missing required attributes | 5% | Review / incomplete path |

## Safe Test Order

1. Import one company's `smoke` file and confirm counts, confidence groups, and Event Ledger reconstruction.
2. Import that company's `workflow` file and confirm Prioritize groups repeated causes.
3. Import `pdi` only after the smaller tiers complete within acceptable latency and payload limits.
4. Keep `local` and `soak` out of ServiceNow until pagination, payload sizing, and instance capacity are measured.
5. Never batch execute generated records. Simulate one selected record, approve its current fingerprint, obtain explicit confirmation, execute once, and verify by the exact execution correlation.

The generated JSON files use Keystone's supported `{ cis, relationships }` import shape. `catalog.json` and `catalog.csv` list counts, sizes, safety estimates, and SHA-256 hashes.
