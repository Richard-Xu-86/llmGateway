import { useEffect, useState } from 'react';
import type { LogRecord } from '@gw/shared';
import { fetchLog, toCurl } from '../api';

type Tab = 'request' | 'response' | 'headers' | 'timing';

export function DetailDrawer({
  apiKey,
  id,
  onClose,
}: {
  apiKey: string;
  id: string;
  onClose: () => void;
}) {
  const [record, setRecord] = useState<LogRecord | null>(null);
  const [tab, setTab] = useState<Tab>('request');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setRecord(null);
    setTab('request');
    fetchLog(apiKey, id)
      .then(setRecord)
      .catch(() => setRecord(null));
  }, [apiKey, id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!record) {
    return (
      <aside className="drawer">
        <div className="drawer-head">
          <button className="close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="empty muted">Loading…</div>
      </aside>
    );
  }

  const messages = parseMessages(record.requestBody);

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <div>
          <div className="mono drawer-title">{record.path}</div>
          <div className="muted mono small">{record.id}</div>
        </div>
        <button className="close" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="tabs">
        {(['request', 'response', 'headers', 'timing'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
        <div className="spacer" />
        <button
          className="tab"
          onClick={() => {
            navigator.clipboard?.writeText(toCurl(record));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'copied' : 'copy as cURL'}
        </button>
      </div>

      <div className="drawer-body">
        {tab === 'request' &&
          (messages && messages.length > 0 ? (
            <div className="messages">
              {messages.map((m, i) => (
                <div key={i} className="message">
                  <div className="role">{m.role}</div>
                  <div className="content">{m.content}</div>
                </div>
              ))}
            </div>
          ) : (
            <Pre value={record.requestBody} truncated={record.requestBodyTruncated} />
          ))}

        {tab === 'response' && (
          <>
            {record.error && <div className="error-box">{record.error}</div>}
            <Pre value={record.responseBody} truncated={record.responseBodyTruncated} />
          </>
        )}

        {tab === 'headers' && (
          <>
            <h4>Request</h4>
            <Headers values={record.requestHeaders} />
            <h4>Response</h4>
            <Headers values={record.responseHeaders} />
          </>
        )}

        {tab === 'timing' && (
          <dl className="timing">
            <Row label="status" value={String(record.status)} />
            <Row label="outcome" value={record.terminalState} />
            <Row label="streamed" value={record.isStream ? 'yes' : 'no'} />
            <Row
              label="time to first token"
              value={record.ttftMs === null ? '—' : `${record.ttftMs} ms`}
            />
            <Row label="total duration" value={`${record.durationMs} ms`} />
            <Row label="chunks" value={record.chunkCount === null ? '—' : String(record.chunkCount)} />
            <Row label="prompt tokens" value={record.promptTokens?.toString() ?? '—'} />
            <Row label="completion tokens" value={record.completionTokens?.toString() ?? '—'} />
            <Row label="finish reason" value={record.finishReason ?? '—'} />
            <Row label="model" value={record.model ?? '—'} />
            <Row label="key" value={`${record.apiKeyName}`} />
          </dl>
        )}
      </div>
    </aside>
  );
}

const Row = ({ label, value }: { label: string; value: string }) => (
  <>
    <dt>{label}</dt>
    <dd className="mono">{value}</dd>
  </>
);

const Pre = ({ value, truncated }: { value: string | null; truncated: boolean }) => (
  <>
    <pre className="mono">{value ?? '(empty)'}</pre>
    {truncated && <p className="muted small">Body truncated at 256 KB for storage.</p>}
  </>
);

const Headers = ({ values }: { values: Record<string, string> }) => (
  <dl className="headers">
    {Object.entries(values).map(([name, value]) => (
      <Row key={name} label={name} value={value} />
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
