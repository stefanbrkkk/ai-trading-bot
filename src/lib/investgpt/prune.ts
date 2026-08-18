/**
 * CSR-RAG schema pruning.
 *
 * The problem it solves is quantitative. The catalog exposes 829 queryable
 * surfaces — `CATALOG.length`, the same number this file publishes as
 * `report.totalColumns` and the terminal prints on the InvestGPT page — across
 * four relations, `TABLES.length`. The full DDL for them runs to tens of
 * thousands of tokens. Injecting that into a model context is both expensive and
 * counter-productive — recall of the *correct* column falls as the candidate set
 * grows, which is the finding the research reports and the reason schema
 * retrieval exists as a distinct stage rather than being folded into generation.
 *
 * The two figures are named to their constants because this paragraph had drifted
 * to "~720 surfaces across five relations" while the code twenty lines below went
 * on deriving 829 from `CATALOG.length` and shipping it to the page. A docstring
 * that disagrees with the number on screen is not a small inaccuracy here: the
 * pruning report exists so a reader can check how hard the schema was cut.
 *
 * Three stages, each with a specific job:
 *
 *   A. **Lexical retrieval over the catalog.** Every entry carries a `searchText`
 *      (label, aliases, description, group, key). Entries are scored against the
 *      question with an exact-phrase bonus, alias matching and term coverage.
 *      This is where "oversold" finds `rsi_14` and "how liquid is it" finds
 *      `adv30`.
 *
 *   B. **Deterministic FK-graph expansion.** Whatever tables the surviving
 *      entries live on, their foreign-key neighbours are admitted too. This is
 *      what makes multi-hop questions answerable: a question that scores only
 *      feature columns still gets `symbols` so it can filter by sector.
 *
 *   C. **DDL emission.** The surviving columns are rendered as CREATE
 *      statements — types, nullability, primary and foreign keys, one-line column
 *      comments — so a model receives a schema it can actually generate against
 *      rather than a list of names.
 *
 * The pruner is deliberately *recall-oriented*. Dropping the column a question
 * needs makes the question unanswerable, while admitting a few extra costs only
 * tokens, so every threshold here is set to over-admit at the margin.
 */

import {
  CATALOG,
  FEATURE_HISTORY_TABLE,
  FK_GRAPH,
  SNAPSHOT_TABLE,
  type CatalogEntry,
  TABLES,
  tableSpec,
} from '@/lib/investgpt/catalog';
import { tokenise } from '@/lib/ai/deterministic';
import { stem } from '@/lib/rag/retrieve';
import type { SchemaPruningReport } from '@/lib/domain/types';

export interface PrunedSchema {
  report: SchemaPruningReport;
  /** Catalog entries that survived, best first. */
  entries: CatalogEntry[];
  /** Relations that survived, in dependency order. */
  tables: string[];
  /** The DDL a model would be shown. */
  ddl: string;
}

/**
 * Columns admitted regardless of score.
 *
 * `symbol` is the join key and the only human-readable identifier; a projection
 * without it is useless whatever the question asked. The rest are what every
 * screening answer is expected to carry, and their absence is the difference
 * between a result a user can read and a column of bare numbers.
 */
const ALWAYS_KEEP: readonly string[] = [
  'symbol',
  'name',
  'sector',
  'price',
  'change_percent',
  'conviction',
  'direction',
];

/** Score below which an entry is not worth its tokens. */
const SCORE_FLOOR = 0.6;
/** Hard ceiling on admitted columns, so a vague question cannot admit everything. */
const MAX_COLUMNS = 46;

interface Scored {
  entry: CatalogEntry;
  score: number;
  reason: string;
}

/**
 * Scores one catalog entry against the question.
 *
 * The weights encode a precedence that matters in practice. An exact alias match
 * ("relative volume") is near-conclusive evidence and outranks everything. A
 * label-term match is strong. A description-term match is weak — descriptions
 * share vocabulary across the whole catalog, so scoring them highly would make
 * every entry look relevant. And a derived variant must clear an extra gate: its
 * cue phrases have to appear, because otherwise the 712 derived entries
 * out-recall the 117 base surfaces on every question that merely names a feature.
 */
function scoreEntry(entry: CatalogEntry, question: string, terms: ReadonlySet<string>): Scored | null {
  const lower = question.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  for (const alias of entry.aliases) {
    const aliasLower = alias.toLowerCase();
    if (aliasLower.length >= 4 && lower.includes(aliasLower)) {
      score += 4.5;
      reasons.push(`alias "${alias}"`);
      break;
    }
  }

  if (entry.label.length >= 4 && lower.includes(entry.label.toLowerCase())) {
    score += 3.5;
    reasons.push(`label "${entry.label}"`);
  }

  // The column name itself: users paste them from the schema explorer.
  if (lower.includes(entry.sqlColumn.toLowerCase()) && entry.sqlColumn.length >= 4) {
    score += 4;
    reasons.push(`column ${entry.sqlColumn}`);
  }

  const labelTerms = new Set(tokenise(entry.label).map(stem));
  let labelHits = 0;
  for (const term of labelTerms) if (terms.has(term)) labelHits += 1;
  if (labelHits > 0) {
    score += 1.6 * (labelHits / labelTerms.size) * Math.min(3, labelHits);
    reasons.push(`${labelHits} label term(s)`);
  }

  const aliasTerms = new Set(entry.aliases.flatMap((alias) => tokenise(alias).map(stem)));
  let aliasHits = 0;
  for (const term of aliasTerms) if (terms.has(term)) aliasHits += 1;
  if (aliasHits > 0) {
    score += 0.9 * Math.min(3, aliasHits);
    reasons.push(`${aliasHits} alias term(s)`);
  }

  const descriptionTerms = new Set(tokenise(entry.description).map(stem));
  let descriptionHits = 0;
  for (const term of descriptionTerms) if (terms.has(term)) descriptionHits += 1;
  if (descriptionHits > 0) {
    score += 0.22 * Math.min(4, descriptionHits);
    reasons.push(`${descriptionHits} description term(s)`);
  }

  if (entry.variant !== null) {
    const cued = entry.cues.some((cue) => lower.includes(cue.toLowerCase()));
    if (!cued) return null;
    score += 1.5;
    reasons.push(`derived-variant cue matched (${entry.variant})`);
  }

  // A tie between an in-model feature and a variant the model does not consume
  // should resolve to the one the platform actually reasons with.
  if (entry.inModel) score += 0.3;

  if (score < SCORE_FLOOR) return null;
  return { entry, score, reason: reasons.join('; ') };
}

/** One CREATE statement per relation, with only the admitted columns. */
function emitDdl(tables: readonly string[], entries: readonly CatalogEntry[]): string {
  const byTable = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (!entry.materialised) continue;
    const set = byTable.get(entry.table) ?? new Set<string>();
    set.add(entry.sqlColumn);
    byTable.set(entry.table, set);
  }

  const blocks: string[] = [];

  for (const name of tables) {
    const spec = tableSpec(name);
    if (spec === undefined) continue;
    const admitted = byTable.get(name);

    /**
     * A relation admitted purely by FK expansion has no scored columns of its
     * own. Emitting it with zero columns would be worse than useless — a model
     * would read it as a table it may join to but never project from — so its key
     * columns are published instead.
     */
    const columns = spec.columns.filter((column) => {
      if (admitted !== undefined && admitted.has(column.name)) return true;
      if (spec.primaryKey.includes(column.name)) return true;
      if (spec.foreignKeys.some((fk) => fk.column === column.name)) return true;
      return admitted === undefined && ALWAYS_KEEP.includes(column.name);
    });

    const lines = columns.map((column) => {
      const nullability = column.nullable ? '' : ' NOT NULL';
      return `  ${column.name} ${column.sqlType}${nullability},  -- ${column.description}`;
    });

    if (spec.primaryKey.length > 0) lines.push(`  PRIMARY KEY (${spec.primaryKey.join(', ')})`);
    for (const fk of spec.foreignKeys) {
      lines.push(`  FOREIGN KEY (${fk.column}) REFERENCES ${fk.referencesTable}(${fk.referencesColumn})`);
    }

    blocks.push(`-- ${spec.description}\nCREATE ${spec.kind === 'view' ? 'VIEW' : 'TABLE'} ${spec.name} (\n${lines.join('\n')}\n);`);
  }

  // Derived entries are not columns; they are documented expressions, and a model
  // that does not see the expression cannot use the surface at all.
  const derived = entries.filter((entry) => !entry.materialised);
  if (derived.length > 0) {
    const expressions = derived
      .slice(0, 12)
      .map((entry) => `--   ${entry.label}: ${entry.sqlColumn}\n--     ${entry.derivation ?? entry.description}`)
      .join('\n');
    blocks.push(
      `-- Derived surfaces (window expressions over ${FEATURE_HISTORY_TABLE}, not stored columns):\n${expressions}`,
    );
  }

  return blocks.join('\n\n');
}

export interface PruneOptions {
  /** Hard ceiling on admitted columns. */
  maxColumns?: number;
  /** Extra columns to admit whatever the score (a follow-up referencing them). */
  require?: readonly string[];
}

export function pruneSchema(question: string, options: PruneOptions = {}): PrunedSchema {
  const startedAt = Date.now();
  const maxColumns = options.maxColumns ?? MAX_COLUMNS;

  const terms = new Set(tokenise(question).map(stem));
  const required = new Set([...ALWAYS_KEEP, ...(options.require ?? [])]);

  const scored: Scored[] = [];
  for (const entry of CATALOG) {
    const result = scoreEntry(entry, question, terms);
    if (result !== null) scored.push(result);
  }

  scored.sort((a, b) =>
    b.score === a.score ? a.entry.key.localeCompare(b.entry.key) : b.score - a.score,
  );

  const keptEntries: CatalogEntry[] = [];
  const seen = new Set<string>();

  // The mandatory columns first, so a low ceiling cannot evict the identifier.
  for (const column of required) {
    const entry = CATALOG.find((candidate) => candidate.sqlColumn === column && candidate.table === SNAPSHOT_TABLE);
    if (entry !== undefined && !seen.has(entry.key)) {
      seen.add(entry.key);
      keptEntries.push(entry);
    }
  }

  for (const { entry } of scored) {
    if (keptEntries.length >= maxColumns) break;
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    keptEntries.push(entry);
  }

  // ── Stage B: deterministic FK-graph expansion ────────────────────────────
  const tableSet = new Set<string>(keptEntries.map((entry) => entry.table));
  // The snapshot view is always present: it is the screening surface, and every
  // question that reaches the compiler is answered from it.
  tableSet.add(SNAPSHOT_TABLE);
  for (const table of [...tableSet]) {
    for (const neighbour of FK_GRAPH.get(table) ?? []) tableSet.add(neighbour);
  }
  const tables = TABLES.filter((spec) => tableSet.has(spec.name)).map((spec) => spec.name);

  const totalColumns = CATALOG.length;
  const keptColumns = keptEntries.length;

  const matches = scored.slice(0, 24).map(({ entry, score, reason }) => ({
    key: entry.key,
    score: Number(score.toFixed(3)),
    reason,
  }));

  return {
    report: {
      totalColumns,
      keptColumns,
      prunedPercent: Number((100 * (1 - keptColumns / Math.max(1, totalColumns))).toFixed(2)),
      tables,
      matches,
      elapsedMs: Math.max(0, Date.now() - startedAt),
    },
    entries: keptEntries,
    tables,
    ddl: emitDdl(tables, keptEntries),
  };
}
