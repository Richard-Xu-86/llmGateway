import { useCallback, useEffect, useRef, useState } from 'react';
import type { Filters, LogSummary } from '@gw/shared';
import { fetchLogs } from './api';

const MAX_ROWS = 500;
const FLUSH_MS = 200;

export type Connection = 'connecting' | 'live' | 'closed';

/**
 * The live request feed.
 *
 * Three deliberate choices:
 *  - Rows are buffered and flushed on a timer. Busy traffic arrives faster than
 *    React should re-render; one update per 200ms keeps the list readable.
 *  - `paused` stops rows being prepended, not the socket. An auto-scrolling
 *    list is unusable the moment you try to click something in it.
 *  - Filters are pushed to the server, which applies the same predicate its SQL
 *    uses — so a filtered view stays live without rows appearing that would
 *    vanish on refresh.
 */
export function useLiveLogs(key: string, filters: Filters, paused: boolean) {
  const [rows, setRows] = useState<LogSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [pending, setPending] = useState(0);

  const buffer = useRef<LogSummary[]>([]);
  const socket = useRef<WebSocket | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const filterKey = JSON.stringify(filters);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchLogs(key, filters)
      .then((page) => {
        if (cancelled) return;
        buffer.current = [];
        setPending(0);
        setRows(page.rows);
        setCursor(page.nextCursor);
      })
      .catch(() => !cancelled && setRows([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, filterKey]);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // The key travels as a subprotocol, not a query string — query strings end
    // up in access logs, proxy logs and browser history.
    const ws = new WebSocket(`${proto}//${location.host}/api/stream`, ['gw-key', key]);
    socket.current = ws;
    ws.onopen = () => setConnection('live');
    ws.onclose = () => setConnection('closed');
    ws.onerror = () => setConnection('closed');
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string);
      if (msg.type !== 'log') return;
      buffer.current.unshift(msg.row as LogSummary);
      if (pausedRef.current) setPending(buffer.current.length);
    };
    return () => ws.close();
  }, [key]);

  useEffect(() => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'filters', filters }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, connection]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (pausedRef.current || buffer.current.length === 0) return;
      const incoming = buffer.current;
      buffer.current = [];
      setPending(0);
      setRows((current) => {
        const seen = new Set(incoming.map((r) => r.id));
        return [...incoming, ...current.filter((r) => !seen.has(r.id))].slice(0, MAX_ROWS);
      });
    }, FLUSH_MS);
    return () => clearInterval(timer);
  }, []);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const page = await fetchLogs(key, filters, cursor);
    setRows((current) => [...current, ...page.rows]);
    setCursor(page.nextCursor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, filterKey, cursor]);

  return { rows, loading, connection, loadMore, hasMore: cursor !== null, pending };
}
