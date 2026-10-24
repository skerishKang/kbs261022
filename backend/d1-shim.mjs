// D1-compatible shim backed by node:sqlite.
//
// Lets the Worker's fetch handler run unmodified against a real SQLite database
// that was initialized with backend/schema.sql. Used for unit/E2E tests and for
// the local HTTP preview. No Cloudflare dependency, no network.
//
//   import { openD1 } from './d1-shim.mjs';
//   const env = { DB: openD1(), ADMIN_TOKEN: 'example-admin' };
//   const response = await worker.fetch(new Request('http://x/api/orders', {...}), env);
//
// Requires: node --experimental-sqlite

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function normalizeParam(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return String(value);
}

const READ_SQL = /^\s*(SELECT|PRAGMA|EXPLAIN|WITH\s+.*SELECT)/is;

function isReadStatement(sql) {
  return READ_SQL.test(String(sql));
}

/** Wrap a node:sqlite DatabaseSync as a D1 binding. */
export function toD1(db) {
  const prepare = (sql) => {
    const stmt = db.prepare(sql);
    const state = { params: [], sql };

    const api = {
      get sql() {
        return state.sql;
      },
      bind(...args) {
        state.params = args.map(normalizeParam);
        return api;
      },
      all() {
        return { results: stmt.all(...state.params) || [], meta: {} };
      },
      first() {
        const row = stmt.get(...state.params);
        return row || null;
      },
      run() {
        const result = stmt.run(...state.params);
        return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
      _execute() {
        if (isReadStatement(state.sql)) return this.all();
        return this.run();
      },
    };
    return api;
  };

  return {
    prepare,
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(statement._execute());
      return results;
    },
    async exec(sql) {
      db.exec(String(sql));
      return {};
    },
    _db: db,
  };
}

/**
 * Open an in-memory D1 shim. By default the bundled backend/schema.sql is
 * applied, so the shim mirrors the deployed database structure.
 */
export function openD1({ schemaPath = join(HERE, 'schema.sql'), applySchema = true } = {}) {
  const db = new DatabaseSync(':memory:');
  if (applySchema) {
    db.exec(readFileSync(schemaPath, 'utf-8'));
  }
  return toD1(db);
}

/** Open a D1 shim on a file (handy for inspecting state after a run). */
export function openD1File(filePath, { applySchema = true } = {}) {
  const db = new DatabaseSync(filePath);
  if (applySchema) db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf-8'));
  return toD1(db);
}
