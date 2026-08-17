import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { TerminalProvider } from '@/components/TerminalProvider';
import { TopBar } from '@/components/chrome/TopBar';
import { SideNav } from '@/components/chrome/SideNav';
import { StatusStrip } from '@/components/chrome/StatusStrip';
import { GlobalDisclaimer } from '@/components/chrome/GlobalDisclaimer';

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
          The store is created inside this client provider, once per mount. It is
          never a module-scope singleton: on a Node server a global store is
          shared across concurrent requests and one user's positions would leak
          into another's session.
        */}
        <TerminalProvider>
          <div className="flex min-h-screen flex-col bg-vanta">
            <TopBar />
            <div className="flex flex-1 flex-col lg:flex-row">
              <SideNav />
              <main id="main" className="min-w-0 flex-1 pb-16">
                {children}
              </main>
            </div>
            <GlobalDisclaimer />
            <StatusStrip />
          </div>
        </TerminalProvider>
      </body>
    </html>
  );
}
