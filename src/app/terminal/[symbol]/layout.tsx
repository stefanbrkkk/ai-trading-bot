/**
 * Route metadata. The page is a client component, so the title is declared here —
 * and built from the symbol, because sixteen identically-titled tabs is what this
 * replaces.
 */

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ symbol: string }>;
}): Promise<Metadata> {
  const { symbol } = await params;
  return {
    title: `${symbol.toUpperCase()} · Attribution · Aurelius`,
    description: 'Exact per-feature attribution for one symbol.',
  };
}

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
