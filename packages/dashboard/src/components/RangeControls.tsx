import { useSearchParams } from 'react-router-dom';
import { DEFAULT_RANGE } from '@gw/shared';
import { RANGES, readRange, readSpan, toLocalInput } from '../lib/filters';

/**
 * The time selector, shared by Requests and Analytics.
 *
 * It writes straight to the query string rather than taking props from a
 * parent, so both pages are reading one piece of state instead of two that have
 * to be kept in step. Switching tabs carries the window with you, which is the
 * behaviour you want the moment the charts and the table live apart: you spot
 * a spike on one page and go looking for it on the other.
 */
export function RangeControls() {
  const [params, setParams] = useSearchParams();
  const range = readRange(params);
  const span = readSpan(params);
  const custom = span.from !== undefined || span.to !== undefined;

  function setRange(next: string) {
    const p = new URLSearchParams(params);
    if (next === DEFAULT_RANGE) p.delete('range');
    else p.set('range', next);
    // Picking a relative chip is how you leave a fixed span, so clear it.
    // Otherwise the chip would look selected while the span still governed the
    // query, with nothing on screen to explain the mismatch.
    p.delete('from');
    p.delete('to');
    setParams(p, { replace: true });
  }

  function setBound(which: 'from' | 'to', value: string) {
    const p = new URLSearchParams(params);
    if (value) p.set(which, value);
    else p.delete(which);
    setParams(p, { replace: true });
  }

  return (
    <div className="rangebar">
      <div className="ranges">
        {RANGES.map((r) => (
          <button
            key={r}
            className={`chip tiny ${r === range && !custom ? 'on' : ''}`}
            onClick={() => setRange(r)}
            title={`The last ${r}`}
          >
            {r}
          </button>
        ))}
      </div>

      <div className="range-custom">
        <span>from</span>
        <input
          id="span-from"
          type="datetime-local"
          aria-label="Start of the range"
          value={toLocalInput(span.from)}
          onChange={(e) => setBound('from', e.target.value)}
        />
        <span>to</span>
        <input
          id="span-to"
          type="datetime-local"
          aria-label="End of the range"
          value={toLocalInput(span.to)}
          onChange={(e) => setBound('to', e.target.value)}
        />
        {custom && (
          <button className="range-clear" onClick={() => setRange(range)}>
            clear
          </button>
        )}
      </div>
    </div>
  );
}
