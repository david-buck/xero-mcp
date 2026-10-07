import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerCreditNoteTools } from "../src/credit-notes.js";

const creditNoteId = "bf196f95-62a9-40ea-890f-8057ad923d98";
const contactId = "ac0b07f6-62a9-40ea-890f-8057ad923d98";
const invoiceId = "de54f318-1b9a-41e1-b431-0dfb3f1863d6";

async function createHarness(t, respond = () => ({ CreditNotes: [] })) {
  const calls = [];
  const server = new McpServer({ name: "credit-note-tests", version: "1.0.0" });
  registerCreditNoteTools(server, async (...args) => {
    calls.push(args);
    return respond(...args);
  });
  const client = new Client({ name: "offline-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { calls, call: (name, args) => client.callTool({ name, arguments: args }) };
}

function resultData(result) {
  return JSON.parse(result.content[0].text);
}

const sampleNote = {
  CreditNoteID: creditNoteId,
  CreditNoteNumber: "CN-123",
  Type: "ACCRECCREDIT",
  Status: "AUTHORISED",
  DateString: "2025-06-12T00:00:00",
  UpdatedDateUTCString: "2025-06-12T03:00:00Z",
  Reference: "Return",
  Contact: { ContactID: contactId, Name: "Example Contact", EmailAddress: "not-needed@example.test" },
  CurrencyCode: "NZD",
  CurrencyRate: 1,
  LineAmountTypes: "Exclusive",
  SubTotal: 100,
  TotalTax: 15,
  Total: 115,
  RemainingCredit: 35,
  HasAttachments: false,
  Allocations: [{
    AllocationID: "1a657593-6bdd-4127-a753-1044dcf21abe",
    DateString: "2025-06-15T00:00:00",
    Amount: 80,
    Invoice: { InvoiceID: invoiceId, InvoiceNumber: "INV-8", Type: "ACCREC" },
  }],
  Payments: [{ PaymentID: "566f9f81-6b2d-4456-9a7f-020ff24415fb", DateString: "2025-06-18T00:00:00", Amount: 10, Reference: "Refund" }],
  LineItems: [{
    LineItemID: "0ed7c8c6-fac5-43aa-800b-441eae5e935b",
    Description: "Returned goods",
    Quantity: 2,
    UnitAmount: 50,
    LineAmount: 100,
    TaxType: "OUTPUT2",
    TaxAmount: 15,
    AccountCode: "200",
    Tracking: [{ TrackingCategoryID: "2dd3ad17-81f6-4328-8aa5-c5fe62c48fd1", Name: "Region", Option: "North" }],
  }],
};

test("credit-note listing applies bounded filters, Xero paging, and useful review fields via GET only", async (t) => {
  const { call, calls } = await createHarness(t, () => ({
    pagination: { page: 2, pageSize: 1, pageCount: 3, itemCount: 3 },
    CreditNotes: [sampleNote],
  }));
  const result = await call("xero_list_credit_notes", {
    fromDate: "2025-04-01",
    toDate: "2026-03-31",
    page: 2,
    pageSize: 1,
    type: "ACCRECCREDIT",
    status: "AUTHORISED",
    contactId,
  });
  const data = resultData(result);
  assert.equal(result.isError, undefined);
  assert.deepEqual(data.period, { fromDate: "2025-04-01", toDate: "2026-03-31" });
  assert.equal(data.page, 2);
  assert.equal(data.pageSize, 1);
  assert.equal(data.nextPage, 3);
  assert.equal(data.records[0].creditNoteId, creditNoteId);
  assert.equal(data.records[0].remainingCredit, 35);
  assert.equal(data.records[0].allocations[0].invoice.invoiceId, invoiceId);
  assert.equal(data.records[0].payments[0].paymentId, "566f9f81-6b2d-4456-9a7f-020ff24415fb");
  assert.equal(data.records[0].lineItems[0].accountCode, "200");
  assert.equal(data.records[0].lineItems[0].tracking[0].option, "North");
  assert.equal(data.records[0].contact.email, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "GET");
  assert.equal(calls[0][1], "/CreditNotes");
  assert.deepEqual(calls[0][2].query, {
    where: 'Date>=DateTime(2025, 4, 1) AND Date<=DateTime(2026, 3, 31) AND Type=="ACCRECCREDIT" AND Status=="AUTHORISED" AND Contact.ContactID=guid("ac0b07f6-62a9-40ea-890f-8057ad923d98")',
    order: "Date ASC",
    page: 2,
    pageSize: 1,
    unitdp: 4,
  });
});

test("credit-note detail reads by ID and missing IDs return a clear error", async (t) => {
  const { call, calls } = await createHarness(t, () => ({ CreditNotes: [sampleNote] }));
  const detail = resultData(await call("xero_get_credit_note", { creditNoteId }));
  assert.equal(detail.creditNoteNumber, "CN-123");
  assert.equal(detail.allocations[0].amount, 80);
  assert.deepEqual(calls[0].slice(0, 2), ["GET", `/CreditNotes/${creditNoteId}`]);
  assert.deepEqual(calls[0][2].query, { unitdp: 4 });

  const missingHarness = await createHarness(t, () => ({ CreditNotes: [] }));
  const missing = await missingHarness.call("xero_get_credit_note", { creditNoteId });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /Xero returned no credit note/);
});

test("listing rejects reversed, overlong, and malformed ranges before reaching Xero", async (t) => {
  const { call, calls } = await createHarness(t);
  for (const args of [
    { fromDate: "2026-04-01", toDate: "2026-03-31" },
    { fromDate: "2024-01-01", toDate: "2026-03-31" },
    { fromDate: "2025-02-30", toDate: "2025-03-01" },
    { fromDate: "2025-04-01", toDate: "2026-03-31", pageSize: 101 },
  ]) {
    const result = await call("xero_list_credit_notes", args);
    assert.equal(result.isError, true);
  }
  assert.equal(calls.length, 0);
});

test("credit-note pagination uses the API page count and never invents a next page", async (t) => {
  const { call } = await createHarness(t, () => ({
    pagination: { page: 1, pageSize: 100, pageCount: 1, itemCount: 1000 },
    CreditNotes: [sampleNote],
  }));
  const result = resultData(await call("xero_list_credit_notes", {
    fromDate: "2025-04-01", toDate: "2025-04-01", page: 1,
  }));
  assert.equal(result.nextPage, null);
});
