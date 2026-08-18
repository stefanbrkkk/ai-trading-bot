/**
 * InvestGPT schema catalog — the retrieval corpus CSR-RAG prunes over.
 *
 * digest-investgpt §Part 1 forbids injecting the full DDL into the model
 * context, so the catalog exists as a first-class, searchable object: every
 * queryable surface carries the label, aliases and description the retriever
 * scores, plus the exact SQL expression the compiler emits. Because the base
 * entries are derived from `FEATURE_DEFINITIONS` rather than hand-copied, the
 * corpus the retriever searches and the view the SQL runs against can never
 * drift apart.
 *
 * §Part 2 records the real scale of the problem — more than 10,000 features per
 * equity — and the pruner is only meaningful against a corpus wide enough to
 * prune. The eight derived variants generated per base feature (`_z1d`, `_z5d`,
 * `_z20d`, `_pctile`, `_delta1d`, `_delta5d`, `_rank_sector`, `_rank_universe`)
 * are the standard cross-sectional and time-series transforms a feature store
 * exposes on top of each raw signal. They are deliberately `materialised: false`
 * — they are queryable through a documented window-function expression (the
 * research's mandated kdb+ `wj` equivalent), not through a stored column — so
 * the validator's column allowlist stays limited to columns that physically
 * exist while the retriever still has to discriminate across ~700 candidates.
 */

import { FEATURE_DEFINITIONS, type FeatureDefinition } from '@/lib/engine/features';
import type { FeatureCatalogEntry, FeatureGroup, FeatureUnit } from '@/lib/domain/types';

/** The wide read surface: one row per symbol at its latest `as_of`. */
export const SNAPSHOT_TABLE = 'v_equity_snapshot';
/** The symbol dimension. */
export const SYMBOLS_TABLE = 'symbols';
/** One row per symbol: the newest signal. */
export const SIGNAL_TABLE = 'v_signal_latest';
/**
 * Long-form feature history. Not part of the snapshot read surface, but the
 * derived variants' window expressions are defined against it, so the pruned
 * DDL names it whenever a derived entry survives pruning.
 */
export const FEATURE_HISTORY_TABLE = 'feature_values';

/**
 * `FeatureGroup` covers the model's feature blocks only. Dimension and signal
 * columns are neither, so the catalog widens the union rather than forcing a
 * dishonest group onto a ticker or a sector string.
 */
export type CatalogGroup = FeatureGroup | 'identity' | 'reference' | 'signal';

/** `FeatureUnit` has no text or epoch member; dimension columns need both. */
export type CatalogUnit = FeatureUnit | 'text' | 'timestamp';

export type SqlType = 'TEXT' | 'REAL' | 'INTEGER';

/** The eight derived transforms generated for every base feature. */
export type DerivedVariant =
  | 'z1d'
  | 'z5d'
  | 'z20d'
  | 'pctile'
  | 'delta1d'
  | 'delta5d'
  | 'rank_sector'
  | 'rank_universe';

/**
 * A catalog entry. Extends the shared `FeatureCatalogEntry` contract (only
 * `group` and `unit` are widened, see above) with the physical placement and
 * derivation metadata the pruner, compiler and validator each need.
 */
export interface CatalogEntry extends Omit<FeatureCatalogEntry, 'group' | 'unit'> {
  group: CatalogGroup;
  unit: CatalogUnit;
  /** Table or view the entry is queried from. */
  table: string;
  /** Other relations exposing the same logical column, for FK-graph seeding. */
  alsoOn: string[];
  /** SQLite storage class, used to emit column types in the pruned DDL. */
  sqlType: SqlType;
  /**
   * True when `sqlColumn` is a stored column of `table`. False when it is a
   * documented expression — those never enter the validator's column allowlist.
   */
  materialised: boolean;
  /** Why the expression computes what the label claims. Derived entries only. */
  derivation: string | null;
  /** Base feature key for derived entries. */
  baseKey: string | null;
  variant: DerivedVariant | null;
  /**
   * True when the expression needs more than one row per symbol, i.e. it cannot
   * be evaluated against the snapshot view alone.
   */
  requiresHistory: boolean;
  /**
   * Phrases that must appear in a question before a derived entry may be
   * selected. Without this gate the ~640 derived entries would out-recall the
   * base features on every question that merely names a feature.
   */
  cues: string[];
  /** Concatenated retrieval text — label, aliases, description, group, key. */
  searchText: string;
}

export interface TableColumn {
  name: string;
  sqlType: SqlType;
  nullable: boolean;
  description: string;
}

export interface ForeignKey {
  column: string;
  referencesTable: string;
  referencesColumn: string;
}

export interface TableSpec {
  name: string;
  kind: 'table' | 'view';
  description: string;
  primaryKey: string[];
  columns: TableColumn[];
  foreignKeys: ForeignKey[];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Hand-written dimension and signal entries
// ─────────────────────────────────────────────────────────────────────────────

interface DimensionSeed {
  key: string;
  column: string;
  label: string;
  group: CatalogGroup;
  unit: CatalogUnit;
  sqlType: SqlType;
  nullable: boolean;
  table: string;
  alsoOn: string[];
  description: string;
  formula: string;
  aliases: string[];
}

/**
 * `v_equity_snapshot` denormalises the symbol dimension and the latest signal,
 * so each logical dimension gets exactly one catalog entry pointing at the
 * snapshot column. `alsoOn` records the base relation the column originates
 * from, which is what the FK-graph traversal seeds on when a question names a
 * dimension ("sector" implies `symbols`, "conviction" implies
 * `v_signal_latest`).
 */
const DIMENSION_SEEDS: DimensionSeed[] = [
  {
    key: 'symbol',
    column: 'symbol',
    label: 'Ticker symbol',
    group: 'identity',
    unit: 'text',
    sqlType: 'TEXT',
    nullable: false,
    table: SNAPSHOT_TABLE,
    alsoOn: [SYMBOLS_TABLE, SIGNAL_TABLE],
    description: 'Exchange ticker, the primary key of every relation.',
    formula: 'symbols.symbol',
    aliases: ['ticker', 'symbol', 'stock', 'equity', 'name of the stock', 'security'],
  },
  {
    key: 'name',
    column: 'name',
    label: 'Company name',
    group: 'identity',
    unit: 'text',
    sqlType: 'TEXT',
    nullable: false,
    table: SNAPSHOT_TABLE,
    alsoOn: [SYMBOLS_TABLE],
    description: 'Registered company name, matched with LIKE for free-text lookups.',
    formula: 'symbols.name',
    aliases: ['company', 'company name', 'issuer', 'called'],
  },
  {
    key: 'sector',
    column: 'sector',
    label: 'GICS sector',
    group: 'reference',
    unit: 'text',
    sqlType: 'TEXT',
    nullable: false,
    table: SNAPSHOT_TABLE,
    alsoOn: [SYMBOLS_TABLE],
    description: 'One of eleven sector classifications; the primary cohort filter.',
    formula: 'symbols.sector',
    aliases: ['sector', 'gics sector', 'industry group', 'tech', 'technology', 'healthcare', 'financials', 'energy'],
  },
  {
    key: 'industry',
    column: 'industry',
    label: 'Industry',
    group: 'reference',
    unit: 'text',
    sqlType: 'TEXT',
    nullable: false,
    table: SNAPSHOT_TABLE,
    alsoOn: [SYMBOLS_TABLE],
    description: 'Narrow industry classification inside the sector, e.g. semiconductors.',
    formula: 'symbols.industry',
    aliases: ['industry', 'sub industry', 'semiconductors', 'software', 'biotech', 'banks'],
  },
  {
    key: 'exchange',
    column: 'exchange',
    label: 'Listing exchange',
    group: 'reference',
    unit: 'text',
    sqlType: 'TEXT',
    nullable: false,
    table: SNAPSHOT_TABLE,
    alsoOn: [SYMBOLS_TABLE],
    description: 'Primary listing venue: NASDAQ, NYSE or ARCA.',
    formula: 'symbols.exchange',
    aliases: ['exchange', 'listed on', 'venue', 'nasdaq', 'nyse'],
  },
  {
    key: 'market_cap',
    column: 'market_cap',
    label: 'Market capitalisation',
    group: 'reference',
    unit: 'currency',
    sqlType: 'REAL',
    nullable: false,
    table: SNAPSHOT_TABLE,
    alsoOn: [SYMBOLS_TABLE],
    description: 'Market capitalisation in US dollars; the cap-cohort filter column.',
    formula: 'shares outstanding × price, in USD',
    aliases: ['market cap', 'capitalisation', 'capitalization', 'cap', 'size', 'mcap', 'large cap', 'mid cap', 'small cap'],
  },
  {
    key: 'adv30',
    column: 'adv30',
    label: '30-day average daily volume',
    group: 'reference',
    unit: 'shares',
    sqlType: 'REAL',
    nullable: false,
    table: SNAPSHOT_TABLE,
    alsoOn: [SYMBOLS_TABLE],
    description: 'Thirty-session average daily share volume — the liquidity limiter input.',
    formula: 'mean(volume) over the last 30 sessions',
    aliases: ['adv', 'average daily volume', 'liquidity', 'adv30', 'typical volume'],
  },
  {
    key: 'shares_outstanding',
    column: 'shares_outstanding',
    label: 'Shares outstanding',
    group: 'reference',
    unit: 'shares',
    sqlType: 'REAL',
    nullable: false,
    table: SNAPSHOT_TABLE,
    alsoOn: [SYMBOLS_TABLE],
    description: 'Share count used for capitalisation and float arithmetic.',
    formula: 'symbols.shares_outstanding',
    aliases: ['shares outstanding', 'share count', 'float'],
  },
  {
    key: 'reference_beta',
    column: 'reference_beta',
    label: 'Reference beta',
    group: 'reference',
    unit: 'ratio',
    sqlType: 'REAL',
    nullable: false,
    table: SNAPSHOT_TABLE,
    alsoOn: [SYMBOLS_TABLE],
    description: 'Published metadata beta to the benchmark, distinct from the rolling estimate.',
    formula: 'symbols.reference_beta',
    aliases: ['reference beta', 'published beta', 'metadata beta'],
  },
  {
    key: 'dividend_yield',
    column: 'dividend_yield',
    label: 'Dividend yield',
    group: 'reference',
    unit: 'ratio',
    sqlType: 'REAL',
    nullable: false,
    table: SNAPSHOT_TABLE,
    alsoOn: [SYMBOLS_TABLE],
    description: 'Annual dividend yield as a decimal.',
    formula: 'annual dividend / price',
    aliases: ['dividend', 'dividend yield', 'yield', 'income'],
  },
  {
    key: 'optionable',
    column: 'optionable',
    label: 'Options listed',
    group: 'reference',
    unit: 'count',
    sqlType: 'INTEGER',
    nullable: false,
    table: SNAPSHOT_TABLE,
    alsoOn: [SYMBOLS_TABLE],
    description: 'Flag (0/1) for a listed option chain; gates the SABR skew block.',
    formula: '1 when an option chain is listed',
    aliases: ['optionable', 'has options', 'options listed'],
  },
  {
    key: 'is_benchmark',
    column: 'is_benchmark',
    label: 'Benchmark flag',
    group: 'reference',
    unit: 'count',
    sqlType: 'INTEGER',
    nullable: false,
    table: SNAPSHOT_TABLE,
    alsoOn: [SYMBOLS_TABLE],
    description: 'Flag (0/1) marking the relative-strength benchmark itself.',
    formula: '1 for the benchmark symbol',
    aliases: ['benchmark', 'index proxy', 'spy'],
  },
  {
    key: 'as_of',
    column: 'as_of',
    label: 'Snapshot timestamp',
    group: 'identity',
    unit: 'timestamp',
    sqlType: 'INTEGER',
    nullable: true,
    table: SNAPSHOT_TABLE,
    alsoOn: [FEATURE_HISTORY_TABLE],
    description: 'Epoch milliseconds of the feature vector the row was computed from.',
    formula: 'MAX(feature_values.as_of) per symbol',
    aliases: ['as of', 'timestamp', 'computed at', 'snapshot time'],
  },
  {
    key: 'price',
    column: 'price',
    label: 'Last price',
    group: 'identity',
    unit: 'currency',
    sqlType: 'REAL',
    nullable: true,
    table: SNAPSHOT_TABLE,
    alsoOn: [],
    description: 'Last traded price in US dollars — the column a bare dollar filter means.',
    formula: 'quotes_snapshot.last at the newest timestamp',
    aliases: ['price', 'share price', 'last price', 'trading at', 'cost', 'quote', 'dollars'],
  },
  {
    key: 'previous_close',
    column: 'previous_close',
    label: 'Previous close',
    group: 'identity',
    unit: 'currency',
    sqlType: 'REAL',
    nullable: true,
    table: SNAPSHOT_TABLE,
    alsoOn: [],
    description: 'Prior session close, the denominator of the change calculation.',
    formula: 'quotes_snapshot.previous_close',
    aliases: ['previous close', 'prior close', 'yesterday close'],
  },
  {
    key: 'change_percent',
    column: 'change_percent',
    label: 'Change today (%)',
    group: 'identity',
    unit: 'percent',
    sqlType: 'REAL',
    nullable: true,
    table: SNAPSHOT_TABLE,
    alsoOn: [],
    description: 'Session change against the previous close, in percent.',
    formula: '100 × (last − previousClose) / previousClose',
    aliases: ['change', 'percent change', 'up today', 'down today', 'gainers', 'losers', 'movers'],
  },
  {
    key: 'session_volume',
    column: 'session_volume',
    label: 'Session volume',
    group: 'volume',
    unit: 'shares',
    sqlType: 'REAL',
    nullable: true,
    table: SNAPSHOT_TABLE,
    alsoOn: [],
    description: 'Cumulative shares traded in the current session.',
    formula: 'quotes_snapshot.volume',
    aliases: ['volume', 'shares traded', 'session volume', 'today volume'],
  },
  {
    key: 'bid',
    column: 'bid',
    label: 'Best bid',
    group: 'microstructure',
    unit: 'currency',
    sqlType: 'REAL',
    nullable: true,
    table: SNAPSHOT_TABLE,
    alsoOn: [],
    description: 'Best bid price of the latest quote.',
    formula: 'quotes_snapshot.bid',
    aliases: ['bid', 'best bid'],
  },
  {
    key: 'ask',
    column: 'ask',
    label: 'Best ask',
    group: 'microstructure',
    unit: 'currency',
    sqlType: 'REAL',
    nullable: true,
    table: SNAPSHOT_TABLE,
    alsoOn: [],
    description: 'Best offer price of the latest quote.',
    formula: 'quotes_snapshot.ask',
    aliases: ['ask', 'offer', 'best ask'],
  },
  {
    key: 'signal_id',
    column: 'signal_id',
    label: 'Signal id',
    group: 'signal',
    unit: 'text',
    sqlType: 'TEXT',
    nullable: true,
    table: SNAPSHOT_TABLE,
    alsoOn: [SIGNAL_TABLE],
    description: 'Identifier of the latest signal, for drill-down links.',
    formula: 'v_signal_latest.id',
    aliases: ['signal id', 'signal reference'],
  },
  {
    key: 'direction',
    column: 'direction',
    label: 'Signal direction',
    group: 'signal',
    unit: 'text',
    sqlType: 'TEXT',
    nullable: true,
    table: SNAPSHOT_TABLE,
    alsoOn: [SIGNAL_TABLE],
    description: "Latest signal side: 'long', 'short' or 'flat'.",
    formula: 'v_signal_latest.direction',
    aliases: ['direction', 'long', 'short', 'bullish signal', 'bearish signal', 'side'],
  },
  {
    key: 'conviction',
    column: 'conviction',
    label: 'Conviction',
    group: 'signal',
    unit: 'index_0_100',
    sqlType: 'REAL',
    nullable: true,
    table: SNAPSHOT_TABLE,
    alsoOn: [SIGNAL_TABLE],
    description: 'Published 0–100 conviction score of the latest signal.',
    formula: 'v_signal_latest.conviction',
    aliases: ['conviction', 'score', 'confidence', 'strongest signal', 'highest conviction', 'rating'],
  },
  {
    key: 'probability',
    column: 'probability',
    label: 'Calibrated probability',
    group: 'signal',
    unit: 'probability',
    sqlType: 'REAL',
    nullable: true,
    table: SNAPSHOT_TABLE,
    alsoOn: [SIGNAL_TABLE],
    description: 'Calibrated probability the position beats the benchmark over the horizon.',
    formula: 'v_signal_latest.probability',
    aliases: ['probability', 'win rate', 'odds', 'calibrated probability', 'hit rate'],
  },
  {
    key: 'expected_return',
    column: 'expected_return',
    label: 'Expected return',
    group: 'signal',
    unit: 'ratio',
    sqlType: 'REAL',
    nullable: true,
    table: SNAPSHOT_TABLE,
    alsoOn: [SIGNAL_TABLE],
    description: 'Expected move over the signal horizon, as a decimal return.',
    formula: 'v_signal_latest.expected_return',
    aliases: ['expected return', 'expected move', 'upside', 'target return'],
  },
  {
    key: 'horizon_days',
    column: 'horizon_days',
    label: 'Horizon (days)',
    group: 'signal',
    unit: 'bars',
    sqlType: 'REAL',
    nullable: true,
    table: SNAPSHOT_TABLE,
    alsoOn: [SIGNAL_TABLE],
    description: 'Trading-day horizon the signal is scored over.',
    formula: 'v_signal_latest.horizon_days',
    aliases: ['horizon', 'holding period', 'days'],
  },
  {
    key: 'regime',
    column: 'regime',
    label: 'Regime label',
    group: 'regime',
    unit: 'text',
    sqlType: 'TEXT',
    nullable: true,
    table: SNAPSHOT_TABLE,
    alsoOn: [SIGNAL_TABLE],
    description: 'Classified market regime at signal time, e.g. trending_bull.',
    formula: 'v_signal_latest.regime',
    aliases: ['regime', 'market regime', 'trending', 'mean reverting', 'high volatility regime'],
  },
  {
    key: 'model_version',
    column: 'model_version',
    label: 'Model version',
    group: 'signal',
    unit: 'text',
    sqlType: 'TEXT',
    nullable: true,
    table: SNAPSHOT_TABLE,
    alsoOn: [SIGNAL_TABLE],
    description: 'Version string of the model that produced the signal.',
    formula: 'v_signal_latest.model_version',
    aliases: ['model version', 'model build'],
  },
  {
    key: 'generated_at',
    column: 'generated_at',
    label: 'Signal timestamp',
    group: 'signal',
    unit: 'timestamp',
    sqlType: 'INTEGER',
    nullable: false,
    table: SIGNAL_TABLE,
    alsoOn: [],
    description: 'Epoch milliseconds of the state-clock tick that produced the signal.',
    formula: 'v_signal_latest.generated_at',
    aliases: ['generated at', 'signal time', 'when was the signal', 'freshness'],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
//  Derived variant specifications
// ─────────────────────────────────────────────────────────────────────────────

interface VariantSpec {
  variant: DerivedVariant;
  suffix: string;
  labelSuffix: string;
  unit: CatalogUnit;
  /** Cue phrases gating selection; `${x}` is substituted with nothing. */
  cues: string[];
  aliasSuffixes: string[];
  requiresHistory: boolean;
  /** Builds the queryable expression for a base column. */
  expression: (column: string) => string;
  /** Explains the transform and where it is evaluated. */
  derivation: (label: string, column: string) => string;
  description: (label: string) => string;
}

/**
 * Window frames referenced by the derived expressions. Named here once so the
 * pruned DDL can publish them alongside the expressions, satisfying prompt
 * constraint C2 (lead–lag logic expressed with window functions, never
 * correlated subqueries).
 */
export const DERIVED_WINDOWS = {
  w: 'PARTITION BY fv.symbol ORDER BY fv.as_of',
  w252: 'PARTITION BY fv.symbol ORDER BY fv.as_of ROWS BETWEEN 251 PRECEDING AND CURRENT ROW',
} as const;

/** Standard deviation of a window expression; SQLite has no STDDEV aggregate. */
function windowSigma(expr: string, frame: string): string {
  return `SQRT(AVG(${expr} * ${expr}) OVER (${frame}) - AVG(${expr}) OVER (${frame}) * AVG(${expr}) OVER (${frame}))`;
}

function changeExpr(lag: number): string {
  return `(fv.value - LAG(fv.value, ${lag}) OVER (${DERIVED_WINDOWS.w}))`;
}

function zVariant(variant: DerivedVariant, lag: number, horizon: string): VariantSpec {
  const change = changeExpr(lag);
  return {
    variant,
    suffix: `_${variant}`,
    labelSuffix: `${horizon} z-score`,
    unit: 'zscore',
    cues: ['z score', 'z-score', 'zscore', 'standardised', 'standardized', 'sigma', 'standard deviations'],
    aliasSuffixes: ['z score', 'z-score', `${horizon} z score`, `standardised ${horizon} change`],
    requiresHistory: true,
    expression: () =>
      `(${change} - AVG(${change}) OVER (${DERIVED_WINDOWS.w252})) / NULLIF(${windowSigma(change, DERIVED_WINDOWS.w252)}, 0)`,
    derivation: (label, column) =>
      `The ${horizon} change in ${label}, standardised by the trailing 252-session mean and standard deviation of that same change. Evaluated over ${FEATURE_HISTORY_TABLE} fv filtered to feature_key = '${column}', with LAG/AVG window frames w and w252; not a stored column of ${SNAPSHOT_TABLE}.`,
    description: (label) =>
      `${label} expressed as a ${horizon} change standardised against its own trailing 252-session distribution.`,
  };
}

function deltaVariant(variant: DerivedVariant, lag: number, horizon: string): VariantSpec {
  return {
    variant,
    suffix: `_${variant}`,
    labelSuffix: `${horizon} change`,
    unit: 'ratio',
    cues: ['change', 'changed', 'delta', 'move', 'moved', 'rose', 'fell', 'increase', 'decrease', 'difference'],
    aliasSuffixes: [`${horizon} change`, `${horizon} delta`, `change in`, `${horizon} move`],
    requiresHistory: true,
    expression: () => changeExpr(lag),
    derivation: (label, column) =>
      `Raw ${horizon} first difference of ${label}: value minus its value ${lag} session(s) earlier, via LAG over window w on ${FEATURE_HISTORY_TABLE} fv filtered to feature_key = '${column}'. Carries the feature's native unit; not a stored column of ${SNAPSHOT_TABLE}.`,
    description: (label) => `Change in ${label} over the last ${horizon.replace('-', ' ')}, in the feature's native unit.`,
  };
}

const VARIANT_SPECS: VariantSpec[] = [
  zVariant('z1d', 1, '1-day'),
  zVariant('z5d', 5, '5-day'),
  zVariant('z20d', 20, '20-day'),
  {
    variant: 'pctile',
    suffix: '_pctile',
    labelSuffix: 'percentile (own history)',
    unit: 'probability',
    cues: ['percentile', 'percentile rank', 'historically', 'own history', 'relative to its history', 'rank in its history'],
    aliasSuffixes: ['percentile', 'percentile rank', 'historical percentile', 'own history percentile'],
    requiresHistory: true,
    expression: () =>
      `(RANK() OVER (${DERIVED_WINDOWS.w252} , fv.value) - 1) * 1.0 / NULLIF(COUNT(*) OVER (${DERIVED_WINDOWS.w252}) - 1, 0)`,
    derivation: (label, column) =>
      `Where the current ${label} sits inside its own trailing 252-session distribution, on (0, 1). Computed as a RANK over the w252 frame divided by the frame count, on ${FEATURE_HISTORY_TABLE} fv filtered to feature_key = '${column}'; not a stored column of ${SNAPSHOT_TABLE}.`,
    description: (label) => `Percentile of the current ${label} within its own trailing 252-session history.`,
  },
  deltaVariant('delta1d', 1, '1-day'),
  deltaVariant('delta5d', 5, '5-day'),
  {
    variant: 'rank_sector',
    suffix: '_rank_sector',
    labelSuffix: 'rank within sector',
    unit: 'count',
    cues: ['rank', 'ranked', 'ranking', 'within its sector', 'in its sector', 'versus peers', 'against peers', 'peer rank', 'sector rank'],
    aliasSuffixes: ['rank in sector', 'sector rank', 'peer rank', 'rank versus peers'],
    requiresHistory: false,
    expression: (column) => `RANK() OVER (PARTITION BY e.sector ORDER BY e.${column} DESC)`,
    derivation: (label, column) =>
      `Cross-sectional descending rank of ${label} inside the symbol's own sector at the snapshot instant: RANK() OVER (PARTITION BY e.sector ORDER BY e.${column} DESC). Evaluable directly against ${SNAPSHOT_TABLE}, so ordering by this rank is equivalent to ordering by ${column} itself.`,
    description: (label) => `Descending rank of ${label} among the symbol's sector peers at the snapshot instant.`,
  },
  {
    variant: 'rank_universe',
    suffix: '_rank_universe',
    labelSuffix: 'rank within universe',
    unit: 'count',
    cues: ['rank', 'ranked', 'ranking', 'in the universe', 'across the market', 'market wide rank', 'universe rank', 'overall rank'],
    aliasSuffixes: ['rank in universe', 'universe rank', 'overall rank', 'market wide rank'],
    requiresHistory: false,
    expression: (column) => `RANK() OVER (ORDER BY e.${column} DESC)`,
    derivation: (label, column) =>
      `Cross-sectional descending rank of ${label} across the whole tradable universe at the snapshot instant: RANK() OVER (ORDER BY e.${column} DESC). Evaluable directly against ${SNAPSHOT_TABLE}, so ordering by this rank is equivalent to ordering by ${column} itself.`,
    description: (label) => `Descending rank of ${label} across the entire universe at the snapshot instant.`,
  },
];

/** The variant suffixes, exported so callers can explain a derived key. */
export const DERIVED_VARIANTS: readonly DerivedVariant[] = VARIANT_SPECS.map((spec) => spec.variant);

// ─────────────────────────────────────────────────────────────────────────────
//  Assembly
// ─────────────────────────────────────────────────────────────────────────────

function searchTextOf(parts: { label: string; aliases: string[]; description: string; group: string; key: string }): string {
  return `${parts.label} ${parts.aliases.join(' ')} ${parts.description} ${parts.group} ${parts.key.replace(/_/g, ' ')}`;
}

function dimensionEntry(seed: DimensionSeed): CatalogEntry {
  return {
    key: seed.key,
    label: seed.label,
    group: seed.group,
    unit: seed.unit,
    description: seed.description,
    formula: seed.formula,
    sqlColumn: seed.column,
    aliases: seed.aliases,
    inModel: false,
    table: seed.table,
    alsoOn: seed.alsoOn,
    sqlType: seed.sqlType,
    materialised: true,
    derivation: null,
    baseKey: null,
    variant: null,
    requiresHistory: false,
    cues: [],
    searchText: searchTextOf({
      label: seed.label,
      aliases: seed.aliases,
      description: seed.description,
      group: seed.group,
      key: seed.key,
    }),
  };
}

function featureEntry(definition: FeatureDefinition): CatalogEntry {
  return {
    key: definition.key,
    label: definition.label,
    group: definition.group,
    unit: definition.unit,
    description: definition.description,
    formula: definition.formula,
    sqlColumn: definition.sqlColumn,
    aliases: [...definition.aliases, definition.shortLabel.toLowerCase()],
    inModel: definition.inModel,
    table: SNAPSHOT_TABLE,
    alsoOn: [FEATURE_HISTORY_TABLE],
    sqlType: 'REAL',
    materialised: true,
    derivation: null,
    baseKey: null,
    variant: null,
    requiresHistory: false,
    cues: [],
    searchText: searchTextOf({
      label: definition.label,
      aliases: [...definition.aliases, definition.shortLabel.toLowerCase()],
      description: definition.description,
      group: definition.group,
      key: definition.key,
    }),
  };
}

function derivedEntry(definition: FeatureDefinition, spec: VariantSpec): CatalogEntry {
  const key = `${definition.key}${spec.suffix}`;
  const label = `${definition.label} — ${spec.labelSuffix}`;
  // Aliases are the cross-product of the base feature's own synonyms with the
  // variant's suffixes, which is how an analyst actually phrases a derived
  // feature ("rsi percentile", "relative volume 5-day change").
  const baseAliases = [definition.label.toLowerCase(), ...definition.aliases];
  const aliases: string[] = [];
  for (const base of baseAliases.slice(0, 4)) {
    for (const suffix of spec.aliasSuffixes) {
      aliases.push(`${base} ${suffix}`);
    }
  }
  const description = spec.description(definition.label);
  return {
    key,
    label,
    group: definition.group,
    unit: spec.unit,
    description,
    formula: `${spec.labelSuffix} of (${definition.formula})`,
    sqlColumn: spec.expression(definition.sqlColumn),
    aliases,
    inModel: false,
    table: spec.requiresHistory ? FEATURE_HISTORY_TABLE : SNAPSHOT_TABLE,
    alsoOn: spec.requiresHistory ? [SNAPSHOT_TABLE] : [FEATURE_HISTORY_TABLE],
    sqlType: 'REAL',
    // Documented expression, not a stored column: it must never enter the
    // validator's column allowlist (digest-investgpt §Part 3 Layer 3).
    materialised: false,
    derivation: spec.derivation(definition.label, definition.sqlColumn),
    baseKey: definition.key,
    variant: spec.variant,
    requiresHistory: spec.requiresHistory,
    cues: spec.cues,
    searchText: searchTextOf({
      label,
      aliases,
      description,
      group: definition.group,
      key,
    }),
  };
}

function buildCatalog(): CatalogEntry[] {
  const entries: CatalogEntry[] = DIMENSION_SEEDS.map(dimensionEntry);
  for (const definition of FEATURE_DEFINITIONS) {
    entries.push(featureEntry(definition));
  }
  for (const definition of FEATURE_DEFINITIONS) {
    for (const spec of VARIANT_SPECS) {
      entries.push(derivedEntry(definition, spec));
    }
  }
  return entries;
}

/** Every queryable surface InvestGPT knows about, base and derived. */
export const CATALOG: readonly CatalogEntry[] = buildCatalog();

const BY_KEY: Map<string, CatalogEntry> = new Map(CATALOG.map((entry) => [entry.key, entry]));

export function catalogSize(): number {
  return CATALOG.length;
}

export function lookup(key: string): CatalogEntry | undefined {
  return BY_KEY.get(key);
}

/** Entries that are stored columns — the only ones the validator will allow. */
export const MATERIALISED_ENTRIES: readonly CatalogEntry[] = CATALOG.filter((entry) => entry.materialised);

/** Entries of one relation. */
export function entriesForTable(table: string): CatalogEntry[] {
  return CATALOG.filter((entry) => entry.table === table || entry.alsoOn.includes(table));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Relations
// ─────────────────────────────────────────────────────────────────────────────

function snapshotColumns(): TableColumn[] {
  const columns: TableColumn[] = [];
  for (const seed of DIMENSION_SEEDS) {
    if (seed.table !== SNAPSHOT_TABLE) continue;
    columns.push({
      name: seed.column,
      sqlType: seed.sqlType,
      nullable: seed.nullable,
      description: seed.description,
    });
  }
  for (const definition of FEATURE_DEFINITIONS) {
    columns.push({
      name: definition.sqlColumn,
      sqlType: 'REAL',
      nullable: true,
      description: definition.description,
    });
  }
  return columns;
}

/**
 * The relations the pruner traverses. `v_equity_snapshot` already denormalises
 * both `symbols` and `v_signal_latest`, so the deterministic compiler never has
 * to emit a join; the edges are still declared because the pruned DDL must
 * publish PK/FK relationships (digest-investgpt §Part 1) and because the
 * FK-graph traversal is what guarantees recall 1.00 on multi-hop questions.
 */
export const TABLES: readonly TableSpec[] = [
  {
    name: SNAPSHOT_TABLE,
    kind: 'view',
    description:
      'One row per symbol at its newest feature timestamp: the symbol dimension, the latest quote, the latest signal and every feature column, denormalised for single-scan screening.',
    primaryKey: ['symbol'],
    columns: snapshotColumns(),
    foreignKeys: [{ column: 'symbol', referencesTable: SYMBOLS_TABLE, referencesColumn: 'symbol' }],
  },
  {
    name: SYMBOLS_TABLE,
    kind: 'table',
    description: 'The symbol dimension: identity, classification and liquidity metadata.',
    columns: [
      { name: 'symbol', sqlType: 'TEXT', nullable: false, description: 'Exchange ticker; primary key.' },
      { name: 'name', sqlType: 'TEXT', nullable: false, description: 'Registered company name.' },
      { name: 'sector', sqlType: 'TEXT', nullable: false, description: 'One of eleven sector classifications.' },
      { name: 'industry', sqlType: 'TEXT', nullable: false, description: 'Narrow industry classification.' },
      {
        name: 'market_cap',
        sqlType: 'REAL',
        nullable: false,
        // The base table stores cents as an integer; the snapshot view exposes
        // dollars. Screening always goes through the view, so the catalog
        // documents the dollar-denominated surface.
        description: 'Market capitalisation in US dollars, as exposed to screening.',
      },
      { name: 'adv30', sqlType: 'REAL', nullable: false, description: '30-day average daily share volume.' },
      { name: 'exchange', sqlType: 'TEXT', nullable: false, description: 'Primary listing venue.' },
    ],
    primaryKey: ['symbol'],
    foreignKeys: [],
  },
  {
    name: SIGNAL_TABLE,
    kind: 'view',
    description: 'One row per symbol: the newest published signal, chosen deterministically.',
    columns: [
      { name: 'symbol', sqlType: 'TEXT', nullable: false, description: 'Exchange ticker; primary key.' },
      { name: 'conviction', sqlType: 'REAL', nullable: false, description: 'Published 0–100 conviction score.' },
      { name: 'probability', sqlType: 'REAL', nullable: false, description: 'Calibrated probability of beating the benchmark.' },
      { name: 'direction', sqlType: 'TEXT', nullable: false, description: "Signal side: 'long', 'short' or 'flat'." },
      { name: 'regime', sqlType: 'TEXT', nullable: false, description: 'Classified market regime at signal time.' },
      { name: 'generated_at', sqlType: 'INTEGER', nullable: false, description: 'Epoch ms of the producing state-clock tick.' },
    ],
    primaryKey: ['symbol'],
    foreignKeys: [{ column: 'symbol', referencesTable: SYMBOLS_TABLE, referencesColumn: 'symbol' }],
  },
  {
    name: FEATURE_HISTORY_TABLE,
    kind: 'table',
    description:
      'Long-form feature history, one row per (symbol, as_of, feature_key). The source relation for every derived z-score, delta and percentile expression.',
    columns: [
      { name: 'symbol', sqlType: 'TEXT', nullable: false, description: 'Exchange ticker.' },
      { name: 'as_of', sqlType: 'INTEGER', nullable: false, description: 'Epoch ms of the feature vector.' },
      { name: 'feature_key', sqlType: 'TEXT', nullable: false, description: 'Feature registry key, e.g. rsi_14.' },
      { name: 'value', sqlType: 'REAL', nullable: false, description: 'Raw feature value in its native unit.' },
      { name: 'normalised', sqlType: 'REAL', nullable: false, description: 'ECDF-normalised value on (0, 1).' },
      { name: 'state', sqlType: 'TEXT', nullable: false, description: 'Discretised state label, e.g. STATE_OVERSOLD.' },
    ],
    primaryKey: ['symbol', 'as_of', 'feature_key'],
    foreignKeys: [{ column: 'symbol', referencesTable: SYMBOLS_TABLE, referencesColumn: 'symbol' }],
  },
];

const TABLE_BY_NAME: Map<string, TableSpec> = new Map(TABLES.map((table) => [table.name, table]));

export function tableSpec(name: string): TableSpec | undefined {
  return TABLE_BY_NAME.get(name);
}

/** Stored columns per relation — the seed of the validator's Layer-3 allowlist. */
export const TABLE_COLUMNS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  TABLES.map((table) => [table.name, new Set(table.columns.map((column) => column.name))]),
);

/** Ordered column names of the wide screening surface. */
export const SNAPSHOT_COLUMNS: readonly string[] = (TABLE_BY_NAME.get(SNAPSHOT_TABLE)?.columns ?? []).map(
  (column) => column.name,
);

/**
 * Undirected foreign-key adjacency, built once from `TABLES`. The pruner's
 * deterministic graph retrieval (algo-investgpt §CSR-RAG step B) walks this.
 */
export const FK_GRAPH: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const graph = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    const existing = graph.get(a);
    if (existing) existing.add(b);
    else graph.set(a, new Set([b]));
  };
  for (const table of TABLES) {
    if (!graph.has(table.name)) graph.set(table.name, new Set());
    for (const fk of table.foreignKeys) {
      link(table.name, fk.referencesTable);
      link(fk.referencesTable, table.name);
    }
  }
  return graph;
})();
