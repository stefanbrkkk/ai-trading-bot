import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // node:sqlite is a Node built-in behind an experimental flag; keep it out of the bundler graph.
  serverExternalPackages: ['node-sql-parser'],
  experimental: {
    // Deterministic server-render of the terminal shell.
    optimizePackageImports: ['framer-motion'],
  },
  eslint: {
    dirs: ['src', 'scripts', 'e2e'],
  },
  async headers() {
    return [
      {
        source: '/fonts/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
