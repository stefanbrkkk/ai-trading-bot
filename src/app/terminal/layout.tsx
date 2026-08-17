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
  title: 'Signal terminal · Aurelius',
  description: 'The daily published ranking and its macro conviction anchors.',
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
