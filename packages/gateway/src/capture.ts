import type { TerminalState } from '@gw/shared';
import { parseEventData } from './sse.ts';

/**
 * Accumulates everything worth logging about a streamed response, one event at
 * a time, as those events fly past on their way to the caller.
 *
 * Hard rule: `observe` runs inside the response path, so it only parses and
 * appends. Anything expensive belongs in `finalize`, which runs after the last
 * byte is already on the wire.
 */
export class StreamCapture {
  ttftMs: number | null = null;
  chunkCount = 0;
  text = '';
  model: string | null = null;
  promptTokens: number | null = null;
  completionTokens: number | null = null;
  finishReason: string | null = null;

  sawDone = false;
  inbandError: string | null = null;
  transportError: string | null = null;
  aborted = false;

  constructor(private readonly startedAt: number) {}

  /**
   * @returns whether this event should be forwarded to the caller.
   *
   * Returns false only for a usage-only chunk that the gateway asked for and
   * the caller did not — see `injectUsage` in app.ts.
   */
  observe(rawEvent: string, suppressUsageEvent: boolean): boolean {
    const data = parseEventData(rawEvent);
    if (data === null) return true; // comment / keep-alive
    if (data === '[DONE]') {
      this.sawDone = true;
      return true;
    }

    let obj: any;
    try {
      obj = JSON.parse(data);
    } catch {
      return true; // not ours to understand; forward untouched
    }

    // An error arriving here is an error *after* the 200 already went out.
    if (obj?.error) {
      this.inbandError =
        typeof obj.error?.message === 'string' ? obj.error.message : JSON.stringify(obj.error);
      return true;
    }

    if (typeof obj?.model === 'string') this.model = obj.model;

    if (obj?.usage) {
      this.promptTokens = obj.usage.prompt_tokens ?? null;
      this.completionTokens = obj.usage.completion_tokens ?? null;
      const usageOnly = Array.isArray(obj.choices) && obj.choices.length === 0;
      if (usageOnly && suppressUsageEvent) return false;
    }

    const choice = obj?.choices?.[0];
    const piece = choice?.delta?.content;
    if (typeof piece === 'string' && piece.length > 0) {
      if (this.ttftMs === null) this.ttftMs = Date.now() - this.startedAt;
      this.text += piece;
    }
    if (Array.isArray(obj?.choices) && obj.choices.length > 0) this.chunkCount++;
    if (typeof choice?.finish_reason === 'string') this.finishReason = choice.finish_reason;

    return true;
  }

  terminalState(): TerminalState {
    if (this.aborted) return 'client_aborted';
    if (this.inbandError !== null || this.transportError !== null) return 'upstream_error';
    if (this.sawDone) return 'completed';
    return 'truncated';
  }

  error(): string | null {
    return this.inbandError ?? this.transportError;
  }
}
