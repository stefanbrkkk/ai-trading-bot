import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { handler, ok, parseBody } from '@/lib/api/respond';

const endpoint = 'https://terminal.example/api/watchlists';
const jsonHeaders = { 'content-type': 'application/json' };

describe('mutation request origin protection', () => {
  it.each(['POST', 'PATCH', 'DELETE', 'PUT'])(
    'rejects a foreign-origin %s before running a mutation',
    async (method) => {
      let mutations = 0;
      const run = handler(async (_request: Request) => {
        mutations += 1;
        return ok({ updated: true });
      });
      const response = await run(new Request(endpoint, {
        method,
        headers: { origin: 'https://untrusted.example', 'sec-fetch-site': 'same-site' },
      }));
      expect(response.status).toBe(403);
      expect(mutations).toBe(0);
    },
  );

  it.each(['null', 'invalid-origin', 'https://terminal.example.attacker.example', 'http://terminal.example'])(
    'rejects invalid or nonmatching browser origins (%s)',
    async (origin) => {
      const run = handler(async (_request: Request) => ok({ updated: true }));
      const response = await run(new Request(endpoint, { method: 'POST', headers: { origin } }));
      expect(response.status).toBe(403);
    },
  );

  it('rejects cross-site browser requests even when Origin is absent', async () => {
    const run = handler(async (_request: Request) => ok({ updated: true }));
    const response = await run(new Request(endpoint, {
      method: 'POST', headers: { 'sec-fetch-site': 'cross-site' },
    }));
    expect(response.status).toBe(403);
  });

  it.each([
    { origin: 'https://terminal.example', 'sec-fetch-site': 'same-origin' },
    {},
  ])('keeps same-origin browsers and non-browser clients working', async (headers) => {
    const run = handler(async (_request: Request) => ok({ updated: true }));
    const response = await run(new Request(endpoint, { method: 'POST', headers: headers as HeadersInit }));
    expect(response.status).toBe(200);
  });

  it('keeps public cross-origin read requests working', async () => {
    const run = handler(async (_request: Request) => ok({ published: true }));
    const response = await run(new Request(endpoint, {
      headers: { origin: 'https://untrusted.example', 'sec-fetch-site': 'cross-site' },
    }));
    expect(response.status).toBe(200);
  });
});

describe('bounded JSON request parsing', () => {
  const schema = z.object({ text: z.string() });

  it('rejects JSON carried by a simple cross-origin form content type', async () => {
    const request = new Request(endpoint, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"text":"change"}',
    });
    await expect(parseBody(request, schema)).rejects.toMatchObject({ status: 415 });
  });

  it('accepts JSON content types with charset parameters', async () => {
    const request = new Request(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
      body: '{"text":"change"}',
    });
    await expect(parseBody(request, schema)).resolves.toEqual({ text: 'change' });
  });

  it('rejects an oversized declared body before reading its stream', async () => {
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { reads += 1; controller.enqueue(new TextEncoder().encode('{"text":"small"}')); controller.close(); },
    }, { highWaterMark: 0 });
    const request = new Request(endpoint, {
      method: 'POST', headers: { ...jsonHeaders, 'content-length': '65537' },
      body, duplex: 'half',
    } as RequestInit);
    await expect(parseBody(request, schema)).rejects.toMatchObject({ status: 413 });
    expect(reads).toBe(0);
  });

  it.each([undefined, '10'])('bounds streamed bytes with a missing or false length (%s)', async (length) => {
    const encoded = new TextEncoder().encode(JSON.stringify({ text: 'x'.repeat(70000) }));
    let cancelled = false;
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoded.slice(offset, offset + 4096));
        offset += 4096;
        if (offset >= encoded.length) controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const request = new Request(endpoint, {
      method: 'POST', headers: { ...jsonHeaders, ...(length === undefined ? {} : { 'content-length': length }) },
      body, duplex: 'half',
    } as RequestInit);
    await expect(parseBody(request, schema)).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toBe(true);
  });

  it('preserves UTF-8 characters split across stream chunks', async () => {
    const encoded = new TextEncoder().encode('{"text":"€"}');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const request = new Request(endpoint, { method: 'POST', headers: jsonHeaders, body, duplex: 'half' } as RequestInit);
    await expect(parseBody(request, schema)).resolves.toEqual({ text: '€' });
  });

  it('continues to report malformed JSON as a client error', async () => {
    const request = new Request(endpoint, { method: 'POST', headers: jsonHeaders, body: '{' });
    await expect(parseBody(request, schema)).rejects.toMatchObject({ status: 400 });
  });
});
