import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { TIME_RANGES, type Stats } from '@gw/shared';
import { Analytics as Charts } from '../components/Analytics';
import { RangeControls } from '../components/RangeControls';
import { useAuth } from '../auth';
import { fetchSeries, fetchStats } from '../lib/api';
import { hasSpan, readFilters, readRange } from '../lib/filters';
import { compact } from '../lib/format';

/**
 * Its own page, not a strip above the table.
 *
 * The two answer different questions and are used at different moments. The
 * table is "find me that one request"; this is "what has been happening". Stacked
 * on one screen the charts pushed the rows below the fold and neither had room
 * — and a chart you have to scroll past to reach the thing you came for is a
 * cost, not a feature.
 *
 * They still share the time selector through the query string, so noticing a
 * spike here and going to look at the rows behind it keeps the same window.
 */
export function Analytics() {
  const { apiKey } = useAuth();
  const key = apiKey!;
  const [params] = useSearchParams();

  const filters = useMemo(() => readFilters(params), [params.toString()]);
  const range = readRange(params);
  const spanKey = `${filters.from ?? ''}-${filters.to ?? ''}`;

  const series = useQuery({
    queryKey: ['series', key, range, spanKey],
    queryFn: () => fetchSeries(key, TIME_RANGES[range], filters.from, filters.to),
    refetchInterval: 30_000,
  });

  const stats = useQuery({
    queryKey: ['stats', key, range, spanKey],
    queryFn: () => fetchStats(key, TIME_RANGES[range], filters.from, filters.to),
    refetchInterval: 30_000,
  });

  const cur = stats.data?.current;
  const prev = stats.data?.previous;
  const label = hasSpan(filters) ? 'the selected span' : `the last ${range}`;

  // Filters other than time are the table's business, not the chart's — but
  // they change what the numbers mean, so say so rather than quietly differing.
  const narrowed =
    filters.q || filters.methods?.length || filters.statusClasses?.length ||
    filters.terminalStates?.length || filters.models?.length;

  return (
    <div className="analyticspage">
      <header className="pagehead">
        <div>
          <h2>Analytics</h2>
          <p className="dim small">Traffic, failures, latency and token spend over {label}.</p>
        </div>
        <RangeControls />
      </header>

      <div className="tiles">
        <Tile label="requests" value={cur ? compact(cur.total) : '—'} prev={prev?.total} cur={cur?.total} />
        <Tile
          label="not completed"
          value={cur ? `${rate(cur)}%` : '—'}
          hint="includes a 200 that died mid-stream"
        />
        <Tile label="p50" value={cur ? `${cur.p50} ms` : '—'} prev={prev?.p50} cur={cur?.p50} lowerIsBetter />
        <Tile label="p95" value={cur ? `${cur.p95} ms` : '—'} prev={prev?.p95} cur={cur?.p95} lowerIsBetter />
        <Tile
          label="tokens in / out"
          value={cur ? `${compact(cur.promptTokens)} / ${compact(cur.completionTokens)}` : '—'}
        />
      </div>

      {narrowed && (
        <p className="dim small notice">
          The charts cover every request in this window. The filters you set on{' '}
          <Link to={{ pathname: '/requests', search: params.toString() }}>Requests</Link> narrow the
          table only.
        </p>
      )}

      <div className="pane">
        {series.data ? (
          <Charts series={series.data} />
        ) : (
          <div className="analytics empty">
            <p>
              {series.isError
                ? 'Could not load analytics — is the backend running?'
                : 'Loading analytics…'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

const rate = (s: Stats) => (s.total === 0 ? '0.0' : ((s.errors / s.total) * 100).toFixed(1));

function Tile({
  label,
  value,
  cur,
  prev,
  hint,
  lowerIsBetter,
}: {
  label: string;
  value: string;
  cur?: number;
  prev?: number;
  hint?: string;
  lowerIsBetter?: boolean;
}) {
  // A number on its own is a number. Against the window before it, it is news.
  const delta =
    cur === undefined || prev === undefined || prev === 0
      ? null
      : Math.round(((cur - prev) / prev) * 100);
  const good = delta === null ? null : lowerIsBetter ? delta <= 0 : delta >= 0;

  return (
    <div className="tile">
      <div className="tile-v">{value}</div>
      <div className="tile-k">
        {label}
        {delta !== null && (
          <span className={`tile-d ${good ? 'up' : 'down'}`}>
            {delta > 0 ? '▲' : delta < 0 ? '▼' : ''} {Math.abs(delta)}%
          </span>
        )}
      </div>
      {hint && <div className="tile-h">{hint}</div>}
    </div>
  );
}
