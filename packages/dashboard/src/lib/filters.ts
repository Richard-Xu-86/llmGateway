import { DEFAULT_RANGE, TIME_RANGES, isTimeRange, type Filters } from '@gw/shared';

/**
 * Filter state lives in the query string, not in component state.
 *
 * That is what makes a view a link — and now that Requests and Analytics both
 * read the same span, it is also what keeps them agreeing. Moving between the
 * two pages carries the window with you, because neither page owns it.
 */

export const RANGES = Object.keys(TIME_RANGES) as Array<keyof typeof TIME_RANGES>;

/** Milliseconds from a `datetime-local` value, or undefined if it is not one. */
export const parseLocal = (v: string | null): number | undefined => {
  if (!v) return undefined;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : undefined;
};

/** Back to the `YYYY-MM-DDTHH:mm` the input expects, in the viewer's own zone. */
export const toLocalInput = (ms: number | undefined): string => {
  if (ms === undefined) return '';
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

export function readSpan(p: URLSearchParams): { from?: number; to?: number } {
  const from = parseLocal(p.get('from'));
  const to = parseLocal(p.get('to'));
  return { ...(from !== undefined && { from }), ...(to !== undefined && { to }) };
}

export const readRange = (p: URLSearchParams) => {
  const r = p.get('range');
  return isTimeRange(r) ? r : DEFAULT_RANGE;
};

export function readFilters(p: URLSearchParams): Filters {
  const list = (k: string) => p.get(k)?.split(',').filter(Boolean);
  return {
    methods: list('methods'),
    statusClasses: list('status'),
    terminalStates: list('states'),
    models: list('models'),
    q: p.get('q') ?? undefined,
    // The window travels as a duration, not a timestamp, so "last 24h" keeps
    // meaning the last 24 hours for as long as the tab is open.
    windowMs: TIME_RANGES[readRange(p)],
    // …unless an explicit span is set, which is the opposite requirement:
    // "between 14:00 and 15:30 on Tuesday" must not move as time passes.
    ...readSpan(p),
  };
}

/** True when a fixed span is governing the query rather than a relative chip. */
export const hasSpan = (f: Filters) => f.from !== undefined || f.to !== undefined;
