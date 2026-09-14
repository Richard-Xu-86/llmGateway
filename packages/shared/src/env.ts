/**
 * Node-only, like `keys.ts` — kept out of the package entry point so nothing
 * here can reach a browser bundle.
 *
 * One job: decide whether convenient defaults are allowed.
 *
 * The defaults are the reason `npm run dev` works with no configuration at all,
 * which is most of this project's onboarding story. They are also a demo key
 * printed in the README and an ingest secret spelled `dev-secret`. Somewhere
 * public, falling back to those silently is the worst possible outcome: the
 * service comes up, looks healthy, and is wide open.
 *
 * So the rule is: defaults in development, refuse to start in production.
 * Fail closed, and say which variable is missing.
 */

/** True unless NODE_ENV says otherwise. Development is the default because that is where this runs most. */
export const isProduction = (): boolean => process.env.NODE_ENV === 'production';

export class MissingConfigError extends Error {
  constructor(names: string[]) {
    super(
      `Refusing to start: ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} not set, ` +
        `and NODE_ENV=production so the development defaults are not allowed.\n` +
        `  Generate a key with:  echo "gw_live_$(openssl rand -hex 24)"\n` +
        `  See .env.example for the full list.`,
    );
    this.name = 'MissingConfigError';
  }
}

/**
 * Returns the environment value, or the development default.
 *
 * In production a missing value is fatal rather than defaulted — the caller
 * collects every missing name first, so someone deploying finds out about all
 * of them at once instead of one restart at a time.
 */
export function requiredInProduction(
  name: string,
  devDefault: string,
  missing: string[],
): string {
  const value = process.env[name];
  if (value) return value;
  if (isProduction()) missing.push(name);
  return devDefault;
}

/** Throws if anything was collected. Call once, after reading every value. */
export function assertConfigured(missing: string[]): void {
  if (missing.length > 0) throw new MissingConfigError(missing);
}
