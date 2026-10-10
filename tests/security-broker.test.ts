import { describe, expect, it } from 'vitest';
import { AlpacaBroker } from '@/lib/broker/alpaca';
import type { BrokerOrderRequest } from '@/lib/broker/types';

const ctx = { userId: 'unit-user', correlationId: 'unit-correlation' };
const request: BrokerOrderRequest = {
  clientOrderId: 'unit-order', symbol: 'AAPL', quantity: 1,
  side: 'buy', type: 'market', timeInForce: 'day', account: 'paper',
  limitPrice: null, stopPrice: null,
};

describe('Alpaca account mode stays bound to its configured endpoint', () => {
  it.each([
    { endpoint: 'https://api.alpaca.markets', account: 'paper' as const },
    { endpoint: 'https://api.alpaca.markets/paper-api/..', account: 'paper' as const },
    { endpoint: 'https://api.alpaca.markets?paper-api', account: 'paper' as const },
    { endpoint: 'https://paper-api.alpaca.markets', account: 'live' as const },
  ])('rejects every mismatched submit and read before contacting $endpoint', async ({ endpoint, account }) => {
    let calls = 0;
    const broker = new AlpacaBroker({
      credentials: { keyId: 'unit-placeholder', secretKey: 'unit-placeholder', baseUrl: endpoint },
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ id: 'unit-ack', cash: '1000', equity: '1000' });
      },
    });
    for (const result of [
      await broker.submitOrder({ ...request, account }, ctx),
      await broker.getAccount(account, ctx),
      await broker.getPositions(account, ctx),
    ]) {
      expect(result.ok).toBe(false);
      expect(result.status).toBe(403);
      expect(result.data).toBeNull();
    }
    expect(calls).toBe(0);
  });

  it.each([
    { endpoint: 'https://api.alpaca.markets', account: 'live' as const },
    { endpoint: 'https://paper-api.alpaca.markets', account: 'paper' as const },
  ])('keeps matched orders working for $endpoint', async ({ endpoint, account }) => {
    let calls = 0;
    const broker = new AlpacaBroker({
      credentials: { keyId: 'unit-placeholder', secretKey: 'unit-placeholder', baseUrl: endpoint },
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ id: 'unit-ack', status: 'accepted' });
      },
    });
    expect((await broker.submitOrder({ ...request, account }, ctx)).ok).toBe(true);
    expect(calls).toBe(1);
  });
});
