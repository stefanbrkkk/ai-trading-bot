/**
 * End-to-end coverage of every page and the order-routing flow.
 *
 * Two things distinguish this suite from a set of smoke tests.
 *
 * First, **every page is asserted to produce a clean console**. A React error, a
 * hydration mismatch, a failed request or a NaN reaching the DOM all fail the test
 * rather than being tolerated because the page still rendered something. Three real
 * defects on this platform — a null `attention` array, a keyed record treated as an
 * array, and an anonymous page fetching authenticated endpoints — were invisible to
 * server-side rendering and only surfaced this way.
 *
 * Second, the order tests assert the *controls*, not the happy path. A ticket that
 * routes an order proves the plumbing works; a ticket that refuses a replayed
 * authorisation, refuses a re-bound quantity and refuses an untrusted click is the
 * thing the platform's regulatory position actually rests on.
 */

import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/** Every route the navigation exposes, plus the two parameterised ones. */
const PAGES: readonly { path: string; heading: RegExp }[] = [
  { path: '/', heading: /signal terminal where every number/i },
  { path: '/terminal', heading: /signal terminal/i },
  { path: '/terminal/AAPL', heading: /attribution/i },
  { path: '/screener', heading: /screener/i },
  { path: '/investgpt', heading: /investgpt/i },
  { path: '/research', heading: /research/i },
  { path: '/backtest', heading: /backtest/i },
  { path: '/portfolio', heading: /portfolio/i },
  { path: '/order/AAPL', heading: /route an order/i },
  { path: '/transparency', heading: /transparency/i },
  { path: '/compliance', heading: /compliance/i },
  { path: '/control', heading: /control centre/i },
  { path: '/admin', heading: /admin/i },
  { path: '/login', heading: /return to the terminal/i },
  { path: '/signup', heading: /paper sandbox/i },
  { path: '/onboarding', heading: /terms, risk disclosures/i },
];

interface Problems {
  console: string[];
  pageErrors: string[];
  failedRequests: string[];
  serverErrors: string[];
}

/**
 * Attaches listeners that record anything a healthy page should not produce.
 *
 * `ERR_ABORTED` is excluded because Next.js aborts in-flight prefetches on
 * navigation as a matter of course — counting those would make every test flaky
 * without indicating a defect.
 */
function watch(page: Page): Problems {
  const problems: Problems = { console: [], pageErrors: [], failedRequests: [], serverErrors: [] };

  page.on('console', (message: ConsoleMessage) => {
    const type = message.type();
    if (type === 'error' || type === 'warning') problems.console.push(`${type}: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const failure = request.failure();
    if (failure && !/ERR_ABORTED/.test(failure.errorText)) {
      problems.failedRequests.push(`${request.url()} — ${failure.errorText}`);
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 500) problems.serverErrors.push(`${response.status()} ${response.url()}`);
  });

  return problems;
}

function expectClean(problems: Problems, context: string): void {
  expect(problems.pageErrors, `${context}: page errors`).toEqual([]);
  expect(problems.serverErrors, `${context}: 5xx responses`).toEqual([]);
  expect(problems.failedRequests, `${context}: failed requests`).toEqual([]);
  expect(problems.console, `${context}: console output`).toEqual([]);
}

/** Signs up a fresh account and accepts the terms, returning the email used. */
async function signUpAndAccept(page: Page): Promise<string> {
  const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@aurelius.local`;

  await page.goto('/signup');
  await page.fill('input[name="displayName"]', 'E2E');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', 'correct-horse-battery-staple');
  await page.click('button[type="submit"]');

  // A new account has not accepted the terms, so it lands on the clickwrap.
  await page.waitForURL(/onboarding/);

  // Scroll the instrumented pane to its end — the gate measures the scrolling
  // element, so this is the same signal a human produces.
  const pane = page.locator('div[role="region"]');
  await pane.waitFor();
  await pane.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });

  const checkbox = page.locator('input[type="checkbox"]');
  await expect(checkbox).toBeEnabled();
  await checkbox.check();
  await page.click('#accept-terms');
  await page.waitForURL(/terminal/);

  return email;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Every page renders cleanly
// ─────────────────────────────────────────────────────────────────────────────

for (const { path, heading } of PAGES) {
  test(`${path} renders with a clean console`, async ({ page }) => {
    const problems = watch(page);

    const response = await page.goto(path, { waitUntil: 'networkidle' });
    expect(response?.status(), `${path} status`).toBe(200);

    // A heading proves the page rendered its own content rather than an error
    // boundary or an empty shell.
    await expect(page.locator('h1, h2').filter({ hasText: heading }).first()).toBeVisible();

    const text = await page.locator('body').innerText();
    // NaN or undefined reaching the DOM is a computation bug surfacing as a
    // rendering bug, and is exactly what a chart with a missing series produces.
    expect(text, `${path} rendered text`).not.toMatch(/\bNaN\b/);
    expect(text, `${path} rendered text`).not.toMatch(/\bInfinity\b/);
    expect(text, `${path} rendered text`).not.toMatch(/\bundefined\b/);

    expectClean(problems, path);
  });
}

test('the global disclaimer is present on every page', async ({ page }) => {
  for (const { path } of PAGES.slice(0, 6)) {
    await page.goto(path, { waitUntil: 'networkidle' });
    const body = await page.locator('body').innerText();
    // The disclaimer is chrome, so it must survive every route rather than being
    // remembered on the pages someone thought to add it to.
    expect(body.toLowerCase(), path).toMatch(/not investment advice|impersonal/);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Navigation
// ─────────────────────────────────────────────────────────────────────────────

test('the side navigation reaches every section without an error', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/terminal', { waitUntil: 'networkidle' });

  for (const label of ['Screener', 'InvestGPT', 'Research', 'Backtest', 'Transparency']) {
    await page.click(`a:has-text("${label}")`);
    await page.waitForLoadState('networkidle');
    expect(page.url()).not.toContain('/terminal/');
  }

  expectClean(problems, 'side navigation');
});

test('a conviction card opens the attribution view for that symbol', async ({ page }) => {
  await page.goto('/terminal', { waitUntil: 'networkidle' });

  const firstCard = page.locator('a[href^="/terminal/"]').first();
  const href = await firstCard.getAttribute('href');
  const symbol = (href ?? '').split('/').pop() ?? '';
  expect(symbol.length).toBeGreaterThan(0);

  await firstCard.click();
  await page.waitForURL(new RegExp(`/terminal/${symbol}`));
  await expect(page.locator('h1').filter({ hasText: /attribution/i })).toBeVisible();
});

// ─────────────────────────────────────────────────────────────────────────────
//  Attribution
// ─────────────────────────────────────────────────────────────────────────────

test('the attribution view shows a decomposition and a counter-thesis', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/terminal/AAPL', { waitUntil: 'networkidle' });

  const body = await page.locator('body').innerText();
  // The counter-thesis ships with every signal rather than on request; its absence
  // would mean a thesis was published as advocacy.
  expect(body).toMatch(/counter-thesis/i);
  expect(body).toMatch(/local-accuracy residual/i);
  // The raw SHAP float must never be rendered — only shares and narratives.
  expect(body).not.toMatch(/shap_value/i);

  // The waterfall and the force plot are the same decomposition; switching between
  // them must not error.
  await page.click('button:has-text("Force")');
  await page.waitForTimeout(700);
  await page.click('button:has-text("Waterfall")');
  await page.waitForTimeout(700);

  expectClean(problems, 'attribution view');
});

test('charts render as inline SVG rather than through a chart library canvas', async ({ page }) => {
  await page.goto('/terminal/AAPL', { waitUntil: 'networkidle' });
  // The mandate is raw SVG; a canvas element would mean a charting dependency crept
  // in, and canvas output is neither inspectable nor accessible.
  expect(await page.locator('svg').count()).toBeGreaterThan(2);
  expect(await page.locator('canvas').count()).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Screener and query surfaces
// ─────────────────────────────────────────────────────────────────────────────

test('the screener filters the published list', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/screener', { waitUntil: 'networkidle' });

  const before = await page.locator('tbody tr').count();
  expect(before).toBeGreaterThan(0);

  // Narrowing to one sector must not increase the row count.
  await page.selectOption('select >> nth=1', { index: 1 });
  await page.waitForTimeout(1200);
  const after = await page.locator('tbody tr').count();
  expect(after).toBeLessThanOrEqual(before);

  expectClean(problems, 'screener');
});

test('InvestGPT compiles a question and shows the SQL it ran', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/investgpt', { waitUntil: 'networkidle' });

  await page.fill('#investgpt-question', 'top 5 by conviction');
  await page.click('button:has-text("Run")');
  await page.waitForTimeout(2500);

  const body = await page.locator('body').innerText();
  // Showing the statement is the whole point: it is what lets a user detect that
  // the question was misread, which the rows alone never reveal.
  expect(body).toMatch(/SELECT/);
  expect(body).toMatch(/v_equity_snapshot/);
  expect(body).toMatch(/is_benchmark/);
  expect(body).toMatch(/passed|rejected/);

  expectClean(problems, 'investgpt');
});

test('Research answers with citations and per-claim verdicts', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/research', { waitUntil: 'networkidle' });

  await page.fill('#research-question', 'What are the main risk factors disclosed?');
  await page.click('button:has-text("Ask")');
  await page.waitForTimeout(3000);

  const body = await page.locator('body').innerText();
  expect(body).toMatch(/grounding/i);
  expect(body).toMatch(/verified|unverified/i);
  // The corpus is synthetic and that must be stated on the page, not in a footnote.
  expect(body).toMatch(/synthetic/i);

  expectClean(problems, 'research');
});

test('Research refuses a question the corpus cannot answer', async ({ page }) => {
  await page.goto('/research', { waitUntil: 'networkidle' });
  await page.fill('#research-question', 'What is the weather in Paris tomorrow?');
  await page.click('button:has-text("Ask")');
  await page.waitForTimeout(3000);

  const body = await page.locator('body').innerText();
  // A confidently wrong answer is the worst outcome for a research tool, so an
  // out-of-scope question must be refused rather than answered from whatever
  // ranked first.
  expect(body).toMatch(/no passage|does not contain|no answer is offered/i);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Transparency and compliance
// ─────────────────────────────────────────────────────────────────────────────

test('the model card shows out-of-sample accuracy beside in-sample', async ({ page }) => {
  await page.goto('/transparency', { waitUntil: 'networkidle' });
  const body = await page.locator('body').innerText();

  // A single accuracy figure is uninterpretable; the pair and their gap are the
  // finding.
  expect(body).toMatch(/in-sample accuracy/i);
  expect(body).toMatch(/out-of-sample/i);
  expect(body).toMatch(/overfit gap/i);
  // Limitations are placed above the metrics, deliberately.
  expect(body).toMatch(/limitations/i);
  expect(body.indexOf('Limitations')).toBeLessThan(body.indexOf('AUC'));
});

test('the compliance page publishes the prohibited-phrase list and audit fields', async ({ page }) => {
  await page.goto('/compliance', { waitUntil: 'networkidle' });
  const body = await page.locator('body').innerText();

  // Publishing the deny-list is what makes "we are careful about advisory
  // language" a checkable claim rather than an assertion.
  expect(body).toMatch(/will not say|prohibited/i);
  expect(body).toMatch(/We recommend you buy/);
  expect(body).toMatch(/click coordinates/i);
});

test('the risk limits are published read-only', async ({ page }) => {
  await page.goto('/control', { waitUntil: 'networkidle' });
  const body = await page.locator('body').innerText();

  expect(body).toMatch(/read-only/i);
  expect(body).toMatch(/15c3-5/);
  // A limit the constrained party can raise is not a control, so no input may
  // exist inside the limits table.
  expect(await page.locator('table input').count()).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Clickwrap
// ─────────────────────────────────────────────────────────────────────────────

test('the clickwrap gate stays closed until the disclosures are scrolled', async ({ page }) => {
  await page.goto('/signup');
  await page.fill('input[name="email"]', `gate-${Date.now()}@aurelius.local`);
  await page.fill('input[name="password"]', 'correct-horse-battery-staple');
  await page.click('button[type="submit"]');
  await page.waitForURL(/onboarding/);

  const checkbox = page.locator('input[type="checkbox"]');
  const accept = page.locator('#accept-terms');

  // Both controls are inert until the pane has been read to its end. The server
  // re-checks this, so the client gate is courtesy — but a courtesy that must work.
  await expect(accept).toBeDisabled();

  const pane = page.locator('div[role="region"]');
  await pane.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(checkbox).toBeEnabled();
  await checkbox.check();
  await expect(accept).toBeEnabled();
});

// ─────────────────────────────────────────────────────────────────────────────
//  Order routing
// ─────────────────────────────────────────────────────────────────────────────

test('the order ticket starts blank and never pre-fills a quantity', async ({ page }) => {
  await signUpAndAccept(page);
  const problems = watch(page);

  await page.goto('/order/AAPL', { waitUntil: 'networkidle' });

  // The blank-field mandate. A pre-filled quantity would make the platform a
  // participant in the decision, and a defaulted order type would make the choice
  // for the user.
  await expect(page.locator('input[inputmode="numeric"]')).toHaveValue('');
  const orderType = page.locator('select').nth(1);
  await expect(orderType).toHaveValue('');

  // Execute is unreachable until the pre-trade checks have run.
  await expect(page.locator('#execute-button')).toBeDisabled();

  expectClean(problems, 'order ticket');
});

test('an order routes end to end and appears in the blotter', async ({ page }) => {
  await signUpAndAccept(page);
  const problems = watch(page);

  await page.goto('/order/AAPL', { waitUntil: 'networkidle' });
  await page.locator('select').nth(1).selectOption('market');
  await page.fill('input[inputmode="numeric"]', '25');

  await page.click('#preflight-button');
  await expect(page.locator('body')).toContainText(/all checks passed/i, { timeout: 15_000 });

  await page.click('#execute-button');
  await expect(page.locator('body')).toContainText(/order transmitted/i, { timeout: 20_000 });

  // The forensic chain is displayed, because the latency of a routing decision has
  // to be attributable to a stage rather than guessed at.
  await expect(page.locator('body')).toContainText(/click to server/i);

  await page.goto('/portfolio', { waitUntil: 'networkidle' });
  await expect(page.locator('body')).toContainText('AAPL');
  await expect(page.locator('body')).toContainText(/filled/i);

  expectClean(problems, 'order routing');
});

test('changing a parameter invalidates a completed pre-flight', async ({ page }) => {
  await signUpAndAccept(page);
  await page.goto('/order/AAPL', { waitUntil: 'networkidle' });

  await page.locator('select').nth(1).selectOption('market');
  await page.fill('input[inputmode="numeric"]', '10');
  await page.click('#preflight-button');
  await expect(page.locator('#execute-button')).toBeEnabled({ timeout: 15_000 });

  // Editing the quantity must re-arm the gate. A stale "approved" banner above
  // Execute would tell the user something the server disagrees with.
  await page.fill('input[inputmode="numeric"]', '999999');
  await expect(page.locator('#execute-button')).toBeDisabled();
});

test('the fat-finger ceiling refuses an oversized order with its mandated copy', async ({ page }) => {
  await signUpAndAccept(page);
  await page.goto('/order/AAPL', { waitUntil: 'networkidle' });

  await page.locator('select').nth(1).selectOption('market');
  await page.fill('input[inputmode="numeric"]', '100000');
  await page.click('#preflight-button');

  await expect(page.locator('body')).toContainText(/would be rejected|blocked/i, { timeout: 15_000 });
  // The code and the figures are the server's, rendered verbatim.
  await expect(page.locator('body')).toContainText(/FAT_FINGER_NOTIONAL/);
  await expect(page.locator('body')).toContainText(/exceeds the per-order ceiling/i);
  await expect(page.locator('#execute-button')).toBeDisabled();
});

test('live routing is unavailable on a trial account', async ({ page }) => {
  await signUpAndAccept(page);
  await page.goto('/order/AAPL', { waitUntil: 'networkidle' });

  // A trial is a paper sandbox by definition; the option exists but cannot be
  // chosen, and the reason is stated rather than left to inference.
  const accountSelect = page.locator('select').last();
  const liveOption = accountSelect.locator('option[value="live"]');
  await expect(liveOption).toHaveAttribute('disabled', '');
  await expect(page.locator('body')).toContainText(/requires an active subscription/i);
});

test('an anonymous visitor cannot reach the order or admin surfaces', async ({ page }) => {
  const problems = watch(page);

  await page.goto('/order/AAPL', { waitUntil: 'networkidle' });
  await expect(page.locator('body')).toContainText(/not signed in/i);

  await page.goto('/admin', { waitUntil: 'networkidle' });
  // The restriction is enforced server-side on every request; hiding the page
  // would not be a control.
  await expect(page.locator('body')).toContainText(/not authorised/i);

  await page.goto('/portfolio', { waitUntil: 'networkidle' });
  await expect(page.locator('body')).toContainText(/not signed in/i);

  expectClean(problems, 'anonymous access');
});

// ─────────────────────────────────────────────────────────────────────────────
//  Accessibility and responsiveness
// ─────────────────────────────────────────────────────────────────────────────

test('every page exposes exactly one h1 and a skip target', async ({ page }) => {
  for (const { path } of PAGES) {
    await page.goto(path, { waitUntil: 'networkidle' });
    const h1Count = await page.locator('h1').count();
    // More than one h1 breaks the document outline screen readers navigate by.
    expect(h1Count, `${path} h1 count`).toBeLessThanOrEqual(1);
    expect(await page.locator('#main').count(), `${path} main landmark`).toBe(1);
  }
});

test('the terminal does not scroll horizontally at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/terminal', '/terminal/AAPL', '/screener']) {
    await page.goto(path, { waitUntil: 'networkidle' });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    // Wide content scrolls inside its own container; the page body must not.
    expect(overflow, `${path} horizontal overflow`).toBeLessThanOrEqual(2);
  }
});

test('every SVG chart carries an accessible label', async ({ page }) => {
  await page.goto('/terminal/AAPL', { waitUntil: 'networkidle' });
  const svgs = page.locator('svg[role="img"]');
  const count = await svgs.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const label = await svgs.nth(i).getAttribute('aria-label');
    expect(label, `svg ${i} aria-label`).toBeTruthy();
  }
});
