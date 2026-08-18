/**
 * The tradable universe.
 *
 * A fixed, deterministic list so screener results, backtests and signal IDs are
 * stable between runs. Symbols and company names are real listings; every
 * numeric attribute (price level, ADV, beta, cap) is a *modelling parameter* for
 * the simulator, not a market quote.
 */

import type { Sector, SymbolMeta } from '@/lib/domain/types';

export interface UniverseSpec extends SymbolMeta {
  /** Starting price for the simulated path. */
  basePrice: number;
  /** Annualised idiosyncratic volatility. */
  idioVol: number;
  /** Annualised drift. */
  drift: number;
  /** Loading on the market factor. */
  marketBeta: number;
  /** Loading on the sector factor. */
  sectorBeta: number;
  /** Base tick-level spread in basis points. */
  spreadBps: number;
  /** Mean-reversion strength of the idiosyncratic component (OU θ, per year). */
  reversionTheta: number;
  /** Poisson intensity of overnight jumps, per year. */
  jumpIntensity: number;
  /** Standard deviation of jump size. */
  jumpSigma: number;
}

const S = (
  symbol: string,
  name: string,
  sector: Sector,
  industry: string,
  basePrice: number,
  marketCapB: number,
  advM: number,
  marketBeta: number,
  idioVol: number,
  drift: number,
  spreadBps: number,
  reversionTheta: number,
  jumpIntensity: number,
  jumpSigma: number,
  dividendYield = 0,
  optionable = true,
  exchange: SymbolMeta['exchange'] = 'NASDAQ',
  isBenchmark = false,
): UniverseSpec => ({
  symbol,
  name,
  sector,
  industry,
  marketCap: marketCapB * 1e9,
  adv30: advM * 1e6,
  sharesOutstanding: (marketCapB * 1e9) / basePrice,
  exchange,
  isBenchmark,
  referenceBeta: marketBeta,
  dividendYield,
  optionable,
  basePrice,
  idioVol,
  drift,
  marketBeta,
  sectorBeta: 0.35,
  spreadBps,
  reversionTheta,
  jumpIntensity,
  jumpSigma,
});

/**
 * 67 tradable names plus the benchmark, across all eleven GICS sectors, chosen so the
 * screener has genuine cross-sectional dispersion: mega-cap low-vol, high-beta
 * growth, deep-value cyclicals, utilities, and a handful of illiquid small caps
 * that exercise the ADV liquidity limiter.
 */
export const UNIVERSE: UniverseSpec[] = [
  // Benchmark
  S('SPY', 'SPDR S&P 500 ETF Trust', 'Financials', 'Broad Market ETF', 548, 520, 78, 1.0, 0.02, 0.08, 0.6, 0.4, 1.2, 0.012, 0.013, true, 'ARCA', true),

  // Technology
  S('AAPL', 'Apple Inc.', 'Technology', 'Consumer Electronics', 226, 3420, 54, 1.12, 0.19, 0.11, 0.7, 1.1, 2.4, 0.026, 0.0045),
  S('MSFT', 'Microsoft Corporation', 'Technology', 'Software — Infrastructure', 418, 3110, 22, 0.94, 0.18, 0.13, 0.9, 0.9, 2.1, 0.028, 0.0072),
  S('NVDA', 'NVIDIA Corporation', 'Technology', 'Semiconductors', 121, 2980, 310, 1.74, 0.44, 0.29, 1.1, 1.6, 4.8, 0.061, 0.0003),
  S('AVGO', 'Broadcom Inc.', 'Technology', 'Semiconductors', 168, 782, 31, 1.21, 0.31, 0.16, 1.4, 1.2, 3.1, 0.038, 0.0125),
  S('AMD', 'Advanced Micro Devices, Inc.', 'Technology', 'Semiconductors', 152, 246, 52, 1.86, 0.46, 0.09, 1.9, 1.8, 5.2, 0.055, 0),
  S('CRM', 'Salesforce, Inc.', 'Technology', 'Software — Application', 264, 255, 6.4, 1.24, 0.29, 0.07, 2.2, 1.4, 3.4, 0.041, 0.0061, true, 'NYSE'),
  S('ORCL', 'Oracle Corporation', 'Technology', 'Software — Infrastructure', 158, 438, 11, 1.03, 0.26, 0.15, 2.0, 1.1, 2.6, 0.033, 0.0101, true, 'NYSE'),
  S('ADBE', 'Adobe Inc.', 'Technology', 'Software — Application', 512, 228, 3.1, 1.31, 0.31, 0.04, 3.1, 1.5, 3.9, 0.052, 0),
  S('QCOM', 'QUALCOMM Incorporated', 'Technology', 'Semiconductors', 168, 187, 9.8, 1.28, 0.32, 0.10, 2.4, 1.3, 3.6, 0.044, 0.0202),
  S('MU', 'Micron Technology, Inc.', 'Technology', 'Semiconductors', 96, 106, 21, 1.62, 0.47, 0.06, 2.8, 1.9, 5.6, 0.058, 0.0047),
  S('PLTR', 'Palantir Technologies Inc.', 'Technology', 'Software — Infrastructure', 34, 76, 62, 1.94, 0.58, 0.22, 4.1, 2.2, 6.4, 0.071, 0, true, 'NYSE'),

  // Communication Services
  S('GOOGL', 'Alphabet Inc.', 'Communication Services', 'Interactive Media', 165, 2020, 28, 1.06, 0.23, 0.12, 1.2, 1.0, 2.7, 0.031, 0.0048),
  S('META', 'Meta Platforms, Inc.', 'Communication Services', 'Interactive Media', 512, 1290, 15, 1.22, 0.32, 0.18, 1.6, 1.2, 4.1, 0.047, 0.0039),
  S('NFLX', 'Netflix, Inc.', 'Communication Services', 'Entertainment', 692, 296, 3.9, 1.18, 0.35, 0.14, 3.4, 1.4, 4.4, 0.056, 0),
  S('DIS', 'The Walt Disney Company', 'Communication Services', 'Entertainment', 94, 172, 11, 1.14, 0.27, 0.02, 2.3, 1.6, 3.2, 0.038, 0.0095, true, 'NYSE'),
  S('T', 'AT&T Inc.', 'Communication Services', 'Telecom Services', 21, 152, 34, 0.62, 0.18, 0.03, 3.6, 2.4, 1.9, 0.024, 0.0524, true, 'NYSE'),
  S('VZ', 'Verizon Communications Inc.', 'Communication Services', 'Telecom Services', 42, 178, 19, 0.58, 0.17, 0.02, 3.1, 2.6, 1.8, 0.022, 0.0631, true, 'NYSE'),

  // Consumer Discretionary
  S('AMZN', 'Amazon.com, Inc.', 'Consumer Discretionary', 'Internet Retail', 184, 1920, 42, 1.16, 0.28, 0.13, 1.3, 1.1, 3.2, 0.037, 0),
  S('TSLA', 'Tesla, Inc.', 'Consumer Discretionary', 'Auto Manufacturers', 248, 792, 96, 2.04, 0.54, 0.05, 1.8, 1.4, 7.1, 0.082, 0),
  S('HD', 'The Home Depot, Inc.', 'Consumer Discretionary', 'Home Improvement Retail', 382, 379, 3.4, 1.02, 0.21, 0.09, 2.6, 1.3, 2.4, 0.029, 0.0234, true, 'NYSE'),
  S('MCD', "McDonald's Corporation", 'Consumer Discretionary', 'Restaurants', 292, 210, 3.0, 0.71, 0.16, 0.07, 2.8, 1.7, 1.9, 0.021, 0.0231, true, 'NYSE'),
  S('NKE', 'NIKE, Inc.', 'Consumer Discretionary', 'Footwear & Accessories', 78, 116, 9.2, 1.08, 0.27, -0.02, 2.9, 1.9, 3.1, 0.036, 0.0189, true, 'NYSE'),
  S('SBUX', 'Starbucks Corporation', 'Consumer Discretionary', 'Restaurants', 96, 109, 8.1, 0.94, 0.25, 0.01, 3.0, 2.0, 3.0, 0.034, 0.0236),
  S('LULU', 'Lululemon Athletica Inc.', 'Consumer Discretionary', 'Apparel Retail', 268, 33, 2.2, 1.34, 0.38, -0.04, 4.6, 2.1, 5.1, 0.062, 0),

  // Health Care
  S('LLY', 'Eli Lilly and Company', 'Health Care', 'Drug Manufacturers', 892, 848, 3.6, 0.52, 0.26, 0.24, 3.2, 0.8, 3.4, 0.041, 0.0064, true, 'NYSE'),
  S('UNH', 'UnitedHealth Group Incorporated', 'Health Care', 'Healthcare Plans', 584, 538, 3.4, 0.61, 0.22, 0.08, 3.4, 1.2, 3.8, 0.048, 0.0146, true, 'NYSE'),
  S('JNJ', 'Johnson & Johnson', 'Health Care', 'Drug Manufacturers', 162, 390, 7.2, 0.51, 0.15, 0.04, 2.2, 1.5, 1.7, 0.019, 0.0308, true, 'NYSE'),
  S('ABBV', 'AbbVie Inc.', 'Health Care', 'Drug Manufacturers', 196, 346, 5.9, 0.58, 0.19, 0.11, 2.5, 1.4, 2.2, 0.026, 0.0322, true, 'NYSE'),
  S('MRK', 'Merck & Co., Inc.', 'Health Care', 'Drug Manufacturers', 112, 284, 9.1, 0.44, 0.18, 0.05, 2.4, 1.6, 2.4, 0.028, 0.0276, true, 'NYSE'),
  S('TMO', 'Thermo Fisher Scientific Inc.', 'Health Care', 'Diagnostics & Research', 592, 226, 1.7, 0.86, 0.22, 0.06, 3.8, 1.3, 2.9, 0.033, 0.0026, true, 'NYSE'),
  S('ISRG', 'Intuitive Surgical, Inc.', 'Health Care', 'Medical Instruments', 462, 163, 1.6, 1.11, 0.28, 0.15, 4.0, 1.2, 3.3, 0.039, 0),
  S('MRNA', 'Moderna, Inc.', 'Health Care', 'Biotechnology', 68, 26, 8.4, 1.68, 0.62, -0.18, 5.2, 2.4, 8.2, 0.094, 0),

  // Financials
  S('BRK.B', 'Berkshire Hathaway Inc.', 'Financials', 'Insurance — Diversified', 452, 976, 4.1, 0.86, 0.14, 0.10, 2.1, 1.0, 1.6, 0.018, 0, true, 'NYSE'),
  S('JPM', 'JPMorgan Chase & Co.', 'Financials', 'Banks — Diversified', 216, 620, 9.4, 1.09, 0.22, 0.12, 2.0, 1.1, 2.6, 0.031, 0.0217, true, 'NYSE'),
  S('V', 'Visa Inc.', 'Financials', 'Credit Services', 276, 552, 6.2, 0.94, 0.18, 0.11, 2.2, 1.2, 2.1, 0.024, 0.0076, true, 'NYSE'),
  S('MA', 'Mastercard Incorporated', 'Financials', 'Credit Services', 468, 434, 2.9, 0.98, 0.19, 0.12, 2.6, 1.2, 2.2, 0.026, 0.0056, true, 'NYSE'),
  S('BAC', 'Bank of America Corporation', 'Financials', 'Banks — Diversified', 40, 312, 38, 1.26, 0.26, 0.07, 2.8, 1.3, 3.1, 0.037, 0.0242, true, 'NYSE'),
  S('GS', 'The Goldman Sachs Group, Inc.', 'Financials', 'Capital Markets', 496, 162, 2.2, 1.28, 0.26, 0.14, 2.7, 1.2, 3.2, 0.039, 0.0225, true, 'NYSE'),
  S('SCHW', 'The Charles Schwab Corporation', 'Financials', 'Capital Markets', 68, 124, 9.6, 1.22, 0.30, 0.04, 3.0, 1.5, 3.8, 0.046, 0.0148, true, 'NYSE'),
  S('COIN', 'Coinbase Global, Inc.', 'Financials', 'Capital Markets', 196, 48, 11, 2.42, 0.72, 0.12, 4.4, 2.0, 9.4, 0.108, 0),

  // Industrials
  S('CAT', 'Caterpillar Inc.', 'Industrials', 'Farm & Heavy Machinery', 348, 168, 3.1, 1.14, 0.25, 0.11, 2.6, 1.3, 3.0, 0.036, 0.0155, true, 'NYSE'),
  S('GE', 'GE Aerospace', 'Industrials', 'Aerospace & Defense', 172, 186, 6.2, 1.18, 0.28, 0.19, 2.7, 1.3, 3.4, 0.041, 0.0064, true, 'NYSE'),
  S('BA', 'The Boeing Company', 'Industrials', 'Aerospace & Defense', 168, 103, 8.4, 1.44, 0.38, -0.09, 3.2, 1.8, 5.4, 0.065, 0, true, 'NYSE'),
  S('UPS', 'United Parcel Service, Inc.', 'Industrials', 'Integrated Freight', 128, 109, 4.2, 1.01, 0.24, -0.03, 2.9, 1.9, 2.9, 0.034, 0.0512, true, 'NYSE'),
  S('LMT', 'Lockheed Martin Corporation', 'Industrials', 'Aerospace & Defense', 562, 133, 1.3, 0.51, 0.19, 0.09, 3.6, 1.4, 2.6, 0.029, 0.0231, true, 'NYSE'),
  S('DE', 'Deere & Company', 'Industrials', 'Farm & Heavy Machinery', 396, 109, 1.7, 1.06, 0.24, 0.06, 3.4, 1.4, 3.1, 0.037, 0.0148, true, 'NYSE'),

  // Consumer Staples
  S('WMT', 'Walmart Inc.', 'Consumer Staples', 'Discount Stores', 78, 628, 17, 0.62, 0.16, 0.14, 2.1, 1.2, 1.9, 0.021, 0.0107, true, 'NYSE'),
  S('COST', 'Costco Wholesale Corporation', 'Consumer Staples', 'Discount Stores', 892, 396, 2.1, 0.79, 0.19, 0.16, 2.8, 1.1, 2.2, 0.025, 0.0051),
  S('PG', 'The Procter & Gamble Company', 'Consumer Staples', 'Household Products', 168, 396, 6.4, 0.42, 0.13, 0.06, 2.0, 1.4, 1.5, 0.016, 0.0243, true, 'NYSE'),
  S('KO', 'The Coca-Cola Company', 'Consumer Staples', 'Beverages', 70, 302, 14, 0.55, 0.14, 0.05, 2.2, 1.5, 1.6, 0.017, 0.0281, true, 'NYSE'),
  S('PEP', 'PepsiCo, Inc.', 'Consumer Staples', 'Beverages', 172, 236, 5.4, 0.51, 0.14, 0.02, 2.3, 1.6, 1.7, 0.019, 0.0322),

  // Energy
  S('XOM', 'Exxon Mobil Corporation', 'Energy', 'Oil & Gas Integrated', 118, 522, 16, 0.88, 0.24, 0.08, 2.2, 1.4, 2.9, 0.035, 0.0328, true, 'NYSE'),
  S('CVX', 'Chevron Corporation', 'Energy', 'Oil & Gas Integrated', 148, 272, 8.6, 0.91, 0.24, 0.04, 2.4, 1.5, 2.9, 0.034, 0.0442, true, 'NYSE'),
  S('COP', 'ConocoPhillips', 'Energy', 'Oil & Gas E&P', 108, 126, 6.4, 1.12, 0.30, 0.03, 2.8, 1.6, 3.6, 0.043, 0.0289, true, 'NYSE'),
  S('SLB', 'Schlumberger Limited', 'Energy', 'Oil & Gas Equipment', 44, 63, 11, 1.36, 0.35, -0.04, 3.2, 1.9, 4.2, 0.051, 0.0248, true, 'NYSE'),

  // Materials
  S('LIN', 'Linde plc', 'Materials', 'Specialty Chemicals', 462, 220, 1.7, 0.94, 0.19, 0.10, 3.0, 1.3, 2.2, 0.026, 0.0121),
  S('FCX', 'Freeport-McMoRan Inc.', 'Materials', 'Copper', 46, 66, 14, 1.58, 0.38, 0.05, 3.1, 1.7, 4.6, 0.056, 0.0131, true, 'NYSE'),
  S('NEM', 'Newmont Corporation', 'Materials', 'Gold', 48, 55, 12, 0.66, 0.34, 0.02, 3.4, 2.1, 4.1, 0.049, 0.0208, true, 'NYSE'),

  // Utilities
  S('NEE', 'NextEra Energy, Inc.', 'Utilities', 'Utilities — Regulated Electric', 78, 160, 11, 0.58, 0.20, 0.05, 2.6, 1.8, 2.4, 0.028, 0.0264, true, 'NYSE'),
  S('DUK', 'Duke Energy Corporation', 'Utilities', 'Utilities — Regulated Electric', 112, 86, 3.4, 0.44, 0.15, 0.04, 3.0, 2.0, 1.8, 0.020, 0.0372, true, 'NYSE'),
  S('SO', 'The Southern Company', 'Utilities', 'Utilities — Regulated Electric', 88, 96, 4.1, 0.46, 0.15, 0.06, 2.9, 2.0, 1.8, 0.020, 0.0328, true, 'NYSE'),

  // Real Estate
  S('PLD', 'Prologis, Inc.', 'Real Estate', 'REIT — Industrial', 118, 109, 3.2, 1.06, 0.24, -0.01, 3.2, 1.7, 2.8, 0.033, 0.0327, true, 'NYSE'),
  S('AMT', 'American Tower Corporation', 'Real Estate', 'REIT — Specialty', 212, 99, 2.4, 0.82, 0.22, 0.02, 3.4, 1.8, 2.7, 0.031, 0.0316, true, 'NYSE'),
  S('SPG', 'Simon Property Group, Inc.', 'Real Estate', 'REIT — Retail', 158, 52, 2.1, 1.34, 0.28, 0.07, 3.6, 1.6, 3.2, 0.038, 0.0512, true, 'NYSE'),

  // Deliberately thin names — these exercise the 5%-of-ADV liquidity limiter.
  S('SMCI', 'Super Micro Computer, Inc.', 'Technology', 'Computer Hardware', 42, 25, 34, 2.18, 0.78, -0.12, 6.2, 2.4, 11.2, 0.128, 0),
  S('RIOT', 'Riot Platforms, Inc.', 'Financials', 'Capital Markets', 9.4, 3.1, 18, 2.64, 0.92, -0.06, 11.4, 2.8, 12.6, 0.142, 0),
  S('BYND', 'Beyond Meat, Inc.', 'Consumer Staples', 'Packaged Foods', 6.2, 0.42, 2.8, 1.92, 0.86, -0.34, 24.6, 3.2, 10.4, 0.126, 0),
];

export const BENCHMARK_SYMBOL = 'SPY';

const bySymbol = new Map(UNIVERSE.map((u) => [u.symbol, u]));

export function getSpec(symbol: string): UniverseSpec | undefined {
  return bySymbol.get(symbol);
}

export function requireSpec(symbol: string): UniverseSpec {
  const spec = bySymbol.get(symbol);
  if (!spec) throw new Error(`Unknown symbol: ${symbol}`);
  return spec;
}

export function symbolMeta(spec: UniverseSpec): SymbolMeta {
  return {
    symbol: spec.symbol,
    name: spec.name,
    sector: spec.sector,
    industry: spec.industry,
    marketCap: spec.marketCap,
    adv30: spec.adv30,
    sharesOutstanding: spec.sharesOutstanding,
    exchange: spec.exchange,
    isBenchmark: spec.isBenchmark,
    referenceBeta: spec.referenceBeta,
    dividendYield: spec.dividendYield,
    optionable: spec.optionable,
  };
}

export const ALL_SYMBOLS = UNIVERSE.map((u) => u.symbol);
export const TRADABLE_SYMBOLS = UNIVERSE.filter((u) => !u.isBenchmark).map((u) => u.symbol);
export const SECTORS = Array.from(new Set(UNIVERSE.map((u) => u.sector))).sort() as Sector[];

export function symbolsInSector(sector: Sector): string[] {
  return UNIVERSE.filter((u) => u.sector === sector).map((u) => u.symbol);
}
