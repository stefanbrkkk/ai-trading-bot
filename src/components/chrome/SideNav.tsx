'use client';

/**
 * Primary navigation.
 *
 * Ordered by workflow rather than by importance: publication → screen → analyse →
 * route → review. No badges, no counters, no "new" markers — digital engagement
 * practices are prohibited, and a numeric badge on a nav item is a behavioural
 * prompt.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from '@/components/ui/primitives';

interface NavItem {
  href: string;
  label: string;
  hint: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  {
    label: 'Publication',
    items: [
      { href: '/terminal', label: 'Terminal', hint: 'The daily published list and the macro conviction anchors' },
      { href: '/screener', label: 'Screener', hint: 'The full universe with every model feature' },
    ],
  },
  {
    label: 'Analysis',
    items: [
      { href: '/investgpt', label: 'InvestGPT', hint: 'Natural-language queries compiled to validated SQL' },
      { href: '/research', label: 'Research', hint: 'Filing-grounded answers with authority-weighted citations' },
      { href: '/backtest', label: 'Backtest', hint: 'Walk-forward simulation and the survival scorecard' },
      { href: '/transparency', label: 'Transparency', hint: 'Model card, feature registry and attribution method' },
    ],
  },
  {
    label: 'Execution',
    items: [
      { href: '/portfolio', label: 'Portfolio', hint: 'Positions, orders and account state' },
      { href: '/control', label: 'Control centre', hint: 'Risk limits, data feeds and session preferences' },
    ],
  },
  {
    label: 'Governance',
    items: [
      { href: '/compliance', label: 'Compliance', hint: 'Disclosures, terms and the audit trail' },
      { href: '/admin', label: 'Admin', hint: 'Kill switch, risk decisions and forensic telemetry' },
    ],
  },
];

export function SideNav() {
  const pathname = usePathname() ?? '';

  return (
    <nav
      aria-label="Primary"
      className="shrink-0 border-b border-obsidian-edge bg-vanta-deep xl:w-[196px] xl:border-b-0 xl:border-r"
    >
      {/*
        Below `lg` this is a horizontal strip that shows about four of the ten
        destinations. `data-scroll-x` opts it into the edge fade so the rest are
        discoverable; the fade is measured, so it disappears above `lg` where the
        nav is a static column.
      */}
      <div
        data-scroll-x
        className="flex gap-6 overflow-x-auto px-4 py-3 xl:flex-col xl:gap-5 xl:overflow-visible xl:px-4 xl:py-6"
      >
        {GROUPS.map((group) => (
          <div key={group.label} className="shrink-0">
            <p className="eyebrow mb-2 hidden xl:block">{group.label}</p>
            <ul className="flex gap-1 xl:flex-col">
              {group.items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      title={item.hint}
                      aria-current={active ? 'page' : undefined}
                      className={cx(
                        'block whitespace-nowrap border-l-2 px-2.5 py-1.5 font-mono text-[0.6875rem] uppercase tracking-institutional transition-colors',
                        active
                          ? 'border-l-gold bg-gold/[0.06] text-gold'
                          : 'border-l-transparent text-parchment-faint hover:border-l-obsidian-edge hover:text-parchment-dim',
                      )}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
