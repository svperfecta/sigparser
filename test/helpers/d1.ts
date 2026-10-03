import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Minimal D1 stand-in over node:sqlite, with the real migrations applied. Covers the
 * prepare/bind/first/all/run surface the repositories use.
 */
export function createTestD1(): { d1: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:');
  const dir = join(import.meta.dirname, '../../src/db/migrations');
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    sqlite.exec(readFileSync(join(dir, file), 'utf8'));
  }

  const prepare = (sql: string, params: unknown[] = []): unknown => ({
    bind: (...next: unknown[]) => prepare(sql, next),
    first: async () => sqlite.prepare(sql).get(...(params as never[])) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(params as never[])), success: true }),
    run: async () => {
      sqlite.prepare(sql).run(...(params as never[]));
      return { success: true };
    },
  });

  return { d1: { prepare: (sql: string) => prepare(sql) } as unknown as D1Database, sqlite };
}
