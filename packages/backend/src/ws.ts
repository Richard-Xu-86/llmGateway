import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { ClientMessage, type LogRecord } from '@gw/shared';
import { findKey, type ApiKey } from '@gw/shared/keys';
import { matchesFilters, summarise, type Filters } from './db.ts';

interface Client {
  socket: WebSocket;
  apiKeyId: string;
  filters: Filters;
}

/**
 * Fan-out of new rows to dashboards.
 *
 * Filters are applied server-side before sending, so a filtered view stays live
 * without shipping rows the browser would only throw away. The predicate is the
 * same one the SQL query uses, because a row that appears live and then
 * disappears on refresh is worse than no live updates at all.
 */
export class Hub {
  #clients = new Set<Client>();

  add(client: Client): void {
    this.#clients.add(client);
    client.socket.on('close', () => this.#clients.delete(client));
    client.socket.on('error', () => this.#clients.delete(client));
  }

  /**
   * One bad client must not cost the others their logs.
   *
   * This runs inside the ingest handler, so anything thrown here becomes a 500,
   * and the gateway's sink responds to a 500 by retrying the same batch — for
   * ever. That turns one broken subscriber into stalled ingestion for every
   * tenant. Filters are validated on arrival now, but the isolation belongs
   * here regardless: fan-out should degrade one connection at a time.
   */
  broadcast(record: LogRecord): void {
    const summary = summarise(record);
    const payload = JSON.stringify({ type: 'log', row: summary });
    for (const client of this.#clients) {
      if (client.apiKeyId !== record.apiKeyId) continue; // the tenancy boundary
      try {
        if (!matchesFilters(summary, client.filters, record.url)) continue;
        if (client.socket.readyState === client.socket.OPEN) client.socket.send(payload);
      } catch {
        // Drop this subscriber's update and carry on with the rest.
        this.#clients.delete(client);
        try {
          client.socket.close(1011, 'subscriber error');
        } catch {
          /* already gone */
        }
      }
    }
  }

  get size(): number {
    return this.#clients.size;
  }
}

/**
 * The key travels as a WebSocket subprotocol rather than a query parameter.
 *
 * Browsers cannot set headers on a WebSocket handshake, so the usual shortcut
 * is `?key=…` — which then shows up in access logs, proxy logs and browser
 * history. The subprotocol carries it in a header instead.
 */
export function attachWebSocket(server: Server, keys: ApiKey[], hub: Hub): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: '/api/stream',
    handleProtocols: (protocols) => (protocols.has('gw-key') ? 'gw-key' : false),
  });

  wss.on('connection', (socket, request) => {
    const offered = (request.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim());
    const presented = offered.find((p) => p !== 'gw-key');
    const key = findKey(keys, presented);

    if (!key) {
      socket.close(1008, 'invalid gateway API key');
      return;
    }

    const client: Client = { socket, apiKeyId: key.id, filters: {} };
    hub.add(client);
    socket.send(JSON.stringify({ type: 'ready', apiKeyName: key.name }));

    socket.on('message', (raw) => {
      // Parsed, not trusted. What arrives here is attacker-controlled by
      // definition — holding a valid key does not make a frame well-formed, and
      // this value is later used by `matchesFilters` on the ingest path.
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return; // a malformed frame from a client is not the server's problem
      }
      const msg = ClientMessage.safeParse(parsed);
      if (msg.success) client.filters = msg.data.filters ?? {};
    });
  });

  return wss;
}
