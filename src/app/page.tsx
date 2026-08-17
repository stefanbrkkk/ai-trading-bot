/**
 * The entry page.
 *
 * Written against a constraint most landing pages do not have: nothing here may
 * read as a performance claim, a recommendation, or an inducement to trade. The
 * publisher's exemption depends on the service being impersonal analysis, and
 * marketing copy is where a platform most easily gives that away — "find winning
 * trades" is a promise about outcomes, and a promise about outcomes made to a
 * prospective subscriber is the thing regulators read first.
 *
 * So the page describes *mechanism*, not results. Every claim is about what the
 * system computes and how the computation can be inspected, which has the useful
 * side effect of being the honest pitch: the differentiator really is that every
 * number decomposes.
 */

import Link from 'next/link';
import { PageShell } from '@/components/PageState';
import { Badge, Button, Divider, Notice, Panel, PanelHeader } from '@/components/ui/primitives';
import { DISCLOSURE_BLOCKS } from '@/lib/compliance/disclosures';

const CAPABILITIES: { eyebrow: string; title: string; body: string }[] = [
  {
    eyebrow: 'Attribution',
    title: 'Every score decomposes exactly',
    body:
      'Conviction is produced by a gradient-boosted ensemble and decomposed by exact TreeSHAP. The contributions sum to the model output to floating-point precision, and the residual is displayed rather than hidden — so the explanation is verifiable arithmetic, not a plausible story about a black box.',
  },
  {
    eyebrow: 'Multi-timeframe',
    title: 'Three agents, and their disagreement',
    body:
      'An LSTM on the 5-minute tape, a bidirectional LSTM on the 15-minute, and a Temporal Fusion Transformer on the hourly. Each is trained and measured separately. When they disagree, the conflict-resolution router shows which one prevailed and why, instead of averaging the disagreement away.',
  },
  {
    eyebrow: 'Quantitative core',
    title: 'Named models, published parameters',
    body:
      'Ornstein–Uhlenbeck mean reversion by closed-form MLE. Kalman innovation bands in Joseph form with adaptive noise estimation. SABR volatility fitted per expiry. Multi-level order-flow imbalance filtered by principal component. Each with its fitted parameters and its goodness-of-fit on screen.',
  },
  {
    eyebrow: 'Counter-thesis',
    title: 'The refutation ships with the thesis',
    body:
      'Every signal is published alongside the conditions that would invalidate it, and the strategies that examined the symbol and declined to fire are listed with the gate that stopped them. A thesis presented without its refutation is advocacy.',
  },
  {
    eyebrow: 'Natural language',
    title: 'Questions compiled to inspectable SQL',
    body:
      'Ask for oversold mid-cap industrials with a negative risk reversal. The question is compiled deterministically to a SELECT statement, the statement is shown to you, and it is validated against a read-only allowlist before it executes. The same question always produces the same query.',
  },
  {
    eyebrow: 'Grounded research',
    title: 'Citations checked claim by claim',
    body:
      'Retrieval fuses lexical and semantic channels, re-ranks on source authority, and then verifies each sentence of the answer against the passage that supports it. Unverified claims are returned marked unverified rather than quietly removed.',
  },
];

const CONTROLS: { label: string; detail: string }[] = [
  { label: 'Notional ceiling', detail: 'Per-order fat-finger limit, enforced before transmission' },
  { label: 'ADV participation', detail: 'Rejects quantities above 5% of 30-day average volume' },
  { label: 'Click provenance', detail: 'Every order carries the coordinates and timestamp of a physical click' },
  { label: 'Single-use authorisation', detail: 'One click authorises exactly one order; replays are refused' },
  { label: 'Kill switch', detail: 'Halts all routing platform-wide, with the reason published' },
  { label: 'Append-only ledger', detail: 'Bitemporal, trigger-enforced; a record cannot be rewritten' },
];

export default function LandingPage() {
  return (
    <PageShell>
      <section className="py-10 sm:py-16">
        <Badge tone="gold">Impersonal quantitative analysis</Badge>
        <h1 className="display mt-5 max-w-3xl text-3xl leading-[1.15] text-parchment sm:text-[2.75rem]">
          A signal terminal where every number shows its derivation.
        </h1>
        <p className="mt-5 max-w-2xl text-[0.9375rem] leading-relaxed text-parchment-dim">
          Aurelius publishes one ranking a session, identical for every subscriber, and opens each score into the exact
          contribution of every input that produced it. It computes; it does not advise. Position sizing, order
          parameters and the decision to transact rest entirely with you.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/terminal">
            <Button variant="primary" size="lg">
              Open the terminal
            </Button>
          </Link>
          <Link href="/transparency">
            <Button size="lg">Read the model card</Button>
          </Link>
          <Link href="/signup">
            <Button variant="ghost" size="lg">
              Create an account
            </Button>
          </Link>
        </div>

        <Notice tone="legal" className="mt-10 max-w-3xl">
          Aurelius is a publisher of impersonal market analysis and is not an investment adviser, broker-dealer or
          fiduciary. Nothing it produces is a recommendation to buy or sell any security. Past performance and
          back-tested results do not indicate future results. All trading involves the risk of loss, including total
          loss of capital.
        </Notice>
      </section>

      <Divider className="my-4" />

      <section className="py-10">
        <p className="font-mono text-2xs uppercase tracking-institutional text-gold/80">What it does</p>
        <h2 className="display mt-1.5 text-xl text-parchment">Mechanism, not promises</h2>
        <div className="mt-7 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {CAPABILITIES.map((item) => (
            <Panel key={item.title} className="h-full">
              <PanelHeader eyebrow={item.eyebrow} title={item.title} />
              <p className="mt-3 text-[0.8125rem] leading-relaxed text-parchment-dim">{item.body}</p>
            </Panel>
          ))}
        </div>
      </section>

      <Divider className="my-4" />

      <section className="py-10">
        <p className="font-mono text-2xs uppercase tracking-institutional text-gold/80">Pre-trade controls</p>
        <h2 className="display mt-1.5 text-xl text-parchment">What stands between a click and a broker</h2>
        <p className="mt-3 max-w-2xl text-[0.8125rem] leading-relaxed text-parchment-dim">
          Order routing is reachable only from a physical click carrying a single-use authorisation. There is no
          scheduler, no completion hook and no autonomous path to a broker — the absence is structural, and the test
          suite asserts it.
        </p>
        <div className="mt-6 grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {CONTROLS.map((control) => (
            <div key={control.label} className="hairline pb-3">
              <p className="font-mono text-2xs uppercase tracking-institutional text-parchment">{control.label}</p>
              <p className="mt-1.5 text-[0.75rem] leading-snug text-parchment-faint">{control.detail}</p>
            </div>
          ))}
        </div>
      </section>

      <Divider className="my-4" />

      <section className="py-10 pb-4">
        <p className="font-mono text-2xs uppercase tracking-institutional text-gold/80">Required disclosures</p>
        <h2 className="display mt-1.5 text-xl text-parchment">Read before you use anything here</h2>
        <div className="mt-6 space-y-4">
          {DISCLOSURE_BLOCKS.map((block) => (
            <Panel key={block.id} flat>
              <p className="font-mono text-2xs uppercase tracking-institutional text-parchment-faint">{block.title}</p>
              <p className="mt-2 text-[0.8125rem] leading-relaxed text-parchment-dim">{block.body}</p>
            </Panel>
          ))}
        </div>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link href="/compliance">
            <Button>Full terms and disclosures</Button>
          </Link>
          <Link href="/onboarding">
            <Button variant="ghost">Review and accept</Button>
          </Link>
        </div>
      </section>
    </PageShell>
  );
}
