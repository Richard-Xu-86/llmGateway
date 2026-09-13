import { createRequire } from 'node:module';

/**
 * `node:sqlite` behind a runtime require.
 *
 * Node 22 answers true to `isBuiltin('node:sqlite')` but leaves `sqlite` out of
 * `module.builtinModules` — and `builtinModules` is the list bundlers check. So
 * Vite (and therefore vitest) tries to resolve it as a package on disk and
 * fails. A runtime require sidesteps the static analysis entirely, and is the
 * price of using a built-in that is still stabilising. Node 24 fixes the list;
 * when the repo moves to it, this file becomes a plain import.
 *
 * Worth it: the alternative is `better-sqlite3`, a native module that compiles
 * at install time — the one step most likely to break a reviewer's `npm install`.
 */

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const require = createRequire(import.meta.url);

export const DatabaseSync = (require('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDatabase;
}).DatabaseSync;
