import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_QUEUE_PATH = path.join(os.homedir(), '.hermes', 'managed-browser', 'jobs.jsonl');
const TERMINAL_STATUSES = new Set(['succeeded', 'failed']);

function resolveQueuePath(explicitPath) {
  return explicitPath || process.env.MANAGED_BROWSER_JOB_QUEUE_PATH || DEFAULT_QUEUE_PATH;
}

function toIsoTime(now) {
  const value = typeof now === 'function' ? now() : Date.now();
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function normalizeError(error) {
  if (!error) return null;
  if (typeof error === 'string') return { message: error };
  if (typeof error === 'object') {
    return {
      name: error.name || undefined,
      message: error.message || String(error),
      code: error.code || undefined,
    };
  }
  return { message: String(error) };
}

async function appendJsonLine(queuePath, record) {
  await fs.mkdir(path.dirname(queuePath), { recursive: true });
  await fs.appendFile(queuePath, `${JSON.stringify(record)}\n`, 'utf8');
}

async function readRecords(queuePath) {
  let source;
  try {
    source = await fs.readFile(queuePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { records: [], warnings: [] };
    }
    throw error;
  }

  const records = [];
  const warnings = [];
  const lines = source.split('\n');

  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === 'object' && record.id) {
        records.push(record);
      } else {
        warnings.push(`Ignored invalid JSONL line ${index + 1}: missing job id`);
      }
    } catch (error) {
      warnings.push(`Ignored invalid JSONL line ${index + 1}: ${error.message}`);
    }
  });

  return { records, warnings };
}

function collapseLatestJobs(records, warnings) {
  const jobsById = new Map();
  const order = [];

  for (const record of records) {
    if (!jobsById.has(record.id)) {
      order.push(record.id);
    }
    const previous = jobsById.get(record.id) || {};
    jobsById.set(record.id, { ...previous, ...record });
  }

  return order.map((id) => {
    const job = jobsById.get(id);
    return warnings.length > 0 ? { ...job, warnings: [...warnings] } : job;
  });
}

async function latestJobById(queuePath, id) {
  const { records, warnings } = await readRecords(queuePath);
  const job = collapseLatestJobs(records, warnings).find((candidate) => candidate.id === id);
  if (!job) {
    throw new Error(`Managed browser job not found: ${id}`);
  }
  return job;
}

function withoutWarnings(job) {
  const { warnings, ...cleanJob } = job;
  return cleanJob;
}

function createTransition(previousJob, status, now, patch = {}) {
  if (TERMINAL_STATUSES.has(previousJob.status)) {
    throw new Error(`Managed browser job ${previousJob.id} is already ${previousJob.status}`);
  }

  return {
    ...withoutWarnings(previousJob),
    ...patch,
    status,
    updated_at: toIsoTime(now),
  };
}

export function createManagedBrowserJobQueue(options = {}) {
  const queuePath = resolveQueuePath(options.path);
  const now = options.now;

  return {
    path: queuePath,

    async enqueue(input = {}) {
      const timestamp = toIsoTime(now);
      const job = {
        id: input.id || randomUUID(),
        created_at: timestamp,
        updated_at: timestamp,
        operation: input.operation,
        profile: input.profile,
        site: input.site,
        payload: input.payload ?? {},
        status: 'pending',
        result: null,
        error: null,
        llm_used: Boolean(input.llm_used),
      };

      await appendJsonLine(queuePath, job);
      return job;
    },

    async list() {
      const { records, warnings } = await readRecords(queuePath);
      return collapseLatestJobs(records, warnings);
    },

    async markRunning(id, updates = {}) {
      const previous = await latestJobById(queuePath, id);
      const next = createTransition(previous, 'running', now, {
        result: null,
        error: null,
        llm_used: updates.llm_used ?? previous.llm_used ?? false,
      });
      await appendJsonLine(queuePath, next);
      return next;
    },

    async markSucceeded(id, result = {}) {
      const previous = await latestJobById(queuePath, id);
      const next = createTransition(previous, 'succeeded', now, {
        result,
        error: null,
      });
      await appendJsonLine(queuePath, next);
      return next;
    },

    async markFailed(id, error) {
      const previous = await latestJobById(queuePath, id);
      const next = createTransition(previous, 'failed', now, {
        result: null,
        error: normalizeError(error),
      });
      await appendJsonLine(queuePath, next);
      return next;
    },
  };
}
