import type { Filters, LogRecord, Page, Series, Stats } from '@gw/shared';

/**
 * The gateway key is the dashboard's login.
 *
 * One credential for both proxying and inspection: whoever holds the key owns
 * the traffic made with it, which is exactly the boundary the backend enforces.
 */
const STORAGE_KEY = 'gw.key';

export const loadKey = (): string | null => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // private window / blocked storage — sign in again
  }
};
export const saveKey = (key: string) => {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    /* not fatal */
  }
};
export const clearKey = () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* not fatal */
  }
};

/**
 * Carries the status so callers can tell "you are wrong" from "I am broken".
 * `status` is null when the request never reached the server at all.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

async function get<T>(key: string, path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { authorization: `Bearer ${key}` } });
  } catch {
    throw new ApiError('backend unreachable', null);
  }
  if (!res.ok) throw new ApiError(`request failed: ${res.status}`, res.status);
  return res.json() as Promise<T>;
}

export interface Me {
  name: string;
  last4: string;
}
export interface StatsPair {
  current: Stats;
  previous: Stats;
  droppedRecords: number;
}

export const verifyKey = (key: string) => get<Me>(key, '/api/me');
/** The stats strip and the charts read the same span as the table below them. */
const spanQuery = (windowMs?: number, from?: number, to?: number): string => {
  const p = new URLSearchParams();
  if (from !== undefined) p.set('from', String(from));
  if (to !== undefined) p.set('to', String(to));
  if (from === undefined && to === undefined && windowMs) p.set('windowMs', String(windowMs));
  return p.toString();
};

export const fetchStats = (key: string, windowMs?: number, from?: number, to?: number) =>
  get<StatsPair>(key, `/api/stats?${spanQuery(windowMs, from, to)}`);

export const fetchSeries = (key: string, windowMs?: number, from?: number, to?: number) =>
  get<Series>(key, `/api/series?${spanQuery(windowMs, from, to)}`);
export const fetchModels = (key: string) => get<{ models: string[] }>(key, '/api/models');
export const fetchLog = (key: string, id: string) => get<LogRecord>(key, `/api/logs/${id}`);

export function filtersToQuery(filters: Filters, cursor?: string | null, limit = 50): string {
  const p = new URLSearchParams();
  if (filters.methods?.length) p.set('methods', filters.methods.join(','));
  if (filters.statusClasses?.length) p.set('status', filters.statusClasses.join(','));
  if (filters.terminalStates?.length) p.set('states', filters.terminalStates.join(','));
  if (filters.models?.length) p.set('models', filters.models.join(','));
  if (filters.q) p.set('q', filters.q);
  if (filters.windowMs) p.set('windowMs', String(filters.windowMs));
  // An explicit span overrides the window server-side; both are sent so the
  // server decides, rather than the client guessing at the precedence.
  if (filters.from !== undefined) p.set('from', String(filters.from));
  if (filters.to !== undefined) p.set('to', String(filters.to));
  if (cursor) p.set('cursor', cursor);
  p.set('limit', String(limit));
  return p.toString();
}

export const fetchLogs = (key: string, filters: Filters, cursor?: string | null) =>
  get<Page>(key, `/api/logs?${filtersToQuery(filters, cursor)}`);

/**
 * Reconstructs the call as the caller made it, key elided.
 *
 * `record.url` and not `record.upstreamUrl`: the point is a command you can
 * paste and re-run, which means it has to go back through the gateway with a
 * gateway key. Aimed at the upstream it would be a request to OpenAI carrying
 * the wrong credential — a command that looks right and always fails.
 */
/**
 * Headers that were worth *recording* but must not be replayed.
 *
 * The captured set is deliberately everything-minus-secrets, which is right for
 * a log and wrong for a command. Three reasons a header gets dropped here:
 *
 *  - curl owns it. `content-length` is the dangerous one: it is correct until
 *    you edit the body, which is the main reason to copy the command at all.
 *    Edit the prompt and the server reads only the declared bytes, leaving
 *    truncated JSON or a hung request.
 *  - it describes a connection that no longer exists (`connection`, `host`).
 *  - it is the client describing itself. The `x-stainless-*` block is the SDK
 *    reporting its OS, arch and Node version; you are a terminal now.
 */
const CURL_SKIP = new Set([
  'authorization', // replaced with the env var below
  'host',
  'content-length',
  'connection',
  'accept-encoding',
  'accept-language',
]);
const CURL_SKIP_PREFIXES = ['sec-', 'x-stainless-'];

export function toCurl(record: LogRecord): string {
  const lines = [`curl -N ${record.url} \\`, `  -H "Authorization: Bearer $GATEWAY_API_KEY" \\`];
  for (const [name, value] of Object.entries(record.requestHeaders)) {
    if (CURL_SKIP.has(name) || CURL_SKIP_PREFIXES.some((p) => name.startsWith(p))) continue;
    lines.push(`  -H "${name}: ${value}" \\`);
  }
  if (record.requestBody) lines.push(`  -d '${record.requestBody.replace(/'/g, "'\\''")}'`);
  else lines[lines.length - 1] = lines[lines.length - 1]!.replace(/ \\$/, '');
  return lines.join('\n');
}
