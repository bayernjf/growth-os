import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../src/storage/migrate.js';
import { SalesRepository } from '../src/sales/repository.js';
import { SalesService } from '../src/sales/sales-service.js';
import { createSalesApp } from '../src/api/sales-http.js';

const TOKEN = 'sales-test-token';
const NOW = '2026-11-01T00:00:00Z';

async function server() {
  const driver = new SqliteDriver(':memory:');
  await migrateUp(driver);
  const service = new SalesService({ repo: new SalesRepository(driver), now: () => NOW });
  const app = new Hono().route('/', createSalesApp({ service, apiToken: TOKEN }));
  return app;
}

let app: Awaited<ReturnType<typeof server>>;
beforeAll(async () => {
  app = await server();
});
afterAll(() => undefined);

const items = [{ description: 'Setup', qty: 1, unitAmountCents: 10_000, currency: 'CNY' }];

describe('sales http auth', () => {
  it('401 without and with a wrong token', async () => {
    const noAuth = await app.request('/api/v1/sales/quotes', { method: 'POST', body: '{}' });
    expect(noAuth.status).toBe(401);
    const bad = await app.request('/api/v1/sales/quotes', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ lineItems: items }),
    });
    expect(bad.status).toBe(401);
  });
});

describe('sales http happy path and validation', () => {
  const auth = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

  it('creates a quote, 400 on bad items, drives the full flow', async () => {
    const bad = await app.request('/api/v1/sales/quotes', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ lineItems: [] }),
    });
    expect(bad.status).toBe(400);

    const created = await app.request('/api/v1/sales/quotes', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ customerName: 'Acme', lineItems: items }),
    });
    expect(created.status).toBe(201);
    const quote = (await created.json()) as { id: string };

    const sent = await app.request(`/api/v1/sales/quotes/${quote.id}/send`, { method: 'POST', headers: auth });
    expect(sent.status).toBe(200);

    const illegal = await app.request(`/api/v1/sales/quotes/${quote.id}/send`, { method: 'POST', headers: auth });
    expect(illegal.status).toBe(409);

    const accepted = await app.request(`/api/v1/sales/quotes/${quote.id}/accept`, { method: 'POST', headers: auth });
    expect(accepted.status).toBe(200);

    const contract = await app.request('/api/v1/sales/contracts', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ quoteId: quote.id }),
    });
    expect(contract.status).toBe(201);
    const c = (await contract.json()) as { id: string };

    await app.request(`/api/v1/sales/contracts/${c.id}/send`, { method: 'POST', headers: auth });
    await app.request(`/api/v1/sales/contracts/${c.id}/sign`, { method: 'POST', headers: auth });

    const order = await app.request('/api/v1/sales/orders', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contractId: c.id }),
    });
    expect(order.status).toBe(201);
    const list = await app.request('/api/v1/sales/orders', { headers: auth });
    expect((await list.json()).length).toBe(1);
  });

  it('400 when creating a contract without quoteId', async () => {
    const res = await app.request('/api/v1/sales/contracts', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('sales http fulfillment and invoices', () => {
  const auth = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

  async function signedOrderId() {
    const created = await app.request('/api/v1/sales/quotes', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ customerName: 'Acme', lineItems: items }),
    });
    const quote = (await created.json()) as { id: string };
    await app.request(`/api/v1/sales/quotes/${quote.id}/send`, { method: 'POST', headers: auth });
    await app.request(`/api/v1/sales/quotes/${quote.id}/accept`, { method: 'POST', headers: auth });
    const contract = await app.request('/api/v1/sales/contracts', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ quoteId: quote.id }),
    });
    const c = (await contract.json()) as { id: string };
    await app.request(`/api/v1/sales/contracts/${c.id}/send`, { method: 'POST', headers: auth });
    await app.request(`/api/v1/sales/contracts/${c.id}/sign`, { method: 'POST', headers: auth });
    const order = await app.request('/api/v1/sales/orders', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contractId: c.id }),
    });
    expect(order.status).toBe(201);
    return (await order.json()).id as string;
  }

  it('rejects verify-before-delivery (409), then delivers and verifies with events', async () => {
    const orderId = await signedOrderId();
    const early = await app.request(`/api/v1/sales/orders/${orderId}/verify`, {
      method: 'POST',
      headers: auth,
    });
    expect(early.status).toBe(409);

    const delivered = await app.request(`/api/v1/sales/orders/${orderId}/deliver`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ note: 'shipped' }),
    });
    expect(delivered.status).toBe(200);
    expect((await delivered.json()).deliveryStatus).toBe('delivered');

    const verified = await app.request(`/api/v1/sales/orders/${orderId}/verify`, {
      method: 'POST',
      headers: auth,
    });
    expect(verified.status).toBe(200);
    expect((await verified.json()).deliveryStatus).toBe('verified');

    const events = await app.request(`/api/v1/sales/orders/${orderId}/events`, { headers: auth });
    expect((await events.json()).map((e: { toStatus: string }) => e.toStatus)).toEqual([
      'delivered',
      'verified',
    ]);
  });

  it('issues an invoice (201), links it on the order and is idempotent', async () => {
    const orderId = await signedOrderId();
    const first = await app.request(`/api/v1/sales/orders/${orderId}/invoice`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ externalRef: 'bill-1' }),
    });
    expect(first.status).toBe(201);
    const invoice = (await first.json()) as { id: string; amountCents: number; currency: string };
    expect(invoice.amountCents).toBe(10_000);
    expect(invoice.currency).toBe('CNY');

    const second = await app.request(`/api/v1/sales/orders/${orderId}/invoice`, {
      method: 'POST',
      headers: auth,
    });
    expect((await second.json()).id).toBe(invoice.id);

    const order = await app.request(`/api/v1/sales/orders/${orderId}`, { headers: auth });
    expect((await order.json()).invoiceRef).toBe(invoice.id);
  });
});
