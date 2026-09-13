import type { LogSummary } from '@gw/shared';

export const ago = (ts: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
};

export const ms = (n: number | null): string => (n === null ? '—' : `${n}ms`);

export const compact = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export const STATE_LABEL: Record<string, string> = {
  completed: '',
  upstream_error: 'upstream error',
  client_aborted: 'aborted',
  truncated: 'truncated',
};

/** One colour vocabulary for outcome, used by the dot, the bar and the text. */
export function outcomeColor(row: Pick<LogSummary, 'terminalState' | 'status'>): string {
  if (row.terminalState === 'completed') return 'var(--ok)';
  if (row.terminalState === 'client_aborted') return '#85858f';
  if (row.terminalState === 'truncated') return 'var(--warn)';
  return 'var(--bad)';
}

export function outcomeClass(terminalState: string): string {
  if (terminalState === 'completed') return '';
  if (terminalState === 'client_aborted') return 'grey';
  if (terminalState === 'truncated') return 'warn';
  return 'bad';
}
