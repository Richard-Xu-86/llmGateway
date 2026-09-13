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
  url: z.string(),
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

export const IngestBatch = z.object({ records: z.array(LogRecord) });
export type IngestBatch = z.infer<typeof IngestBatch>;

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
