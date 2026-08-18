/**
 * The SQL validator's allowlist is the security boundary for InvestGPT.
 *
 * When a provider key is present the model, not the deterministic compiler,
 * writes the SQL — and model output is untrusted input that reaches SQLite. The
 * only thing between "the model was talked into writing a join" and the caller
 * receiving five hundred rows of it is `validateSql`.
 *
 * These are the attacks that worked. `extractRelations` read the single token
 * after FROM, so a comma-separated relation list hid everything past the first
 * element from the allowlist entirely:
 *
 *     SELECT v.symbol, u.email, u.password_hash
 *     FROM v_equity_snapshot v, users u
 *
 * `sessions.token` is stored as the literal cookie value, so that one query is
 * account takeover for every signed-in user, and it validated clean.
 */

import { describe, expect, it } from 'vitest';
import { validateSql } from '@/lib/investgpt/validate';

/** The relations a question about the equity universe would legitimately expose. */
const SCHEMA = ['v_equity_snapshot', 'v_signal_latest', 'signals'];

function verdict(sql: string) {
  return validateSql(sql, { allowedTables: SCHEMA });
}

describe('validateSql — comma-joined relation lists', () => {
  const smuggled = [
    ['users', 'SELECT v.symbol, u.email, u.password_hash FROM v_equity_snapshot v, users u LIMIT 200'],
    ['sessions', 'SELECT v.symbol, s.token FROM v_equity_snapshot v, sessions s LIMIT 200'],
    ['sqlite_master', 'SELECT v.symbol, m.sql FROM v_equity_snapshot v, sqlite_master m LIMIT 200'],
    ['audit_events', 'SELECT v.symbol, a.raw_payload FROM v_equity_snapshot v, audit_events a LIMIT 200'],
    ['orders', 'SELECT v.symbol, o.user_id FROM v_equity_snapshot v, orders o LIMIT 200'],
  ] as const;

  for (const [table, sql] of smuggled) {
    it(`refuses ${table} smuggled in after a comma`, () => {
      expect(verdict(sql).valid, sql).toBe(false);
    });
  }

  it('refuses a relation reached through two commas', () => {
    const sql =
      'SELECT v.symbol FROM v_equity_snapshot v, v_signal_latest s, users u LIMIT 10';
    expect(verdict(sql).valid).toBe(false);
  });

  it('refuses it with AS aliases, which walk a different token path', () => {
    const sql =
      'SELECT v.symbol FROM v_equity_snapshot AS v, users AS u LIMIT 10';
    expect(verdict(sql).valid).toBe(false);
  });

  it('refuses it with no alias at all', () => {
    expect(verdict('SELECT symbol FROM v_equity_snapshot, users LIMIT 10').valid).toBe(false);
  });

  it('names the smuggled relation in the error, not just the first one', () => {
    const result = verdict('SELECT v.symbol FROM v_equity_snapshot v, users u LIMIT 10');
    expect(JSON.stringify(result.issues)).toContain('users');
  });
});

describe('validateSql — parenthesised relations', () => {
  /*
   * The second way through the same boundary, and a worse one.
   *
   * The list walk stopped at an open parenthesis, on the reasoning that a
   * parenthesis introduces a subquery whose own FROM the outer scan visits
   * anyway. SQLite's `table-or-subquery` grammar also accepts `( relation )`
   * and `( join-clause )`, which have no inner FROM for anything to visit — and
   * stopping meant the rest of the list went unread too. One pair of brackets
   * turned a refused query into an allowed one:
   *
   *     SELECT email, password_hash FROM v_equity_snapshot, (users)
   *
   * That validated clean and returned real scrypt hashes out of the live store.
   */
  const smuggled = [
    ['a parenthesised relation after a comma', 'SELECT email, password_hash FROM v_equity_snapshot, (users) LIMIT 5'],
    ['a parenthesised relation after JOIN', 'SELECT * FROM v_equity_snapshot JOIN (audit_events) ON 1 = 1 LIMIT 5'],
    ['a parenthesised relation in first position', 'SELECT * FROM (users) JOIN v_equity_snapshot ON 1 = 1 LIMIT 5'],
    ['double brackets', 'SELECT * FROM v_equity_snapshot, ((sessions)) LIMIT 5'],
    ['two of them at once', 'SELECT * FROM v_equity_snapshot, (orders), (audit_events) LIMIT 5'],
    ['one behind an alias', 'SELECT * FROM v_equity_snapshot, (users) u LIMIT 5'],
    ['one behind an AS alias', 'SELECT * FROM v_equity_snapshot, (users) AS u LIMIT 5'],
    ['a parenthesised join clause', 'SELECT * FROM v_equity_snapshot, (users JOIN orders ON 1 = 1) LIMIT 5'],
  ] as const;

  for (const [shape, sql] of smuggled) {
    it(`refuses ${shape}`, () => {
      const result = verdict(sql);
      expect(result.valid, JSON.stringify(result.issues)).toBe(false);
      expect(result.issues.some((issue) => issue.code === 'RELATION_NOT_ALLOWED')).toBe(true);
    });
  }

  it('reads the rest of the list after a parenthesised element, rather than stopping', () => {
    const result = verdict('SELECT * FROM v_equity_snapshot, (v_signal_latest), users LIMIT 5');
    expect(result.tables).toContain('users');
    expect(result.valid).toBe(false);
  });

  it('still treats a genuine subquery as a subquery, not as a relation named SELECT', () => {
    const result = verdict('SELECT symbol FROM (SELECT symbol FROM v_signal_latest LIMIT 5) LIMIT 5');
    expect(result.valid, JSON.stringify(result.issues)).toBe(true);
    expect(result.tables).not.toContain('select');
  });

  it('finds a smuggled relation inside a subquery in the list', () => {
    const result = verdict('SELECT symbol FROM v_equity_snapshot, (SELECT token FROM sessions) LIMIT 5');
    expect(result.valid, JSON.stringify(result.issues)).toBe(false);
    expect(result.tables).toContain('sessions');
  });
});

describe('validateSql — unknown qualifiers', () => {
  it('refuses a qualifier that is neither relation, CTE nor declared alias', () => {
    const sql = 'SELECT users.password_hash FROM v_equity_snapshot v LIMIT 10';
    expect(verdict(sql).valid).toBe(false);
  });

  it('accepts a qualifier that is a declared alias', () => {
    expect(verdict('SELECT v.symbol FROM v_equity_snapshot v LIMIT 10').valid).toBe(true);
  });

  it('accepts a qualifier that is an AS alias', () => {
    expect(verdict('SELECT v.symbol FROM v_equity_snapshot AS v LIMIT 10').valid).toBe(true);
  });

  it('accepts a qualifier that is the relation itself', () => {
    expect(
      verdict('SELECT v_equity_snapshot.symbol FROM v_equity_snapshot LIMIT 10').valid,
    ).toBe(true);
  });
});

describe('validateSql — the legitimate shapes still pass', () => {
  const valid = [
    'SELECT symbol, last_price FROM v_equity_snapshot ORDER BY last_price DESC LIMIT 10',
    'SELECT v.symbol, s.conviction_score FROM v_equity_snapshot v JOIN v_signal_latest s ON s.symbol = v.symbol LIMIT 25',
    'SELECT v.symbol FROM v_equity_snapshot v, v_signal_latest s WHERE s.symbol = v.symbol LIMIT 25',
    'SELECT symbol FROM v_equity_snapshot WHERE symbol IN (SELECT symbol FROM v_signal_latest) LIMIT 10',
    'WITH top AS (SELECT symbol FROM v_signal_latest LIMIT 5) SELECT symbol FROM top LIMIT 5',
    'SELECT COUNT(*) AS n FROM v_equity_snapshot LIMIT 1',
    'SELECT v.symbol FROM (v_equity_snapshot v JOIN v_signal_latest s ON s.symbol = v.symbol) LIMIT 25',
    'SELECT symbol FROM (v_signal_latest) LIMIT 10',
  ];

  for (const sql of valid) {
    it(`accepts: ${sql.slice(0, 62)}…`, () => {
      const result = verdict(sql);
      expect(result.valid, JSON.stringify(result.issues)).toBe(true);
    });
  }
});
