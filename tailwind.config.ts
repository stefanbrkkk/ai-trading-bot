import type { Config } from 'tailwindcss';

/**
 * Project Aurelius design tokens.
 *
 * Palette is mandated verbatim by MASTER_AURELIUS_SPECIFICATION §4.1 / Phase 4 §2:
 *   Vanta Black #0A0A0A backgrounds, Obsidian #1C1C1C cards, Metallic Gold #D4AF37
 *   conviction, Oxidized Copper/Sage #5F7161 positive drivers, Muted Burgundy #8C3A3A
 *   negative drivers. Neon red/green is banned.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        vanta: {
          DEFAULT: '#0A0A0A',
          deep: '#050505',
          raised: '#0F0F10',
        },
        obsidian: {
          DEFAULT: '#1C1C1C',
          light: '#232324',
          lighter: '#2B2B2C',
          edge: '#343435',
        },
        gold: {
          DEFAULT: '#D4AF37',
          bright: '#E8C860',
          dim: '#8E7526',
          wash: 'rgba(212, 175, 55, 0.08)',
        },
        sage: {
          DEFAULT: '#5F7161',
          bright: '#83A086',
          dim: '#3D4A3F',
          wash: 'rgba(95, 113, 97, 0.12)',
        },
        burgundy: {
          DEFAULT: '#8C3A3A',
          bright: '#B25A5A',
          dim: '#5A2525',
          wash: 'rgba(140, 58, 58, 0.12)',
        },
        parchment: {
          DEFAULT: '#EDE8DC',
          dim: '#B8B2A5',
          faint: '#7A766D',
          ghost: '#4A4842',
        },
        slate: {
          ink: '#141415',
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        display: ['"Playfair Display"', 'Georgia', 'Cambria', 'serif'],
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem', letterSpacing: '0.08em' }],
        xs: ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.04em' }],
      },
      boxShadow: {
        // "wide, deeply blurred shadow spreads to imply physical depth" — Phase 4 §2
        plinth: '0 24px 64px -24px rgba(0, 0, 0, 0.9), 0 2px 8px -4px rgba(0, 0, 0, 0.7)',
        inset: 'inset 0 1px 0 0 rgba(255, 255, 255, 0.035)',
        gilt: '0 0 0 1px rgba(212, 175, 55, 0.28), 0 16px 48px -16px rgba(212, 175, 55, 0.16)',
      },
      letterSpacing: {
        institutional: '0.14em',
      },
      transitionTimingFunction: {
        vault: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        'tick-flash-up': {
          '0%': { backgroundColor: 'rgba(95, 113, 97, 0.28)' },
          '100%': { backgroundColor: 'transparent' },
        },
        'tick-flash-down': {
          '0%': { backgroundColor: 'rgba(140, 58, 58, 0.28)' },
          '100%': { backgroundColor: 'transparent' },
        },
        'sheen-sweep': {
          '0%': { transform: 'translateX(-120%)' },
          '100%': { transform: 'translateX(220%)' },
        },
        'pulse-faint': {
          '0%, 100%': { opacity: '0.35' },
          '50%': { opacity: '1' },
        },
      },
      animation: {
        'tick-up': 'tick-flash-up 520ms ease-out',
        'tick-down': 'tick-flash-down 520ms ease-out',
        sheen: 'sheen-sweep 2.4s cubic-bezier(0.16, 1, 0.3, 1) infinite',
        'pulse-faint': 'pulse-faint 2.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
