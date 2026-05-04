# Managed Browser Local Job Queue

The managed-browser queue is an optional local persistence layer for deferred CLI jobs. It is meant to complement the direct managed-browser API, not replace it.

Use the raw API for ordinary status, snapshot, navigation, and short interactive actions. Use the queue for long-running or sensitive side-effect flows where a CLI should record intent and later reconcile the outcome, for example checkout, login recovery, account changes, or other operations that may require human review or LLM-assisted repair.

## Current storage

The initial implementation intentionally avoids native dependencies. There is no bundled SQLite package. Jobs are stored as JSON Lines at:

- `MANAGED_BROWSER_JOB_QUEUE_PATH`, when set
- otherwise `~/.hermes/managed-browser/jobs.jsonl`

Each write appends a complete JSON object. Readers collapse records by `id` and return the latest state for each job. This is append-safe enough for local CLI usage and keeps invalid lines in place instead of rewriting the file.

This format is deliberately small and replaceable. A future SQLite-backed implementation can keep the same high-level queue API while adding stronger locking, indexing, and concurrent worker coordination.

## API

`lib/managed-browser-job-queue.js` exports:

```js
import { createManagedBrowserJobQueue } from './lib/managed-browser-job-queue.js';

const queue = createManagedBrowserJobQueue({
  path: '/optional/custom/jobs.jsonl',
  now: () => Date.now(),
});
```

Options:

- `path`: optional queue file path. Defaults to `MANAGED_BROWSER_JOB_QUEUE_PATH` or `~/.hermes/managed-browser/jobs.jsonl`.
- `now`: optional clock injection for tests.

Methods:

- `enqueue({ operation, profile, site, payload, llm_used })`
- `list()`
- `markRunning(id, { llm_used })`
- `markSucceeded(id, result)`
- `markFailed(id, error)`

## Job shape

Jobs include:

```js
{
  id: 'uuid-or-caller-provided-id',
  created_at: '2026-04-29T15:53:00.000Z',
  updated_at: '2026-04-29T15:53:00.000Z',
  operation: 'checkout',
  profile: 'leboncoin-cim',
  site: 'leboncoin.fr',
  payload: {},
  status: 'pending', // pending | running | succeeded | failed
  result: null,
  error: null,
  llm_used: false
}
```

`markSucceeded` stores a result object and clears `error`. `markFailed` stores normalized error details and clears `result`. `markRunning` can update `llm_used` when an LLM-assisted worker takes over.

## Invalid lines and missing files

A missing queue file is treated as an empty queue.

Invalid JSONL lines are ignored during reads and preserved on disk. When invalid lines are encountered, returned jobs include a `warnings` array such as `Ignored invalid JSONL line 1: ...` so a CLI can surface local store corruption without losing data.

## Intended usage

The queue should be used for deferred, auditable managed-browser actions:

1. CLI validates user intent and enqueues a job.
2. A local worker marks it `running` before executing managed-browser API calls.
3. The worker records `succeeded` or `failed` with result/error details.
4. The CLI lists jobs for audit/retry decisions.

Do not use this queue as the main path for live page state. Status checks, snapshots, tab operations, and fast read-only inspection should continue to use the managed-browser API directly.
