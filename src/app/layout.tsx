import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { TerminalProvider } from '@/components/TerminalProvider';
import { TopBar } from '@/components/chrome/TopBar';
import { SideNav } from '@/components/chrome/SideNav';
import { StatusStrip } from '@/components/chrome/StatusStrip';
import { GlobalDisclaimer } from '@/components/chrome/GlobalDisclaimer';
import { ScrollAffordance } from '@/components/chrome/ScrollAffordance';

export const metadata: Metadata = {
  title: 'Aurelius — Quantitative Signal Terminal',
  description:
    'A continuous-time, multi-timeframe quantitative signal terminal. Impersonal mathematical computation only; not investment advice.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#0A0A0A',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/*
          Skip link. Every page put eleven navigation stops before its first piece
          of content, so a keyboard or screen-reader user traversed the whole nav
          on each of the sixteen routes. Visually hidden until focused.
        */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:border focus:border-gold focus:bg-vanta-deep focus:px-4 focus:py-2 focus:font-mono focus:text-2xs focus:uppercase focus:tracking-institutional focus:text-gold"
        >
          Skip to content
        </a>
        {/*
          The store is created inside this client provider, once per mount. It is
          never a module-scope singleton: on a Node server a global store is
          shared across concurrent requests and one user's positions would leak
          into another's session.
        */}
        <TerminalProvider>
          <div className="flex min-h-screen flex-col bg-vanta">
            <TopBar />
            <div className="flex flex-1 flex-col xl:flex-row">
              <SideNav />
              <main id="main" className="min-w-0 flex-1 pb-16">
                {children}
              </main>
            </div>
            <GlobalDisclaimer />
            <StatusStrip />
            {/* Renders nothing; measures every scrolling region on the page. */}
            <ScrollAffordance />
          </div>
        </TerminalProvider>
      </body>
    </html>
  );
}
