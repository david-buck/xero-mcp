import test from "node:test";
import { invoiceRevision } from "../src/invoice-edits.js";
import assert from "node:assert/strict";
import { createHarness, resultData } from "./helpers/mcp.js";

const invoiceId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";
const lineItemId = "33333333-3333-4333-8333-333333333333";
const line = { description: "Consulting", quantity: 2, unitAmount: 75, accountCode: "200", lineItemId, itemCode: "CONSULT", taxType: "OUTPUT" };
const createArgs = { contactId, invoiceDate: "2026-09-08", dueDate: "2026-09-22", lineItems: [line] };
const invoice = { InvoiceID: invoiceId, InvoiceNumber: "INV-123", Type: "ACCREC", Status: "DRAFT", Contact: { ContactID: contactId, Name: "Fixture" }, DateString: "2026-09-08", DueDateString: "2026-09-22", CurrencyCode: "NZD", Total: 172.5, SubTotal: 150, TotalTax: 22.5, AmountDue: 172.5, LineItems: [{ LineItemID: lineItemId, Description: "Consulting" }] };
const mappedLine = { LineItemID: lineItemId, ItemCode: "CONSULT", Description: "Consulting", Quantity: 2, UnitAmount: 75, AccountCode: "200", TaxType: "OUTPUT" };

test("registers exactly the eight existing tools", async (t) => {
  const { client } = await createHarness(t);
  assert.deepEqual((await client.listTools()).tools.map(({ name }) => name).sort(), ["xero_find_contact", "xero_get_contact_defaults", "xero_list_revenue_accounts", "xero_list_revenue_tax_rates", "xero_list_invoices", "xero_get_invoice", "xero_create_draft_invoice", "xero_update_draft_invoice"].sort());
});

test("actual SDK rejects invalid schema input before HTTP", async (t) => {
  const { call, calls } = await createHarness(t);
  for (const args of [{ ...createArgs, contactId: "bad" }, { ...createArgs, lineItems: [] }, { ...createArgs, lineItems: [{ ...line, quantity: 0 }] }]) {
    const result = await call("xero_create_draft_invoice", args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /validation|invalid/i);
  }
  assert.equal(calls.length, 0);
});

test("create forces ACCREC DRAFT and forwards line IDs and item codes", async (t) => {
  const { call, calls } = await createHarness(t, () => ({ Invoices: [invoice] }));
  const result = await call("xero_create_draft_invoice", createArgs);
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls, [["POST", "/Invoices", { query: { unitdp: 4 }, body: { Invoices: [{ Type: "ACCREC", Status: "DRAFT", LineAmountTypes: "Exclusive", Contact: { ContactID: contactId }, Date: "2026-09-08", DueDate: "2026-09-22", LineItems: [mappedLine] }] } }]]);
  assert.deepEqual(resultData(result), { invoiceId, revision: invoiceRevision(invoice), invoiceNumber: "INV-123", type: "ACCREC", status: "DRAFT", contact: { contactId, name: "Fixture" }, date: "2026-09-08", dueDate: "2026-09-22", total: 172.5, amountDue: 172.5, currency: "NZD", subTotal: 150, totalTax: 22.5, lineItems: invoice.LineItems });
});

for (const status of ["SUBMITTED", "AUTHORISED", "PAID", "VOIDED", "DELETED", "SENT", "UNKNOWN", undefined]) {
  test(`update rejects non-DRAFT ${status} before POST`, async (t) => {
    const { call, calls } = await createHarness(t, () => ({ Invoices: [{ ...invoice, Status: status }] }));
    const result = await call("xero_update_draft_invoice", { invoiceId, expectedRevision: invoiceRevision(invoice), reference: "Changed" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not DRAFT/);
    assert.deepEqual(calls, [["GET", `/Invoices/${invoiceId}`, { query: { unitdp: 4 } }]]);
  });
}

test("no-op update fails without HTTP", async (t) => {
  const { call, calls } = await createHarness(t);
  const result = await call("xero_update_draft_invoice", { invoiceId, expectedRevision: invoiceRevision(invoice) });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /at least one field/);
  assert.equal(calls.length, 0);
});

for (const tool of ["xero_get_invoice", "xero_update_draft_invoice", "xero_create_draft_invoice"]) {
  test(`${tool} reports missing invoice`, async (t) => {
    const { call, calls } = await createHarness(t);
    const result = await call(tool, tool === "xero_create_draft_invoice" ? createArgs : { invoiceId, expectedRevision: invoiceRevision(invoice), reference: "Changed" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /did not return/);
    if (tool === "xero_update_draft_invoice") assert.deepEqual(calls, [["GET", `/Invoices/${invoiceId}`, { query: { unitdp: 4 } }]]);
  });
}

for (const tool of ["xero_create_draft_invoice", "xero_update_draft_invoice"]) {
  test(`${tool} reports unexpected post-write status`, async (t) => {
    const { call, calls } = await createHarness(t, (method) => ({ Invoices: [{ ...invoice, Status: method === "GET" ? "DRAFT" : "AUTHORISED" }] }));
    const result = await call(tool, tool === "xero_create_draft_invoice" ? createArgs : { invoiceId, expectedRevision: invoiceRevision(invoice), reference: "Changed" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Safety check failed.*AUTHORISED.*expected DRAFT/);
    assert.equal(calls.at(-1)[0], "POST");
  });
}

test("line update replaces complete set and preserves line IDs/item codes", async (t) => {
  const { call, calls } = await createHarness(t, () => ({ Invoices: [invoice] }));
  const result = await call("xero_update_draft_invoice", { invoiceId, expectedRevision: invoiceRevision(invoice), lineItems: [line] });
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls, [["GET", `/Invoices/${invoiceId}`, { query: { unitdp: 4 } }], ["POST", `/Invoices/${invoiceId}`, { query: { unitdp: 4 }, body: { Invoices: [{ InvoiceID: invoiceId, Status: "DRAFT", LineItems: [mappedLine] }] } }]]);
});

test("reference-only update omits LineItems and allows clearing reference", async (t) => {
  const { call, calls } = await createHarness(t, () => ({ Invoices: [invoice] }));
  const result = await call("xero_update_draft_invoice", { invoiceId, expectedRevision: invoiceRevision(invoice), reference: "" });
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls[1][2].body.Invoices[0], { InvoiceID: invoiceId, Status: "DRAFT", Reference: "" });
});

for (const lineAmountTypes of ["Exclusive", "Inclusive", "NoTax"]) {
  test(`create forwards explicit ${lineAmountTypes} tax basis`, async (t) => {
    const { call, calls } = await createHarness(t, () => ({ Invoices: [{ ...invoice, LineAmountTypes: lineAmountTypes }] }));
    const result = await call("xero_create_draft_invoice", { ...createArgs, lineAmountTypes });
    assert.notEqual(result.isError, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2].body.Invoices[0].LineAmountTypes, lineAmountTypes);
    assert.equal(resultData(result).lineAmountTypes, lineAmountTypes);
  });

  test(`full get returns Xero ${lineAmountTypes} tax basis unchanged`, async (t) => {
    const { call } = await createHarness(t, () => ({ Invoices: [{ ...invoice, LineAmountTypes: lineAmountTypes }] }));
    const result = await call("xero_get_invoice", { invoiceId });
    assert.notEqual(result.isError, true);
    assert.equal(resultData(result).lineAmountTypes, lineAmountTypes);
  });
}

test("invalid and wrong-case tax basis fail SDK validation before HTTP", async (t) => {
  const { call, calls } = await createHarness(t);
  for (const lineAmountTypes of ["inclusive", "EXCLUSIVE", "None", "", null, 1]) {
    const result = await call("xero_create_draft_invoice", { ...createArgs, lineAmountTypes });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /validation|invalid/i);
  }
  assert.equal(calls.length, 0);
});

for (const changes of [{ reference: "Changed" }, { lineItems: [line] }]) {
  test(`update of Inclusive invoice omits tax basis for ${Object.keys(changes)[0]}`, async (t) => {
    const { call, calls } = await createHarness(t, () => ({ Invoices: [{ ...invoice, LineAmountTypes: "Inclusive" }] }));
    const result = await call("xero_update_draft_invoice", { invoiceId, expectedRevision: invoiceRevision({ ...invoice, LineAmountTypes: "Inclusive" }), ...changes });
    assert.notEqual(result.isError, true);
    assert.equal(resultData(result).lineAmountTypes, "Inclusive");
    assert.deepEqual(calls.map(([method]) => method), ["GET", "POST"]);
    assert.equal(Object.hasOwn(calls[1][2].body.Invoices[0], "LineAmountTypes"), false);
  });
}

for (const tool of ["xero_get_invoice", "xero_create_draft_invoice", "xero_update_draft_invoice"]) {
  test(`${tool} does not invent missing response tax basis`, async (t) => {
    const { call } = await createHarness(t, () => ({ Invoices: [invoice] }));
    const result = await call(tool, tool === "xero_create_draft_invoice" ? createArgs : { invoiceId, expectedRevision: invoiceRevision(invoice), reference: "Changed" });
    assert.notEqual(result.isError, true);
    assert.equal(Object.hasOwn(resultData(result), "lineAmountTypes"), false);
  });
}

test("invoice list requests four decimals and retains pagination, ordering and contact filter", async (t) => {
  const { call, calls } = await createHarness(t, () => ({ Invoices: [invoice] }));
  const result = await call("xero_list_invoices", { contactId, limit: 7 });
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls, [["GET", "/Invoices", { query: { page: 1, pageSize: 7, order: "Date DESC", unitdp: 4, ContactIDs: contactId } }]]);
  assert.equal(Array.isArray(resultData(result)), true);
});

test("four-decimal price survives get-to-update with precision on both update requests", async (t) => {
  const preciseInvoice = { ...invoice, LineItems: [{ ...mappedLine, UnitAmount: 0.0611 }] };
  const { call, calls } = await createHarness(t, () => ({ Invoices: [preciseInvoice] }));
  const fetched = resultData(await call("xero_get_invoice", { invoiceId }));
  assert.equal(fetched.lineItems[0].UnitAmount, 0.0611);
  const fetchedLine = fetched.lineItems[0];
  const result = await call("xero_update_draft_invoice", { invoiceId, expectedRevision: fetched.revision, lineItems: [{ description: fetchedLine.Description, quantity: fetchedLine.Quantity, unitAmount: fetchedLine.UnitAmount, accountCode: fetchedLine.AccountCode, lineItemId: fetchedLine.LineItemID, itemCode: fetchedLine.ItemCode, taxType: fetchedLine.TaxType }] });
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls.slice(0, 2), [["GET", `/Invoices/${invoiceId}`, { query: { unitdp: 4 } }], ["GET", `/Invoices/${invoiceId}`, { query: { unitdp: 4 } }]]);
  assert.deepEqual(calls[2], ["POST", `/Invoices/${invoiceId}`, { query: { unitdp: 4 }, body: { Invoices: [{ InvoiceID: invoiceId, Status: "DRAFT", LineItems: [{ ...mappedLine, UnitAmount: 0.0611 }] }] } }]);
});

test("supported canonical decimal unit amounts serialize unchanged", async (t) => {
  const { call, calls } = await createHarness(t, () => ({ Invoices: [invoice] }));
  const values = [0, -1, 12.34, 0.0611, 1.0001, -1.0001, 1e-4, 1e21, 1.23e21];
  for (const unitAmount of values) {
    const result = await call("xero_create_draft_invoice", { ...createArgs, lineItems: [{ ...line, unitAmount }] });
    assert.notEqual(result.isError, true, `accepted ${unitAmount}`);
    assert.equal(calls.at(-1)[2].body.Invoices[0].LineItems[0].UnitAmount, unitAmount);
    assert.deepEqual(calls.at(-1)[2].query, { unitdp: 4 });
  }
  assert.equal(calls.length, values.length);
});

for (const tool of ["xero_create_draft_invoice", "xero_update_draft_invoice"]) {
  test(`${tool} rejects fifth decimals and tiny nonzero values before HTTP`, async (t) => {
    const { call, calls } = await createHarness(t);
    for (const unitAmount of [0.00001, 1e-7, 1.23456, -1.23456, -1e-7, 5e-324]) {
      const args = tool === "xero_create_draft_invoice" ? createArgs : { invoiceId };
      const result = await call(tool, { ...args, lineItems: [{ ...line, unitAmount }] });
      assert.equal(result.isError, true, `rejected ${unitAmount}`);
      assert.match(result.content[0].text, /at most 4 decimal places/);
    }
    assert.equal(calls.length, 0);
  });
}

test("SDK advertises both line variants with all recognized monetary fields forbidden in descriptive branch", async (t) => {
  const { client } = await createHarness(t);
  for (const tool of (await client.listTools()).tools.filter(({ name }) => /create_draft|update_draft/.test(name))) {
    const [monetary, descriptive] = tool.inputSchema.properties.lineItems.items.anyOf;
    assert.deepEqual(monetary.required, ["description", "quantity", "unitAmount", "accountCode"]);
    assert.deepEqual(descriptive.required, ["description"]);
    assert.equal(descriptive.properties.description.minLength, 1);
    assert.equal(descriptive.properties.description.maxLength, 4000);
    assert.equal(descriptive.properties.lineItemId.format, "uuid");
    for (const field of ["quantity", "unitAmount", "accountCode", "itemCode", "taxType"]) assert.deepEqual(descriptive.properties[field], { not: {} });
    assert.notEqual(monetary.additionalProperties, false, "retain existing unknown-field behavior");
  }
});

test("create mixed line shapes preserves order and exact descriptive keys", async (t) => {
  const { call, calls } = await createHarness(t, () => ({ Invoices: [invoice] }));
  const result = await call("xero_create_draft_invoice", { ...createArgs, lineItems: [{ description: "Project notes" }, line, { description: "Existing notes", lineItemId }] });
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls[0][2].body.Invoices[0].LineItems, [{ Description: "Project notes" }, mappedLine, { LineItemID: lineItemId, Description: "Existing notes" }]);
});

test("mixed invoice update retains descriptive and monetary IDs and item linkage in complete replacement order", async (t) => {
  const noteId = "44444444-4444-4444-8444-444444444444";
  const existingLines = [{ LineItemID: noteId, Description: "Existing notes" }, mappedLine];
  const { call, calls } = await createHarness(t, () => ({ Invoices: [{ ...invoice, LineItems: existingLines }] }));
  const result = await call("xero_update_draft_invoice", { invoiceId, expectedRevision: invoiceRevision({ ...invoice, LineItems: existingLines }), lineItems: [{ description: "Existing notes", lineItemId: noteId }, { ...line, unitAmount: 0.0611 }] });
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls, [["GET", `/Invoices/${invoiceId}`, { query: { unitdp: 4 } }], ["POST", `/Invoices/${invoiceId}`, { query: { unitdp: 4 }, body: { Invoices: [{ InvoiceID: invoiceId, Status: "DRAFT", LineItems: [{ LineItemID: noteId, Description: "Existing notes" }, { ...mappedLine, UnitAmount: 0.0611 }] }] } }]]);
});

for (const tool of ["xero_create_draft_invoice", "xero_update_draft_invoice"]) {
  test(`${tool} rejects incomplete monetary shapes and invalid descriptive boundaries without HTTP`, async (t) => {
    const { call, calls } = await createHarness(t);
    const invalidLines = [
      { description: "" }, { description: "x".repeat(4001) }, { description: "Notes", lineItemId: "bad" },
      ...[{ quantity: 1 }, { unitAmount: 0 }, { accountCode: "200" }, { itemCode: "CONSULT" }, { taxType: "OUTPUT" }, { quantity: null }, { unitAmount: null }, { accountCode: null }, { itemCode: null }, { taxType: null }].map((fields) => ({ description: "Notes", ...fields })),
      { ...line, quantity: 0 }, { ...line, accountCode: "" }, { ...line, unitAmount: 1.23456 },
    ];
    for (const invalidLine of invalidLines) {
      const args = tool === "xero_create_draft_invoice" ? createArgs : { invoiceId };
      const result = await call(tool, { ...args, lineItems: [invalidLine] });
      assert.equal(result.isError, true, JSON.stringify(invalidLine));
      assert.match(result.content[0].text, /validation|invalid/i);
    }
    assert.equal(calls.length, 0);
  });
}

test("description-only arrays accept inclusive length boundaries without requiring monetary lines", async (t) => {
  const { call, calls } = await createHarness(t, () => ({ Invoices: [invoice] }));
  for (const description of ["x", "x".repeat(4000)]) {
    const result = await call("xero_create_draft_invoice", { ...createArgs, lineItems: [{ description }] });
    assert.notEqual(result.isError, true);
    assert.deepEqual(calls.at(-1)[2].body.Invoices[0].LineItems, [{ Description: description }]);
  }
});

test("mixed-line non-DRAFT update still fails preflight without POST", async (t) => {
  const { call, calls } = await createHarness(t, () => ({ Invoices: [{ ...invoice, Status: "AUTHORISED" }] }));
  const result = await call("xero_update_draft_invoice", { invoiceId, expectedRevision: invoiceRevision(invoice), lineItems: [{ description: "Notes" }, line] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not DRAFT/);
  assert.deepEqual(calls, [["GET", `/Invoices/${invoiceId}`, { query: { unitdp: 4 } }]]);
});

test("default invoice list keeps page 1 limit 20 array and one request", async (t) => {
  const { call, calls } = await createHarness(t, () => ({ Invoices: [invoice] }));
  const result = await call("xero_list_invoices", {});
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls, [["GET", "/Invoices", { query: { page: 1, pageSize: 20, order: "Date DESC", unitdp: 4 } }]]);
  const rows = resultData(result);
  assert.equal(Array.isArray(rows), true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].invoiceId, invoiceId);
});

test("page two combines contact and trimmed exact invoice number in one request", async (t) => {
  const { call, calls } = await createHarness(t, () => ({ Invoices: [invoice] }));
  const result = await call("xero_list_invoices", { page: 2, limit: 100, contactId, invoiceNumber: "  INV-123  " });
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls, [["GET", "/Invoices", { query: { page: 2, pageSize: 100, order: "Date DESC", unitdp: 4, ContactIDs: contactId, InvoiceNumbers: "INV-123" } }]]);
  const id = resultData(result)[0].invoiceId;
  const fetched = await call("xero_get_invoice", { invoiceId: id });
  assert.notEqual(fetched.isError, true);
  assert.equal(resultData(fetched).invoiceId, invoiceId);
  assert.deepEqual(calls[1], ["GET", `/Invoices/${invoiceId}`, { query: { unitdp: 4 } }]);
});

test("empty older page returns empty array without automatic fetch", async (t) => {
  const { call, calls } = await createHarness(t);
  const result = await call("xero_list_invoices", { page: 99, limit: 1 });
  assert.deepEqual(resultData(result), []);
  assert.deepEqual(calls, [["GET", "/Invoices", { query: { page: 99, pageSize: 1, order: "Date DESC", unitdp: 4 } }]]);
});

test("lookup rejects invalid page, limit, and number inputs before HTTP", async (t) => {
  const { call, calls } = await createHarness(t);
  const invalid = [
    ...[0, -1, 1.5, "2", null].map((page) => ({ page })),
    ...[0, 101, -1, 1.5, "20"].map((limit) => ({ limit })),
    ...["", "   ", "x".repeat(256), "INV-1,INV-2", "INV,1", null, 123].map((invoiceNumber) => ({ invoiceNumber })),
  ];
  for (const args of invalid) {
    const result = await call("xero_list_invoices", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(result.content[0].text, /validation|invalid/i);
  }
  assert.equal(calls.length, 0);
});

test("lookup accepts maximum 255-character number without truncation", async (t) => {
  const { call, calls } = await createHarness(t);
  const invoiceNumber = "x".repeat(255);
  const result = await call("xero_list_invoices", { invoiceNumber });
  assert.notEqual(result.isError, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].query.InvoiceNumbers, invoiceNumber);
});

test("exact number passes through actual URLSearchParams encoding as one query value", async (t) => {
  const { createXeroClient } = await import("../src/xero.js");
  const requests = [];
  const api = createXeroClient({
    now: () => 1000,
    loadTokens: async () => ({ tenantId: "synthetic", access_token: "synthetic", expires_at: 1000000 }),
    saveTokens: async () => assert.fail("Unexpected token persistence"),
    getConfig: () => assert.fail("Unexpected refresh"),
    fetch: async (url) => { requests.push(String(url)); return new Response(JSON.stringify({ Invoices: [] })); },
  });
  const { call } = await createHarness(t, api.xeroRequest);
  const invoiceNumber = "INV /?&=+#%2C";
  const result = await call("xero_list_invoices", { invoiceNumber });
  assert.notEqual(result.isError, true);
  assert.equal(requests.length, 1);
  const url = new URL(requests[0]);
  assert.equal(url.searchParams.get("InvoiceNumbers"), invoiceNumber);
  assert.equal(url.searchParams.size, 5);
  assert.equal(url.hash, "");
  assert.match(requests[0], /InvoiceNumbers=INV\+%2F%3F%26%3D%2B%23%252C$/);
});

test("omitted create currency leaves no currency or rate and performs no default lookup", async (t) => {
  const { call, calls } = await createHarness(t, () => ({ Invoices: [invoice] }));
  const result = await call("xero_create_draft_invoice", createArgs);
  assert.notEqual(result.isError, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "POST");
  const written = calls[0][2].body.Invoices[0];
  assert.equal(Object.hasOwn(written, "CurrencyCode"), false);
  assert.equal(Object.hasOwn(written, "CurrencyRate"), false);
  assert.equal(resultData(result).currency, "NZD");
});

for (const currencyCode of ["USD", "usd", "  uSd  "]) {
  test(`create normalizes currency ${JSON.stringify(currencyCode)} through actual MCP without converting amounts`, async (t) => {
    const { call, calls } = await createHarness(t, () => ({ Invoices: [{ ...invoice, CurrencyCode: "USD", LineAmountTypes: "Inclusive" }] }));
    const result = await call("xero_create_draft_invoice", { ...createArgs, currencyCode, lineAmountTypes: "Inclusive", lineItems: [{ ...line, unitAmount: 0.0611 }] });
    assert.notEqual(result.isError, true);
    assert.deepEqual(calls, [["POST", "/Invoices", { query: { unitdp: 4 }, body: { Invoices: [{ Type: "ACCREC", Status: "DRAFT", LineAmountTypes: "Inclusive", CurrencyCode: "USD", Contact: { ContactID: contactId }, Date: "2026-09-08", DueDate: "2026-09-22", LineItems: [{ ...mappedLine, UnitAmount: 0.0611 }] }] } }]]);
    assert.equal(resultData(result).currency, "USD");
  });
}

test("malformed currency fails MCP validation before any request", async (t) => {
  const { call, calls } = await createHarness(t);
  for (const currencyCode of ["", "  ", "US", "USDD", "U1D", "U$D", "U SD", "ÜSD", "ＵＳＤ", null, 123]) {
    const result = await call("xero_create_draft_invoice", { ...createArgs, currencyCode });
    assert.equal(result.isError, true, JSON.stringify(currencyCode));
    assert.match(result.content[0].text, /validation|invalid/i);
  }
  assert.equal(calls.length, 0);
});

test("upstream disabled-currency error remains visible without local currency allowlist", async (t) => {
  const { call, calls } = await createHarness(t, () => { throw new Error("Xero API POST /Invoices?unitdp=4 failed (400 Bad Request): Currency XYZ is not enabled for this organisation."); });
  const result = await call("xero_create_draft_invoice", { ...createArgs, currencyCode: "XYZ" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /400 Bad Request.*Currency XYZ is not enabled/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].body.Invoices[0].CurrencyCode, "XYZ");
});

test("currency is advertised only on create and update payload cannot mutate currency", async (t) => {
  const { client, call, calls } = await createHarness(t, () => ({ Invoices: [{ ...invoice, CurrencyCode: "USD" }] }));
  const tools = (await client.listTools()).tools;
  assert.equal(Object.hasOwn(tools.find(({ name }) => name === "xero_create_draft_invoice").inputSchema.properties, "currencyCode"), true);
  assert.equal(Object.hasOwn(tools.find(({ name }) => name === "xero_update_draft_invoice").inputSchema.properties, "currencyCode"), false);
  const result = await call("xero_update_draft_invoice", { invoiceId, expectedRevision: invoiceRevision({ ...invoice, CurrencyCode: "USD" }), reference: "Changed", currencyCode: "EUR" });
  assert.notEqual(result.isError, true);
  assert.equal(resultData(result).currency, "USD");
  assert.deepEqual(calls[1][2].body.Invoices[0], { InvoiceID: invoiceId, Status: "DRAFT", Reference: "Changed" });
});
