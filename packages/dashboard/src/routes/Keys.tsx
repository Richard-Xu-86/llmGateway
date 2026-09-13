import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth';
import { fetchStats, verifyKey } from '../lib/api';
import { compact } from '../lib/format';

/**
 * Everything a developer needs to start sending traffic through the gateway,
 * in one place — the base URL is the question people actually ask.
 */
export function Keys() {
  const { apiKey } = useAuth();
  const me = useQuery({ queryKey: ['me', apiKey], queryFn: () => verifyKey(apiKey!) });
  const stats = useQuery({ queryKey: ['stats', apiKey], queryFn: () => fetchStats(apiKey!) });

  const base = `${location.origin.replace(':5173', ':4000')}/v1`;

  return (
    <div className="keyspage">
      <h2>{me.data?.name ?? 'This key'}</h2>
      <p className="dim">
        Logs are scoped to this key. Another key cannot read them, and this one cannot read theirs.
      </p>

      <div className="keycard">
        <div className="h4" style={{ marginTop: 0 }}>Identity</div>
        <dl className="kv">
          <dt>name</dt><dd className="mono">{me.data?.name ?? '—'}</dd>
          <dt>key</dt><dd className="mono">…{me.data?.last4 ?? '????'}</dd>
          <dt>stored as</dt><dd className="mono">sha256 — the secret itself is never stored</dd>
        </dl>
      </div>

      <div className="keycard">
        <div className="h4" style={{ marginTop: 0 }}>Point a client at it</div>
        <pre>{`import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${base}',
  apiKey: process.env.GATEWAY_API_KEY,   // the gateway key, not your OpenAI key
});`}</pre>
        <p className="dim small" style={{ marginTop: 10 }}>
          The real OpenAI key stays in the gateway process. It is never sent to the browser, never
          written to the log store, and never returned by this API.
        </p>
      </div>

      <div className="keycard">
        <div className="h4" style={{ marginTop: 0 }}>Last hour</div>
        <dl className="kv">
          <dt>requests</dt><dd className="mono">{stats.data ? compact(stats.data.current.total) : '—'}</dd>
          <dt>not completed</dt><dd className="mono">{stats.data?.current.errors ?? '—'}</dd>
          <dt>tokens in / out</dt>
          <dd className="mono">
            {stats.data
              ? `${compact(stats.data.current.promptTokens)} / ${compact(stats.data.current.completionTokens)}`
              : '—'}
          </dd>
        </dl>
      </div>
    </div>
  );
}
