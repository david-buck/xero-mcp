import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, resultData } from './helpers/mcp.js';
import { createXeroClient } from '../src/xero.js';
import { invoiceRevision } from '../src/invoice-edits.js';
const id = '11111111-1111-4111-8111-111111111111';
const contactId = '22222222-2222-4222-8222-222222222222';
const input = { contactId, title: 'Website', summary: 'Scope', terms: 'Payment terms', quoteDate: '2026-10-15', expiryDate: '2026-11-15', currencyCode: 'NZD', lineAmountTypes: 'Inclusive', lineItems: [{ description: 'Design', quantity: 2, unitAmount: 100.1234, accountCode: '200', taxType: 'OUTPUT2' }, { description: 'Scope detail' }] };
const quote = { QuoteID: id, Status: 'DRAFT', DateString: input.quoteDate, ExpiryDateString: input.expiryDate, CurrencyCode: 'NZD', LineItems: [{ Description: 'Existing', DiscountRate: 10 }], Title: 'Before' };
for (const [basis, api] of [['Inclusive', 'INCLUSIVE'], ['Exclusive', 'EXCLUSIVE'], ['NoTax', 'NOTAX']]) {
  test(`create mapping with explicit ${basis}`, async (t) => {
    const { call, calls } = await createHarness(t, () => ({ Quotes: [quote] }));
    const result = await call('xero_create_draft_quote', { ...input, lineAmountTypes: basis });
    assert.notEqual(result.isError, true);
    assert.deepEqual(calls, [['POST', '/Quotes', { body: { Quotes: [{ Status: 'DRAFT', Title: 'Website', Summary: 'Scope', Terms: 'Payment terms', Date: input.quoteDate, ExpiryDate: input.expiryDate, CurrencyCode: 'NZD', Contact: { ContactID: contactId }, LineAmountTypes: api, LineItems: [{ Description: 'Design', Quantity: 2, UnitAmount: 100.1234, AccountCode: '200', TaxType: 'OUTPUT2' }, { Description: 'Scope detail' }] }] } }]]);
  });
}
for (const mutation of [{ currencyCode: undefined }, { lineAmountTypes: undefined }, { quoteDate: '2026-02-30' }, { expiryDate: '2026-01-01' }, { status: 'SENT' }, { lineItems: [{ ...input.lineItems[0], taxType: undefined }] }, { lineItems: [{ ...input.lineItems[0], unitAmount: 1.00001 }] }, { lineItems: [{ ...input.lineItems[0], quantity: 0 }] }, { lineItems: [{ description: 'x', unitAmount: 1 }] }]) {
  test(`reject invalid input ${JSON.stringify(mutation)}`, async (t) => {
    const { call, calls } = await createHarness(t);
    assert.equal((await call('xero_create_draft_quote', { ...input, ...mutation })).isError, true);
    assert.equal(calls.length, 0);
  });
}
test('list filters use quote-specific singular parameters and paging; read returns revision', async (t) => {
  const { call, calls } = await createHarness(t, () => ({ Quotes: [quote] }));
  const list = resultData(await call('xero_list_quotes', { contactId, status: 'DRAFT', page: 2 }));
  assert.equal(list[0].revision, invoiceRevision(quote));
  assert.deepEqual(calls[0], ['GET', '/Quotes', { query: { page: 2, ContactID: contactId, Status: 'DRAFT', order: 'Date DESC' } }]);
  assert.equal(resultData(await call('xero_get_quote', { quoteId: id })).QuoteID, id);
});
test('narrow edit preserves omitted fields by omission and checks revision', async (t) => {
  const { call, calls } = await createHarness(t, () => ({ Quotes: [quote] }));
  assert.notEqual((await call('xero_update_draft_quote', { quoteId: id, expectedRevision: invoiceRevision(quote), title: 'After' })).isError, true);
  assert.deepEqual(calls[1], ['POST', `/Quotes/${id}`, { body: { Quotes: [{ QuoteID: id, Status: 'DRAFT', Title: 'After' }] } }]);
});
for (const value of [{ ...quote, Status: 'SENT' }, { ...quote, Title: 'Concurrent edit' }]) {
  test('non-draft or stale edit never writes', async (t) => {
    const { call, calls } = await createHarness(t, () => ({ Quotes: [value] }));
    assert.equal((await call('xero_update_draft_quote', { quoteId: id, expectedRevision: invoiceRevision(quote), title: 'After' })).isError, true);
    assert.equal(calls.length, 1); assert.equal(calls[0][0], 'GET');
  });
}
test('empty edit and currency change without rate cannot write', async (t) => {
  const { call, calls } = await createHarness(t, () => ({ Quotes: [quote] }));
  for (const change of [{}, { currencyCode: 'USD' }]) assert.equal((await call('xero_update_draft_quote', { quoteId: id, expectedRevision: invoiceRevision(quote), ...change })).isError, true);
  assert.equal(calls.filter(([method]) => method === 'POST').length, 0);
});
test('Xero validation and upstream errors are retained', async (t) => {
  const { call } = await createHarness(t, (_method, path) => {
    if (path === '/Quotes') return { Quotes: [{ ...quote, ValidationErrors: [{ Message: 'Invalid tax code' }] }] };
    throw new Error('Xero API GET failed (403 Forbidden): insufficient_scope');
  });
  const rejected = await call('xero_create_draft_quote', input);
  assert.equal(rejected.isError, true); assert.match(rejected.content[0].text, /Invalid tax code/);
  assert.match((await call('xero_get_quote', { quoteId: id })).content[0].text, /403 Forbidden.*insufficient_scope/);
});
test('read-only quote configuration does not register quote writes or sending tools', async (t) => {
  const { client } = await createHarness(t, undefined, { enableQuoteWrites: false });
  const { tools } = await client.listTools();
  assert.equal(tools.some(({ name }) => /draft_quote|send|accept/.test(name)), false);
});
const pdf = Buffer.from([37,80,68,70,45,49,46,55,10,0,128,255,10]);
for (const kind of ['quote', 'invoice']) {
  test(`${kind} PDF is binary resource and can be read via MCP`, async (t) => {
    const { call, calls, client } = await createHarness(t, () => pdf);
    const result = await call(`xero_get_${kind}_pdf`, { [`${kind}Id`]: id });
    assert.notEqual(result.isError, true);
    assert.equal(result.content[0].type, 'resource');
    assert.equal(result.content[0].resource.mimeType, 'application/pdf');
    assert.deepEqual(Buffer.from(result.content[0].resource.blob, 'base64'), pdf);
    assert.equal(calls[0][1], `/${kind === 'quote' ? 'Quotes' : 'Invoices'}/${id}`);
    assert.deepEqual(calls[0][2], { responseType: 'pdf' });
    assert.deepEqual(Buffer.from((await client.readResource({ uri: result.content[0].resource.uri })).contents[0].blob, 'base64'), pdf);
  });
}
function api(fetch) { return createXeroClient({ fetch, loadTokens: async () => ({ access_token: 'synthetic', tenantId: id, expires_at: Date.now() + 300000 }) }); }
test('HTTP PDF bytes bypass text decoding and preserve auth headers', async () => {
  const client = api(async (_url, options) => {
    assert.equal(options.headers.Accept, 'application/pdf'); assert.equal(options.headers['xero-tenant-id'], id);
    return new Response(pdf, { headers: { 'Content-Type': 'application/pdf; charset=binary' } });
  });
  assert.deepEqual(await client.xeroRequest('GET', `/Quotes/${id}`, { responseType: 'pdf' }), pdf);
});
for (const response of [() => new Response('no', { headers: { 'content-type': 'application/pdf' } }), () => new Response('{}', { headers: { 'content-type': 'application/json' } })]) {
  test('invalid successful PDF response is rejected', async () => { await assert.rejects(api(async () => response()).xeroRequest('GET', `/Quotes/${id}`, { responseType: 'pdf' }), /invalid PDF/); });
}
test('PDF HTTP error preserves status and Xero body', async () => {
  await assert.rejects(api(async () => new Response('{"Message":"No access"}', { status: 403, statusText: 'Forbidden' })).xeroRequest('GET', `/Invoices/${id}`, { responseType: 'pdf' }), /403 Forbidden.*No access/);
});

test('advertised quote schema requires financial decisions and excludes lifecycle controls', async (t) => {
  const { client } = await createHarness(t);
  const tools = (await client.listTools()).tools;
  const create = tools.find(({ name }) => name === 'xero_create_draft_quote').inputSchema;
  for (const key of ['currencyCode', 'lineAmountTypes', 'quoteDate', 'expiryDate', 'contactId', 'lineItems']) assert.ok(create.required.includes(key));
  assert.equal(create.additionalProperties, false);
  assert.equal(create.properties.status, undefined);
  assert.equal(create.properties.lineItems.items.anyOf[0].properties.unitAmount.maximum, undefined);
  assert.ok(create.properties.lineItems.items.anyOf[0].required.includes('taxType'));
  assert.equal(tools.some(({ name }) => /send|accept|api_request/.test(name)), false);
});
test('edit maps contact, scope, lines, tax, currency, dates and terms explicitly', async (t) => {
  const { call, calls } = await createHarness(t, () => ({ Quotes: [quote] }));
  const change = { ...input, currencyCode: 'USD', currencyRate: 0.6, reference: 'Funding' };
  assert.notEqual((await call('xero_update_draft_quote', { ...change, quoteId: id, expectedRevision: invoiceRevision(quote) })).isError, true);
  const sent = calls[1][2].body.Quotes[0];
  assert.equal(sent.Contact.ContactID, contactId); assert.equal(sent.Title, change.title);
  assert.equal(sent.Summary, change.summary); assert.equal(sent.Terms, change.terms);
  assert.equal(sent.Date, change.quoteDate); assert.equal(sent.ExpiryDate, change.expiryDate);
  assert.equal(sent.CurrencyCode, 'USD'); assert.equal(sent.CurrencyRate, 0.6);
  assert.equal(sent.LineAmountTypes, 'INCLUSIVE'); assert.equal(sent.LineItems[0].TaxType, 'OUTPUT2');
  assert.equal(sent.Status, 'DRAFT'); assert.equal(sent.Reference, 'Funding');
});
test('overlapping edits are refused and failed writes release lock', async (t) => {
  let unblock, entered;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  const reached = new Promise((resolve) => { entered = resolve; });
  let block = true;
  const { call, calls } = await createHarness(t, async (method) => {
    if (method === 'GET' && block) { entered(); await blocked; }
    if (method === 'POST') throw new Error('Synthetic write error');
    return { Quotes: [quote] };
  });
  const args = { quoteId: id, expectedRevision: invoiceRevision(quote), title: 'After' };
  const first = call('xero_update_draft_quote', args);
  await reached;
  assert.match((await call('xero_update_draft_quote', args)).content[0].text, /already in progress/);
  unblock(); await first; block = false;
  assert.match((await call('xero_update_draft_quote', args)).content[0].text, /Synthetic write error/);
  assert.equal(calls.filter(([method]) => method === 'POST').length, 2);
});
for (const tool of ['xero_get_quote', 'xero_create_draft_quote', 'xero_get_quote_pdf', 'xero_get_invoice_pdf']) {
  test(`${tool} refuses missing or malformed upstream result`, async (t) => {
    const { call } = await createHarness(t, () => ({}));
    assert.equal((await call(tool, tool === 'xero_create_draft_quote' ? input : tool === 'xero_get_invoice_pdf' ? { invoiceId: id } : { quoteId: id })).isError, true);
  });
}
