import { afterEach, describe, expect, it } from 'vitest';
import { MissingConfigError, assertConfigured, requiredInProduction } from '../src/env.ts';

/**
 * The defaults are why `npm run dev` needs no configuration, and that is most of
 * this project's onboarding story. They are also a demo key printed in the
 * README and an ingest secret spelled `dev-secret`.
 *
 * Falling back to those on a public host is the worst available outcome: the
 * service starts, reports healthy, and accepts a credential anyone can read.
 * So the defaults are a development affordance with a production guard, and
 * these tests pin both halves — a convenience that silently survives into
 * production is not a convenience.
 */

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('development', () => {
  it('uses the defaults, so a fresh clone runs with no .env', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.GATEWAY_API_KEYS;

    const missing: string[] = [];
    const keys = requiredInProduction('GATEWAY_API_KEYS', 'demo-app:gw_live_demo_key_1', missing);

    expect(keys).toBe('demo-app:gw_live_demo_key_1');
    expect(() => assertConfigured(missing)).not.toThrow();
  });

  it('treats an unset NODE_ENV as development', () => {
    delete process.env.NODE_ENV;
    delete process.env.INGEST_SECRET;

    const missing: string[] = [];
    requiredInProduction('INGEST_SECRET', 'dev-secret', missing);
    expect(missing).toEqual([]);
  });
});

describe('production', () => {
  it('refuses to start rather than fall back to the README key', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.GATEWAY_API_KEYS;

    const missing: string[] = [];
    requiredInProduction('GATEWAY_API_KEYS', 'demo-app:gw_live_demo_key_1', missing);

    expect(() => assertConfigured(missing)).toThrow(MissingConfigError);
  });

  it('names every missing variable at once, not one restart at a time', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.GATEWAY_API_KEYS;
    delete process.env.INGEST_SECRET;

    const missing: string[] = [];
    requiredInProduction('GATEWAY_API_KEYS', 'x', missing);
    requiredInProduction('INGEST_SECRET', 'y', missing);

    expect(() => assertConfigured(missing)).toThrow(/GATEWAY_API_KEYS, INGEST_SECRET/);
  });

  it('tells you how to fix it', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.GATEWAY_API_KEYS;

    const missing: string[] = [];
    requiredInProduction('GATEWAY_API_KEYS', 'x', missing);

    // An error that says what is wrong but not what to do is half an error.
    expect(() => assertConfigured(missing)).toThrow(/openssl rand -hex 24/);
  });

  it('is satisfied once the values are set', () => {
    process.env.NODE_ENV = 'production';
    process.env.GATEWAY_API_KEYS = 'acme:gw_live_realkey';
    process.env.INGEST_SECRET = 'a-real-secret';

    const missing: string[] = [];
    const keys = requiredInProduction('GATEWAY_API_KEYS', 'demo', missing);
    const secret = requiredInProduction('INGEST_SECRET', 'dev-secret', missing);

    expect(keys).toBe('acme:gw_live_realkey');
    expect(secret).toBe('a-real-secret');
    expect(() => assertConfigured(missing)).not.toThrow();
  });

  it('does not accept an empty string as "set"', () => {
    // `INGEST_SECRET=` in a .env file is a mistake, not a choice.
    process.env.NODE_ENV = 'production';
    process.env.INGEST_SECRET = '';

    const missing: string[] = [];
    requiredInProduction('INGEST_SECRET', 'dev-secret', missing);
    expect(missing).toEqual(['INGEST_SECRET']);
  });
});
