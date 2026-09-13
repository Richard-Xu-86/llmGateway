import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { LogRecord } from '@gw/shared';
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

  broadcast(record: LogRecord): void {
    const summary = summarise(record);
    const payload = JSON.stringify({ type: 'log', row: summary });
    for (const client of this.#clients) {
      if (client.apiKeyId !== record.apiKeyId) continue; // the tenancy boundary
      if (!matchesFilters(summary, client.filters, record.url)) continue;
      if (client.socket.readyState === client.socket.OPEN) client.socket.send(payload);
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
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.type === 'filters') client.filters = msg.filters ?? {};
      } catch {
        // A malformed frame from a client is not the server's problem.
      }
    });
  });

  return wss;
}
