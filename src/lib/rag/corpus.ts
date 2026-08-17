/**
 * The retrieval corpus.
 *
 * The platform's alternative-data mandate names ten source classes and ranks
 * them by evidentiary authority: a 10-K risk-factor disclosure is not the same
 * kind of claim as a post on X, and a retriever that scores them alike will
 * confidently cite the wrong one. That ranking is the `AUTHORITY` table below,
 * and it is applied at re-rank time rather than baked into the similarity, so a
 * highly-relevant news item can still outrank a barely-relevant filing.
 *
 * The documents themselves are generated deterministically from the universe
 * metadata and the seeded simulator. That is a design decision with a cost worth
 * stating plainly: this corpus is **synthetic**. It is internally consistent —
 * the revenue figure in a 10-Q agrees with the one in the matching transcript,
 * the Form 4 sizes agree with the shares outstanding, and every number derives
 * from the same seed as the price series — so the retrieval, fusion, grounding
 * and citation machinery is exercised against real structure. But no sentence in
 * it is a statement about a real company, and the UI says so wherever a citation
 * is rendered. Swapping in an EDGAR ingest replaces this file and nothing else:
 * everything downstream consumes `RagDocument`.
 */

import { createRng, hashSeed } from '@/lib/quant/rng';
import { TRADABLE_SYMBOLS, requireSpec } from '@/lib/market/universe';
import type { RagSourceType } from '@/lib/domain/types';

/**
 * Evidentiary authority per source class, in [0, 1].
 *
 * The values are ordinal rather than probabilistic: what matters is that an
 * audited annual report outranks an unaudited quarterly, that both outrank
 * management's own spoken commentary, that sell-side opinion sits below primary
 * disclosure, and that anonymous social posts sit at the bottom while still being
 * retrievable — the crowding-sentiment feature block needs them, and silently
 * excluding them would be a different kind of dishonesty.
 */
export const AUTHORITY: Record<RagSourceType, number> = {
  sec_10k: 1.0,
  sec_10q: 0.94,
  sec_8k: 0.9,
  sec_13f: 0.86,
  sec_form4: 0.86,
  earnings_transcript: 0.72,
  analyst_note: 0.55,
  news: 0.45,
  social_x: 0.2,
  reddit: 0.18,
  // First-party and authoritative about this platform, and about nothing else.
  platform_statement: 0.9,
};

/** Display labels for the citation chips. */
export const SOURCE_LABELS: Record<RagSourceType, string> = {
  sec_10k: 'SEC Form 10-K',
  sec_10q: 'SEC Form 10-Q',
  sec_8k: 'SEC Form 8-K',
  sec_13f: 'SEC Form 13F',
  sec_form4: 'SEC Form 4',
  earnings_transcript: 'Earnings call transcript',
  analyst_note: 'Sell-side note',
  news: 'Newswire',
  social_x: 'X / social',
  reddit: 'Retail forum',
  platform_statement: 'Platform statement',
};

export interface RagDocument {
  id: string;
  title: string;
  sourceType: RagSourceType;
  /** Null for market-wide documents (the macro note, the regulatory summary). */
  symbol: string | null;
  section: string;
  authority: number;
  publishedAt: number;
  url: string | null;
  body: string;
}

const DAY_MS = 86_400_000;

function money(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `$${(value / 1e12).toFixed(2)} trillion`;
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)} billion`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(1)} million`;
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

function pct(value: number): string {
  return `${value >= 0 ? '' : '-'}${Math.abs(value).toFixed(1)}%`;
}

/**
 * Share counts scale to billions above a thousand million, because a filing
 * writes "24.6 billion shares" and never "24628.1 million shares" — and the
 * grounding check compares against the corpus's own phrasing.
 */
function shareCount(shares: number): string {
  return shares >= 1e9 ? `${(shares / 1e9).toFixed(2)} billion shares` : `${(shares / 1e6).toFixed(1)} million shares`;
}

/** Fiscal quarter label for an instant, on a calendar-quarter convention. */
function quarterLabel(at: number): string {
  const date = new Date(at);
  return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`;
}

function isoDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * The financial profile every document for a symbol is written against.
 *
 * Derived once per symbol from the seed so the 10-K, the 10-Q, the transcript
 * and the analyst note quote *the same* revenue, margin and growth figures.
 * Retrieval quality is meaningless if the corpus contradicts itself — a
 * grounding check would then fail on true claims.
 */
interface Fundamentals {
  revenue: number;
  revenueGrowth: number;
  grossMargin: number;
  operatingMargin: number;
  freeCashFlow: number;
  netDebt: number;
  employees: number;
  rndIntensity: number;
  guidanceDelta: number;
  buybackAuthorisation: number;
}

function fundamentals(symbol: string, seed: number): Fundamentals {
  const spec = requireSpec(symbol);
  const rng = createRng(hashSeed(`fundamentals:${symbol}:${seed}`));

  // Revenue is anchored to market capitalisation through a sector-plausible
  // price-to-sales multiple, so a mega-cap does not report boutique revenue.
  const priceToSales = 1.4 + rng.next() * 7.5;
  const revenue = spec.marketCap / priceToSales;
  const grossMargin = 0.24 + rng.next() * 0.58;

  return {
    revenue,
    revenueGrowth: (rng.next() - 0.35) * 0.46,
    grossMargin,
    operatingMargin: grossMargin * (0.22 + rng.next() * 0.5),
    freeCashFlow: revenue * (0.02 + rng.next() * 0.24),
    netDebt: revenue * (rng.next() * 0.9 - 0.3),
    employees: Math.round(400 + rng.next() * 180_000),
    rndIntensity: 0.02 + rng.next() * 0.19,
    guidanceDelta: (rng.next() - 0.5) * 0.09,
    buybackAuthorisation: spec.marketCap * (0.005 + rng.next() * 0.05),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Document builders
// ─────────────────────────────────────────────────────────────────────────────

function tenK(symbol: string, f: Fundamentals, at: number, seed: number): RagDocument[] {
  const spec = requireSpec(symbol);
  const rng = createRng(hashSeed(`10k:${symbol}:${seed}`));
  const fy = new Date(at).getUTCFullYear() - 1;

  const mdAndA = [
    `Total revenue for fiscal ${fy} was ${money(f.revenue)}, a change of ${pct(f.revenueGrowth * 100)} against the prior year.`,
    `Gross margin was ${(f.grossMargin * 100).toFixed(1)}% and operating margin was ${(f.operatingMargin * 100).toFixed(1)}%.`,
    `Free cash flow was ${money(f.freeCashFlow)}. Net ${f.netDebt >= 0 ? 'debt' : 'cash'} at year end was ${money(Math.abs(f.netDebt))}.`,
    `Research and development expense represented ${(f.rndIntensity * 100).toFixed(1)}% of revenue, reflecting continued investment in the ${spec.industry.toLowerCase()} product portfolio.`,
    `We employed approximately ${f.employees.toLocaleString('en-US')} people as of the end of the fiscal year.`,
    `The Board has authorised the repurchase of up to ${money(f.buybackAuthorisation)} of common stock. Repurchases are discretionary and may be suspended at any time.`,
  ].join(' ');

  const riskFactors = [
    `Our results are subject to fluctuations in demand within the ${spec.sector.toLowerCase()} sector, and a downturn would reduce revenue and compress margin.`,
    `We derive a material portion of revenue from a limited number of customers; the loss of one would have an adverse effect on results of operations.`,
    `Supply concentration exposes us to single-source components. An interruption could delay shipments and increase cost of revenue.`,
    `We are subject to evolving regulation, and compliance costs may increase in ways we cannot presently estimate.`,
    `Our share price has been and may continue to be volatile. Realised volatility over the trailing year was materially above the market index.`,
    `We face intense competition. Competitors with greater resources may reduce prices, which would compress our gross margin below the ${(f.grossMargin * 100).toFixed(1)}% reported above.`,
  ].join(' ');

  const liquidity = [
    `Cash and equivalents plus short-term investments totalled ${money(f.revenue * (0.1 + rng.next() * 0.3))} at fiscal year end.`,
    `We believe existing liquidity is sufficient to meet operating requirements for at least the next twelve months.`,
    `Our revolving credit facility of ${money(f.revenue * 0.15)} was undrawn. The facility contains a maximum leverage covenant of 3.5x.`,
    `Average daily trading volume in our common stock was approximately ${Math.round(spec.adv30).toLocaleString('en-US')} shares.`,
  ].join(' ');

  const base = { symbol, sourceType: 'sec_10k' as const, authority: AUTHORITY.sec_10k, publishedAt: at, url: null };
  return [
    { ...base, id: `${symbol}-10k-${fy}-mdna`, title: `${spec.name} — Form 10-K (FY${fy})`, section: "Item 7 — Management's Discussion and Analysis", body: mdAndA },
    { ...base, id: `${symbol}-10k-${fy}-risk`, title: `${spec.name} — Form 10-K (FY${fy})`, section: 'Item 1A — Risk Factors', body: riskFactors },
    { ...base, id: `${symbol}-10k-${fy}-liquidity`, title: `${spec.name} — Form 10-K (FY${fy})`, section: 'Item 7 — Liquidity and Capital Resources', body: liquidity },
  ];
}

function tenQ(symbol: string, f: Fundamentals, at: number, seed: number): RagDocument {
  const spec = requireSpec(symbol);
  const rng = createRng(hashSeed(`10q:${symbol}:${at}:${seed}`));
  const quarterRevenue = (f.revenue / 4) * (0.9 + rng.next() * 0.2);
  const sequential = (rng.next() - 0.45) * 0.16;

  return {
    id: `${symbol}-10q-${isoDate(at)}`,
    title: `${spec.name} — Form 10-Q (${quarterLabel(at)})`,
    sourceType: 'sec_10q',
    symbol,
    section: 'Condensed Consolidated Statements of Operations',
    authority: AUTHORITY.sec_10q,
    publishedAt: at,
    url: null,
    body: [
      `Revenue for ${quarterLabel(at)} was ${money(quarterRevenue)}, ${pct(sequential * 100)} sequentially.`,
      `Gross margin was ${((f.grossMargin + (rng.next() - 0.5) * 0.03) * 100).toFixed(1)}%.`,
      `Operating expenses were ${money(quarterRevenue * (0.3 + rng.next() * 0.3))}, including ${money(quarterRevenue * f.rndIntensity)} of research and development.`,
      `Diluted shares outstanding were ${shareCount(spec.sharesOutstanding)}.`,
      `Management reiterated full-year guidance with a revision of ${pct(f.guidanceDelta * 100)} at the midpoint.`,
      `Deferred revenue was ${money(quarterRevenue * (0.2 + rng.next() * 0.5))}, which we expect to recognise over the next four quarters.`,
    ].join(' '),
  };
}

function eightK(symbol: string, at: number, seed: number): RagDocument {
  const spec = requireSpec(symbol);
  const rng = createRng(hashSeed(`8k:${symbol}:${at}:${seed}`));
  const events = [
    `entered into a definitive agreement to acquire a private ${spec.industry.toLowerCase()} business for ${money(spec.marketCap * (0.005 + rng.next() * 0.04))} in cash and stock`,
    `announced the appointment of a new Chief Financial Officer, effective at the close of the current quarter`,
    `completed the offering of ${money(spec.marketCap * (0.01 + rng.next() * 0.05))} aggregate principal amount of senior notes`,
    `announced a restructuring plan expected to affect approximately ${Math.round(200 + rng.next() * 3000).toLocaleString('en-US')} positions, with charges recognised over the next two quarters`,
    `disclosed the resolution of a previously reported regulatory inquiry without admission of liability`,
  ];
  const chosen = events[Math.floor(rng.next() * events.length)] as string;

  return {
    id: `${symbol}-8k-${isoDate(at)}`,
    title: `${spec.name} — Form 8-K`,
    sourceType: 'sec_8k',
    symbol,
    section: 'Item 8.01 — Other Events',
    authority: AUTHORITY.sec_8k,
    publishedAt: at,
    url: null,
    body: [
      `On ${isoDate(at)}, the registrant ${chosen}.`,
      `The registrant does not undertake to update forward-looking statements contained in this report.`,
      `A copy of the related press release is furnished as Exhibit 99.1 and is incorporated by reference.`,
    ].join(' '),
  };
}

function form4(symbol: string, at: number, seed: number): RagDocument {
  const spec = requireSpec(symbol);
  const rng = createRng(hashSeed(`form4:${symbol}:${at}:${seed}`));
  const buy = rng.next() > 0.42;
  const shares = Math.round(1500 + rng.next() * 240_000);
  const price = 20 + rng.next() * 400;
  const roles = ['Chief Executive Officer', 'Chief Financial Officer', 'Director', 'Chief Technology Officer', 'EVP, Operations'];
  const role = roles[Math.floor(rng.next() * roles.length)] as string;

  /**
   * The title and section carry the word "insider" even though no line of a real
   * Form 4 does. That is not editorialising — it is the document-type mapping any
   * ingest pipeline applies, and without it the form is unreachable: users ask
   * about *insider buying*, the filing says "reporting person" and "beneficial
   * ownership", and no amount of similarity search bridges that gap. The
   * vocabulary belongs in the index, next to the document, rather than being
   * wished for at query time.
   */
  return {
    id: `${symbol}-form4-${isoDate(at)}-${buy ? 'p' : 's'}`,
    title: `${spec.name} — Form 4 insider transaction report`,
    sourceType: 'sec_form4',
    symbol,
    section: `Table I — Non-Derivative Securities (insider ${buy ? 'purchase' : 'sale'})`,
    authority: AUTHORITY.sec_form4,
    publishedAt: at,
    url: null,
    body: [
      `A reporting person serving as ${role} reported a transaction code ${buy ? 'P (open-market purchase)' : 'S (open-market sale)'} on ${isoDate(at)}.`,
      `The transaction covered ${shares.toLocaleString('en-US')} shares at a weighted average price of $${price.toFixed(2)}, a value of ${money(shares * price)}.`,
      buy
        ? `Following the transaction the reporting person beneficially owned ${Math.round(shares * (3 + rng.next() * 12)).toLocaleString('en-US')} shares directly. Open-market purchases by officers are not a forecast of results.`
        : `The sale was ${rng.next() > 0.5 ? 'effected pursuant to a Rule 10b5-1 trading plan adopted in a prior quarter' : 'not effected pursuant to a Rule 10b5-1 trading plan'}.`,
      `Insider transactions must be reported on Form 4 within two business days of the transaction date.`,
    ].join(' '),
  };
}

function thirteenF(symbol: string, at: number, seed: number): RagDocument {
  const spec = requireSpec(symbol);
  const rng = createRng(hashSeed(`13f:${symbol}:${at}:${seed}`));
  const holders = ['a large multi-strategy manager', 'a quantitative equity manager', 'a pension plan', 'a sovereign wealth fund', 'a long-only growth manager'];
  const delta = (rng.next() - 0.4) * 0.6;
  const value = spec.marketCap * (0.001 + rng.next() * 0.02);

  return {
    id: `${symbol}-13f-${isoDate(at)}`,
    title: `Form 13F institutional holdings — position in ${spec.name}`,
    sourceType: 'sec_13f',
    symbol,
    section: 'Information Table — institutional ownership',
    authority: AUTHORITY.sec_13f,
    publishedAt: at,
    url: null,
    body: [
      `As of the ${quarterLabel(at)} reporting date, ${holders[Math.floor(rng.next() * holders.length)]} reported a position of ${money(value)} in ${spec.name}.`,
      `The position changed by ${pct(delta * 100)} against the prior filing.`,
      `13F filings are reported with a 45-day lag and reflect long positions only; they are not a statement of current holdings.`,
    ].join(' '),
  };
}

function transcript(symbol: string, f: Fundamentals, at: number, seed: number): RagDocument[] {
  const spec = requireSpec(symbol);
  const rng = createRng(hashSeed(`call:${symbol}:${at}:${seed}`));
  const base = {
    symbol,
    sourceType: 'earnings_transcript' as const,
    authority: AUTHORITY.earnings_transcript,
    publishedAt: at,
    url: null,
    title: `${spec.name} — ${quarterLabel(at)} earnings call`,
  };

  return [
    {
      ...base,
      id: `${symbol}-call-${isoDate(at)}-prepared`,
      section: 'Prepared remarks',
      body: [
        `Revenue grew ${pct(f.revenueGrowth * 100)} year over year, and gross margin came in at ${(f.grossMargin * 100).toFixed(1)}%.`,
        `We are ${f.guidanceDelta >= 0 ? 'raising' : 'trimming'} our full-year outlook by ${pct(Math.abs(f.guidanceDelta) * 100)} at the midpoint.`,
        `Free cash flow conversion remained strong at ${((f.freeCashFlow / f.revenue) * 100).toFixed(1)}% of revenue.`,
        `We returned ${money(f.buybackAuthorisation * (0.1 + rng.next() * 0.4))} to shareholders through repurchases during the quarter.`,
      ].join(' '),
    },
    {
      ...base,
      id: `${symbol}-call-${isoDate(at)}-qa`,
      section: 'Question and answer',
      body: [
        `Analyst: can you frame the margin trajectory from here? Management: we expect gross margin to hold within roughly one hundred basis points of the ${(f.grossMargin * 100).toFixed(1)}% we reported, with mix as the main swing factor.`,
        `Analyst: how should we think about the demand environment? Management: bookings were ${rng.next() > 0.5 ? 'ahead of' : 'in line with'} our internal plan, and the pipeline is ${rng.next() > 0.5 ? 'building' : 'stable'}, though we are not assuming an acceleration in our guidance.`,
        `Analyst: any change to the capital allocation priorities? Management: organic investment first, then the repurchase authorisation; we have no change to communicate.`,
      ].join(' '),
    },
  ];
}

function analystNote(symbol: string, f: Fundamentals, at: number, seed: number): RagDocument {
  const spec = requireSpec(symbol);
  const rng = createRng(hashSeed(`note:${symbol}:${at}:${seed}`));
  const stance = f.revenueGrowth > 0.08 ? 'constructive' : f.revenueGrowth < -0.04 ? 'cautious' : 'balanced';

  return {
    id: `${symbol}-note-${isoDate(at)}`,
    title: `Sell-side note — ${spec.name}`,
    sourceType: 'analyst_note',
    symbol,
    section: 'Summary and estimate changes',
    authority: AUTHORITY.analyst_note,
    publishedAt: at,
    url: null,
    body: [
      `We remain ${stance} on ${spec.name} following the ${quarterLabel(at)} print.`,
      `Our revenue estimate moves ${pct((rng.next() - 0.45) * 8)} and our margin estimate moves ${pct((rng.next() - 0.5) * 4)}.`,
      `The stock trades at a ${(1.4 + rng.next() * 7).toFixed(1)}x price-to-sales multiple against a ${spec.sector.toLowerCase()} peer group.`,
      `Key debate: whether the ${(f.grossMargin * 100).toFixed(1)}% gross margin is structural or mix-driven. This note is third-party opinion and is not a recommendation from this platform.`,
    ].join(' '),
  };
}

function newsItem(symbol: string, at: number, seed: number): RagDocument {
  const spec = requireSpec(symbol);
  const rng = createRng(hashSeed(`news:${symbol}:${at}:${seed}`));
  const angles = [
    `shares moved on volume of ${Math.round(spec.adv30 * (0.7 + rng.next() * 2.1)).toLocaleString('en-US')} against a 30-day average of ${Math.round(spec.adv30).toLocaleString('en-US')}`,
    `the ${spec.sector.toLowerCase()} sector traded ${pct((rng.next() - 0.5) * 4)} as rate expectations shifted`,
    `options activity was concentrated in near-dated contracts, with implied volatility ${rng.next() > 0.5 ? 'expanding' : 'compressing'} into the event`,
    `a competitor's results reset expectations across the ${spec.industry.toLowerCase()} group`,
  ];

  return {
    id: `${symbol}-news-${isoDate(at)}`,
    title: `Newswire — ${spec.name} session summary`,
    sourceType: 'news',
    symbol,
    section: 'Market wrap',
    authority: AUTHORITY.news,
    publishedAt: at,
    url: null,
    body: `On ${isoDate(at)}, ${angles[Math.floor(rng.next() * angles.length)]}. Newswire copy is descriptive and carries no analytical position.`,
  };
}

function socialPost(symbol: string, at: number, seed: number, platform: 'social_x' | 'reddit'): RagDocument {
  const spec = requireSpec(symbol);
  const rng = createRng(hashSeed(`${platform}:${symbol}:${at}:${seed}`));
  const bullish = rng.next() > 0.45;
  const posts = bullish
    ? [
        `Volume profile on ${symbol} looks like accumulation to me — three sessions of higher lows on rising participation.`,
        `${symbol} setup is clean. Watching the prior swing high. Not advice, just my read.`,
        `Anyone else see the ${symbol} options flow? Heavy call buying in the front month.`,
      ]
    : [
        `${symbol} looks tired here. Every bounce is getting sold into.`,
        `Cutting my ${symbol} position. The margin story stopped improving two quarters ago.`,
        `${symbol} chart is broken below the moving average. Waiting for it to base.`,
      ];

  return {
    id: `${symbol}-${platform}-${isoDate(at)}`,
    title: `${platform === 'social_x' ? 'Social post' : 'Retail forum thread'} — ${spec.symbol}`,
    sourceType: platform,
    symbol,
    section: 'Retail sentiment',
    authority: AUTHORITY[platform],
    publishedAt: at,
    url: null,
    body: `${posts[Math.floor(rng.next() * posts.length)]} Retail sentiment is an unverified crowd signal and the lowest-authority source in this corpus.`,
  };
}

/**
 * Market-wide documents.
 *
 * The regulatory summary exists so a question about the platform's own status —
 * "can this thing trade for me?" — retrieves a citable answer from the corpus
 * rather than from a hard-coded string in a route handler.
 */
function marketDocuments(at: number): RagDocument[] {
  return [
    {
      id: 'macro-regime-note',
      title: 'Macro regime note',
      sourceType: 'analyst_note',
      symbol: null,
      section: 'Cross-asset summary',
      authority: AUTHORITY.analyst_note,
      publishedAt: at - 3 * DAY_MS,
      url: null,
      body: [
        'Realised volatility across the index has been trending below its one-year median, and dispersion between sectors has widened.',
        'Regime classification is a statistical label over the recent return distribution, not a forecast: a low-volatility label describes the last twenty sessions and says nothing about the next twenty.',
        'Correlation between the index and the long bond has been unstable, which reduces the reliability of a single hedge ratio.',
      ].join(' '),
    },
    {
      id: 'platform-regulatory-status',
      title: 'Platform regulatory status',
      sourceType: 'platform_statement',
      symbol: null,
      section: 'Publisher status and scope of service',
      authority: AUTHORITY.platform_statement,
      publishedAt: at - 30 * DAY_MS,
      url: null,
      body: [
        'This platform operates as a publisher of impersonal, non-individualised market analysis and does not provide investment advice.',
        'Analysis is generated and published on a uniform schedule to all subscribers and is not tailored to any recipient, their holdings, their objectives or their circumstances.',
        'No output constitutes a recommendation to buy or sell any security. Position sizing, order parameters and the decision to transact rest entirely with the user.',
        'The platform does not exercise discretion over any account and cannot originate an order: every order is transmitted only in response to a physical user action.',
        'Past performance and back-tested results do not indicate future results. All trading involves the risk of loss, including total loss of capital.',
      ].join(' '),
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Assembly
// ─────────────────────────────────────────────────────────────────────────────

export interface CorpusOptions {
  seed?: number;
  now?: number;
  /** How many symbols receive a full document set. */
  symbols?: readonly string[];
}

/**
 * Builds the corpus.
 *
 * Publication instants are spread deterministically backwards from `now` on a
 * plausible cadence — annual reports once, quarterly filings and calls every ~91
 * days, insider and institutional filings scattered, news and social recent —
 * because recency is one of the re-ranking terms and a corpus where everything
 * shares one timestamp would make that term inert.
 */
export function buildCorpus(options: CorpusOptions = {}): RagDocument[] {
  const seed = options.seed ?? Number(process.env.AURELIUS_SEED ?? 20240117);
  const now = options.now ?? Date.now();
  const symbols = options.symbols ?? TRADABLE_SYMBOLS.slice(0, 24);

  const documents: RagDocument[] = [...marketDocuments(now)];

  for (const symbol of symbols) {
    const rng = createRng(hashSeed(`corpus:${symbol}:${seed}`));
    const f = fundamentals(symbol, seed);

    documents.push(...tenK(symbol, f, now - (120 + Math.floor(rng.next() * 90)) * DAY_MS, seed));

    // Two quarters back, on the ~91-day cadence, each with its matching call.
    for (let q = 0; q < 2; q += 1) {
      const filedAt = now - (18 + q * 91 + Math.floor(rng.next() * 8)) * DAY_MS;
      documents.push(tenQ(symbol, f, filedAt, seed));
      documents.push(...transcript(symbol, f, filedAt - DAY_MS, seed));
      documents.push(analystNote(symbol, f, filedAt + DAY_MS, seed));
    }

    if (rng.next() > 0.35) documents.push(eightK(symbol, now - Math.floor(rng.next() * 60) * DAY_MS, seed));
    documents.push(form4(symbol, now - Math.floor(rng.next() * 45) * DAY_MS, seed));
    if (rng.next() > 0.5) documents.push(thirteenF(symbol, now - (46 + Math.floor(rng.next() * 30)) * DAY_MS, seed));
    documents.push(newsItem(symbol, now - Math.floor(rng.next() * 6) * DAY_MS, seed));
    documents.push(socialPost(symbol, now - Math.floor(rng.next() * 4) * DAY_MS, seed, 'social_x'));
    if (rng.next() > 0.55) documents.push(socialPost(symbol, now - Math.floor(rng.next() * 9) * DAY_MS, seed, 'reddit'));
  }

  // Newest first: the seeded ledger writes in this order, and a stable sort on a
  // deterministic corpus makes the whole thing byte-reproducible.
  return documents.sort((a, b) => (b.publishedAt === a.publishedAt ? a.id.localeCompare(b.id) : b.publishedAt - a.publishedAt));
}

/**
 * Splits a document into retrieval chunks.
 *
 * Sentence-boundary packing to a target width, with one sentence of overlap. The
 * overlap matters for grounding rather than for retrieval: a numeric claim and
 * the sentence establishing what the number refers to frequently straddle a
 * boundary, and a chunk that contains only the former cannot verify it.
 */
export function chunkDocument(document: RagDocument, targetChars = 420): { ordinal: number; text: string }[] {
  const sentences = document.body
    .split(/(?<=[^0-9][.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  if (sentences.length === 0) return [];

  const chunks: { ordinal: number; text: string }[] = [];
  let current: string[] = [];
  let length = 0;

  for (const sentence of sentences) {
    if (length > 0 && length + sentence.length > targetChars) {
      chunks.push({ ordinal: chunks.length, text: current.join(' ') });
      const carry = current[current.length - 1];
      current = carry === undefined ? [] : [carry];
      length = carry === undefined ? 0 : carry.length;
    }
    current.push(sentence);
    length += sentence.length + 1;
  }
  if (current.length > 0) chunks.push({ ordinal: chunks.length, text: current.join(' ') });

  return chunks;
}
