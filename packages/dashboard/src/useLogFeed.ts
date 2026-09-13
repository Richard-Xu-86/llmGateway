import { useCallback, useEffect, useRef, useState } from 'react';
import type { Filters, LogSummary } from '@gw/shared';
import { fetchLogs } from './api';

const MAX_ROWS = 500;
const FLUSH_MS = 200;

export type Connection = 'connecting' | 'live' | 'closed';

/**
 * The live table.
 *
 * Three things here are deliberate rather than incidental:
 *
 *  - Incoming rows are buffered and flushed on a timer. Busy traffic arrives
 *    faster than React should re-render; one update per 200ms keeps the table
 *    readable and the tab responsive.
 *  - `paused` stops rows being prepended, not the socket. An auto-scrolling
 *    table is unusable the moment you try to click something in it, and the
 *    backlog is still there when you resume.
 *  - Filters are sent to the server. The backend applies the same predicate it
 *    uses for SQL, so a filtered view stays live without shipping rows the
 *    browser would discard — and without rows appearing that would vanish on
 *    refresh.
 */
export function useLogFeed(key: string, filters: Filters, paused: boolean) {
  const [rows, setRows] = useState<LogSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [pendingCount, setPendingCount] = useState(0);

  const buffer = useRef<LogSummary[]>([]);
  const socket = useRef<WebSocket | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Reload the page of history whenever the filters change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchLogs(key, filters)
      .then((page) => {
        if (cancelled) return;
        buffer.current = [];
        setPendingCount(0);
        setRows(page.rows);
        setCursor(page.nextCursor);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [key, JSON.stringify(filters)]);

  // One socket for the life of the session.
  useEffect(() => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // The key travels as a subprotocol, not a query string — query strings end
    // up in access logs and browser history.
    const ws = new WebSocket(`${protocol}//${location.host}/api/stream`, ['gw-key', key]);
    socket.current = ws;

    ws.onopen = () => setConnection('live');
    ws.onclose = () => setConnection('closed');
    ws.onerror = () => setConnection('closed');
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string);
      if (msg.type !== 'log') return;
      buffer.current.unshift(msg.row as LogSummary);
      if (pausedRef.current) setPendingCount(buffer.current.length);
    };

    return () => ws.close();
  }, [key]);

  // Push current filters to the server whenever they change.
  useEffect(() => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'filters', filters }));
    }
  }, [JSON.stringify(filters), connection]);

  // Drain the buffer on a timer instead of on every message.
  useEffect(() => {
    const timer = setInterval(() => {
      if (pausedRef.current || buffer.current.length === 0) return;
      const incoming = buffer.current;
      buffer.current = [];
      setPendingCount(0);
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
  }, [key, JSON.stringify(filters), cursor]);

  return { rows, loading, connection, loadMore, hasMore: cursor !== null, pendingCount };
}
