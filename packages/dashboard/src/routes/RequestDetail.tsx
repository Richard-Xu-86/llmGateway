import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { LogRecord } from '@gw/shared';
import { useAuth } from '../auth';
import { fetchLog, toCurl } from '../lib/api';
import { Timing } from '../components/Timing';
import { STATE_LABEL, ms } from '../lib/format';

const TABS = ['request', 'response', 'headers', 'timing'] as const;
type Tab = (typeof TABS)[number];

export function EmptyDetail() {
  return (
    <div className="empty">
      Select a request to inspect it.
      <br />
      <span className="small">j / k moves through the list · Esc closes</span>
    </div>
  );
}

export function RequestDetail() {
  const { apiKey } = useAuth();
  const { id } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>('request');
  const [copied, setCopied] = useState(false);
  const tablist = useRef<HTMLDivElement>(null);

  const { data: record, isLoading } = useQuery({
    queryKey: ['log', apiKey, id],
    queryFn: () => fetchLog(apiKey!, id!),
    enabled: Boolean(id),
  });

  useEffect(() => setTab('request'), [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') navigate({ pathname: '/requests', search: params.toString() });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, params]);

  if (isLoading) return <div className="empty">Loading…</div>;
  if (!record) return <div className="empty">That request is not in this key&apos;s logs.</div>;

  const messages = parseMessages(record.requestBody);
  const note = STATE_LABEL[record.terminalState];

  /** Roving tabindex: arrow keys move between tabs, as a real tablist should. */
  function onTabKey(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = TABS.indexOf(tab);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
    setTab(next);
    (tablist.current?.querySelector(`[data-tab="${next}"]`) as HTMLElement | null)?.focus();
  }

  return (
    <>
      <div className="dhead">
        <div style={{ minWidth: 0 }}>
          <h2 className="mono">
            {record.method} {record.path}
          </h2>
          {/* Both URLs, because they answer different questions: what the
              caller asked the proxy for, and where the proxy sent it. The
              second is the only thing on screen that distinguishes a call
              that reached api.openai.com from one that hit the local mock. */}
          <div className="durl mono small" title={record.url}>
            {record.url}
          </div>
          {record.upstreamUrl && (
            <div className="durl up mono small" title={record.upstreamUrl}>
              <span className="arrow">→</span> {record.upstreamUrl}
            </div>
          )}
          <div className="dim mono small" style={{ marginTop: 3 }}>
            {record.id}
          </div>
        </div>
        <div className="spacer" />
        <div style={{ textAlign: 'right' }}>
          <div className="mono" style={{ fontSize: 13 }}>
            <span className={record.terminalState === 'completed' ? 'ok' : 'bad'}>
              {record.status || 'ERR'}
            </span>
            {note && <span className="bad small"> · {note}</span>}
          </div>
          <div className="dim small mono" style={{ marginTop: 3 }}>
            {record.durationMs}ms
          </div>
        </div>
      </div>

      <div className="dtabs" role="tablist" ref={tablist} onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            data-tab={t}
            aria-selected={tab === t}
            tabIndex={tab === t ? 0 : -1}
            className="dtab"
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
        <div className="spacer" />
        <button
          className="dtab"
          onClick={() => {
            navigator.clipboard?.writeText(toCurl(record));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'copied' : 'copy as cURL'}
        </button>
      </div>

      <div className="dbody" role="tabpanel">
        {tab === 'request' &&
          (messages && messages.length > 0 ? (
            messages.map((m, i) => (
              <div className="msg" key={i}>
                <div className="role">{m.role}</div>
                <div className="content">{m.content}</div>
              </div>
            ))
          ) : (
            <Body value={record.requestBody} truncated={record.requestBodyTruncated} />
          ))}

        {tab === 'response' && (
          <>
            {record.error && <div className="errbox">{record.error}</div>}
            <Body value={record.responseBody} truncated={record.responseBodyTruncated} />
          </>
        )}

        {tab === 'headers' && (
          <>
            <div className="h4">Request</div>
            <Headers values={record.requestHeaders} />
            <div className="h4">Response</div>
            <Headers values={record.responseHeaders} />
          </>
        )}

        {tab === 'timing' && (
          <>
            <Timing record={record} />
            <div className="h4">Measurements</div>
            <dl className="kv">
              <dt>time to first token</dt><dd className="mono">{ms(record.ttftMs)}</dd>
              <dt>total duration</dt><dd className="mono">{record.durationMs}ms</dd>
              <dt>chunks</dt><dd className="mono">{record.chunkCount ?? '—'}</dd>
              <dt>prompt tokens</dt><dd className="mono">{record.promptTokens ?? '—'}</dd>
              <dt>completion tokens</dt><dd className="mono">{record.completionTokens ?? '—'}</dd>
              <dt>finish reason</dt><dd className="mono">{record.finishReason ?? '—'}</dd>
              <dt>model</dt><dd className="mono">{record.model ?? '—'}</dd>
              <dt>outcome</dt><dd className="mono">{record.terminalState}</dd>
            </dl>
          </>
        )}
      </div>
    </>
  );
}

const Body = ({ value, truncated }: { value: string | null; truncated: boolean }) => (
  <>
    <pre>{value ?? '(empty)'}</pre>
    {truncated && <p className="dim small">Body truncated at 256 KB for storage.</p>}
  </>
);

const Headers = ({ values }: { values: Record<string, string> }) => (
  <dl className="kv">
    {Object.entries(values).map(([name, value]) => (
      <div key={name} style={{ display: 'contents' }}>
        <dt className="mono">{name}</dt>
        <dd className="mono">{value}</dd>
      </div>
    ))}
  </dl>
);

/** Render a chat request as a conversation rather than a wall of JSON. */
function parseMessages(body: string | null): Array<{ role: string; content: string }> | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed?.messages)) return null;
    return parsed.messages.map((m: any) => ({
      role: String(m.role ?? 'unknown'),
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2),
    }));
  } catch {
    return null;
  }
}
