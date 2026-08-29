# Local memory: manual two-device workflow

This workflow transfers local SQLite memory through a reviewed, Git-tracked bundle. The CLI does not run Git, contact GitHub, sync automatically, or merge conflicting records.

The SQLite database is OS-local state outside the repository. The portable `scope` travels in the bundle; `--workspace` is an explicit local path that is canonicalized and bound only inside SQLite. It is never written to `manifest.json` or `records.jsonl`.

## Writer device

Start from the canonical `main` branch with a clean checkout that exactly matches the refreshed `origin/main`. Inspect the configured remote and refs before export:

```powershell
$workspace = (Get-Location).Path
if ((git branch --show-current) -ne 'main') { throw 'Memory export requires canonical main' }
if (git status --short) { throw 'Memory export requires a clean checkout' }
git remote -v
git remote get-url origin
git fetch --prune origin
$headBeforeExport = git rev-parse HEAD
$remoteMainBeforeExport = git rev-parse refs/remotes/origin/main
if ($headBeforeExport -ne $remoteMainBeforeExport) { throw 'Local main must be up to date with origin/main before export' }
```

Choose one configured `scope` and one permitted `writer` identity. Create an OS-local database directory and a Git-tracked bundle directory, then put, get, and export with an explicit workspace:

```powershell
$memoryRoot = Join-Path $env:LOCALAPPDATA 'D-AI-Hub\memory'
$database = Join-Path $memoryRoot 'memory.sqlite'
$bundle = Join-Path $workspace 'memory-bundles\note-2026-08-28'
New-Item -ItemType Directory -Force $memoryRoot, (Split-Path $bundle -Parent)

npm --silent run memory -- put --database $database --workspace $workspace --scope d-ai-hub --writer primary-device --mode writer --memory-id note-1 --value '{"text":"hello"}'
npm --silent run memory -- get --database $database --workspace $workspace --scope d-ai-hub --writer primary-device --mode reader --memory-id note-1
npm --silent run memory -- export --database $database --workspace $workspace --scope d-ai-hub --writer primary-device --mode reader --bundle $bundle --bundle-id bundle-2026-08-28 --created-at 2026-08-28T00:02:00.000Z
```

On Windows PowerShell, keep object JSON in single quotes and invoke the CLI through the documented `npm --silent run memory -- ...` path. Do not substitute a direct call to `node_modules\.bin\tsx.cmd` for commands containing inline object JSON: the Windows command wrapper can strip the embedded double quotes before the CLI receives the value. This limitation belongs to that direct wrapper invocation; the documented npm path preserves the JSON object.

Review the exact raw files before staging. Confirm the scope, writer, record count, values, digest, and absence of machine-local paths or secret-shaped content:

```powershell
$manifestFile = Join-Path $bundle 'manifest.json'
$recordsFile = Join-Path $bundle 'records.jsonl'
Get-Content -Raw $manifestFile
Get-Content -Raw $recordsFile
```

Stage only those two files, verify the exact staged-file set, review the staged bytes, then commit and push that exact current bundle commit to canonical `main`:

```powershell
$bundleFiles = @(
  ((Resolve-Path -Relative $manifestFile).TrimStart('.\') -replace '\\', '/'),
  ((Resolve-Path -Relative $recordsFile).TrimStart('.\') -replace '\\', '/')
)
git add -- $bundleFiles
$stagedFiles = @(git diff --cached --name-only)
$unexpectedStagedFiles = Compare-Object ($bundleFiles | Sort-Object) ($stagedFiles | Sort-Object)
if ($unexpectedStagedFiles) { throw 'The staged set is not exactly the two reviewed bundle files' }
git diff --cached -- $bundleFiles
git commit -m 'Transfer local memory bundle'
$bundleCommit = git rev-parse HEAD
git show --stat --oneline $bundleCommit
git push origin "${bundleCommit}:refs/heads/main"
git fetch origin main
if ((git rev-parse refs/remotes/origin/main) -ne $bundleCommit) { throw 'origin/main does not contain the exact bundle commit' }
```

These Git commands are manual operator instructions only; the memory CLI never invokes them. Give the verified `$bundleCommit` SHA to the reader operator.

## Reader device

Start from canonical `main` with a clean checkout. Inspect the remote, fetch it, require the writer's exact bundle commit at `origin/main`, then fast-forward pull and verify local `HEAD`:

```powershell
$workspace = (Get-Location).Path
$bundleCommit = '<verified writer bundle commit SHA>'
if ((git branch --show-current) -ne 'main') { throw 'Memory import requires canonical main' }
if (git status --short) { throw 'Memory import requires a clean checkout' }
git remote -v
git remote get-url origin
git fetch --prune origin
if ((git rev-parse refs/remotes/origin/main) -ne $bundleCommit) { throw 'origin/main is not the verified bundle commit' }
git pull --ff-only origin main
if ((git rev-parse HEAD) -ne $bundleCommit) { throw 'Local main is not the verified bundle commit' }
```

Review the exact pulled bundle again, then import into an OS-local reader database and retrieve the record:

```powershell
$memoryRoot = Join-Path $env:LOCALAPPDATA 'D-AI-Hub\memory'
$database = Join-Path $memoryRoot 'memory.sqlite'
$bundle = Join-Path $workspace 'memory-bundles\note-2026-08-28'
New-Item -ItemType Directory -Force $memoryRoot
Get-Content -Raw (Join-Path $bundle 'manifest.json')
Get-Content -Raw (Join-Path $bundle 'records.jsonl')

npm --silent run memory -- import --database $database --workspace $workspace --scope d-ai-hub --writer primary-device --mode reader --bundle $bundle
npm --silent run memory -- get --database $database --workspace $workspace --scope d-ai-hub --writer primary-device --mode reader --memory-id note-1
```

A valid import creates a missing local reader database with the configured writer and resolved workspace binding, then applies the whole bundle in one SQLite transaction. Invalid or tampered input is rejected before database initialization, so it returns `BLOCKED` without creating a missing database.

## Subsequent single-writer transfers

Use the `toSequence` from the last reviewed and transferred manifest as the next export cursor. Do not guess the cursor from filenames or skip a bundle. After the sole writer adds another record, export only records after that verified sequence:

```powershell
$previousToSequence = 1
$nextBundle = Join-Path $workspace 'memory-bundles\note-2026-08-29'

npm --silent run memory -- put --database $database --workspace $workspace --scope d-ai-hub --writer primary-device --mode writer --memory-id note-2 --value '{"text":"second"}'
npm --silent run memory -- export --database $database --workspace $workspace --scope d-ai-hub --writer primary-device --mode reader --bundle $nextBundle --bundle-id bundle-2026-08-29 --after-sequence $previousToSequence
```

Review, stage, commit, push, fetch, and verify the next bundle using the same exact two-file Git gate as the first transfer. Its non-empty manifest must start at `fromSequence = previousToSequence + 1`. On the reader, pull the verified commit and import bundles in sequence order. A missing predecessor, gap, or overlap returns `BLOCKED` without inserting records or an applied-bundle receipt. Re-importing an exact already-applied bundle remains `NOOP_DUPLICATE`.

## Expected responses

- A first valid import prints a JSON receipt with `"outcome":"IMPORTED"` and exits zero.
- Repeating the exact same bundle prints `"outcome":"NOOP_DUPLICATE"` and exits zero; no records are inserted again.
- A non-empty first bundle that does not start at sequence `1`, or a later bundle that does not start at the reader's current maximum sequence plus one, prints `"outcome":"BLOCKED"` and exits non-zero; no records or receipt are added.
- Tampered input, a scope/writer/workspace mismatch, a reused bundle ID with another digest, or a conflicting memory ID prints `"outcome":"BLOCKED"` and exits non-zero; the reader database is unchanged.
- A `put` run with `--mode reader` prints a blocked JSON error and exits non-zero; it does not modify SQLite.
