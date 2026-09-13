import type { LogRecord } from '@gw/shared';
import { outcomeClass } from '../lib/format';

/**
 * Where the time actually went, drawn to scale.
 *
 * This is the one visualisation worth having: on a real call the split is
 * routinely 1260ms waiting and 72ms generating, and an average latency number
 * hides that completely. Waiting is the queue; generating is the model.
 */
export function Timing({ record }: { record: LogRecord }) {
  const total = Math.max(record.durationMs, 1);
  const wait = record.ttftMs ?? 0;
  const waitPct = Math.min(100, (wait / total) * 100);
  const genPct = Math.max(0, 100 - waitPct);
  const cls = outcomeClass(record.terminalState);

  if (!record.isStream) {
    return (
      <>
        <div className="timing">
          <div className={`seg gen ${cls}`} style={{ left: 0, width: '100%' }} />
          <span style={{ left: 10 }}>{record.durationMs}ms round trip</span>
        </div>
        <div className="legend">
          <span>Not a stream — no first-token measurement.</span>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="timing">
        <div className="seg wait" style={{ left: 0, width: `${waitPct}%` }} />
        <div className={`seg gen ${cls}`} style={{ left: `${waitPct}%`, width: `${genPct}%` }} />
        {waitPct > 22 && <span style={{ left: 10 }}>waiting {wait}ms</span>}
        {genPct > 22 && (
          <span style={{ left: `calc(${waitPct}% + 10px)` }}>
            generating {record.durationMs - wait}ms
          </span>
        )}
      </div>
      <div className="legend">
        <span>
          <span className="sw" style={{ background: '#2c2f3a' }} />
          waiting for first token
        </span>
        <span>
          <span className="sw" style={{ background: 'var(--accent)' }} />
          generating
        </span>
        {record.terminalState !== 'completed' && (
          <span>
            <span className="sw" style={{ background: 'var(--bad)' }} />
            ended early
          </span>
        )}
      </div>
    </>
  );
}
