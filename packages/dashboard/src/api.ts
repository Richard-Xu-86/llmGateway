import type { Filters, LogRecord, Page, Stats } from '@gw/shared';

/**
 * The gateway key is the dashboard's login.
 *
 * One credential for both proxying and inspection: whoever holds the key owns
 * the traffic made with it, which is exactly the boundary the backend enforces.
 * Kept in localStorage so a refresh does not log you out; it never leaves this
 * origin, and the backend never returns it.
 */
const STORAGE_KEY = 'gw.key';

export const loadKey = (): string | null => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // private window, blocked storage — fall back to signing in again
  }
};

export const saveKey = (key: string): void => {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    /* not fatal */
  }
};

export const clearKey = (): void => {
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

export const verifyKey = (key: string) => get<{ name: string; last4: string }>(key, '/api/me');

export function filtersToQuery(filters: Filters, cursor?: string | null, limit = 50): string {
  const params = new URLSearchParams();
  if (filters.methods?.length) params.set('methods', filters.methods.join(','));
  if (filters.statusClasses?.length) params.set('status', filters.statusClasses.join(','));
  if (filters.terminalStates?.length) params.set('states', filters.terminalStates.join(','));
  if (filters.models?.length) params.set('models', filters.models.join(','));
  if (filters.q) params.set('q', filters.q);
  if (cursor) params.set('cursor', cursor);
  params.set('limit', String(limit));
  return params.toString();
}

export const fetchLogs = (key: string, filters: Filters, cursor?: string | null) =>
  get<Page>(key, `/api/logs?${filtersToQuery(filters, cursor)}`);

export const fetchLog = (key: string, id: string) => get<LogRecord>(key, `/api/logs/${id}`);

export const fetchStats = (key: string) => get<Stats>(key, '/api/stats');

export const fetchModels = (key: string) => get<{ models: string[] }>(key, '/api/models');

/** Reconstructs the call as the caller would have made it, key elided. */
export function toCurl(record: LogRecord): string {
  const lines = [`curl -N ${record.url} \\`, `  -H "Authorization: Bearer $GATEWAY_API_KEY" \\`];
  for (const [name, value] of Object.entries(record.requestHeaders)) {
    if (name === 'authorization' || name === 'host' || name.startsWith('sec-')) continue;
    lines.push(`  -H "${name}: ${value}" \\`);
  }
  if (record.requestBody) {
    lines.push(`  -d '${record.requestBody.replace(/'/g, "'\\''")}'`);
  } else {
    lines[lines.length - 1] = lines[lines.length - 1]!.replace(/ \\$/, '');
  }
  return lines.join('\n');
}
