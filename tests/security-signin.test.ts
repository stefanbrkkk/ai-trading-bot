import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, resetDb } from '@/lib/db';
import { POST } from '@/app/api/auth/signin/route';

// The route and durable limiter run normally; omit the expensive KDF and Next's
// request-local headers context when exercising hundreds of anonymous attempts.
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/auth/session')>(),
  requestContext: async () => ({ ipAddress: 'unattributed', userAgent: 'unit-test' }),
  signIn: async () => ({ ok: false, error: 'Invalid test credentials.' }),
}));

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-10T10:00:00Z'));
  vi.stubEnv('AURELIUS_DATA_DIR', ':memory:');
  resetDb();
});

afterEach(() => { vi.restoreAllMocks(); });

afterAll(() => { closeDb(); vi.unstubAllEnvs(); });

function attempt(email: string): Promise<Response> {
  return POST(new Request('https://terminal.example/api/auth/signin', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'fake-unit-input' }),
  }));
}

describe('sign-in throttling without a trusted client address', () => {
  it('bounds attempts even when each request names a different account', async () => {
    for (let index = 0; index < 200; index += 1) {
      expect((await attempt(`unknown-${index}@example.test`)).status).toBe(401);
    }
    expect((await attempt('another-unknown@example.test')).status).toBe(429);
  });

  it('keeps the tighter per-account limit in addition to the fallback budget', async () => {
    for (let index = 0; index < 10; index += 1) {
      expect((await attempt('same-account@example.test')).status).toBe(401);
    }
    expect((await attempt(' SAME-ACCOUNT@EXAMPLE.TEST ')).status).toBe(429);
    expect((await attempt('different-account@example.test')).status).toBe(401);
  });
});
