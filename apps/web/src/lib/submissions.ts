import { ApiError } from './api-error';

export type SubmissionKind = 'create-run' | 'cancel-run' | 'steer-run' | 'follow-up-run';
export type SubmissionState = 'pending' | 'uncertain' | 'failed';

export interface SubmissionMetadata {
  readonly [key: string]: string | number | boolean | null;
}

export interface SubmissionRecord {
  readonly version: 1;
  readonly key: string;
  readonly kind: SubmissionKind;
  readonly target: string;
  readonly requestDigest: string;
  readonly createdAt: string;
  readonly state: SubmissionState;
  readonly receiptId?: string;
  readonly metadata: SubmissionMetadata;
}

const STORAGE_PREFIX = 'pideck.submission.';
const submissionKinds: readonly SubmissionKind[] = [
  'create-run',
  'cancel-run',
  'steer-run',
  'follow-up-run',
];

export class SubmissionBlockedError extends Error {
  readonly code = 'submission_outcome_unknown';
  readonly submission: SubmissionRecord;

  constructor(submission: SubmissionRecord) {
    super('A previous submission for this target has an unresolved outcome. Retry it first.');
    this.name = 'SubmissionBlockedError';
    this.submission = submission;
  }
}

export function beginSubmission(
  kind: SubmissionKind,
  target: string,
  payload: unknown,
  metadata: SubmissionMetadata,
): SubmissionRecord {
  const digest = requestDigest(payload);
  const existing = readSubmission(kind, target);
  if (existing?.requestDigest === digest) return existing;
  if (existing && (existing.state === 'pending' || existing.state === 'uncertain')) {
    throw new SubmissionBlockedError(existing);
  }

  const submission: SubmissionRecord = {
    version: 1,
    key: createSubmissionKey(),
    kind,
    target,
    requestDigest: digest,
    createdAt: new Date().toISOString(),
    state: 'pending',
    metadata,
  };
  writeSubmission(submission);
  return submission;
}

export function markSubmissionUncertain(
  submission: SubmissionRecord,
  receiptId?: string,
): SubmissionRecord {
  return updateSubmission(submission, 'uncertain', receiptId);
}

export function markSubmissionFailed(
  submission: SubmissionRecord,
  receiptId?: string,
): SubmissionRecord {
  return updateSubmission(submission, 'failed', receiptId);
}

export function rememberSubmissionReceipt(
  submission: SubmissionRecord,
  receiptId: string | undefined,
): SubmissionRecord {
  return updateSubmission(submission, submission.state, receiptId);
}

export function completeSubmission(submission: SubmissionRecord): void {
  removeSubmission(submission.kind, submission.target, submission.key);
}

export function readSubmissions(): SubmissionRecord[] {
  const storage = getStorage();
  if (!storage) return [];
  const records: SubmissionRecord[] = [];
  for (const kind of submissionKinds) {
    for (let index = 0; index < storage.length; index += 1) {
      const storageKey = storage.key(index);
      if (!storageKey?.startsWith(`${STORAGE_PREFIX}${kind}.`)) continue;
      const record = parseSubmission(storage.getItem(storageKey));
      if (record?.kind === kind) records.push(record);
    }
  }
  return records;
}

export function isUncertainSubmissionError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return (
    error.status >= 500 ||
    error.code === 'idempotency_in_progress' ||
    error.code === 'command_outcome_unknown' ||
    error.code === 'supervisor_unavailable'
  );
}

export function requestDigest(value: unknown): string {
  const text = stableJson(value);
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

function updateSubmission(
  submission: SubmissionRecord,
  state: SubmissionState,
  receiptId?: string,
): SubmissionRecord {
  const updated: SubmissionRecord = {
    ...submission,
    state,
    ...(receiptId === undefined ? {} : { receiptId }),
  };
  const current = readSubmission(submission.kind, submission.target);
  if (current?.key === submission.key) writeSubmission(updated);
  return updated;
}

function readSubmission(kind: SubmissionKind, target: string): SubmissionRecord | undefined {
  const storage = getStorage();
  if (!storage) return undefined;
  return parseSubmission(storage.getItem(storageKey(kind, target)));
}

function writeSubmission(submission: SubmissionRecord): void {
  getStorage()?.setItem(storageKey(submission.kind, submission.target), JSON.stringify(submission));
}

function removeSubmission(kind: SubmissionKind, target: string, key: string): void {
  const storage = getStorage();
  if (parseSubmission(storage?.getItem(storageKey(kind, target)))?.key === key) {
    storage?.removeItem(storageKey(kind, target));
  }
}

function storageKey(kind: SubmissionKind, target: string): string {
  return `${STORAGE_PREFIX}${kind}.${target}`;
}

function parseSubmission(value: string | null): SubmissionRecord | undefined {
  if (!value) return undefined;
  try {
    const candidate: unknown = JSON.parse(value);
    if (!isRecord(candidate)) return undefined;
    if (
      candidate.version !== 1 ||
      typeof candidate.key !== 'string' ||
      !submissionKinds.includes(candidate.kind as SubmissionKind) ||
      typeof candidate.target !== 'string' ||
      typeof candidate.requestDigest !== 'string' ||
      typeof candidate.createdAt !== 'string' ||
      !['pending', 'uncertain', 'failed'].includes(String(candidate.state)) ||
      !isMetadata(candidate.metadata)
    ) {
      return undefined;
    }
    return {
      version: 1,
      key: candidate.key,
      kind: candidate.kind as SubmissionKind,
      target: candidate.target,
      requestDigest: candidate.requestDigest,
      createdAt: candidate.createdAt,
      state: candidate.state as SubmissionState,
      ...(typeof candidate.receiptId === 'string' ? { receiptId: candidate.receiptId } : {}),
      metadata: candidate.metadata,
    };
  } catch {
    return undefined;
  }
}

function isMetadata(value: unknown): value is SubmissionMetadata {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (item) =>
      item === null ||
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

function createSubmissionKey(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getStorage(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}
