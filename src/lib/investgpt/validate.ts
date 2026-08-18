/**
 * SQL validation.
 *
 * This is the security boundary. Everything upstream — the pruner, the compiler,
 * a language model — is a *suggestion*; nothing reaches the database until it
 * passes here. That inversion matters because the deterministic compiler can only
 * emit safe SQL by construction, but a live model cannot be constrained by
 * construction at all, and the moment an operator adds an API key the system is
 * executing statements written by something outside it.
 *
 * Three layers, in the order the research specifies:
 *
 *   **Layer 1 — lexical.** The statement is tokenised properly, with string
 *   literals, quoted identifiers and both comment forms recognised as single
 *   tokens. This is not a nicety: every naive SQL guard is defeated by putting the
 *   payload where a regex will not look. `WHERE name = '; DROP TABLE users; --'`
 *   contains the word DROP and is completely harmless; `SELECT/*x*∕1` hides a
 *   keyword from a word-boundary match. Deciding what is code and what is data
 *   before pattern-matching is the only way to get either judgement right.
 *
 *   **Layer 2 — shape.** Exactly one statement, and that statement must be a
 *   SELECT (or a WITH whose body is a SELECT). Every mutating and
 *   environment-touching keyword is rejected as a token, which also covers
 *   SQLite-specific escapes — ATTACH mounts another database file, PRAGMA can
 *   change durability, and `writefile()` in a loadable extension writes to disk.
 *
 *   **Layer 3 — recursive allowlisting.** Every relation the statement references
 *   is extracted and checked against `READ_ALLOWLIST`, and every qualified column
 *   is checked against that relation's real columns. The allowlist is the
 *   expression of the RBAC separation the mandate requires: impersonal market,
 *   feature and signal relations are reachable; `users`, `sessions`, `orders`,
 *   `order_telemetry` and the ledger tables are not, so no natural-language
 *   question can read another user's account or the audit evidence.
 *
 * Anything unrecognised is rejected. A validator that guesses is not a validator.
 */

import { READ_ALLOWLIST } from '@/lib/db';
import { TABLE_COLUMNS } from '@/lib/investgpt/catalog';
import type { SqlValidationIssue } from '@/lib/domain/types';

export interface ValidationResult {
  valid: boolean;
  issues: SqlValidationIssue[];
  /** Relations the statement references. */
  tables: string[];
  /** Qualified and bare column references found. */
  columns: string[];
  /** A normalised, comment-stripped rendering — the `ast` field's payload. */
  normalised: string | null;
}

type TokenKind = 'word' | 'number' | 'string' | 'identifier' | 'punct' | 'comment' | 'parameter';

interface Token {
  kind: TokenKind;
  /** Raw text, including quotes for strings and identifiers. */
  raw: string;
  /** For words: upper-cased. For strings/identifiers: the unquoted content. */
  value: string;
  start: number;
}

/**
 * Keywords that must never appear as code.
 *
 * The list covers three classes: DML/DDL (mutation), transaction and schema
 * control (a statement that can commit or roll back can escape a read-only
 * wrapper), and SQLite's environment escapes. `PRAGMA` and `ATTACH` in particular
 * are the two that turn a read-only query engine into arbitrary file access.
 */
const FORBIDDEN_KEYWORDS: readonly string[] = [
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'UPSERT', 'MERGE', 'TRUNCATE',
  'CREATE', 'DROP', 'ALTER', 'RENAME', 'REINDEX', 'VACUUM', 'ANALYZE',
  'ATTACH', 'DETACH', 'PRAGMA', 'GRANT', 'REVOKE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE',
  'TRIGGER', 'INDEX', 'TEMP', 'TEMPORARY', 'EXPLAIN',
  'RETURNING', 'DO', 'CALL', 'EXEC', 'EXECUTE', 'LOAD_EXTENSION',
];

/**
 * Functions that read or write outside the query.
 *
 * SQLite ships `load_extension` and, with extensions loaded, `writefile` and
 * `readfile`. `randomblob` and `zeroblob` are here because they are the standard
 * way to force a resource-exhaustion query — a single `randomblob(1e9)` will
 * happily allocate a gigabyte.
 */
const FORBIDDEN_FUNCTIONS: readonly string[] = [
  'load_extension', 'writefile', 'readfile', 'fts3_tokenizer', 'randomblob', 'zeroblob', 'edit', 'sqlite_compileoption_used',
];

/** Relations reachable from a generated query. */
const ALLOWED_TABLES: ReadonlySet<string> = new Set(READ_ALLOWLIST.map((name) => name.toLowerCase()));

/**
 * Tokeniser.
 *
 * Handles SQLite's full literal syntax: single-quoted strings with `''` escaping,
 * double-quoted and bracketed and backticked identifiers, both comment forms, and
 * `?`/`?N`/`:name` parameters. An unterminated literal is reported rather than
 * silently consumed to end-of-input, because "unterminated string" is precisely
 * the state an injection attempt leaves behind.
 */
export function tokenise(sql: string): { tokens: Token[]; error: string | null } {
  const tokens: Token[] = [];
  let i = 0;

  while (i < sql.length) {
    const char = sql[i] as string;

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    // Comments
    if (char === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end < 0 ? sql.length : end;
      tokens.push({ kind: 'comment', raw: sql.slice(i, stop), value: '', start: i });
      i = stop;
      continue;
    }
    if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) return { tokens, error: 'An unterminated block comment was found.' };
      tokens.push({ kind: 'comment', raw: sql.slice(i, end + 2), value: '', start: i });
      i = end + 2;
      continue;
    }

    // Single-quoted string, with '' escaping
    if (char === "'") {
      let j = i + 1;
      let content = '';
      for (;;) {
        if (j >= sql.length) return { tokens, error: 'An unterminated string literal was found.' };
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            content += "'";
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        content += sql[j];
        j += 1;
      }
      tokens.push({ kind: 'string', raw: sql.slice(i, j), value: content, start: i });
      i = j;
      continue;
    }

    // Quoted identifiers
    const identifierQuotes: Record<string, string> = { '"': '"', '`': '`', '[': ']' };
    const closing = identifierQuotes[char];
    if (closing !== undefined) {
      const end = sql.indexOf(closing, i + 1);
      if (end < 0) return { tokens, error: 'An unterminated quoted identifier was found.' };
      tokens.push({ kind: 'identifier', raw: sql.slice(i, end + 1), value: sql.slice(i + 1, end), start: i });
      i = end + 1;
      continue;
    }

    // Parameters
    if (char === '?' || char === ':' || char === '@' || char === '$') {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j] as string)) j += 1;
      tokens.push({ kind: 'parameter', raw: sql.slice(i, j), value: sql.slice(i, j), start: i });
      i = j;
      continue;
    }

    // Numbers (including hex and exponent forms)
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      let j = i;
      while (j < sql.length && /[0-9a-fA-FxX.+\-eE]/.test(sql[j] as string)) {
        // Stop at a sign unless it is an exponent's sign.
        const c = sql[j] as string;
        if ((c === '+' || c === '-') && !/[eE]/.test(sql[j - 1] ?? '')) break;
        j += 1;
      }
      tokens.push({ kind: 'number', raw: sql.slice(i, j), value: sql.slice(i, j), start: i });
      i = j;
      continue;
    }

    // Bare words
    if (/[A-Za-z_]/.test(char)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j] as string)) j += 1;
      const raw = sql.slice(i, j);
      tokens.push({ kind: 'word', raw, value: raw.toUpperCase(), start: i });
      i = j;
      continue;
    }

    tokens.push({ kind: 'punct', raw: char, value: char, start: i });
    i += 1;
  }

  return { tokens, error: null };
}

/** Tokens that are code, i.e. everything but comments. */
function codeTokens(tokens: readonly Token[]): Token[] {
  return tokens.filter((token) => token.kind !== 'comment');
}

/**
 * Keywords that end a FROM clause's comma-separated relation list.
 *
 * Anything else in that position is a relation or its alias. Kept as its own set
 * rather than reusing `SQL_KEYWORDS`, because that set includes words like
 * `DISTINCT` and `CASE` that cannot appear here at all, and a name is only safe to
 * stop on when stopping is definitely correct.
 */
const RELATION_LIST_END: ReadonlySet<string> = new Set([
  'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'WINDOW',
  'UNION', 'INTERSECT', 'EXCEPT', 'ON', 'USING',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'NATURAL',
]);

/**
 * Relation names.
 *
 * Extracted positionally — the identifier following FROM or a JOIN — rather than
 * by matching known names, so an unexpected relation is *found* instead of
 * ignored. A validator that only looks for names it recognises cannot report the
 * one case that matters.
 *
 * A CTE name is collected separately and excluded from the allowlist check,
 * because it refers to a query defined in the same statement rather than to a
 * stored relation.
 *
 * A parenthesis in the list is **not** a reason to stop reading it. The scan used
 * to `break` there, on the reasoning that a parenthesis introduces a subquery and
 * a subquery's own FROM is visited by the same outer scan. Both halves of that are
 * wrong, and together they were a hole straight through the security boundary:
 *
 *     SELECT email, password_hash FROM v_equity_snapshot, (users)
 *
 * SQLite's `table-or-subquery` grammar accepts `( table-or-subquery-list )` and
 * `( join-clause )` as well as `( select-stmt )`, so `(users)` is a plain relation
 * reference with no inner FROM for anything to visit — and because `break` left
 * the list entirely, nothing after the parenthesis was read either. The statement
 * validated as touching only `v_equity_snapshot` and then executed, returning real
 * password hashes out of the live store.
 *
 * So a parenthesised element is now walked. Its contents are scanned recursively
 * as a relation list, except when they open a `SELECT`, `WITH` or `VALUES` — a
 * true subquery, whose own FROM the outer scan does visit. Either way the walk
 * resumes after the matching close paren, so the rest of the list is still read.
 *
 * The FROM clause is a comma-separated *list*, and reading only the token after
 * FROM saw only its first element. That is the whole security boundary, so
 * everything past the first comma was joined without ever being checked:
 *
 *     SELECT v.symbol, u.email, u.password_hash
 *     FROM v_equity_snapshot v, users u          -- `users` never reached the allowlist
 *
 * The list is now walked to its end — each element, its optional `schema.` prefix
 * and its optional alias, then a comma to continue or a clause keyword to stop.
 */
function extractRelations(tokens: readonly Token[]): {
  relations: string[];
  cteNames: Set<string>;
  aliases: Set<string>;
} {
  const relations: string[] = [];
  const cteNames = new Set<string>();
  const aliases = new Set<string>();

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as Token;

    // WITH name AS ( … )
    if (token.kind === 'word' && token.value === 'WITH') {
      let j = i + 1;
      if ((tokens[j] as Token | undefined)?.value === 'RECURSIVE') j += 1;
      for (;;) {
        const name = tokens[j] as Token | undefined;
        if (name === undefined || (name.kind !== 'word' && name.kind !== 'identifier')) break;
        cteNames.add(name.kind === 'identifier' ? name.value.toLowerCase() : name.raw.toLowerCase());
        // Skip to the matching close paren of the CTE body, then look for a comma.
        let depth = 0;
        let k = j + 1;
        while (k < tokens.length) {
          const inner = tokens[k] as Token;
          if (inner.raw === '(') depth += 1;
          else if (inner.raw === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
          k += 1;
        }
        const next = tokens[k + 1] as Token | undefined;
        if (next?.raw === ',') {
          j = k + 2;
          continue;
        }
        break;
      }
      continue;
    }

    const isFrom = token.kind === 'word' && token.value === 'FROM';
    const isJoin = token.kind === 'word' && token.value === 'JOIN';
    if (!isFrom && !isJoin) continue;

    let cursor = i + 1;
    for (;;) {
      const next = tokens[cursor] as Token | undefined;
      if (next === undefined) break;
      if (next.raw === '(') {
        // Find the matching close paren.
        let depth = 0;
        let close = cursor;
        while (close < tokens.length) {
          const inner = tokens[close] as Token;
          if (inner.raw === '(') depth += 1;
          else if (inner.raw === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
          close += 1;
        }
        // Unbalanced: nothing further can be read reliably, so stop rather than
        // guess. `validateSql` reports the imbalance separately.
        if (close >= tokens.length) break;

        const head = tokens[cursor + 1] as Token | undefined;
        const isSubquery =
          head?.kind === 'word' && (head.value === 'SELECT' || head.value === 'WITH' || head.value === 'VALUES');
        if (!isSubquery) {
          const inner = extractRelations([
            { kind: 'word', raw: 'FROM', value: 'FROM', start: next.start },
            ...tokens.slice(cursor + 1, close),
          ]);
          relations.push(...inner.relations);
          for (const name of inner.aliases) aliases.add(name);
          for (const name of inner.cteNames) cteNames.add(name);
        }

        // Step over an alias on the group, then a comma continues the list.
        let after = close + 1;
        const groupAs = tokens[after] as Token | undefined;
        if (groupAs?.kind === 'word' && groupAs.value === 'AS') after += 1;
        const groupAlias = tokens[after] as Token | undefined;
        const groupAliasIsKeyword = groupAlias?.kind === 'word' && RELATION_LIST_END.has(groupAlias.value);
        if (
          groupAlias !== undefined &&
          (groupAlias.kind === 'word' || groupAlias.kind === 'identifier') &&
          !groupAliasIsKeyword
        ) {
          aliases.add((groupAlias.kind === 'identifier' ? groupAlias.value : groupAlias.raw).toLowerCase());
          after += 1;
        }
        if ((tokens[after] as Token | undefined)?.raw !== ',') break;
        cursor = after + 1;
        continue;
      }
      if (next.kind !== 'word' && next.kind !== 'identifier') break;
      // A bare keyword here is the end of the list, not a relation named WHERE.
      if (next.kind === 'word' && RELATION_LIST_END.has(next.value)) break;

      // Possible schema qualification: name . name
      const dot = tokens[cursor + 1] as Token | undefined;
      const qualified = tokens[cursor + 2] as Token | undefined;
      if (dot?.raw === '.' && qualified !== undefined && (qualified.kind === 'word' || qualified.kind === 'identifier')) {
        relations.push(`${next.raw.toLowerCase()}.${qualified.raw.toLowerCase()}`);
        cursor += 3;
      } else {
        relations.push(next.kind === 'identifier' ? next.value.toLowerCase() : next.raw.toLowerCase());
        cursor += 1;
      }

      // Step over `AS alias` or a bare alias, then a comma continues the list.
      let k = cursor;
      const maybeAs = tokens[k] as Token | undefined;
      if (maybeAs?.kind === 'word' && maybeAs.value === 'AS') k += 1;
      const alias = tokens[k] as Token | undefined;
      const aliasIsKeyword = alias?.kind === 'word' && RELATION_LIST_END.has(alias.value);
      if (alias !== undefined && (alias.kind === 'word' || alias.kind === 'identifier') && !aliasIsKeyword) {
        aliases.add((alias.kind === 'identifier' ? alias.value : alias.raw).toLowerCase());
        k += 1;
      }
      if ((tokens[k] as Token | undefined)?.raw !== ',') break;
      cursor = k + 1;
    }
  }

  return { relations: [...new Set(relations)], cteNames, aliases };
}

/**
 * Column references.
 *
 * Every bare word that is not a keyword, not a function call (not followed by an
 * open parenthesis) and not an alias introduced by AS. Aliases have to be excluded
 * or every `AS matches` would be reported as an unknown column.
 */
const SQL_KEYWORDS: ReadonlySet<string> = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'GLOB', 'BETWEEN',
  'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'ASC', 'DESC', 'AS', 'ON', 'JOIN', 'LEFT',
  'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'NATURAL', 'USING', 'UNION', 'ALL', 'DISTINCT',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'CAST', 'COLLATE', 'ESCAPE', 'WITH', 'RECURSIVE',
  'INTERSECT', 'EXCEPT', 'OVER', 'PARTITION', 'ROWS', 'RANGE', 'PRECEDING', 'FOLLOWING',
  'CURRENT', 'ROW', 'UNBOUNDED', 'NULLS', 'FIRST', 'LAST', 'TRUE', 'FALSE', 'EXISTS', 'FILTER',
]);

function extractColumns(tokens: readonly Token[]): { columns: string[]; qualified: { table: string; column: string }[] } {
  const columns = new Set<string>();
  const qualified: { table: string; column: string }[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as Token;
    if (token.kind !== 'word' && token.kind !== 'identifier') continue;
    if (token.kind === 'word' && SQL_KEYWORDS.has(token.value)) continue;

    const previous = tokens[i - 1] as Token | undefined;
    const next = tokens[i + 1] as Token | undefined;

    if (next?.raw === '(') continue; // function name
    if (previous?.kind === 'word' && previous.value === 'AS') continue; // alias
    if (previous?.raw === '.') continue; // handled with its qualifier
    if (previous?.kind === 'word' && (previous.value === 'FROM' || previous.value === 'JOIN')) continue;

    if (next?.raw === '.') {
      const after = tokens[i + 2] as Token | undefined;
      if (after !== undefined && (after.kind === 'word' || after.kind === 'identifier')) {
        const table = token.kind === 'identifier' ? token.value : token.raw;
        const column = after.kind === 'identifier' ? after.value : after.raw;
        if (column !== '*') {
          qualified.push({ table: table.toLowerCase(), column: column.toLowerCase() });
          columns.add(`${table.toLowerCase()}.${column.toLowerCase()}`);
        }
        continue;
      }
    }

    const bare = (token.kind === 'identifier' ? token.value : token.raw).toLowerCase();
    columns.add(bare);
  }

  return { columns: [...columns], qualified };
}

export interface ValidateOptions {
  /**
   * Relations the statement is permitted to touch, when narrower than the global
   * allowlist. The pruned schema's table set is passed here, so a model cannot
   * reach a relation it was never shown.
   */
  allowedTables?: readonly string[];
  /** Statement length ceiling. A generated SELECT has no business being longer. */
  maxLength?: number;
}

export function validateSql(sql: string, options: ValidateOptions = {}): ValidationResult {
  const issues: SqlValidationIssue[] = [];
  const push = (severity: SqlValidationIssue['severity'], code: string, message: string): void => {
    issues.push({ severity, code, message });
  };

  const trimmed = sql.trim();
  const maxLength = options.maxLength ?? 8000;

  if (trimmed.length === 0) {
    push('error', 'EMPTY', 'The statement is empty.');
    return { valid: false, issues, tables: [], columns: [], normalised: null };
  }
  if (trimmed.length > maxLength) {
    push('error', 'TOO_LONG', `The statement is ${trimmed.length} characters; the ceiling is ${maxLength}.`);
    return { valid: false, issues, tables: [], columns: [], normalised: null };
  }

  // ── Layer 1: lexical ─────────────────────────────────────────────────────
  const { tokens, error } = tokenise(trimmed);
  if (error !== null) {
    push('error', 'LEX_ERROR', error);
    return { valid: false, issues, tables: [], columns: [], normalised: null };
  }

  const code = codeTokens(tokens);
  if (code.length === 0) {
    push('error', 'NO_STATEMENT', 'The input contains only comments.');
    return { valid: false, issues, tables: [], columns: [], normalised: null };
  }

  if (tokens.some((token) => token.kind === 'comment')) {
    // Not fatal — a model routinely annotates its SQL — but the comment is
    // stripped before execution and the user is told, because a comment is the
    // usual hiding place for a second statement.
    push('warning', 'COMMENTS_STRIPPED', 'Comments were removed from the statement before execution.');
  }

  // ── Layer 2: shape ───────────────────────────────────────────────────────
  // Trailing semicolons are conventional; interior ones mean two statements.
  const semicolons = code.filter((token) => token.raw === ';');
  const lastToken = code[code.length - 1] as Token;
  const trailingOnly = semicolons.length === 0 || (semicolons.length === 1 && lastToken.raw === ';');
  if (!trailingOnly) {
    push('error', 'MULTIPLE_STATEMENTS', 'Only a single statement may be executed. A statement separator was found mid-query.');
  }

  const first = code[0] as Token;
  if (first.kind !== 'word' || (first.value !== 'SELECT' && first.value !== 'WITH')) {
    push('error', 'NOT_A_SELECT', `Only SELECT statements are permitted; this one begins with "${first.raw}".`);
  }
  if (first.value === 'WITH' && !code.some((token) => token.kind === 'word' && token.value === 'SELECT')) {
    push('error', 'NOT_A_SELECT', 'A WITH clause must terminate in a SELECT.');
  }

  for (const token of code) {
    if (token.kind !== 'word') continue;
    if (FORBIDDEN_KEYWORDS.includes(token.value)) {
      push('error', 'FORBIDDEN_KEYWORD', `The keyword ${token.value} is not permitted in a generated query.`);
    }
    if (FORBIDDEN_FUNCTIONS.includes(token.value.toLowerCase())) {
      push('error', 'FORBIDDEN_FUNCTION', `The function ${token.raw} is not permitted.`);
    }
  }

  // ── Layer 3: recursive allowlisting ──────────────────────────────────────
  const { relations, cteNames, aliases } = extractRelations(code);
  const allowed = options.allowedTables === undefined ? ALLOWED_TABLES : new Set(options.allowedTables.map((name) => name.toLowerCase()));

  if (relations.length === 0) {
    push('error', 'NO_RELATION', 'The statement references no relation, so there is nothing to read.');
  }

  for (const relation of relations) {
    if (cteNames.has(relation)) continue;
    if (relation.includes('.')) {
      push('error', 'SCHEMA_QUALIFIED', `Schema-qualified references are not permitted ("${relation}").`);
      continue;
    }
    if (!ALLOWED_TABLES.has(relation)) {
      push(
        'error',
        'RELATION_NOT_ALLOWED',
        `The relation "${relation}" is not readable from a natural-language query. Only impersonal market, feature and signal relations are exposed.`,
      );
      continue;
    }
    if (!allowed.has(relation)) {
      push(
        'error',
        'RELATION_NOT_IN_SCHEMA',
        `The relation "${relation}" was not part of the schema supplied for this question.`,
      );
    }
  }

  /*
   * Qualified columns are checked against the relation they name.
   *
   * A qualifier that names no known relation used to be skipped outright, on the
   * grounds that an alias is not resolvable without full name resolution. It is
   * resolvable: the FROM-list walk above already steps over every alias to find
   * the next comma, so it can simply record them. Anything that is neither a
   * catalogued table, a CTE, nor an alias declared in this statement is a
   * reference to something that is not in scope, and saying so is the point.
   */
  const { columns, qualified } = extractColumns(code);
  for (const reference of qualified) {
    const known = TABLE_COLUMNS.get(reference.table);
    if (known === undefined) {
      if (!cteNames.has(reference.table) && !aliases.has(reference.table)) {
        push(
          'error',
          'UNKNOWN_QUALIFIER',
          `"${reference.table}" is not a relation, a CTE or an alias declared in this query.`,
        );
      }
      continue;
    }
    if (!known.has(reference.column)) {
      push(
        'error',
        'UNKNOWN_COLUMN',
        `Column "${reference.column}" does not exist on ${reference.table}.`,
      );
    }
  }

  // Bare columns are checked against the union of the referenced relations, which
  // is exact for the single-relation queries the compiler emits and permissive for
  // joins — where the ambiguity is genuine and SQLite will report it anyway.
  const permittedColumns = new Set<string>();
  for (const relation of relations) {
    for (const column of TABLE_COLUMNS.get(relation) ?? []) permittedColumns.add(column);
  }
  if (permittedColumns.size > 0 && cteNames.size === 0) {
    for (const column of columns) {
      if (column.includes('.') || column === '*') continue;
      if (permittedColumns.has(column)) continue;
      push(
        'warning',
        'UNRECOGNISED_IDENTIFIER',
        `"${column}" is not a column of the referenced relations; it may be an alias or a function this validator does not model.`,
      );
    }
  }

  const normalised = code
    .filter((token) => token.raw !== ';')
    .map((token) => token.raw)
    .join(' ')
    .replace(/\s+([,.)])/g, '$1')
    .replace(/([(])\s+/g, '$1');

  return {
    valid: issues.every((issue) => issue.severity !== 'error'),
    issues,
    tables: relations,
    columns,
    normalised,
  };
}
