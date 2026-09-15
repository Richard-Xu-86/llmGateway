import { useEffect, useMemo, useState } from 'react';
import { Outlet, useMatch, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_RANGE, TIME_RANGES, type Stats } from '@gw/shared';
import { useAuth } from '../auth';
import { fetchModels, fetchStats } from '../lib/api';
import { RangeControls } from '../components/RangeControls';
import { hasSpan, readFilters, readRange } from '../lib/filters';
import { useLiveLogs, type Connection } from '../lib/useLiveLogs';
import { STATE_LABEL, ago, compact, outcomeColor } from '../lib/format';

const METHODS = ['POST', 'GET'];
const STATUS = ['2xx', '4xx', '5xx'];
const STATES = [
  ['completed', 'completed'],
  ['upstream_error', 'upstream error'],
  ['client_aborted', 'aborted'],
  ['truncated', 'truncated'],
] as const;

export function Requests() {
  const { apiKey } = useAuth();
  const key = apiKey!;
  const navigate = useNavigate();
  // Read the selection from the URL rather than component state — the URL is
  // the source of truth, which is what makes a detail view linkable.
  const selectedId = useMatch('/requests/:id')?.params.id;
  const [params, setParams] = useSearchParams();
  const [paused, setPaused] = useState(false);

  const filters = useMemo(() => readFilters(params), [params.toString()]);
  const range = readRange(params);
  const { rows, loading, connection, loadMore, hasMore, pending, loadFailed } = useLiveLogs(
    key,
    filters,
    paused,
  );

  const spanKey = `${filters.from ?? ''}-${filters.to ?? ''}`;

  const stats = useQuery({
    // The window is part of the key, so changing the range refetches rather
    // than showing an hour's numbers above a week's rows.
    queryKey: ['stats', key, range, spanKey, rows.length === 0],
    queryFn: () => fetchStats(key, TIME_RANGES[range], filters.from, filters.to),
    refetchInterval: 15_000,
  });
  const models = useQuery({ queryKey: ['models', key], queryFn: () => fetchModels(key) });

  // j / k move through the list — a devtool without keys feels unfinished.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key !== 'j' && e.key !== 'k') return;
      const i = rows.findIndex((r) => r.id === selectedId);
      const next = e.key === 'j' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
      const row = rows[i === -1 ? 0 : next];
      if (row) navigate({ pathname: `/requests/${row.id}`, search: params.toString() });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, selectedId, navigate, params]);

  function toggle(field: 'methods' | 'statusClasses' | 'terminalStates' | 'models', value: string) {
    const param = { methods: 'methods', statusClasses: 'status', terminalStates: 'states', models: 'models' }[field];
    const current = params.get(param)?.split(',').filter(Boolean) ?? [];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    const p = new URLSearchParams(params);
    if (next.length) p.set(param, next.join(','));
    else p.delete(param);
    setParams(p, { replace: true });
  }

  const isOn = (param: string, value: string) =>
    (params.get(param)?.split(',') ?? []).includes(value);

  const customSpan = hasSpan(filters);

  return (
    <>
      <RangeControls />
      <StatStrip pair={stats.data} range={range} custom={customSpan} />

      <Banner
        connection={connection}
        loadFailed={loadFailed}
        dropped={stats.data?.droppedRecords ?? 0}
      />

      <div className="panes">
        <section className="pane">
          <div className="panehead">
            <input
              className="field"
              placeholder="Filter by URL…"
              value={params.get('q') ?? ''}
              onChange={(e) => {
                const p = new URLSearchParams(params);
                if (e.target.value) p.set('q', e.target.value);
                else p.delete('q');
                setParams(p, { replace: true });
              }}
            />
            <button
              className={`chip ${paused ? 'on' : ''}`}
              onClick={() => setPaused((v) => !v)}
              title="Stops new rows being prepended; the stream stays connected"
            >
              {paused ? `Resume${pending ? ` ${pending}` : ''}` : 'Pause'}
            </button>
            <span
              className={`livedot ${
                connection === 'live' ? '' : connection === 'reconnecting' ? 'retry' : 'off'
              }`}
              title={
                connection === 'live'
                  ? 'Receiving live requests'
                  : connection === 'reconnecting'
                    ? 'Backend unreachable — reconnecting'
                    : 'Not connected'
              }
            />
          </div>

          <div className="filters">
            {METHODS.map((m) => (
              <button key={m} className={`chip tiny ${isOn('methods', m) ? 'on' : ''}`} onClick={() => toggle('methods', m)}>
                {m}
              </button>
            ))}
            {STATUS.map((s) => (
              <button key={s} className={`chip tiny ${isOn('status', s) ? 'on' : ''}`} onClick={() => toggle('statusClasses', s)}>
                {s}
              </button>
            ))}
            {STATES.map(([id, label]) => (
              <button key={id} className={`chip tiny ${isOn('states', id) ? 'on' : ''}`} onClick={() => toggle('terminalStates', id)}>
                {label}
              </button>
            ))}
            {(models.data?.models ?? []).map((m) => (
              <button key={m} className={`chip tiny ${isOn('models', m) ? 'on' : ''}`} onClick={() => toggle('models', m)}>
                {m}
              </button>
            ))}
          </div>

          <div className="scroll">
            {loading ? (
              <>
                <div className="skel w2" /><div className="skel w1" /><div className="skel w3" />
                <div className="skel w2" /><div className="skel w1" />
              </>
            ) : rows.length === 0 ? (
              <div className="empty">
                {loadFailed ? (
                  <>
                    Could not reach the log backend.
                    <br />
                    This is not &ldquo;no traffic&rdquo; — nothing was asked.
                  </>
                ) : (
                  <>
                    No requests in the last {range}.
                    <br />
                    Send one through the gateway and it appears here without a refresh.
                  </>
                )}
              </div>
            ) : (
              <>
                {rows.map((row) => (
                  <div
                    key={row.id}
                    className={`reqrow ${row.id === selectedId ? 'on' : ''}`}
                    onClick={() => navigate({ pathname: `/requests/${row.id}`, search: params.toString() })}
                  >
                    <span className="dot" style={{ background: outcomeColor(row) }} />
                    <div>
                      <div className="l1">
                        <span className="mono dim small">{row.method}</span>
                        <span className="path mono">{row.path}</span>
                      </div>
                      <div className="l2 mono">
                        {row.model ?? '—'} · {row.status}
                        {STATE_LABEL[row.terminalState] ? ` · ${STATE_LABEL[row.terminalState]}` : ''}
                      </div>
                    </div>
                    <div className="r">
                      <div className="d mono">{row.durationMs}ms</div>
                      <div className="t mono">{ago(row.startedAt)}</div>
                    </div>
                  </div>
                ))}
                {hasMore && (
                  <button className="loadmore" onClick={() => void loadMore()}>
                    Load older
                  </button>
                )}
              </>
            )}
          </div>
        </section>

        <section className="pane">
          <Outlet />
        </section>
      </div>
    </>
  );
}

/**
 * Says out loud when the table has stopped telling the truth.
 *
 * Two different silences look identical in a live view, and both used to be
 * invisible here: a backend that went away (rows stop arriving, which reads as
 * "no traffic"), and a gateway queue that overflowed (rows arrive, but some
 * never existed). An inspector that quietly under-reports is worse than one
 * that is obviously down, so both get said in words.
 */
function Banner({
  connection,
  loadFailed,
  dropped,
}: {
  connection: Connection;
  loadFailed: boolean;
  dropped: number;
}) {
  const offline = connection === 'closed' || connection === 'reconnecting' || loadFailed;

  if (!offline && dropped === 0) return null;

  return (
    <div className="banners">
      {offline && (
        <div className="banner warn">
          <span className="bdot" />
          <span>
            <b>Not receiving new requests.</b> The log backend is unreachable — rows shown are
            whatever arrived before it went away.
          </span>
          <span className="bnote">
            {connection === 'reconnecting' ? 'reconnecting…' : 'retrying'}
          </span>
        </div>
      )}
      {dropped > 0 && (
        <div className="banner warn">
          <span className="bdot" />
          <span>
            <b>{compact(dropped)} log records dropped.</b> The gateway's queue overflowed, so some
            requests were served but never recorded. Proxying was unaffected.
          </span>
        </div>
      )}
    </div>
  );
}

function StatStrip({
  pair,
  range,
  custom,
}: {
  pair?: { current: Stats; previous: Stats };
  range: string;
  /** A fixed span is active, so the header says "span" rather than "1h". */
  custom?: boolean;
}) {
  const cur = pair?.current;
  const prev = pair?.previous;

  const pctChange = (a?: number, b?: number) => {
    if (a === undefined || b === undefined || b === 0) return null;
    return ((a - b) / b) * 100;
  };

  const errRate = cur && cur.total > 0 ? (cur.errors / cur.total) * 100 : 0;
  const prevErrRate = prev && prev.total > 0 ? (prev.errors / prev.total) * 100 : 0;

  return (
    <div className="stats">
      <Kpi
        label={custom ? 'requests / span' : `requests / ${range}`}
        value={cur ? compact(cur.total) : '—'}
        delta={pctChange(cur?.total, prev?.total)}
        goodWhenUp
      />
      <Kpi label="not completed" value={cur ? `${errRate.toFixed(1)}%` : '—'} delta={errRate - prevErrRate} unit="pt" />
      <Kpi label="p50" value={cur ? `${cur.p50}` : '—'} suffix="ms" delta={pctChange(cur?.p50, prev?.p50)} />
      <Kpi label="p95" value={cur ? `${cur.p95}` : '—'} suffix="ms" delta={pctChange(cur?.p95, prev?.p95)} />
      <Kpi
        label="tokens in / out"
        value={cur ? `${compact(cur.promptTokens)} / ${compact(cur.completionTokens)}` : '—'}
      />
    </div>
  );
}

function Kpi({
  label,
  value,
  suffix,
  delta,
  unit = '%',
  goodWhenUp = false,
}: {
  label: string;
  value: string;
  suffix?: string;
  delta?: number | null;
  unit?: string;
  goodWhenUp?: boolean;
}) {
  // For latency and failures, down is good. For request volume, up is good.
  const tone =
    delta === null || delta === undefined || Math.abs(delta) < 0.05
      ? 'flat'
      : (delta > 0) === goodWhenUp
        ? 'up'
        : 'dn';

  return (
    <div className="kpi">
      <div className="row">
        <span className="num">
          {value}
          {suffix && <small> {suffix}</small>}
        </span>
        {delta !== null && delta !== undefined && Math.abs(delta) >= 0.05 && (
          <span className={`delta ${tone}`}>
            {delta > 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(unit === 'pt' ? 1 : 0)}
            {unit}
          </span>
        )}
      </div>
      <div className="lab">{label}</div>
    </div>
  );
}
