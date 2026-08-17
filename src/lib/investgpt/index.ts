/**
 * InvestGPT — the natural-language screening surface.
 *
 * Prune → compile → (optionally) generate → validate → execute → explain.
 *
 * The stage worth explaining is the third. When no model is configured the
 * deterministic compiler's SQL is used, full stop. When a model *is* configured,
 * both paths run and the model's SQL is adopted only if it clears three
 * independent bars:
 *
 *   1. the validator passes it, with the pruned table set as the allowlist — so it
 *      cannot reach a relation it was never shown;
 *   2. it executes without error;
 *   3. it returns at least one row, or the compiler's SQL returned none either.
 *
 * That last condition is the one that stops a plausible-looking model query from
 * silently replacing a working one. A model that misreads "conviction above 60" as
 * a filter on `probability` produces valid, safe, allowlisted SQL that returns
 * nothing, and without the row-count comparison the user would see an empty
 * screener and conclude the market had no matches. The compiler is the floor, and
 * the model has to clear it rather than merely be admissible.
 *
 * `source` on the result reports which path won, always. A user is never left
 * guessing whether they are reading deterministic or generated SQL.
 */

import { complete } from '@/lib/ai';
import { compileQuestion, type CompiledQuery } from '@/lib/investgpt/compile';
import { pruneSchema, type PrunedSchema } from '@/lib/investgpt/prune';
import { validateSql, type ValidationResult } from '@/lib/investgpt/validate';
import { executeQuery, storeReady, type ExecutionResult } from '@/lib/investgpt/execute';
import { CATALOG, catalogSize } from '@/lib/investgpt/catalog';
import type { InvestGptResult } from '@/lib/domain/types';

export type { CatalogEntry, CatalogGroup, CatalogUnit, DerivedVariant, SqlType, TableColumn, TableSpec } from '@/lib/investgpt/catalog';
export {
  CATALOG,
  DERIVED_VARIANTS,
  FEATURE_HISTORY_TABLE,
  FK_GRAPH,
  MATERIALISED_ENTRIES,
  SIGNAL_TABLE,
  SNAPSHOT_COLUMNS,
  SNAPSHOT_TABLE,
  SYMBOLS_TABLE,
  TABLES,
  TABLE_COLUMNS,
  catalogSize,
  entriesForTable,
  lookup,
  tableSpec,
} from '@/lib/investgpt/catalog';
export type { CompiledQuery, QueryPlan } from '@/lib/investgpt/compile';
export { RECOGNISED_SECTORS, compileQuestion } from '@/lib/investgpt/compile';
export type { PruneOptions, PrunedSchema } from '@/lib/investgpt/prune';
export { pruneSchema } from '@/lib/investgpt/prune';
export type { ValidateOptions, ValidationResult } from '@/lib/investgpt/validate';
export { validateSql } from '@/lib/investgpt/validate';
export type { ExecuteOptions, ExecutionResult } from '@/lib/investgpt/execute';
export { MAX_ROWS, executeQuery, storeReady } from '@/lib/investgpt/execute';

const GENERATION_SYSTEM = [
  'You translate a question about US equities into exactly one SQLite SELECT statement.',
  '',
  'Rules, all absolute:',
  '• Emit SQL only. No prose, no markdown fence, no trailing commentary.',
  '• One statement. No semicolon except optionally at the very end.',
  '• SELECT only. Never INSERT, UPDATE, DELETE, CREATE, DROP, ATTACH or PRAGMA.',
  '• Use only the tables and columns in the schema below. Nothing else exists.',
  '• Always include `is_benchmark = 0` in the WHERE clause — the benchmark ETF is not screenable.',
  '• Always include an explicit LIMIT, at most 200.',
  '• Always project `symbol` and `name` so the result is readable.',
  '• Percent columns store whole percentage points: 5% is 5, not 0.05.',
  '• market_cap and adv30 are in dollars and shares respectively, unscaled.',
  '',
  'If the question cannot be answered from the schema, emit a SELECT that returns zero rows rather than inventing a column.',
].join('\n');

export interface QueryOptions {
  /** Suppresses the live-model path even when a provider is configured. */
  deterministicOnly?: boolean;
  maxRows?: number;
  signal?: AbortSignal;
  correlationId?: string;
}

export interface QueryResult extends InvestGptResult {
  /** The compiler's structured reading of the question. */
  plan: CompiledQuery['plan'];
  /** The DDL the model was shown, so a user can see what it had to work with. */
  prunedDdl: string;
  /** True when the row cap truncated the result. */
  truncated: boolean;
}

/**
 * Answers a question.
 *
 * Never throws. Every failure mode — an unseeded store, an invalid generated
 * statement, a driver error — resolves to a result carrying the SQL that was
 * attempted and a note explaining what happened, because a screener that fails
 * opaquely is indistinguishable from a screener that found nothing.
 */
export async function query(question: string, options: QueryOptions = {}): Promise<QueryResult> {
  const startedAt = Date.now();
  const notes: string[] = [];

  const pruned: PrunedSchema = pruneSchema(question);
  const compiled = compileQuestion(question);
  notes.push(...compiled.notes);
  for (const fragment of compiled.unparsed) {
    notes.push(`Not interpreted: ${fragment}`);
  }

  const readiness = storeReady();
  if (!readiness.ready) {
    return {
      question,
      sql: compiled.sql,
      source: 'deterministic_compiler',
      llmProvider: null,
      pruning: pruned.report,
      validation: { valid: true, issues: [], ast: null },
      columns: compiled.columns,
      rows: [],
      rowCount: 0,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      explanation: compiled.explanation,
      notes: [...notes, readiness.reason ?? 'The store is not ready.'],
      plan: compiled.plan,
      prunedDdl: pruned.ddl,
      truncated: false,
    };
  }

  // ── Deterministic path ───────────────────────────────────────────────────
  const compiledValidation = validateSql(compiled.sql, { allowedTables: pruned.tables });
  if (!compiledValidation.valid) {
    // The compiler emitting SQL its own validator rejects is a bug, not a user
    // error, and it must surface loudly rather than degrade into an empty table.
    return {
      question,
      sql: compiled.sql,
      source: 'deterministic_compiler',
      llmProvider: null,
      pruning: pruned.report,
      validation: { valid: false, issues: compiledValidation.issues, ast: compiledValidation.normalised },
      columns: [],
      rows: [],
      rowCount: 0,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      explanation: compiled.explanation,
      notes: [
        ...notes,
        'The compiled statement failed validation. This is a platform defect rather than a problem with the question; the statement and the reason are shown above.',
      ],
      plan: compiled.plan,
      prunedDdl: pruned.ddl,
      truncated: false,
    };
  }

  const compiledExecution = executeQuery(compiled.sql, { params: compiled.params, maxRows: options.maxRows });

  let winner: {
    sql: string;
    source: InvestGptResult['source'];
    provider: string | null;
    validation: ValidationResult;
    execution: ExecutionResult;
    explanation: string;
  } = {
    sql: compiled.sql,
    source: 'deterministic_compiler',
    provider: null,
    validation: compiledValidation,
    execution: compiledExecution,
    explanation: compiled.explanation,
  };

  // ── Live path ────────────────────────────────────────────────────────────
  if (options.deterministicOnly !== true) {
    const response = await complete({
      task: 'nl_to_sql',
      system: GENERATION_SYSTEM,
      messages: [{ role: 'user', content: `Schema:\n\n${pruned.ddl}\n\nQuestion: ${question}\n\nSQL:` }],
      temperature: 0,
      maxTokens: 600,
      signal: options.signal,
      correlationId: options.correlationId,
    });

    if (response.live) {
      const candidate = stripFence(response.text);
      const candidateValidation = validateSql(candidate, { allowedTables: pruned.tables });

      if (!candidateValidation.valid) {
        notes.push(
          `The generated statement was rejected by the validator (${candidateValidation.issues
            .filter((issue) => issue.severity === 'error')
            .map((issue) => issue.code)
            .join(', ')}), so the deterministic compiler's SQL was used.`,
        );
      } else {
        // The model's SQL carries its literals inline — it was never given
        // parameters — so it executes without a parameter list.
        const candidateExecution = executeQuery(candidate, { maxRows: options.maxRows });
        if (candidateExecution.error !== null) {
          notes.push(`The generated statement failed to execute (${candidateExecution.error}), so the deterministic compiler's SQL was used.`);
        } else if (candidateExecution.rowCount === 0 && compiledExecution.rowCount > 0) {
          notes.push(
            'The generated statement was valid but matched no rows while the deterministic compiler matched some, so the compiler\'s SQL was used.',
          );
        } else {
          winner = {
            sql: candidate,
            source: 'llm',
            provider: response.provider,
            validation: candidateValidation,
            execution: candidateExecution,
            explanation: `Generated by ${response.provider} against the pruned schema. ${compiled.explanation}`,
          };
          const warnings = candidateValidation.issues.filter((issue) => issue.severity === 'warning');
          if (warnings.length > 0) {
            notes.push(`The generated statement passed with ${warnings.length} validator warning(s).`);
          }
        }
      }
    } else if (response.fallbackReason !== null) {
      notes.push(`Live generation was unavailable: ${response.fallbackReason}`);
    }
  }

  if (winner.execution.error !== null) {
    notes.push(`Execution failed: ${winner.execution.error}`);
  }
  if (winner.execution.truncated) {
    notes.push(`The result was truncated to ${winner.execution.rowCount} rows.`);
  }
  if (winner.execution.rowCount === 0 && winner.execution.error === null) {
    notes.push('No symbol in the current snapshot satisfies every condition.');
  }

  return {
    question,
    sql: winner.sql,
    source: winner.source,
    llmProvider: winner.provider,
    pruning: pruned.report,
    validation: {
      valid: winner.validation.valid,
      issues: winner.validation.issues,
      ast: winner.validation.normalised,
    },
    columns: winner.execution.columns.length > 0 ? winner.execution.columns : compiled.columns,
    rows: winner.execution.rows,
    rowCount: winner.execution.rowCount,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    explanation: winner.explanation,
    notes,
    plan: compiled.plan,
    prunedDdl: pruned.ddl,
    truncated: winner.execution.truncated,
  };
}

/** Removes a markdown fence a model wrapped its SQL in, and any trailing prose. */
function stripFence(text: string): string {
  const fenced = /```(?:sql)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  // A model that adds an explanation after the statement puts it on its own line
  // following the semicolon; keeping everything up to and including it is enough.
  const semicolon = body.indexOf(';');
  return (semicolon >= 0 ? body.slice(0, semicolon) : body).trim();
}

/** Catalog statistics for the schema explorer's header. */
export function catalogSummary(): {
  total: number;
  materialised: number;
  derived: number;
  inModel: number;
  byGroup: { group: string; count: number }[];
} {
  const byGroup = new Map<string, number>();
  for (const entry of CATALOG) byGroup.set(entry.group, (byGroup.get(entry.group) ?? 0) + 1);
  return {
    total: catalogSize(),
    materialised: CATALOG.filter((entry) => entry.materialised).length,
    derived: CATALOG.filter((entry) => entry.variant !== null).length,
    inModel: CATALOG.filter((entry) => entry.inModel).length,
    byGroup: [...byGroup.entries()]
      .map(([group, count]) => ({ group, count }))
      .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group)),
  };
}

/**
 * Example questions offered in the UI.
 *
 * Chosen to exercise different compiler paths — a categorical filter, a numeric
 * threshold, a regime band, an aggregate, a compound predicate, an explicit
 * ordering — so the examples double as a demonstration of what the surface
 * actually understands.
 *
 * They are also chosen to *return rows*. Four of the previous eight compiled
 * correctly and matched nothing — "conviction above 55" against a calibrated
 * model whose highest score is 37, "OU z-score below -2" against a universe whose
 * z-scores cluster at zero — so half the starter chips demonstrated the empty
 * state. A worked example that returns nothing reads as a broken feature however
 * carefully the empty panel is written, and the thresholds here are loose enough
 * to survive a different seed. A question a user writes themselves can still
 * match nothing, and the result panel says so plainly.
 */
export const EXAMPLE_QUESTIONS: readonly string[] = [
  'Top 10 by conviction',
  'Technology stocks sorted by conviction descending',
  'Which optionable large cap names have a 25 delta risk reversal below -2?',
  'How many mid cap healthcare stocks are bullish?',
  'Stocks in a trending bull regime sorted by conviction descending',
  'Bearish names with market cap over 50',
  'Names where RSI (14) is under 30 sorted by ATR percent ascending',
  'Which symbols have relative volume above 1.5 and a positive MLOFI intent?',
];
