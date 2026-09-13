import type { LogSummary } from '@gw/shared';

const ago = (ts: number) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
};

const STATE_LABEL: Record<string, string> = {
  completed: '',
  upstream_error: 'upstream error',
  client_aborted: 'aborted',
  truncated: 'truncated',
};

export function LogTable({
  rows,
  loading,
  selectedId,
  onSelect,
  hasMore,
  onLoadMore,
}: {
  rows: LogSummary[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  if (loading) return <div className="empty muted">Loading…</div>;

  if (rows.length === 0) {
    return (
      <div className="empty muted">
        <p>No requests yet.</p>
        <p className="hint">
          Send one through the gateway and it will appear here without a refresh.
        </p>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="log-table">
        <thead>
          <tr>
            <th>when</th>
            <th>method</th>
            <th>path</th>
            <th>model</th>
            <th>status</th>
            <th className="num">ttft</th>
            <th className="num">duration</th>
            <th className="num">tokens</th>
            <th>key</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cls = Math.floor(row.status / 100);
            const note = STATE_LABEL[row.terminalState];
            return (
              <tr
                key={row.id}
                className={selectedId === row.id ? 'selected' : ''}
                onClick={() => onSelect(row.id)}
              >
                <td className="muted mono">{ago(row.startedAt)}</td>
                <td className="mono">{row.method}</td>
                <td className="mono path">
                  {row.path}
                  {row.isStream && <span className="badge">stream</span>}
                </td>
                <td className="muted mono">{row.model ?? '—'}</td>
                <td>
                  <span className={`status s${cls}`}>{row.status || 'ERR'}</span>
                  {note && <span className="status-note">{note}</span>}
                </td>
                <td className="num mono muted">{row.ttftMs === null ? '—' : `${row.ttftMs}ms`}</td>
                <td className="num mono">{row.durationMs}ms</td>
                <td className="num mono muted">
                  {row.promptTokens === null && row.completionTokens === null
                    ? '—'
                    : `${row.promptTokens ?? 0}/${row.completionTokens ?? 0}`}
                </td>
                <td className="muted">{row.apiKeyName}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {hasMore && (
        <button className="load-more" onClick={onLoadMore}>
          Load older
        </button>
      )}
    </div>
  );
}
