/**
 * The SQL validator and the NL→SQL compiler.
 *
 * The validator suite is adversarial by design. It is the boundary between a
 * statement written by something outside the platform — a language model, once an
 * operator adds a key — and the database, so the tests are written as attacks
 * rather than as examples.
 *
 * The two cases worth reading first are the ones that prove tokenisation happens
 * before pattern matching: `DROP TABLE` inside a string literal must be *allowed*
 * (it is data, and rejecting it would break any query filtering on a company name
 * containing those words), while a keyword hidden in a block comment must be
 * stripped rather than executed. Every naive SQL guard fails one of those two in
 * the dangerous direction.
 */

import { describe, expect, it } from 'vitest';
import { compileQuestion } from '@/lib/investgpt/compile';
import { validateSql } from '@/lib/investgpt/validate';
import { pruneSchema } from '@/lib/investgpt/prune';
import { CATALOG, catalogSize } from '@/lib/investgpt/catalog';

/** Error codes only; warnings are advisory and do not block execution. */
function errorCodes(sql: string): string[] {
  return validateSql(sql)
    .issues.filter((issue) => issue.severity === 'error')
    .map((issue) => issue.code);
}

describe('SQL validator — shape', () => {
  it('accepts a plain SELECT against an allowlisted view', () => {
    const result = validateSql('SELECT symbol, price FROM v_equity_snapshot WHERE conviction > 50');
    expect(result.valid).toBe(true);
    expect(result.tables).toEqual(['v_equity_snapshot']);
  });

  it('accepts a WITH clause terminating in a SELECT', () => {
    expect(
      validateSql('WITH top AS (SELECT symbol, conviction FROM v_equity_snapshot) SELECT symbol FROM top').valid,
    ).toBe(true);
  });

  it('accepts a join between two allowlisted relations', () => {
    expect(
      validateSql('SELECT s.symbol FROM v_equity_snapshot s JOIN symbols ON symbols.symbol = s.symbol').valid,
    ).toBe(true);
  });

  it('accepts a window function over the feature history', () => {
    expect(
      validateSql('SELECT symbol, AVG(value) OVER (PARTITION BY symbol ORDER BY as_of) FROM feature_values').valid,
    ).toBe(true);
  });

  it('rejects anything that is not a SELECT', () => {
    for (const sql of [
      "INSERT INTO orders (id) VALUES ('x')",
      "UPDATE users SET role = 'admin'",
      'DELETE FROM audit_events',
      'CREATE TABLE evil (id TEXT)',
      'DROP TABLE users',
      'ALTER TABLE orders ADD COLUMN x TEXT',
      "ATTACH DATABASE '/etc/passwd' AS leak",
      'PRAGMA journal_mode = OFF',
      'VACUUM',
      'BEGIN; SELECT 1',
    ]) {
      expect(errorCodes(sql).length, sql).toBeGreaterThan(0);
      expect(validateSql(sql).valid, sql).toBe(false);
    }
  });

  it('rejects a second statement smuggled after a semicolon', () => {
    const codes = errorCodes('SELECT symbol FROM v_equity_snapshot; DROP TABLE users');
    expect(codes).toContain('MULTIPLE_STATEMENTS');
    expect(codes).toContain('FORBIDDEN_KEYWORD');
  });

  it('accepts a single trailing semicolon', () => {
    expect(validateSql('SELECT symbol FROM v_equity_snapshot;').valid).toBe(true);
  });

  it('rejects an input that is only comments', () => {
    expect(errorCodes('-- nothing to see here')).toContain('NO_STATEMENT');
  });

  it('rejects an unterminated string literal', () => {
    // An unterminated quote is exactly the state a failed injection leaves behind.
    expect(errorCodes("SELECT symbol FROM v_equity_snapshot WHERE name = 'abc")).toContain('LEX_ERROR');
  });

  it('rejects an unterminated block comment', () => {
    expect(errorCodes('SELECT symbol FROM v_equity_snapshot /* never closed')).toContain('LEX_ERROR');
  });
});

describe('SQL validator — tokenisation before matching', () => {
  it('ALLOWS a forbidden keyword inside a string literal', () => {
    /**
     * The payload here is data, not code. A regex-based guard rejects this, which
     * is not merely over-cautious: it breaks every legitimate query that filters
     * on text, and it teaches the reader that the guard understands SQL when it
     * only understands substrings.
     */
    const result = validateSql("SELECT symbol FROM v_equity_snapshot WHERE name = '; DROP TABLE users; --'");
    expect(result.valid).toBe(true);
  });

  it('handles doubled single quotes inside a literal', () => {
    expect(validateSql("SELECT symbol FROM v_equity_snapshot WHERE name = 'O''Reilly'").valid).toBe(true);
  });

  it('strips a keyword hidden in a block comment rather than executing it', () => {
    const result = validateSql('SELECT symbol FROM v_equity_snapshot /* DELETE FROM users */');
    expect(result.valid).toBe(true);
    expect(result.issues.some((i) => i.code === 'COMMENTS_STRIPPED')).toBe(true);
    // The normalised rendering is what would execute, and the comment is gone.
    expect(result.normalised).not.toContain('DELETE');
  });

  it('does not treat a comment marker inside a literal as a comment', () => {
    const result = validateSql("SELECT symbol FROM v_equity_snapshot WHERE name = '/* not a comment */'");
    expect(result.valid).toBe(true);
    expect(result.issues.some((i) => i.code === 'COMMENTS_STRIPPED')).toBe(false);
  });
});

describe('SQL validator — relation allowlisting', () => {
  it('blocks every private relation', () => {
    for (const table of [
      'users',
      'sessions',
      'orders',
      'order_telemetry',
      'intent_tokens',
      'audit_events',
      'entity_facet_snapshots',
      'entity_facet_deltas',
      'positions',
      'accounts',
      'payments',
      'subscriptions',
      'tos_acceptances',
      'admin_actions',
      'nn_weights',
    ]) {
      const codes = errorCodes(`SELECT * FROM ${table}`);
      expect(codes, table).toContain('RELATION_NOT_ALLOWED');
    }
  });

  it('blocks a private relation reached through UNION', () => {
    // The dangerous shape: a valid public query with a private tail.
    const codes = errorCodes(
      'SELECT symbol FROM v_equity_snapshot UNION SELECT password_hash FROM users',
    );
    expect(codes).toContain('RELATION_NOT_ALLOWED');
  });

  it('blocks a private relation reached through a subquery', () => {
    const codes = errorCodes(
      'SELECT symbol FROM v_equity_snapshot WHERE symbol IN (SELECT email FROM users)',
    );
    expect(codes).toContain('RELATION_NOT_ALLOWED');
  });

  it('blocks a schema-qualified reference', () => {
    expect(errorCodes('SELECT * FROM main.users')).toContain('SCHEMA_QUALIFIED');
  });

  it('blocks a pragma function table', () => {
    expect(
      errorCodes('SELECT symbol FROM v_equity_snapshot UNION SELECT name FROM pragma_table_info'),
    ).toContain('RELATION_NOT_ALLOWED');
  });

  it('honours a narrower per-question allowlist', () => {
    // `symbols` is globally readable but was not in the schema shown for this
    // question, so a model reaching for it is out of scope.
    const result = validateSql('SELECT symbol FROM symbols', { allowedTables: ['v_equity_snapshot'] });
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('RELATION_NOT_IN_SCHEMA');
  });
});

describe('SQL validator — functions and resources', () => {
  it('blocks filesystem and extension functions', () => {
    for (const fn of ['load_extension', 'writefile', 'readfile']) {
      expect(errorCodes(`SELECT ${fn}('/tmp/x') FROM v_equity_snapshot`).length, fn).toBeGreaterThan(0);
    }
  });

  it('blocks allocation bombs', () => {
    // randomblob(1e9) allocates a gigabyte inside the query engine.
    expect(errorCodes('SELECT randomblob(1000000000) FROM v_equity_snapshot')).toContain('FORBIDDEN_FUNCTION');
    expect(errorCodes('SELECT zeroblob(1000000000) FROM v_equity_snapshot')).toContain('FORBIDDEN_FUNCTION');
  });

  it('rejects a statement beyond the length ceiling', () => {
    const long = `SELECT symbol FROM v_equity_snapshot WHERE name = '${'x'.repeat(9000)}'`;
    expect(errorCodes(long)).toContain('TOO_LONG');
  });

  it('rejects an empty statement', () => {
    expect(errorCodes('   ')).toContain('EMPTY');
  });
});

describe('SQL validator — column checking', () => {
  it('rejects a qualified column that does not exist', () => {
    expect(errorCodes('SELECT v_equity_snapshot.nope FROM v_equity_snapshot')).toContain('UNKNOWN_COLUMN');
  });

  it('accepts a qualified column that does exist', () => {
    expect(validateSql('SELECT v_equity_snapshot.conviction FROM v_equity_snapshot').valid).toBe(true);
  });

  it('warns rather than errors on an unrecognised bare identifier', () => {
    // It may be an alias or a function this validator does not model, so a hard
    // rejection would break valid SQL. SQLite will reject it if it is genuinely
    // wrong.
    const result = validateSql('SELECT conviction AS score, mystery FROM v_equity_snapshot');
    expect(result.issues.some((i) => i.severity === 'warning' && i.code === 'UNRECOGNISED_IDENTIFIER')).toBe(true);
    expect(result.valid).toBe(true);
  });
});

describe('NL→SQL compiler', () => {
  it('always emits SQL its own validator accepts', () => {
    const questions = [
      'Show me the most oversold technology stocks with conviction above 55',
      'Which optionable large cap names have a 25 delta risk reversal below -2?',
      'How many mid cap healthcare stocks are bullish?',
      'Stocks in a mean reverting regime where the OU z-score is below -2',
      'Top 10 by conviction',
      'Bearish energy names with market cap over 50',
      'Names where RSI (14) is under 30 sorted by ATR percent ascending',
      'AAPL MSFT NVDA',
      '',
      'asdfghjkl',
      "'; DROP TABLE users; --",
      'SELECT * FROM users',
    ];
    for (const question of questions) {
      const compiled = compileQuestion(question);
      const result = validateSql(compiled.sql);
      expect(result.valid, `${question} → ${compiled.sql}\n${JSON.stringify(result.issues)}`).toBe(true);
    }
  });

  it('never interpolates a value into the statement text', () => {
    const compiled = compileQuestion('conviction above 60 and RSI (14) under 30');
    // Values arrive as bound parameters, which is what makes injection through the
    // question text structurally impossible rather than filtered.
    expect(compiled.sql).toContain('?');
    expect(compiled.sql).not.toContain('60');
    expect(compiled.params).toContain(60);
    expect(compiled.params).toContain(30);
  });

  it('resists an injection attempt in the question text', () => {
    const compiled = compileQuestion("technology stocks'; DROP TABLE users; --");
    expect(compiled.sql).not.toMatch(/DROP/i);
    expect(validateSql(compiled.sql).valid).toBe(true);
  });

  it('always excludes the benchmark ETF', () => {
    for (const question of ['top 10 by conviction', 'SPY', 'everything']) {
      expect(compileQuestion(question).sql).toContain('is_benchmark = 0');
    }
  });

  it('compiles a numeric comparison to the right operator', () => {
    const above = compileQuestion('conviction above 60');
    expect(above.plan.filters.some((f) => f.column === 'conviction' && f.operator === '>')).toBe(true);

    const atLeast = compileQuestion('conviction at least 60');
    expect(atLeast.plan.filters.some((f) => f.column === 'conviction' && f.operator === '>=')).toBe(true);

    const below = compileQuestion('RSI (14) below 30');
    expect(below.plan.filters.some((f) => f.column === 'rsi_14' && f.operator === '<')).toBe(true);
  });

  it('does not lose a categorical filter that precedes a numeric one', () => {
    /**
     * The regression this pins down: the comparison scanner used to claim its
     * whole subject window, which silently deleted any sector, regime or cap
     * filter appearing before a numeric constraint. The query still ran and still
     * looked plausible — it just screened the wrong universe.
     */
    const compiled = compileQuestion('bearish energy stocks with market cap over 50');
    const columns = compiled.plan.filters.map((f) => f.column);
    expect(columns).toContain('sector');
    expect(columns).toContain('direction');
    expect(columns).toContain('market_cap');
  });

  it('keeps a regime filter alongside a numeric one', () => {
    const compiled = compileQuestion('stocks in a mean reverting regime where the OU z-score is below -2');
    const columns = compiled.plan.filters.map((f) => f.column);
    expect(columns).toContain('regime');
    expect(columns).toContain('ou_zscore');
  });

  it('reads a market-cap bucket as its published range', () => {
    const compiled = compileQuestion('mid cap stocks');
    expect(compiled.params).toContain(2e9);
    expect(compiled.params).toContain(10e9);
    // The interpretation is disclosed rather than applied silently.
    expect(compiled.notes.join(' ')).toMatch(/mid cap/i);
  });

  it('scales a bare market-cap figure to billions and says so', () => {
    const compiled = compileQuestion('market cap over 50');
    expect(compiled.params).toContain(50e9);
    expect(compiled.notes.join(' ')).toMatch(/\$50B/);
  });

  it('does not mistake a feature abbreviation for a ticker', () => {
    /**
     * "RSI", "ATR" and "OU" are upper-case and ticker-shaped. Accepting them
     * produced `symbol IN ('RSI','ATR')` — a filter matching nothing, appended to
     * an otherwise correct query, so the question returned zero rows for no
     * visible reason.
     */
    const compiled = compileQuestion('names where RSI (14) is under 30 sorted by ATR percent ascending');
    expect(compiled.plan.filters.some((f) => f.column === 'symbol')).toBe(false);
  });

  it('recognises real tickers', () => {
    const compiled = compileQuestion('AAPL MSFT NVDA');
    const symbolFilter = compiled.plan.filters.find((f) => f.column === 'symbol');
    expect(symbolFilter?.value).toContain('AAPL');
    expect(symbolFilter?.value).toContain('NVDA');
  });

  it('binds a generic band word to the feature next to it, not the first match', () => {
    // "bullish" alone means the signal direction; next to a feature it means that
    // feature's band.
    const direction = compileQuestion('bullish healthcare stocks');
    expect(direction.plan.filters.some((f) => f.column === 'direction')).toBe(true);
  });

  it('compiles a count question to an aggregate', () => {
    const compiled = compileQuestion('how many technology stocks are bullish?');
    expect(compiled.plan.intent).toBe('count');
    expect(compiled.sql).toContain('COUNT(*)');
    expect(compiled.sql).not.toContain('ORDER BY');
  });

  it('inverts a superlative on a low-is-extreme band', () => {
    // "most oversold" means the lowest RSI, not the highest.
    const compiled = compileQuestion('the most oversold technology stocks');
    expect(compiled.plan.orderBy?.column).toBe('rsi_14');
    expect(compiled.plan.orderBy?.direction).toBe('ASC');
  });

  it('caps the limit and honours an explicit one', () => {
    expect(compileQuestion('top 10 by conviction').plan.limit).toBe(10);
    expect(compileQuestion('top 9999 by conviction').plan.limit).toBeLessThanOrEqual(200);
  });

  it('is deterministic: the same question yields the same statement', () => {
    const question = 'oversold large cap technology names with conviction above 40';
    const a = compileQuestion(question);
    const b = compileQuestion(question);
    // This is the property that makes a screening result reconstructable from the
    // ledger months later, and it is why the compiler is the default path.
    expect(a.sql).toBe(b.sql);
    expect(a.params).toEqual(b.params);
  });
});

describe('schema pruning', () => {
  it('prunes hard while keeping the identifier columns', () => {
    const pruned = pruneSchema('most oversold technology stocks');
    expect(pruned.report.totalColumns).toBe(catalogSize());
    expect(pruned.report.prunedPercent).toBeGreaterThan(90);

    const columns = pruned.entries.map((e) => e.sqlColumn);
    // A projection without the identifier is useless whatever the question asked.
    expect(columns).toContain('symbol');
    expect(columns).toContain('name');
    expect(columns).toContain('sector');
  });

  it('retrieves the column a question names', () => {
    for (const [question, column] of [
      ['most oversold names', 'rsi_14'],
      ['25 delta risk reversal below -2', 'rr25_30d'],
      ['OU z-score below -2', 'ou_zscore'],
      ['high relative volume', 'rel_volume_20'],
    ] as const) {
      const pruned = pruneSchema(question);
      expect(
        pruned.entries.some((e) => e.sqlColumn === column),
        `${question} → ${column}`,
      ).toBe(true);
    }
  });

  it('always admits the snapshot view and expands over the FK graph', () => {
    const pruned = pruneSchema('anything at all');
    expect(pruned.tables).toContain('v_equity_snapshot');
    // `symbols` is an FK neighbour, so it must survive even when nothing scored it.
    expect(pruned.tables).toContain('symbols');
  });

  it('emits DDL naming only surviving relations', () => {
    const pruned = pruneSchema('conviction above 60');
    expect(pruned.ddl).toContain('v_equity_snapshot');
    expect(pruned.ddl).toContain('conviction');
    // A private relation must never appear in the schema a model is shown.
    for (const table of ['users', 'orders', 'audit_events']) {
      expect(pruned.ddl).not.toContain(`TABLE ${table} (`);
    }
  });

  it('gates derived variants behind their cue phrases', () => {
    const withoutCue = pruneSchema('show me RSI');
    const withCue = pruneSchema('show me the 20 day z-score of RSI');
    const derivedWithout = withoutCue.entries.filter((e) => e.variant !== null).length;
    const derivedWith = withCue.entries.filter((e) => e.variant !== null).length;
    // Without the gate the ~700 derived entries out-recall the ~80 base features
    // on every question that merely names one.
    expect(derivedWith).toBeGreaterThan(derivedWithout);
  });

  it('keeps the catalog large enough for pruning to mean something', () => {
    expect(catalogSize()).toBeGreaterThan(500);
    expect(CATALOG.filter((e) => e.materialised).length).toBeGreaterThan(80);
  });
});

describe('column resolution picks the subject nearest the comparison', () => {
  it('binds "price under 50" to price even when a regime word precedes it', () => {
    const compiled = compileQuestion('technology stocks in a trending bear regime with price under 50');
    expect(compiled.sql).toContain('price < ?');
    expect(compiled.sql).not.toContain('regime_trend_score <');
    expect(compiled.params).toContain(50);
  });

  it('still prefers the longer phrase when two candidates end together', () => {
    const compiled = compileQuestion('names with relative volume above 2');
    expect(compiled.sql).toContain('rel_volume_20 > ?');
  });

  it('reports a qualitative clause it could not compile rather than dropping it', () => {
    const compiled = compileQuestion('Which symbols have relative volume above 2 and a positive MLOFI intent?');
    expect(compiled.sql).toContain('rel_volume_20 > ?');
    expect(compiled.unparsed.join(' ').toLowerCase()).toContain('mlofi');
  });
});
