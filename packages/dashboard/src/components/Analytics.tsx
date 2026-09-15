import { useRef, useState } from 'react';
import type { Bucket, Series } from '@gw/shared';

/**
 * Traffic, failures, latency and spend over the selected span.
 *
 * Three charts rather than one, because they carry three different units.
 * Putting requests and milliseconds on one plot needs two y-scales, and a
 * dual-axis chart lets you imply any correlation you like by choosing where the
 * scales cross. They share an x-axis and a single crosshair instead, which
 * gives the same "did these move together?" reading without the lie.
 *
 * Latency is drawn with gaps rather than interpolated across empty buckets: a
 * line joined straight through an outage hides the exact thing being looked for.
 */

const W = 1000;
const H = 104;
const PAD_T = 10;
const PAD_B = 16;
const PLOT = H - PAD_T - PAD_B;

const x = (i: number, n: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
const y = (v: number, max: number) => PAD_T + PLOT - (max <= 0 ? 0 : (v / max) * PLOT);

/** An area from the baseline, and the line that caps it. */
function shape(values: number[], max: number): { area: string; line: string } {
  const n = values.length;
  if (n === 0) return { area: '', line: '' };
  const pts = values.map((v, i) => `${x(i, n).toFixed(2)},${y(v, max).toFixed(2)}`);
  return {
    area: `M0,${PAD_T + PLOT} L${pts.join(' L')} L${W},${PAD_T + PLOT} Z`,
    line: `M${pts.join(' L')}`,
  };
}

/**
 * A line broken into runs of consecutive non-null values, so empty buckets
 * become gaps instead of a straight line drawn through them.
 */
function brokenLine(values: Array<number | null>, max: number): string[] {
  const n = values.length;
  const runs: string[] = [];
  let run: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (run.length > 1) runs.push(`M${run.join(' L')}`);
      run = [];
      return;
    }
    run.push(`${x(i, n).toFixed(2)},${y(v, max).toFixed(2)}`);
  });
  if (run.length > 1) runs.push(`M${run.join(' L')}`);
  return runs;
}

const fmtTime = (t: number) =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const fmtDay = (t: number) =>
  new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });

/**
 * Both ends of a one-hour span are the same date, so labelling them "Sep 15"
 * twice tells you nothing — and both ends of a 24-hour span are the same clock
 * time, so labelling them "01:30 PM" twice is worse. The deciding question is
 * whether the two ends fall on different days, not how wide the span is: a
 * six-hour window over midnight needs the date, a 23-hour one inside a single
 * day does not.
 */
const sameDay = (a: number, b: number) =>
  new Date(a).toDateString() === new Date(b).toDateString();

const fmtAxis = (t: number, crossesDay: boolean) =>
  crossesDay ? `${fmtDay(t)} ${fmtTime(t)}` : fmtTime(t);

const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export function Analytics({ series }: { series: Series }) {
  const { buckets, bucketMs } = series;
  const [hover, setHover] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const total = buckets.reduce((a, b) => a + b.requests, 0);
  if (buckets.length === 0 || total === 0) {
    return (
      <div className="analytics empty">
        <p>No traffic in this range. Send a request, or widen the window.</p>
      </div>
    );
  }

  const n = buckets.length;
  const maxReq = Math.max(1, ...buckets.map((b) => b.requests));
  const maxLat = Math.max(1, ...buckets.map((b) => b.p50 ?? 0));
  const maxTok = Math.max(1, ...buckets.map((b) => b.promptTokens + b.completionTokens));

  const req = shape(buckets.map((b) => b.requests), maxReq);
  const err = shape(buckets.map((b) => b.errors), maxReq);
  const lat = brokenLine(buckets.map((b) => b.p50), maxLat);
  // Stacked: the lower band is prompt tokens, the upper the running total, so
  // the visible gap between them is completion tokens.
  const tokIn = shape(buckets.map((b) => b.promptTokens), maxTok);
  const tokAll = shape(buckets.map((b) => b.promptTokens + b.completionTokens), maxTok);

  const totalErrors = buckets.reduce((a, b) => a + b.errors, 0);
  const totalTokens = buckets.reduce((a, b) => a + b.promptTokens + b.completionTokens, 0);
  const latencies = buckets.map((b) => b.p50).filter((v): v is number => v !== null);
  const typicalLat = latencies.length
    ? latencies.slice().sort((a, b) => a - b)[Math.floor(latencies.length / 2)]!
    : null;

  const onMove = (e: React.MouseEvent) => {
    const rect = wrap.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const ratio = (e.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1)))));
  };

  const first = buckets[0]!.t;
  const last = buckets[n - 1]!.t;
  const crossesDay = !sameDay(first, last);

  const active: Bucket | null = hover === null ? null : (buckets[hover] ?? null);
  const hoverPct = hover === null ? 0 : (x(hover, n) / W) * 100;

  return (
    <div
      className="analytics"
      ref={wrap}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <Row
        title="Requests"
        summary={`${compact(total)} total · ${compact(totalErrors)} not completed`}
        legend={[
          { label: 'requests', className: 'sw-req' },
          { label: 'not completed', className: 'sw-err' },
        ]}
        hoverPct={hoverPct}
        showHover={hover !== null}
      >
        <path className="fill-req" d={req.area} />
        <path className="line-req" d={req.line} />
        {totalErrors > 0 && (
          <>
            <path className="fill-err" d={err.area} />
            <path className="line-err" d={err.line} />
          </>
        )}
      </Row>

      <Row
        title="Median latency"
        summary={typicalLat === null ? '—' : `${compact(typicalLat)} ms typical`}
        hoverPct={hoverPct}
        showHover={hover !== null}
      >
        {lat.map((d, i) => (
          <path key={i} className="line-lat" d={d} />
        ))}
      </Row>

      <Row
        title="Tokens"
        summary={`${compact(totalTokens)} total`}
        legend={[
          { label: 'in', className: 'sw-in' },
          { label: 'out', className: 'sw-out' },
        ]}
        hoverPct={hoverPct}
        showHover={hover !== null}
        axis={[fmtAxis(first, crossesDay), fmtAxis(last, crossesDay)]}
      >
        <path className="fill-out" d={tokAll.area} />
        <path className="fill-in" d={tokIn.area} />
        {/* A 2px surface-coloured stroke keeps the two bands from touching. */}
        <path className="sep-in" d={tokIn.line} />
        <path className="line-in" d={tokIn.line} />
      </Row>

      {active && (
        <div
          className="chart-tip"
          style={{
            left: `${hoverPct}%`,
            // Never centred on the cursor: that puts the panel over the exact
            // point being read. It sits on whichever side has more room.
            transform: hoverPct > 50 ? 'translateX(calc(-100% - 14px))' : 'translateX(14px)',
          }}
        >
          <div className="tip-t">
            {fmtDay(active.t)} {fmtTime(active.t)}
            <span className="tip-span"> · {Math.round(bucketMs / 1000)}s</span>
          </div>
          <dl>
            <dt><i className="sw sw-req" />requests</dt>
            <dd>{active.requests}</dd>
            <dt><i className="sw sw-err" />not completed</dt>
            <dd>{active.errors}</dd>
            <dt><i className="sw sw-lat" />median</dt>
            <dd>{active.p50 === null ? '—' : `${active.p50} ms`}</dd>
            <dt><i className="sw sw-in" />tokens in</dt>
            <dd>{compact(active.promptTokens)}</dd>
            <dt><i className="sw sw-out" />tokens out</dt>
            <dd>{compact(active.completionTokens)}</dd>
          </dl>
        </div>
      )}
    </div>
  );
}

function Row({
  title,
  summary,
  legend,
  children,
  hoverPct,
  showHover,
  axis,
}: {
  title: string;
  summary: string;
  legend?: Array<{ label: string; className: string }>;
  children: React.ReactNode;
  hoverPct: number;
  showHover: boolean;
  axis?: [string, string];
}) {
  return (
    <section className="chart">
      <header>
        <h3>{title}</h3>
        <span className="chart-sum">{summary}</span>
        {legend && (
          <ul className="chart-legend">
            {legend.map((l) => (
              <li key={l.label}>
                <i className={`sw ${l.className}`} />
                {l.label}
              </li>
            ))}
          </ul>
        )}
      </header>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${title}: ${summary}`}>
        <line className="baseline" x1="0" y1={PAD_T + PLOT} x2={W} y2={PAD_T + PLOT} />
        {children}
        {showHover && (
          <line
            className="crosshair"
            x1={(hoverPct / 100) * W}
            y1={PAD_T - 4}
            x2={(hoverPct / 100) * W}
            y2={PAD_T + PLOT}
          />
        )}
      </svg>
      {axis && (
        <div className="chart-axis">
          <span>{axis[0]}</span>
          <span>{axis[1]}</span>
        </div>
      )}
    </section>
  );
}
