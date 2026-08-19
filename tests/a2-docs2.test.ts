/**
 * Two documentation claims, pinned to the code that has to make them true.
 *
 * Both sentences audited here were wrong in the same way: they described a
 * guarantee the platform genuinely delivers, and then named the wrong surface or
 * the wrong scope for it. That failure mode is worse than a vague sentence,
 * because a precise claim is one a reader acts on — the operator whose key is
 * misconfigured navigates to the page the README names, sees nothing about
 * providers, and concludes live inference is working.
 *
 * So neither test asserts a string against a string. Each reads the shipped
 * document and the source of the thing the document points at, and asserts they
 * still agree:
 *
 *   - Provider degradation is reported on `/control`, so the assertion is that
 *     `aiReason` is rendered in the control page and absent from the transparency
 *     page. Move the panel and this fails, which is the point: the next engineer
 *     to relocate it is told, here, which two documents move with it.
 *   - The order ticket starts three of its five controls at a conventional
 *     default, so the assertion is that the `useState` initialisers still divide
 *     the way the README's compliance table now says they do. Blank a default, or
 *     add one, and the row is named as the sentence that has to change.
 *
 * The environment is `node`; nothing here renders, trains or touches `.data/`.
 * Every file is read as text, including the `.tsx` sources — parsing the
 * initialisers is what makes the claim checkable without a DOM.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function path(relative: string): string {
  return fileURLToPath(new URL(`../${relative}`, import.meta.url));
}

function read(relative: string): string {
  return readFileSync(path(relative), 'utf8');
}

const README = read('README.md');
const ENV_EXAMPLE = read('.env.example');
const BUILD_CONTRACT = read('docs/BUILD_CONTRACT.md');
const CONTROL_PAGE = read('src/app/control/page.tsx');
const TRANSPARENCY_PAGE = read('src/app/transparency/page.tsx');
const ORDER_PAGE = read('src/app/order/[symbol]/page.tsx');

/*
 * Both documents hard-wrap their prose — the README at about 86 columns, the
 * env template at about 80 — so a sentence that survives a rewrap is the same
 * sentence. Prose claims are matched against the collapsed text.
 */
const README_PROSE = README.replace(/\s+/g, ' ');
const ENV_PROSE = ENV_EXAMPLE.replace(/^\s*#\s?/gm, '').replace(/\s+/g, ' ');

describe('provider degradation is documented on the page that reports it', () => {
  it('renders the reason on /control and nowhere on /transparency', () => {
    /*
     * `aiReason` is the sentence the resolver writes when a named provider has no
     * credential — "AURELIUS_LLM_PROVIDER names \"anthropic\" but no credential is
     * present…". It has exactly one render site. The README and .env.example both
     * named the transparency page, which has no provider surface of any kind: its
     * only data sources are the model card and the feature registry, so no
     * provider text can arrive through the page's props either.
     */
    expect(CONTROL_PAGE).toContain('data.aiReason');
    expect(CONTROL_PAGE).toContain('eyebrow="Provider status"');
    expect(CONTROL_PAGE).toContain('title="What is actually serving"');

    expect(TRANSPARENCY_PAGE).not.toMatch(/aiReason|aiProvider/);
    // Not merely absent from the markup — absent from the data the page fetches.
    const transparencySources = [...TRANSPARENCY_PAGE.matchAll(/useApi<[^>]+>\('([^']+)'\)/g)].map(
      (m) => m[1],
    );
    expect(transparencySources.sort()).toEqual(['/features', '/model-card']);
  });

  it('sends the operator to the control centre, not to transparency', () => {
    /*
     * The wrong page name was in both documents, and .env.example repeated it at
     * the exact moment the operator is typing the key. Assert the correction in
     * both, and assert the old sentence cannot come back.
     */
    expect(README_PROSE).toContain(
      'degrades to the deterministic engine and says so on the control centre (`/control`)',
    );
    expect(README_PROSE).not.toContain('says so on the transparency page');

    expect(ENV_PROSE).toContain(
      'degrades to the deterministic engine and says so on /control',
    );
    expect(ENV_PROSE).not.toContain('says so on /transparency');
  });

  it('does not promote the top-bar chip into the surface that explains the downgrade', () => {
    /*
     * The chip is real and it is on every route, so the README credits it — but it
     * renders `aiProvider`, a bare "DETERMINISTIC", under a fixed tooltip that
     * never names the provider that was requested. It is a state indicator, not an
     * explanation, and the documentation has to keep those apart or it recreates
     * the original defect one level down.
     */
    const topBar = read('src/components/chrome/TopBar.tsx');
    expect(topBar).toContain('health.aiProvider');
    expect(topBar).not.toContain('aiReason');
    expect(README_PROSE).toContain('only that panel prints the reason in full');
  });
});

describe('the compliance table describes the order ticket that ships', () => {
  /**
   * The initial value of every `useState` in the order ticket, by variable name.
   * Read from the source rather than listed here, so a changed default is caught
   * instead of being re-asserted from memory.
   */
  const initialState = new Map(
    [...ORDER_PAGE.matchAll(/const \[(\w+), set\w+\] = useState(?:<[^>]*>)?\(([^)]*)\)/g)].map(
      (m) => [m[1], m[2].trim()] as const,
    ),
  );

  it('starts quantity, order type and the price fields blank', () => {
    /*
     * These are the position-sizing inputs, and the control the row is actually
     * about — no computed quantity, no pre-selected order type, no price put in
     * the field by the platform — is intact. `quantity` is a string rather than a
     * number precisely so that empty means empty.
     */
    for (const field of ['quantity', 'orderType', 'limitPrice', 'stopPrice']) {
      expect(initialState.get(field)).toBe("''");
    }
  });

  it('carries conventional defaults on side, time in force and account', () => {
    /*
     * Three of the five controls visible before an order type is chosen mount
     * pre-selected: Buy, Day, Paper sandbox. The README said "Every order field
     * starts blank and stays blank", inside the compliance table it uses to argue
     * its regulatory posture — the worst place to overstate a control, because a
     * reviewer who opens the ticket and sees Buy/Day/Paper has just caught the
     * documentation overstating one, which puts the three true rows beside it in
     * doubt. Nothing about these three is derived from the account or from a model
     * output, which is the property that actually matters, and that is what the
     * row claims now.
     */
    expect(initialState.get('side')).toBe("'buy'");
    expect(initialState.get('timeInForce')).toBe("'day'");
    expect(initialState.get('account')).toBe("'paper'");

    expect(README_PROSE).not.toContain('Every order field starts blank');
    expect(README_PROSE).toContain(
      'Quantity, order type and the price fields start blank and stay blank; side, time in force and account carry visible conventional defaults',
    );
  });

  it('agrees with the build contract and with the ticket’s own lede', () => {
    /*
     * Three surfaces describe these defaults and all three have to say the same
     * thing: the normative contract, the page the user reads, and the README. The
     * README was the only one that was wrong.
     */
    expect(BUILD_CONTRACT).toContain(
      'Order form defaults: quantity `null`, order type unselected, limit price empty.',
    );
    expect(ORDER_PAGE).toContain(
      'Side, time in force and account carry conventional defaults you can see and change; nothing about them is derived from your account or from a model output.',
    );
    expect(README_PROSE).toContain(
      'derived from nothing about you and nothing about a model output',
    );
  });

  it('still refuses to put the Kelly fraction on the ticket', () => {
    // The second half of the row, unchanged and still true: the published Kelly
    // fraction is an impersonal statistic and the order page never reads it.
    expect(ORDER_PAGE).not.toMatch(/kelly/i);
    expect(README_PROSE).toContain(
      'The published Kelly fraction is an impersonal model statistic and is not readable from the ticket.',
    );
  });
});
