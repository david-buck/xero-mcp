import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, resultData } from "./helpers/mcp.js";
import { invoiceRevision } from "../src/invoice-edits.js";

const invoiceId = "11111111-1111-4111-8111-111111111111";
const lineItemId = "33333333-3333-4333-8333-333333333333";
const noteId = "44444444-4444-4444-8444-444444444444";
const contactId = "22222222-2222-4222-8222-222222222222";
const discountedLine = { LineItemID: lineItemId, Description: "Boka work", Quantity: 2, UnitAmount: 100.0611, DiscountRate: 10, AccountCode: "200", ItemCode: "WORK", TaxType: "OUTPUT", LineAmount: 180.11, TaxAmount: 27.02, Tracking: [{ TrackingCategoryID: noteId, TrackingOptionID: contactId }] };
const note = { LineItemID: noteId, Description: "Project notes" };
const before = { InvoiceID: invoiceId, InvoiceNumber: "INV-123", Type: "ACCREC", Status: "DRAFT", Contact: { ContactID: contactId }, DateString: "2026-10-02", DueDateString: "2026-10-20", LineAmountTypes: "Exclusive", CurrencyCode: "NZD", SubTotal: 180.11, TotalTax: 27.02, Total: 207.13, LineItems: [discountedLine, note], UpdatedDateUTC: "/Date(1790899200000)/" };
const args = { invoiceId, expectedRevision: invoiceRevision(before) };

for (const discount of [{ DiscountRate: 10 }, { DiscountAmount: 20 }, { DiscountRate: 10, DiscountAmount: 20.0122 }]) {
  test(`tax-only patch preserves discount ${JSON.stringify(discount)}, rates, quantities, tracking, notes and identities`, async (t) => {
    const { DiscountRate, ...undiscounted } = discountedLine;
    const original = { ...before, LineItems: [{ ...undiscounted, ...discount }, note] };
    const after = { ...original, LineItems: [{ ...original.LineItems[0], TaxType: "NONE", TaxAmount: 0 }, note], TotalTax: 0, Total: 180.11 };
    const { call, calls } = await createHarness(t, (method) => ({ Invoices: [method === "GET" ? original : after] }));
    const read = resultData(await call("xero_get_invoice", { invoiceId }));
    const result = await call("xero_update_draft_invoice", { invoiceId, expectedRevision: read.revision, lineItemPatches: [{ lineItemId, taxType: "NONE" }] });
    assert.notEqual(result.isError, true);
    const { LineAmount, TaxAmount, ...preserved } = original.LineItems[0];
    assert.deepEqual(calls[2][2].body.Invoices[0].LineItems, [{ ...preserved, TaxType: "NONE" }, note]);
    const data = resultData(result);
    assert.deepEqual(data.changeSummary.fields, [
      { field: "total", before: 207.13, after: 180.11 },
      { field: "totalTax", before: 27.02, after: 0 },
      { field: "lineItems[0].TaxType", before: "OUTPUT", after: "NONE" },
      { field: "lineItems[0].TaxAmount", before: 27.02, after: 0 },
    ]);
    assert.deepEqual(data.changeSummary.before, { subTotal: 180.11, totalTax: 27.02, total: 207.13, currency: "NZD" });
    assert.deepEqual(data.changeSummary.after, { subTotal: 180.11, totalTax: 0, total: 180.11, currency: "NZD" });
    assert.equal(data.revision, invoiceRevision(after));
  });
}

test("summary shows unexpected changes returned by Xero as well as requested fields", async (t) => {
  const after = { ...before, Reference: "Changed", LineItems: [{ ...discountedLine, DiscountRate: 0 }, note], Total: 230.14 };
  const { call } = await createHarness(t, (method) => ({ Invoices: [method === "GET" ? before : after] }));
  const result = resultData(await call("xero_update_draft_invoice", { ...args, reference: "Changed" }));
  assert.ok(result.changeSummary.fields.some((change) => change.field === "lineItems[0].DiscountRate" && change.before === 10 && change.after === 0));
  assert.equal(result.changeSummary.after.total, 230.14);
});

for (const mutation of [{ Reference: "Concurrent edit" }, { Total: 1 }, { UpdatedDateUTC: "later" }, { LineItems: [{ ...discountedLine, DiscountRate: 0 }, note] }]) {
  test(`stale revision refuses update after change to ${Object.keys(mutation)[0]}`, async (t) => {
    const { call, calls } = await createHarness(t, () => ({ Invoices: [{ ...before, ...mutation }] }));
    const result = await call("xero_update_draft_invoice", { ...args, reference: "Changed" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /changed since it was read.*No update was sent/);
    assert.deepEqual(calls.map(([method]) => method), ["GET"]);
  });
}

test("missing or malformed revision cannot write", async (t) => {
  const { call, calls } = await createHarness(t);
  for (const expectedRevision of [undefined, "bad"]) {
    const result = await call("xero_update_draft_invoice", { invoiceId, reference: "Changed", expectedRevision });
    assert.equal(result.isError, true);
  }
  assert.equal(calls.length, 0);
});

for (const changes of [
  { lineItemPatches: [{ lineItemId }] },
  { lineItemPatches: [{ lineItemId, taxType: "NONE", madeUp: 1 }] },
  { lineItemPatches: [{ lineItemId, discountRate: 10, discountAmount: 20 }] },
  { lineItemPatches: [{ lineItemId, quantity: 0 }] },
  { lineItemPatches: [{ lineItemId, unitAmount: 0.00001 }] },
]) {
  test(`invalid patch rejects before HTTP: ${JSON.stringify(changes)}`, async (t) => {
    const { call, calls } = await createHarness(t);
    assert.equal((await call("xero_update_draft_invoice", { ...args, ...changes })).isError, true);
    assert.equal(calls.length, 0);
  });
}

for (const patches of [
  [{ lineItemId: contactId, taxType: "NONE" }],
  [{ lineItemId, taxType: "NONE" }, { lineItemId, quantity: 1 }],
  [{ lineItemId: noteId, taxType: "NONE" }],
]) {
  test(`invalid line target cannot write: ${JSON.stringify(patches)}`, async (t) => {
    const { call, calls } = await createHarness(t, () => ({ Invoices: [before] }));
    assert.equal((await call("xero_update_draft_invoice", { ...args, lineItemPatches: patches })).isError, true);
    assert.deepEqual(calls.map(([method]) => method), ["GET"]);
  });
}

test("patch and complete replacement are mutually exclusive", async (t) => {
  const { call, calls } = await createHarness(t);
  assert.equal((await call("xero_update_draft_invoice", { ...args, lineItemPatches: [{ lineItemId, taxType: "NONE" }], lineItems: [{ description: "New" }] })).isError, true);
  assert.equal(calls.length, 0);
});

for (const change of [{ discountRate: 0 }, { discountAmount: 0 }]) {
  test(`discount removal requires explicit zero ${JSON.stringify(change)}`, async (t) => {
    const { call, calls } = await createHarness(t, () => ({ Invoices: [before] }));
    assert.notEqual((await call("xero_update_draft_invoice", { ...args, lineItemPatches: [{ lineItemId, ...change }] })).isError, true);
    const sent = calls[1][2].body.Invoices[0].LineItems[0];
    assert.equal(sent[change.discountRate !== undefined ? "DiscountRate" : "DiscountAmount"], 0);
    assert.equal(Object.hasOwn(sent, change.discountRate !== undefined ? "DiscountAmount" : "DiscountRate"), false);
  });
}

test("description edits preserve tax overrides and computed amounts on every line", async (t) => {
  const { call, calls } = await createHarness(t, () => ({ Invoices: [before] }));
  await call("xero_update_draft_invoice", { ...args, lineItemPatches: [{ lineItemId: noteId, description: "Updated notes" }] });
  assert.deepEqual(calls[1][2].body.Invoices[0].LineItems, [discountedLine, { ...note, Description: "Updated notes" }]);
});

test("complete replacement preserves omitted discounts by existing line ID", async (t) => {
  const { call, calls } = await createHarness(t, () => ({ Invoices: [before] }));
  await call("xero_update_draft_invoice", { ...args, lineItems: [{ lineItemId, description: "Changed", quantity: 2, unitAmount: 100.0611, accountCode: "200", taxType: "NONE" }] });
  assert.equal(calls[1][2].body.Invoices[0].LineItems[0].DiscountRate, 10);
});

test("in-process overlapping writes are refused and the lock is released after errors", async (t) => {
  let unblock;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  let reached;
  const entered = new Promise((resolve) => { reached = resolve; });
  let shouldBlock = true;
  const { call, calls } = await createHarness(t, async (method) => {
    if (method === "GET" && shouldBlock) { reached(); await blocked; }
    if (method === "POST") throw new Error("Synthetic POST failure");
    return { Invoices: [before] };
  });
  const first = call("xero_update_draft_invoice", { ...args, reference: "First" });
  await entered;
  const second = await call("xero_update_draft_invoice", { ...args, reference: "Second" });
  assert.equal(second.isError, true);
  assert.match(second.content[0].text, /already in progress/);
  unblock();
  assert.equal((await first).isError, true);
  shouldBlock = false;
  const retry = await call("xero_update_draft_invoice", { ...args, reference: "Retry" });
  assert.match(retry.content[0].text, /Synthetic POST failure/);
  assert.equal(calls.filter(([method]) => method === "POST").length, 2);
});

test("revenue tax labels retain name and code even for equal zero rates", async (t) => {
  const { call } = await createHarness(t, () => ({ TaxRates: [
    { TaxType: "NONE", Name: "No GST", DisplayTaxRate: 0, Status: "ACTIVE", CanApplyToRevenue: true },
    { TaxType: "ZERORATED", Name: "Zero Rated", DisplayTaxRate: 0, Status: "ACTIVE", CanApplyToRevenue: true },
  ] }));
  const rates = resultData(await call("xero_list_revenue_tax_rates", {}));
  assert.deepEqual(rates.map(({ label, taxType, rate }) => ({ label, taxType, rate })), [
    { label: "No GST (NONE)", taxType: "NONE", rate: 0 },
    { label: "Zero Rated (ZERORATED)", taxType: "ZERORATED", rate: 0 },
  ]);
});

test("contact billing lookup returns dated full invoices and fetches missing lines", async (t) => {
  const { call, calls } = await createHarness(t, (_method, path) => ({ Invoices: [path === "/Invoices" ? { ...before, LineItems: [] } : before] }));
  const invoices = resultData(await call("xero_list_invoices", { contactId, limit: 5, includeLineItems: true }));
  assert.deepEqual(calls, [
    ["GET", "/Invoices", { query: { page: 1, pageSize: 5, order: "Date DESC", unitdp: 4, ContactIDs: contactId } }],
    ["GET", `/Invoices/${invoiceId}`, { query: { unitdp: 4 } }],
  ]);
  assert.equal(invoices[0].date, "2026-10-02");
  assert.equal(invoices[0].status, "DRAFT");
  assert.equal(invoices[0].currency, "NZD");
  assert.deepEqual(invoices[0].lineItems, before.LineItems);
});

test("billing lookup reuses list line details without extra reads", async (t) => {
  const { call, calls } = await createHarness(t, () => ({ Invoices: [before] }));
  assert.equal(resultData(await call("xero_list_invoices", { contactId, includeLineItems: true })).length, 1);
  assert.equal(calls.length, 1);
});

test("empty billing page returns no records or detail requests", async (t) => {
  const { call, calls } = await createHarness(t);
  assert.deepEqual(resultData(await call("xero_list_invoices", { contactId, includeLineItems: true })), []);
  assert.equal(calls.length, 1);
});

for (const tool of ["xero_create_draft_invoice", "xero_update_draft_invoice"]) {
  test(`${tool} reports per-invoice validation errors without a success summary`, async (t) => {
    const { call } = await createHarness(t, (method) => ({ Invoices: [method === "GET" ? before : { ...before, HasErrors: true, ValidationErrors: [{ Message: "Invalid tax type" }] }] }));
    const input = tool === "xero_update_draft_invoice" ? { ...args, reference: "Changed" } : { contactId, invoiceDate: "2026-10-02", dueDate: "2026-10-20", lineItems: [{ description: "Notes" }] };
    const result = await call(tool, input);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Xero rejected invoice.*Invalid tax type/);
  });
}
