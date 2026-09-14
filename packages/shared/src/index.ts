import { z } from 'zod';

/**
 * How a request ended.
 *
 * An HTTP status is committed to the wire before a streamed body exists, so a
 * stream that dies at token 400 is still `200 OK`. This field is the gateway's
 * own verdict, and it is the reason the dashboard can answer "which streams
 * broke?" — a question OpenAI's status codes cannot.
 */
export const TerminalState = z.enum([
  'completed', // non-streaming 2xx, or a stream that reached [DONE]
  'client_aborted', // caller hung up mid-stream; upstream was cancelled
  'upstream_error', // non-2xx, or an error object arriving in-band after 200
  'truncated', // stream ended without [DONE] and without an error
]);
export type TerminalState = z.infer<typeof TerminalState>;

/** The wire contract between gateway, backend and dashboard. Change it here only. */
export const LogRecord = z.object({
  id: z.string(),
  apiKeyId: z.string(),
  apiKeyName: z.string(),

  startedAt: z.number(),
  method: z.string(),
  /**
   * The URL the caller requested, as it arrived at the proxy. This is the
   * request being intercepted, so it is what `url` means everywhere: it is
   * what the URL filter searches and what "copy as cURL" reproduces.
   */
  url: z.string(),
  /**
   * Where the gateway forwarded it. Distinct from `url` and worth keeping
   * separately — every upstream shares the same paths, so this is the only
   * field that distinguishes a call that reached api.openai.com from one that
   * hit the local mock.
   *
   * Nullable because rows written before this field existed have no value for
   * it; the column was added by migration rather than by dropping the table.
   */
  upstreamUrl: z.string().nullable(),
  path: z.string(),
  model: z.string().nullable(),
  isStream: z.boolean(),

  requestHeaders: z.record(z.string()),
  requestBody: z.string().nullable(),
  requestBodyTruncated: z.boolean(),

  status: z.number(),
  responseHeaders: z.record(z.string()),
  /** Reassembled assistant text for streams; the raw body otherwise. */
  responseBody: z.string().nullable(),
  responseBodyTruncated: z.boolean(),

  durationMs: z.number(),
  /** Time to first token. Streams only. */
  ttftMs: z.number().nullable(),
  chunkCount: z.number().nullable(),
  promptTokens: z.number().nullable(),
  completionTokens: z.number().nullable(),

  terminalState: TerminalState,
  finishReason: z.string().nullable(),
  error: z.string().nullable(),
});
export type LogRecord = z.infer<typeof LogRecord>;

export const IngestBatch = z.object({
  records: z.array(LogRecord),
  /**
   * Running total of records the gateway's queue has dropped under
   * back-pressure. Monotonic, so it rides along with every batch and needs no
   * separate channel: if the backend is the thing that was down, the count
   * arrives on the first batch that gets through.
   *
   * Silent log loss is the failure mode of every buffered logging system. This
   * is what makes it not silent.
   */
  droppedTotal: z.number().optional(),
});
export type IngestBatch = z.infer<typeof IngestBatch>;

/**
 * The time windows the dashboard offers, shared so the UI and the API cannot
 * drift. Order is the order the chips render in.
 */
export const TIME_RANGES = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
} as const;
export type TimeRange = keyof typeof TIME_RANGES;
export const DEFAULT_RANGE: TimeRange = '1h';
export const isTimeRange = (v: string | null | undefined): v is TimeRange =>
  v !== null && v !== undefined && v in TIME_RANGES;

/**
 * Headers replaced with "[redacted]" before a record is ever stored.
 * The upstream OpenAI key lives in exactly one place: the gateway process.
 */
export const REDACTED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'api-key',
  'x-api-key',
  'cookie',
  'set-cookie',
]);

/** Bodies above this are stored truncated with a flag, so one 40MB payload cannot wedge the DB. */
export const MAX_STORED_BODY_BYTES = 256 * 1024;

export function redactHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const entries =
    headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  const out: Record<string, string> = {};
  for (const [rawKey, value] of entries) {
    const key = rawKey.toLowerCase();
    out[key] = REDACTED_HEADERS.has(key) ? '[redacted]' : value;
  }
  return out;
}

export function truncateBody(body: string | null): { body: string | null; truncated: boolean } {
  if (body === null) return { body: null, truncated: false };
  if (Buffer.byteLength(body, 'utf8') <= MAX_STORED_BODY_BYTES) {
    return { body, truncated: false };
  }
  const slice = Buffer.from(body, 'utf8').subarray(0, MAX_STORED_BODY_BYTES).toString('utf8');
  return { body: slice, truncated: true };
}

/* ---------------------------------------------------------------------------
 * View types.
 *
 * The dashboard imports these with `import type`, so nothing here reaches a
 * browser bundle. They live in shared for the same reason LogRecord does: the
 * backend produces them and the dashboard consumes them, and a drift between
 * those two is a bug nobody notices until a column is silently empty.
 * ------------------------------------------------------------------------ */

/** The list view never ships bodies or headers — those arrive when a row is opened. */
export interface LogSummary {
  id: string;
  startedAt: number;
  method: string;
  path: string;
  model: string | null;
  isStream: boolean;
  status: number;
  durationMs: number;
  ttftMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  terminalState: string;
  apiKeyName: string;
}

export interface Filters {
  methods?: string[];
  statusClasses?: string[]; // '2xx' | '4xx' | '5xx'
  terminalStates?: string[];
  models?: string[];
  /** substring match on the URL */
  q?: string;
  /**
   * Look-back window in ms, relative rather than absolute on purpose: an
   * anchored `since` timestamp would freeze "the last hour" at the moment the
   * chip was clicked, and the view would go stale while you watched it.
   */
  windowMs?: number;
}

export interface Page {
  rows: LogSummary[];
  nextCursor: string | null;
}

export interface Stats {
  total: number;
  errors: number;
  p50: number;
  p95: number;
  promptTokens: number;
  completionTokens: number;
}

export interface StatsResponse {
  current: Stats;
  previous: Stats;
  /** Records the gateway had to drop; anything above zero means logs are lost. */
  droppedRecords: number;
}
