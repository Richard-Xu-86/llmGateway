/**
 * End-to-end proof, from the caller's side.
 *
 *   npm run ask -- "what is a FIFO buffer?"
 *
 * This is a real client app. It uses the official `openai` SDK with nothing
 * changed but `baseURL`, which is the strongest compatibility claim the project
 * makes: the SDK is strict about SSE framing and throws on anything malformed.
 *
 * It answers the question "does the caller actually receive this?" by measuring
 * from the caller's own side, then comparing against what the gateway recorded:
 *
 *   1. prints each token the moment it arrives (so you can watch it stream)
 *   2. times its own first token, independently of the gateway
 *   3. fetches the gateway's log row for this exact request
 *   4. asserts the text it received is byte-identical to the text logged
 */
import OpenAI from 'openai';

const BASE = process.env.GATEWAY_BASE_URL ?? 'http://localhost:4000/v1';
const BACKEND = process.env.BACKEND_BASE_URL ?? 'http://localhost:4020';
const KEY = process.env.GATEWAY_API_KEY ?? 'gw_live_demo_key_1';
const DASHBOARD = process.env.DASHBOARD_URL ?? 'http://localhost:5173';

const question = process.argv.slice(2).join(' ') || 'Say hi in five words.';

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

// `fetch: globalThis.fetch` matters.
//
// The openai v4 SDK ships node-fetch v2 as its HTTP layer. That package
// predates modern Node streams and reports ERR_STREAM_PREMATURE_CLOSE when a
// streamed response ends on Node 22+, after having received every byte
// correctly. Handing the SDK Node's own fetch (undici) skips the shim entirely.
// openai v5 drops node-fetch and this line becomes unnecessary.
const client = new OpenAI({ baseURL: BASE, apiKey: KEY, fetch: globalThis.fetch });

console.log(dim(`\n  caller  → ${BASE}`));
console.log(dim(`  asking  → ${question}\n`));

const startedAt = Date.now();
let firstTokenAt = null;
let received = '';
let chunks = 0;

// .withResponse() gives us the raw HTTP response alongside the stream, which is
// how we get the gateway's request id back.
const { data: stream, response } = await client.chat.completions
  .create({
    model: process.env.MODEL ?? 'gpt-4o-mini',
    stream: true,
    messages: [{ role: 'user', content: question }],
  })
  .withResponse();

const requestId = response.headers.get('x-gateway-request-id');

process.stdout.write('  ');
for await (const part of stream) {
  const piece = part.choices?.[0]?.delta?.content ?? '';
  if (!piece) continue;
  if (firstTokenAt === null) firstTokenAt = Date.now();
  received += piece;
  chunks += 1;
  process.stdout.write(piece); // straight to the terminal, as it arrives
}

const callerTtft = firstTokenAt === null ? null : firstTokenAt - startedAt;
const callerTotal = Date.now() - startedAt;

console.log('\n');
console.log(bold('  what the caller saw'));
console.log(`    characters received   ${received.length}`);
console.log(`    chunks with content   ${chunks}`);
console.log(`    time to first token   ${callerTtft ?? '—'}ms`);
console.log(`    total                 ${callerTotal}ms`);

if (!requestId) {
  console.log(red('\n  No x-gateway-request-id header — was this call routed through the gateway?\n'));
  process.exit(1);
}

// Give the gateway's batching worker a moment to ship the record.
await new Promise((r) => setTimeout(r, 600));

const res = await fetch(`${BACKEND}/api/logs/${requestId}`, {
  headers: { authorization: `Bearer ${KEY}` },
});

if (!res.ok) {
  console.log(red(`\n  Could not read the log row (${res.status}). Is the backend running, and LOG_SINK=http?\n`));
  process.exit(1);
}

const row = await res.json();

console.log(bold('\n  what the gateway recorded'));
console.log(`    characters logged     ${row.responseBody?.length ?? 0}`);
console.log(`    chunks                ${row.chunkCount}`);
console.log(`    time to first token   ${row.ttftMs ?? '—'}ms`);
console.log(`    total                 ${row.durationMs}ms`);
console.log(`    outcome               ${row.terminalState}`);
console.log(`    tokens in / out       ${row.promptTokens ?? '—'} / ${row.completionTokens ?? '—'}`);

const identical = received === row.responseBody;
const ttftClose =
  callerTtft !== null && row.ttftMs !== null && Math.abs(callerTtft - row.ttftMs) < 150;

console.log(bold('\n  end to end'));
console.log(
  identical
    ? green('    ✓ the text the caller received is byte-identical to the text logged')
    : red('    ✗ MISMATCH between what the caller received and what was logged'),
);
console.log(
  ttftClose
    ? green(`    ✓ caller and gateway agree on first-token time (${callerTtft}ms vs ${row.ttftMs}ms)`)
    : dim(`    · first-token time: caller ${callerTtft}ms, gateway ${row.ttftMs}ms`),
);
console.log(dim(`\n  inspect it:  ${DASHBOARD}/requests/${requestId}\n`));

process.exit(identical ? 0 : 1);
