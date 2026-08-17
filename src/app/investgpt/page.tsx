/**
 * InvestGPT — natural-language screening.
 *
 * The unusual thing about this page is how much of the machinery it shows. The SQL,
 * the pruning report, the validator verdict and the compiler's structured reading
 * of the question are all rendered next to the rows, and that is the design rather
 * than developer tooling left switched on.
 *
 * The reason is that a natural-language query surface has a specific failure mode:
 * it misunderstands the question and returns a confident, well-formatted table that
 * answers something else. There is no way for a user to detect that from the rows
 * alone. Showing the statement makes it detectable in one glance — "conviction >
 * 60" is either in the WHERE clause or it isn't — and showing the pruning report
 * makes it clear which of 829 catalog surfaces were even considered.
 *
 * `source` is always displayed. A user is never left guessing whether they are
 * reading deterministic SQL or a model's.
 */

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { PageHeader, PageShell } from '@/components/PageState';
import {
  Badge,
  Button,
  Divider,
  INPUT_CLASS,
  Notice,
  Panel,
  PanelHeader,
  StatGrid,
  StatTile,
  TableShell,
  Td,
  Th,
} from '@/components/ui/primitives';
import { ApiRequestError, request, useApi } from '@/lib/ui/api';
import { duration, integer, percent } from '@/lib/ui/format';

interface SqlValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

interface QueryResult {
  question: string;
  sql: string;
  source: 'deterministic_compiler' | 'llm';
  llmProvider: string | null;
  pruning: {
    totalColumns: number;
    keptColumns: number;
    prunedPercent: number;
    tables: string[];
    matches: { key: string; score: number; reason: string }[];
    elapsedMs: number;
  };
  validation: { valid: boolean; issues: SqlValidationIssue[]; ast: string | null };
  columns: string[];
  rows: (string | number | null)[][];
  rowCount: number;
  elapsedMs: number;
  explanation: string;
  notes: string[];
  plan: {
    intent: string;
    filters: { column: string; operator: string; value: string; source: string }[];
    orderBy: { column: string; direction: string } | null;
    limit: number;
    aggregate: { function: string; column: string } | null;
  };
  prunedDdl: string;
  truncated: boolean;
  ai: { provider: string; model: string; live: boolean; reason: string };
}

interface MetaResponse {
  catalog: { total: number; materialised: number; derived: number; inModel: number; byGroup: { group: string; count: number }[] };
  examples: string[];
  store: { ready: boolean; reason: string | null; symbols: number };
  maxRows: number;
  ai: { provider: string; model: string; live: boolean; reason: string };
}

/** Column names whose values are a tradable symbol, so they can link out. */
const SYMBOL_COLUMNS = new Set(['symbol']);

export default function InvestGptPage() {
  const meta = useApi<MetaResponse>('/investgpt/query');
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [showSql, setShowSql] = useState(true);

  async function run(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length < 3 || pending) return;
    setPending(true);
    setError(null);
    try {
      setResult(await request<QueryResult>('/investgpt/query', { method: 'POST', body: { question: trimmed } }));
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : 'The query could not be run.');
      setResult(null);
    } finally {
      setPending(false);
    }
  }

  const errors = result?.validation.issues.filter((i) => i.severity === 'error') ?? [];
  const warnings = result?.validation.issues.filter((i) => i.severity === 'warning') ?? [];

  return (
    <PageShell wide>
      <PageHeader
        eyebrow="Natural language to SQL"
        title="InvestGPT"
        lede="Ask about the universe in plain English. The question is compiled to a SELECT statement, the statement is shown to you, and it is validated against a read-only allowlist before it runs."
        action={
          meta.data ? (
            <Badge tone={meta.data.ai.live ? 'gold' : 'neutral'} title={meta.data.ai.reason}>
              {meta.data.ai.live ? `live · ${meta.data.ai.provider}` : 'deterministic compiler'}
            </Badge>
          ) : null
        }
      />

      {meta.data?.store.ready === false ? (
        <Notice tone="warning" title="Feature store empty" className="mb-6">
          {meta.data.store.reason}
        </Notice>
      ) : null}

      <Panel className="mb-5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(question);
          }}
        >
          <label className="eyebrow mb-2 block" htmlFor="investgpt-question">
            Your question
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              id="investgpt-question"
              className={INPUT_CLASS}
              type="text"
              value={question}
              maxLength={600}
              placeholder="Which optionable large cap names have conviction above 55?"
              onChange={(e) => setQuestion(e.target.value)}
            />
            <Button type="submit" variant="primary" size="lg" disabled={pending || question.trim().length < 3}>
              {pending ? 'Compiling…' : 'Run'}
            </Button>
          </div>
        </form>

        {meta.data ? (
          <div className="mt-4">
            <p className="eyebrow mb-2">Try one of these</p>
            <div className="flex flex-wrap gap-2">
              {meta.data.examples.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => {
                    setQuestion(example);
                    void run(example);
                  }}
                  className="border border-obsidian-edge px-2.5 py-1 text-left text-[0.75rem] text-parchment-dim transition-colors hover:border-parchment-ghost hover:text-parchment"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </Panel>

      {error !== null ? (
        <Notice tone="error" title="Query failed" className="mb-5">
          {error}
        </Notice>
      ) : null}

      {result !== null ? (
        <>
          <StatGrid className="mb-5" columns={5}>
            <StatTile
              label="Rows"
              value={integer(result.rowCount)}
              tone="gold"
              footnote={result.truncated ? 'Truncated by the row cap' : 'Complete result'}
            />
            <StatTile
              label="Schema pruned"
              value={percent(result.pruning.prunedPercent, 1)}
              footnote={`${integer(result.pruning.keptColumns)} of ${integer(result.pruning.totalColumns)} surfaces kept`}
            />
            <StatTile
              label="Source"
              value={result.source === 'llm' ? (result.llmProvider ?? 'model') : 'compiler'}
              size="sm"
              footnote={result.source === 'llm' ? 'Generated, then validated' : 'Deterministic; reproducible'}
            />
            <StatTile
              label="Validation"
              value={result.validation.valid ? 'passed' : 'rejected'}
              tone={result.validation.valid ? 'sage' : 'burgundy'}
              size="sm"
              footnote={`${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`}
            />
            <StatTile label="Elapsed" value={duration(result.elapsedMs)} size="sm" footnote="Prune, compile, validate, execute" />
          </StatGrid>

          {result.notes.length > 0 ? (
            <Notice tone="info" title="How the question was read" className="mb-5">
              <ul className="space-y-1">
                {result.notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            </Notice>
          ) : null}

          {errors.length > 0 ? (
            <Notice tone="error" title="The statement was rejected" className="mb-5">
              <ul className="space-y-1">
                {errors.map((issue, i) => (
                  <li key={i}>
                    <span className="font-mono text-2xs uppercase text-burgundy-bright">{issue.code}</span>{' '}
                    {issue.message}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}

          <Panel className="mb-5">
            <PanelHeader
              eyebrow="Generated statement"
              title="The exact SQL that ran"
              detail={result.explanation}
              action={
                <Button size="sm" variant="ghost" onClick={() => setShowSql((v) => !v)} aria-expanded={showSql}>
                  {showSql ? 'Hide' : 'Show'}
                </Button>
              }
            />
            {showSql ? (
              <>
                <pre className="scroll-x mt-4 border border-obsidian-edge bg-vanta-deep p-4 font-mono text-[0.75rem] leading-relaxed text-parchment-dim">
                  {result.sql}
                </pre>
                <Divider className="my-4" />
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                  <div>
                    <p className="eyebrow mb-2">Structured reading</p>
                    {result.plan.filters.length === 0 ? (
                      <p className="text-[0.75rem] text-parchment-faint">No filter was recognised in the question.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {result.plan.filters.map((filter, i) => (
                          <li key={i} className="font-mono text-[0.75rem] text-parchment-dim">
                            <span className="text-parchment">{filter.column}</span> {filter.operator}{' '}
                            <span className="text-gold">{filter.value}</span>
                            <span className="ml-2 text-parchment-ghost">← “{filter.source}”</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="mt-3 font-mono text-[0.75rem] text-parchment-faint">
                      order by {result.plan.orderBy?.column ?? '—'} {result.plan.orderBy?.direction ?? ''} · limit{' '}
                      {result.plan.limit}
                    </p>
                  </div>
                  <div>
                    <p className="eyebrow mb-2">Retrieved schema surfaces</p>
                    <ul className="space-y-1">
                      {result.pruning.matches.slice(0, 8).map((match) => (
                        <li key={match.key} className="text-[0.75rem] text-parchment-dim" title={match.reason}>
                          <span className="font-mono text-parchment">{match.key}</span>{' '}
                          <span className="text-parchment-ghost">{match.score.toFixed(2)}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-3 font-mono text-2xs uppercase tracking-institutional text-parchment-faint">
                      relations: {result.pruning.tables.join(', ')}
                    </p>
                  </div>
                </div>
              </>
            ) : null}
          </Panel>

          <Panel padded={false}>
            <div className="p-5 pb-0">
              <PanelHeader
                eyebrow="Result"
                title={`${integer(result.rowCount)} row${result.rowCount === 1 ? '' : 's'}`}
                detail={
                  result.rowCount === 0
                    ? 'No symbol in the current snapshot satisfies every condition. The statement above is the query that returned nothing.'
                    : undefined
                }
              />
            </div>
            {result.rowCount > 0 ? (
              <div className="scroll-x mt-4">
                <TableShell>
                  <thead>
                    <tr>
                      {result.columns.map((column) => (
                        <Th key={column} align={SYMBOL_COLUMNS.has(column) ? 'left' : 'right'}>
                          {column}
                        </Th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, rowIndex) => (
                      <tr key={rowIndex} className="hover:bg-obsidian-light/50">
                        {row.map((cell, cellIndex) => {
                          const column = result.columns[cellIndex] ?? '';
                          const symbolCell = SYMBOL_COLUMNS.has(column) && typeof cell === 'string';
                          return (
                            <Td
                              key={cellIndex}
                              align={symbolCell ? 'left' : 'right'}
                              numeric={typeof cell === 'number'}
                            >
                              {symbolCell ? (
                                <Link
                                  href={`/terminal/${cell}`}
                                  className="font-mono text-parchment underline decoration-obsidian-edge hover:decoration-gold"
                                >
                                  {cell}
                                </Link>
                              ) : (
                                formatCell(cell)
                              )}
                            </Td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </TableShell>
              </div>
            ) : (
              <div className="p-5" />
            )}
          </Panel>

          <Notice tone="legal" className="mt-5">
            A query result is a filter over impersonal published statistics. It is not a recommendation, and the
            ordering of rows carries no view on any security.
          </Notice>
        </>
      ) : (
        <Panel>
          <PanelHeader
            eyebrow="Schema"
            title="What you can ask about"
            detail="The catalog is retrieved over, not injected wholesale — a question reaches only the columns it scores against."
          />
          {meta.data ? (
            <>
              <StatGrid className="mt-4" columns={4}>
                <StatTile label="Queryable surfaces" value={integer(meta.data.catalog.total)} />
                <StatTile label="Stored columns" value={integer(meta.data.catalog.materialised)} footnote="Physically present" />
                <StatTile
                  label="Derived variants"
                  value={integer(meta.data.catalog.derived)}
                  footnote="Window expressions, not columns"
                />
                <StatTile label="Model features" value={integer(meta.data.catalog.inModel)} footnote="Consumed by the ensemble" />
              </StatGrid>
              <Divider className="my-4" />
              <div className="flex flex-wrap gap-2">
                {meta.data.catalog.byGroup.map((group) => (
                  <Badge key={group.group}>
                    {group.group.replace(/_/g, ' ')} · {group.count}
                  </Badge>
                ))}
              </div>
            </>
          ) : null}
        </Panel>
      )}
    </PageShell>
  );
}

/**
 * Renders one cell.
 *
 * Numbers are shown to six significant figures rather than rounded to two: this is
 * a query result, and a user who asked for a raw column value should get the value,
 * not a presentation of it. Formatting is the terminal's job; a SQL result table is
 * where the underlying number belongs.
 */
function formatCell(cell: string | number | null): string {
  if (cell === null) return '—';
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell)) return '—';
    if (Number.isInteger(cell)) return cell.toLocaleString('en-US');
    return Number(cell.toPrecision(6)).toLocaleString('en-US', { maximumFractionDigits: 6 });
  }
  return cell;
}
