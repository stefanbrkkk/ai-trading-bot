# Project Aurelius

A quantitative signal terminal that publishes impersonal market analysis and shows
the derivation of every number it produces.

It runs end to end with a completely empty `.env` — no API keys, no external
services, no network. Add a key when you want live inference or a live feed; nothing
else about the platform changes.

```bash
npm install
npm run build       # trains the ensemble on first build (~3 min), then compiles
npm start           # http://localhost:3000
```

For development, `npm run dev` after a `npm run seed`. `.data/` is git-ignored, so a
fresh clone has no trained ensemble; `npm run build` trains one if the deployment has
none and skips it otherwise. Set `AURELIUS_SKIP_SEED=1` to opt out — the platform
still runs, and the five routes that need the engine say what to run instead of
failing.

---

## What it is

Aurelius computes a conviction score for each symbol in a 67-name tradable universe
(68 including the benchmark it measures relative strength against) and opens
that score into the exact contribution of every input behind it. It is a **publisher**
of analysis, not an adviser: one ranking per session, identical for every subscriber,
with no personalisation and no discretion over any account.

That posture is not a disclaimer bolted onto a trading bot. It determines the
architecture, and most of the unusual decisions in this codebase follow from it:

| Constraint | Consequence in the code |
| --- | --- |
| Analysis must be impersonal | No signal, level, narrative or ranking reads your holdings. The account is read for the pre-trade margin check and to display back to you — nowhere else. |
| No discretionary trading | Order routing is reachable only from a physical click carrying a single-use authorisation. There is no scheduler, no completion hook, no autonomous path to a broker. |
| No position sizing | Every order field starts blank and stays blank. The published Kelly fraction is an impersonal model statistic and is not readable from the ticket. |
| Every claim must be checkable | Attributions are exact, not sampled. The local-accuracy residual is displayed. Generated SQL is shown. Retrieved answers are graded claim by claim. |

---

## The stack

Next.js 15 App Router, React 19, TypeScript in strict mode with `no-explicit-any` as
an error. Tailwind for styling. Framer Motion for transitions.

Three deliberate absences:

- **No charting library.** Every chart is hand-written SVG. Seventeen of them, of
  which fourteen are rendered; `CalibrationPlot`, `DepthLadder` and `Sparkline`
  are built and not yet placed, and this sentence exists so that stays visible.
- **No ML framework.** The gradient-boosted trees, the LSTM/BiLSTM/TFT agents and the
  reverse-mode autodiff that trains them are implemented from scratch in TypeScript.
- **No vendor SDKs.** Three providers — Anthropic, OpenAI and DeepSeek — are served
  by two `fetch` adapters (the last two share the chat-completions shape), so
  `npm install` yields a working platform with no vendor packages present at all.

Persistence is Node 22's built-in `node:sqlite` behind a driver seam, so the same
append-only DDL runs on Postgres by registering one adapter.

---

## Running it

```bash
npm run dev          # dev server on :3000
npm run seed         # full seed (~3 min) — trains and persists everything
npm run seed:fast    # reduced budget (~20s) — for CI and E2E
npm run verify       # typecheck → lint → 202 unit tests → build → 43 E2E tests
```

The E2E suite seeds its own data directory on first run, so `npm run e2e` works on a
clone with nothing set up. Hosting is a long-running Node process (`npm start`): the
store is an embedded SQLite file and the trained ensemble is a file on disk, so a
per-request serverless runtime is the wrong shape for it. Point `DATABASE_URL` at
Postgres to change that.

Everything is deterministic in `AURELIUS_SEED`. Two machines running the same seed
produce byte-identical signals, which is what makes a published attribution auditable
months later rather than merely plausible at the time.

### Optional configuration

Every variable in `.env.example` is optional and blank by default.

```bash
AURELIUS_LLM_PROVIDER=deterministic   # anthropic | openai | deepseek
ANTHROPIC_API_KEY=                    # supply one to switch to live inference
AURELIUS_MARKET_PROVIDER=simulator    # alpaca | polygon
AURELIUS_BROKER=paper                 # alpaca
DATABASE_URL=                         # blank → embedded SQLite
```

Provider resolution treats an unset and an empty credential as the same thing, so
there is no "demo key" path. A named provider whose key is missing degrades to the
deterministic engine and says so on the transparency page rather than failing the
process.

---

## The quantitative core

`src/lib/quant/` — no dependencies, all verified against closed forms or brute force
in `tests/`.

- **Ornstein–Uhlenbeck** mean reversion by closed-form MLE; half-life `ln2/θ`,
  equilibrium band, reversion probability from the exact transition density.
- **Kalman filter** in Joseph form with Sage-Husa adaptive noise estimation, yielding
  innovation bands that adapt to regime rather than to a fixed window.
- **SABR** (Hagan 2002) fitted per expiry by Nelder–Mead on an unconstrained
  reparameterisation, plus the 25-delta risk reversal.
- **MLOFI** — multi-level order-flow imbalance (Cont–Kukanov–Stoikov extended to
  depth *M*), filtered onto its first principal component.
- **Exact TreeSHAP** with FastTreeSHAP v2 path pre-compilation. Attributions satisfy
  local accuracy to floating-point precision, and the residual is published.
- **GBDT** with second-order Newton boosting; **LSTM, BiLSTM and a Temporal Fusion
  Transformer** with a monotonic quantile head, trained by matrix-level reverse-mode
  autodiff.
- ECDF normalisation, C-vine copulas, PCA, Rogers-Satchell volatility, and the usual
  indicator set.

### The conflict-resolution router

Three agents on three timeframes disagree constantly. The router resolves it with
published constants — per-agent edge, a regime-override threshold, a VPIN toxic-flow
abort, a macro-volatility amplification and an aggregate noise floor — and reports
which one prevailed and why. It never averages a disagreement away silently.

---

## Honest reporting

The seeded model's out-of-sample accuracy is **56.1%** against an in-sample **73.2%**,
and the portfolio backtest returns **−3.7%** with a Sharpe of **−0.31**. Most
strategies have a profit factor below 1.

Those numbers are on the transparency and backtest pages, in the same size type as
everything else, and the survival scorecard shows every threshold that was missed
next to what was observed. The model is fitted on a deterministic simulator rather
than on licensed market data, and it has no real edge — the limitation is stated at
the top of the model card, above the metrics.

This is the intended behaviour. A back-test surface that only ever shows a passing
result is marketing with a chart attached, and the number that matters to someone
deciding whether to trust a strategy is the one it did *not* clear.

The same principle applies to the three temporal agents, and it caught something
worth reporting. Each one's **discrimination** — the standard deviation of its
predicted probability across the held-out split — is measured at training time
and published on the model card. The 60m Temporal Fusion Transformer scores about
6e-6: it returns the same number for every symbol in the universe. So the router
gives it no weight, and the transparency page shows why in the same table as its
loss, because a collapsed agent reports a perfectly ordinary loss — a constant
prediction on a balanced set is unremarkable by that measure and only the spread
gives it away.

All three agents also came out of training with a mean predicted probability near
0.75 against a 49.5% base rate, which made every one of the 67 names publish as
long. Each now carries a logit offset fitted on the validation split, which moves
the distribution onto the base rate without disturbing the relative ordering the
network learned. The published list is a mixture of long, short and flat, and
conviction scores are correspondingly lower — which is the honest number, not a
worse one.

---

## Pre-trade controls

Order routing passes through a pure risk engine (`src/lib/risk/engine.ts`) that
performs no I/O, so any decision can be replayed exactly from the ledger. Every
control fails **closed**: a missing ADV, an unpriceable order, an absent account
snapshot each deny rather than waving the order through.

- Notional ceiling per order and per user per day
- ADV participation limit (5% of 30-day average volume)
- Click provenance — coordinates, viewport and `isTrusted` from the DOM event
- Single-use intent token bound to one symbol and one parameter set
- Duplicate-order and open-order-count controls
- Price collar, stop-price sanity, margin check
- Platform-wide kill switch, with the reason published

`POST /api/orders/submit` is the only code path that can reach a broker, and it has
no caller other than the HTTP route. The order flow is: mint an authorisation from a
physical click → risk engine consumes the token → persist the authorised order →
dispatch → record all six mandatory audit fields with the click → API → broker-ACK
timestamp chain.

---

## InvestGPT

Ask in English; get inspectable SQL.

```
"Which optionable large cap names have a 25 delta risk reversal below -2?"
```

1. **CSR-RAG pruning** takes 829 catalog surfaces down to 10–46 columns before any
   generation, then expands over the foreign-key graph.
2. **A deterministic compiler** — not a fallback, the default — translates the
   question into a parameterised SELECT. Qualitative predicates compile to the
   feature registry's own published state bands, so the SQL agrees with the state
   label the terminal renders for the same row.
3. **A three-layer validator** tokenises before pattern matching, permits only a
   single SELECT, and checks every relation against a read-only allowlist. `users`,
   `orders`, `order_telemetry` and the ledger tables are unreachable from any
   natural-language question.
4. **Execution** with a row cap, returning the statement, the pruning report and the
   validator verdict alongside the rows.

Where a live model is configured it must clear three bars to displace the compiler:
validate against the pruned table set, execute, and return rows when the compiler
did. A model that misreads a filter otherwise produces safe, valid, empty SQL and the
user concludes the market had no matches.

---

## Research

Hybrid retrieval — BM25 plus hashed-embedding dense search, fused by reciprocal rank
and re-ranked on source authority and recency — then claim-level grounding. Each
sentence of the answer is typed (numerical, temporal, comparative, regulatory,
platform-derived) and verified against the span that supports it.

**Unverified claims are returned marked unverified, not removed.** Removing them
produces a cleaner paragraph whose remaining sentences carry a guarantee they have not
earned.

The corpus is synthetic. It is internally consistent — the revenue figure in a 10-Q
agrees with the matching transcript, every number derives from the same seed as the
price series — so the whole retrieval and grounding pipeline is genuinely exercised.
But no sentence in it is a statement about a real company, and the UI says so wherever
a citation appears. Replacing it with an EDGAR ingest changes one file.

---

## The ledger

Bitemporal and append-only, with UPDATE and DELETE blocked by database triggers rather
than by convention. `assertAppendOnly()` proves enforcement by attempting a real
UPDATE and a real DELETE against a real row and confirming the engine aborts both.

Two independent time axes:

- **Valid time** — the instant in the modelled world being rebuilt.
- **Transaction time** — the cutoff on what the platform had learned.

Holding the first fixed and moving the second shows how the platform's account of a
past moment changed as it learned more. That is the difference between a bitemporal
ledger and a versioned table, and it is what makes "what did you believe at 14:32,
using only what you knew then" an answerable question.

---

## Testing

```
202 unit tests   (vitest)
 43 E2E tests    (Playwright, real Chromium)
```

The unit tests check against independent references wherever one exists, because
asserting against recorded output proves nothing — a wrong implementation reproduces
its own wrong numbers reliably. TreeSHAP is checked against an exhaustive enumeration
of the Shapley definition; Black-Scholes against put-call parity and finite
differences; the OU MLE by recovering known parameters from a simulated path; SABR by
reproducing the smile it was fitted to.

Every narrative template the engine can emit is run through the platform's own
prohibited-phrase checker, which closes the loop between "we forbid advisory language"
and "our output contains none".

The E2E suite asserts a **clean console on every page** — a React error, a hydration
mismatch, a failed request or a NaN reaching the DOM all fail the test. Three real
defects were invisible to server-side rendering and surfaced only this way.

It also asserts that the platform agrees with itself: the published list, the screener
and each symbol page have to carry the same conviction and the same direction for the
same name. They did not, for a while. The publication is persisted — it is immutable
for its date, one ranking identical for every subscriber — while the other two
recompute per request, and the engine was evaluating at the wall clock, so the cached
list drifted away from the pages it linked to as the session went on. Everything now
evaluates at the last completed session close, which is a function of the calendar
rather than of when the process started.

---

## Layout

```
src/lib/quant/        Pure mathematics. No I/O, no dependencies.
src/lib/market/       Deterministic simulator + live provider adapters.
src/lib/engine/       Features, strategies, router, pipeline, backtester.
src/lib/risk/         Pre-trade controls, intent tokens, kill switch, telemetry.
src/lib/broker/       Adapter seam; paper broker with modelled slippage.
src/lib/db/           Bitemporal append-only store behind a driver seam.
src/lib/investgpt/    Catalog, pruner, NL→SQL compiler, validator, executor.
src/lib/rag/          Corpus, embeddings, hybrid retrieval, claim grounding.
src/lib/ai/           Language-model seam. Deterministic by default.
src/lib/compliance/   Verbatim disclosures, terms, prohibited copy.
src/components/charts/  17 hand-written SVG charts.
src/app/              16 pages and 29 API routes.
```

---

## What this is not

Not investment advice. Not a recommendation to buy or sell any security. Not a
fiduciary, adviser or broker-dealer. Back-tested results are hypothetical and do not
indicate future results. All trading involves the risk of loss, including total loss
of capital.

The model is fitted on a synthetic simulator and has no demonstrated edge on real
markets. Treat every number as a description of the simulator until it has been
refitted on licensed data and evaluated out of sample.
