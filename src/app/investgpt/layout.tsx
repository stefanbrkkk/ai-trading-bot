/**
 * Route metadata.
 *
 * The page itself is a client component, so its title cannot be declared there.
 * Every route shipped the same `<title>` — "Aurelius — Quantitative Signal
 * Terminal" — which makes sixteen open tabs indistinguishable and gives a screen
 * reader the same page announcement on every navigation.
 */

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'InvestGPT · Aurelius',
  description: 'Natural-language questions compiled to validated, inspectable SQL.',
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
