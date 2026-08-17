import Link from 'next/link';

/**
 * The persistent disclaimer.
 *
 * Present on every page, not buried in a footer link. The compliance research is
 * explicit that browsewrap — terms merely hyperlinked at the bottom of a page —
 * is "legally useless", so the substantive statement is rendered inline and the
 * link only leads to the full text.
 *
 * The wording is drawn from the mandated No Fiduciary Duty / Publisher Status
 * block and carries no marketing language.
 */
export function GlobalDisclaimer() {
  return (
    <aside
      aria-label="Regulatory disclaimer"
      className="border-t border-obsidian-edge bg-vanta-deep px-4 py-4 lg:px-6"
    >
      <p className="max-w-5xl text-[0.6875rem] leading-relaxed text-parchment-faint">
        <span className="font-mono uppercase tracking-institutional text-parchment-dim">Not investment advice.</span>{' '}
        Aurelius is a data-processing software utility. It is <strong className="text-parchment-dim">not</strong> a
        Registered Investment Adviser, broker-dealer, or fiduciary, and it provides no personalised investment advice,
        financial planning, or tax advice. Every output — including the daily published list — is an impersonal
        mathematical computation over historical data, distributed identically to all subscribers, and does not account
        for your financial situation, risk tolerance, or objectives. The platform never executes on your behalf: every
        order is entered and submitted by you. Securities trading involves substantial risk of loss, and the value of any
        security can go to zero.{' '}
        <Link href="/compliance" className="text-gold underline decoration-gold/40 underline-offset-2 hover:decoration-gold">
          Full disclosures and terms
        </Link>
        .
      </p>
    </aside>
  );
}
