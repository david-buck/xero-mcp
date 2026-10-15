import { z } from 'zod';
import { invoiceRevision as revision } from './invoice-edits.js';

const text = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const errorResult = (error) => ({ isError: true, content: [{ type: 'text', text: error.message ?? String(error) }] });
const status = z.enum(['DRAFT', 'SENT', 'DECLINED', 'ACCEPTED', 'INVOICED', 'DELETED']);
const precision = (value) => {
  const [mantissa, exponent = '0'] = String(value).split('e');
  return (mantissa.split('.')[1] ?? '').length - Number(exponent) <= 4;
};
const line = z.union([
  z.object({ description: z.string().min(1).max(4000), quantity: z.number().finite().positive(), unitAmount: z.number().finite().nonnegative().refine(precision, 'At most four decimal places'), accountCode: z.string().min(1).max(20), taxType: z.string().min(1).max(50), discountRate: z.number().finite().min(0).max(100).optional() }).strict(),
  z.object({ description: z.string().min(1).max(4000) }).strict(),
]);
const fields = {
  contactId: z.string().uuid(), title: z.string().max(100), summary: z.string().max(3000),
  reference: z.string().max(4000), terms: z.string().max(4000), quoteDate: z.string().date(), expiryDate: z.string().date(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/), currencyRate: z.number().finite().positive(),
  lineAmountTypes: z.enum(['Exclusive', 'Inclusive', 'NoTax']), lineItems: z.array(line).min(1).max(100),
};
const mapping = { title: 'Title', summary: 'Summary', reference: 'Reference', terms: 'Terms', quoteDate: 'Date', expiryDate: 'ExpiryDate', currencyCode: 'CurrencyCode', currencyRate: 'CurrencyRate' };
function payload(input) {
  const result = { Status: 'DRAFT' };
  for (const [key, target] of Object.entries(mapping)) if (input[key] !== undefined) result[target] = input[key];
  if (input.contactId !== undefined) result.Contact = { ContactID: input.contactId };
  if (input.lineAmountTypes !== undefined) result.LineAmountTypes = { Exclusive: 'EXCLUSIVE', Inclusive: 'INCLUSIVE', NoTax: 'NOTAX' }[input.lineAmountTypes];
  if (input.lineItems !== undefined) result.LineItems = input.lineItems.map((item) => ({ Description: item.description, ...(item.quantity === undefined ? {} : { Quantity: item.quantity, UnitAmount: item.unitAmount, AccountCode: item.accountCode, TaxType: item.taxType, ...(item.discountRate === undefined ? {} : { DiscountRate: item.discountRate }) }) }));
  return result;
}
function quoteFrom(result, id, draft = false) {
  const quote = result?.Quotes?.[0];
  if (!quote || (id && quote.QuoteID !== id)) throw new Error('Xero did not return the requested quote.');
  if (quote.HasErrors || quote.ValidationErrors?.length) throw new Error(`Xero rejected quote: ${JSON.stringify(quote.ValidationErrors ?? [])}`);
  if (draft && quote.Status !== 'DRAFT') throw new Error(`Quote is ${quote.Status}; only DRAFT quotes can be edited. No further write was sent.`);
  return quote;
}
const full = (quote) => ({ ...quote, revision: revision(quote) });
function checkDates(input, before) {
  const date = input.quoteDate ?? before?.DateString?.slice(0, 10) ?? before?.Date?.slice(0, 10);
  const expiry = input.expiryDate ?? before?.ExpiryDateString?.slice(0, 10) ?? before?.ExpiryDate?.slice(0, 10);
  if (!date || !expiry || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw new Error('Read the quote dates in YYYY-MM-DD form before editing.');
  if (expiry < date) throw new Error('Expiry date must be on or after quote date.');
}

export function registerQuoteTools(server, xeroRequest, { enableQuoteWrites = true } = {}) {
  server.registerTool('xero_list_quotes', {
    title: 'List customer quotes', description: 'Read one page of up to 100 sales quotes, including lines. Increment page until fewer than 100 results; ContactID and Status filters combine.',
    inputSchema: z.object({ contactId: z.string().uuid().optional(), status: status.optional(), page: z.number().int().positive().default(1), dateFrom: z.string().date().optional(), dateTo: z.string().date().optional() }).strict(), annotations: { readOnlyHint: true },
  }, async ({ contactId, status, page, dateFrom, dateTo }) => {
    try {
      if (dateFrom && dateTo && dateFrom > dateTo) throw new Error('dateFrom must not exceed dateTo.');
      const result = await xeroRequest('GET', '/Quotes', { query: { page, ...(contactId ? { ContactID: contactId } : {}), ...(status ? { Status: status } : {}), ...(dateFrom ? { DateFrom: dateFrom } : {}), ...(dateTo ? { DateTo: dateTo } : {}), order: 'Date DESC' } });
      return text((result.Quotes ?? []).map(full));
    } catch (error) { return errorResult(error); }
  });
  server.registerTool('xero_get_quote', {
    title: 'Read customer quote', description: 'Read quote details and revision required for draft editing.', inputSchema: z.object({ quoteId: z.string().uuid() }).strict(), annotations: { readOnlyHint: true },
  }, async ({ quoteId }) => {
    try { return text(full(quoteFrom(await xeroRequest('GET', `/Quotes/${quoteId}`), quoteId))); }
    catch (error) { return errorResult(error); }
  });
  if (!enableQuoteWrites) return;
  server.registerTool('xero_create_draft_quote', {
    title: 'Create draft quote', description: 'Create DRAFT only; never send, accept or invoice. Currency, dates, tax basis and monetary line tax/account codes are explicit. Xero calculates totals and any omitted currency exchange rate. Reconcile an uncertain creation before retrying.',
    inputSchema: z.object({ ...fields, reference: fields.reference.optional(), currencyRate: fields.currencyRate.optional() }).strict(),
  }, async (input) => {
    try {
      checkDates(input);
      const quote = quoteFrom(await xeroRequest('POST', '/Quotes', { body: { Quotes: [payload(input)] } }), undefined, true);
      return text(full(quote));
    } catch (error) { return errorResult(error); }
  });
  const locks = new Set();
  server.registerTool('xero_update_draft_quote', {
    title: 'Edit draft quote', description: 'Edit only DRAFT using expectedRevision from xero_get_quote. Omitted fields are preserved; lineItems explicitly replaces ALL lines including discounts/tracking. Read and review before replacement. No send/status transition. External edits during the request cannot be locked.',
    inputSchema: z.object({ ...Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, schema.optional()])), quoteId: z.string().uuid(), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  }, async ({ quoteId, expectedRevision, ...input }) => {
    let ownsLock = false;
    try {
      if (!Object.values(input).some((value) => value !== undefined)) throw new Error('Provide at least one field to update.');
      if (locks.has(quoteId)) throw new Error('Quote update already in progress. Read again after completion.');
      locks.add(quoteId); ownsLock = true;
      const before = quoteFrom(await xeroRequest('GET', `/Quotes/${quoteId}`), quoteId, true);
      if (revision(before) !== expectedRevision) throw new Error('Quote changed since it was read. No update was sent.');
      checkDates(input, before);
      // A currency change must not reuse a prior exchange rate silently.
      if (input.currencyCode !== undefined && input.currencyCode !== before.CurrencyCode && input.currencyRate === undefined) throw new Error('Changing currency requires an explicit currencyRate.');
      const result = await xeroRequest('POST', `/Quotes/${quoteId}`, { body: { Quotes: [{ QuoteID: quoteId, ...payload(input) }] } });
      return text(full(quoteFrom(result, quoteId, true)));
    } catch (error) { return errorResult(error); }
    finally { if (ownsLock) locks.delete(quoteId); }
  });
}
