import { useCallback, useEffect, useRef, useState } from 'react';
import type { Filters, LogSummary } from '@gw/shared';
import { fetchLogs } from './api';

const MAX_ROWS = 500;
const FLUSH_MS = 200;

export type Connection = 'connecting' | 'live' | 'closed' | 'reconnecting';

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
  const [loadFailed, setLoadFailed] = useState(false);

  const buffer = useRef<LogSummary[]>([]);
  const socket = useRef<WebSocket | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  // Read by the socket's onopen, which outlives the render that created it.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

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
        setLoadFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setRows([]);
        // Distinguishes "nothing matched" from "nobody answered", which the
        // empty state alone cannot.
        setLoadFailed(true);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, filterKey]);

  /**
   * Reconnects, with backoff.
   *
   * Restarting the backend used to leave the dashboard silently dead until a
   * manual refresh — the table just stopped updating, which looks exactly like
   * "no traffic". A devtool that lies about whether it is watching is worse
   * than one that is obviously broken, so the socket comes back on its own and
   * `connection` is reported honestly while it does.
   */
  useEffect(() => {
    let closedByUs = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      // The key travels as a subprotocol, not a query string — query strings end
      // up in access logs, proxy logs and browser history.
      const ws = new WebSocket(`${proto}//${location.host}/api/stream`, ['gw-key', key]);
      socket.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setConnection('live');
        // Re-arm the server-side filter: the new socket knows nothing.
        ws.send(JSON.stringify({ type: 'filters', filters: filtersRef.current }));
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string);
        if (msg.type !== 'log') return;
        buffer.current.unshift(msg.row as LogSummary);
        if (pausedRef.current) setPending(buffer.current.length);
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        if (closedByUs) return;
        setConnection('closed');
        // 500ms, 1s, 2s, 4s… capped at 10s. Fast enough that a dev restarting
        // the backend barely notices, slow enough not to hammer a dead host.
        const delay = Math.min(10_000, 500 * 2 ** attempt++);
        retryTimer = setTimeout(connect, delay);
        setConnection('reconnecting');
      };
    };

    connect();
    return () => {
      closedByUs = true;
      clearTimeout(retryTimer);
      socket.current?.close();
    };
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

  return { rows, loading, connection, loadMore, hasMore: cursor !== null, pending, loadFailed };
}
