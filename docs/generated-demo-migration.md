# Generated Dataset to ServiceNow Migration

## Goal

Generated company fixtures are reusable source material, not reusable CI identity.
Before a demo, materialize the chosen source into a fresh namespace, land it in
ServiceNow staging, simulate every eligible record, and drain mutations through
as many bounded approval packets as the run requires.

The 100-record packet size is a safety bound, not a migration-run limit. A
homogeneous 500-CI run normally produces twenty-five 20-record child campaigns
and five separately authorized parent packets of at most 100 records each.
Mixed ServiceNow classes or operation families can require more parent packets.

## Why the catalog files should not be uploaded repeatedly

The files under `outputs/company-stress-fixtures` intentionally contain stable
identifiers plus duplicates, missing identity, malformed network data, class
aliases, incomplete records, and classes that may not be accepted by the
current ServiceNow runtime policy. Uploading the same file again can also cause
IRE to match a prior demo CI.

Use the migration-demo materializer to create a clean, uniquely namespaced
variant. It assigns unique source identity and CI attributes, fills the fields
needed for a healthy demonstration, remaps valid relationships, accepts a
canonical proposed class without claiming it is allowlisted, and records a
manifest plus SHA-256 digest.

Never reuse a namespace when the demo expectation is a fresh INSERT. A new
namespace separates source identity; it is not permission to approve a
mutation and cannot guarantee INSERT before ServiceNow simulation.

## 1. Materialize a fresh dataset

Example for 500 Microsoft-modeled CIs:

```text
npm.cmd run fixtures:migration-demo -- \
  --input outputs/company-stress-fixtures/microsoft/microsoft-workflow.json \
  --namespace msft-demo-20260722-01 \
  --count 500 \
  --class cmdb_ci_linux_server
```

The command writes a JSON dataset and adjacent manifest under
`outputs/servicenow-demo-imports`. It refuses to overwrite existing output
unless `--overwrite` is explicit. Prefer a fresh namespace instead.

The proposed class is a request to ServiceNow simulation. Keystone does not
maintain a competing class allowlist.

## 2. Inspect the exact staging request

The staging command is dry-run by default:

```text
npm.cmd run stage:migration-demo -- \
  --file outputs/servicenow-demo-imports/microsoft-workflow-msft-demo-20260722-01.json \
  --run-name DEMO-MSFT-500-20260722
```

It prints the exact file SHA-256, structured request SHA-256, counts, byte size,
and ServiceNow origin. It sends nothing without `--confirm-sha256`.

## 3. Land the dataset in ServiceNow staging

After checking the file, repeat the command with the exact displayed file hash:

```text
npm.cmd run stage:migration-demo -- \
  --file outputs/servicenow-demo-imports/microsoft-workflow-msft-demo-20260722-01.json \
  --run-name DEMO-MSFT-500-20260722 \
  --confirm-sha256 <EXACT_FILE_SHA256>
```

This call creates only a migration run and quarantined staging records. The
request forces `target=staging`, `mode=quarantine`, and
`directCmdbWrite=false`. It cannot approve, execute, verify, or write a CMDB
target table. ServiceNow queues Comprehend through the existing import contract.

## 4. Simulate and drain the run

1. Open the returned migration-run sys_id in Agent Workspace.
2. Wait for Comprehend and Prioritize evidence to finish.
3. Run bounded simulation campaigns until no record remains ready to simulate.
   Each child contains at most 20 records and simulation concurrency remains
   three.
4. Reconcile healthy `NO_CHANGE` outcomes through the ServiceNow-owned
   read-back. They never enter mutation packets.
5. Plan and prepare the next homogeneous mutation packet. Each parent contains
   at most 100 records across five children.
6. Stop on the complete freshly prepared 64-character packet hash.
7. Paste that exact hash in the UI, select `Authorize exact packet`, confirm the
   three checks are green, and approve once. The server recomputes the packet
   before issuing a one-time exact-hash capability; no restart is required.
8. Observe sequential individual approvals and ServiceNow-owned Phase D
   Execute/Verify chains. The one-time gate is consumed when approval begins.
9. Repeat packet planning until every staged record has a terminal outcome.

Completed records are excluded from later packet planning. The next packet is
derived from fresh ServiceNow evidence; a run never stops merely because one
100-record parent packet completed.

## 5. Prove terminal readiness

The readiness command derives expected total from the staged run when
`--expected-total` is omitted:

```text
npm.cmd run verify:live-demo -- --run <MIGRATION_RUN_SYS_ID>
```

For a known all-INSERT demo, bind the intended mix explicitly:

```text
npm.cmd run verify:live-demo -- \
  --run <MIGRATION_RUN_SYS_ID> \
  --expected-total 500 \
  --expect INSERT=500
```

Do not use `INSERT=500` unless ServiceNow simulations actually produced 500
fresh INSERT operations. Mixed runs should provide their real verified mix or
omit `--expect` while retaining the all-terminal checks.

The command fetches twice and fails on missing or duplicate terminal outcomes,
approval/Phase D correlation gaps, malformed targets, duplicate INSERT target
bindings, nonterminal work, or unstable refresh results.
