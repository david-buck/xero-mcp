import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, resultData } from "./helpers/mcp.js";

const fromDate = "2025-04-01";
const toDate = "2026-03-31";
const invoiceId = "bf196f95-62a9-40ea-890f-8057ad923d98";

test("integrated server advertises review guidance and read tools alongside draft-only invoice tools", async (t) => {
  const { client } = await createHarness(t);
  const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
  assert.equal(names.size, 24, "local release must advertise all 24 supported tools");
  for (const name of [
    "xero_review_context", "xero_review_guide", "xero_list_credit_notes", "xero_get_credit_note",
    "xero_get_profit_and_loss", "xero_list_period_invoices", "xero_create_draft_invoice", "xero_update_draft_invoice",
  ]) assert.equal(names.has(name), true, name);
  assert.ok((await client.listPrompts()).prompts.some((prompt) => prompt.name === "xero_review"));
  assert.match(client.getInstructions(), /Keep review read-only/);
});

test("review helpers identify historical accounts and date-filter invoices and bills with GET only", async (t) => {
  const { call, calls } = await createHarness(t, (_method, path) => path === "/Accounts"
    ? { Accounts: [
      { AccountID: invoiceId, Code: "400", Name: "Old sales", Class: "REVENUE", Status: "ARCHIVED" },
      { AccountID: invoiceId, Code: "200", Name: "Sales", Class: "REVENUE", Status: "ACTIVE" },
    ] }
    : { Invoices: [{ InvoiceID: invoiceId, InvoiceNumber: "BILL-1", Type: "ACCPAY", Total: 75, TotalTax: 10, Contact: { Name: "Supplier" } }] });
  const accounts = resultData(await call("xero_list_accounts", {}));
  assert.deepEqual(accounts.map((account) => account.code), ["200", "400"]);
  assert.equal(accounts[1].status, "ARCHIVED");
  const invoices = resultData(await call("xero_list_period_invoices", {
    fromDate, toDate, page: 2, type: "ACCPAY", status: "PAID", contactId: invoiceId,
  }));
  assert.equal(invoices.pageSize, 100);
  assert.equal(invoices.records[0].invoiceId, invoiceId);
  assert.equal(invoices.records[0].totalTax, 10);
  assert.match(invoices.balanceTiming, /current record state/);
  assert.equal(invoices.source.endpoint, "/Invoices");
  assert.deepEqual(calls.map(([method, path]) => [method, path]), [["GET", "/Accounts"], ["GET", "/Invoices"]]);
  assert.match(calls[1][2].query.where, /Date>=DateTime\(2025, 4, 1\) AND Date<=DateTime\(2026, 3, 31\) AND Type=="ACCPAY"/);
  assert.equal(calls[1][2].query.Statuses, "PAID");
  assert.equal(calls[1][2].query.ContactIDs, invoiceId);
  assert.equal(calls[1][2].query.pageSize, undefined);
});

test("year-end transaction tools use only bounded GET requests and expose page metadata", async (t) => {
  const { call, calls } = await createHarness(t, (_method, path) => {
    if (path === "/BankTransactions") return { BankTransactions: [{ BankTransactionID: invoiceId, IsReconciled: true, LineItems: [{ Description: "Bank charge" }] }] };
    if (path === "/Payments") return { Payments: [{ PaymentID: invoiceId, Invoice: { InvoiceID: invoiceId, InvoiceNumber: "INV-1" }, Account: { Code: "090" } }] };
    return { ManualJournals: [{ ManualJournalID: invoiceId, JournalLines: [{ AccountCode: "200", LineAmount: 50 }] }] };
  });
  for (const name of ["xero_list_bank_transactions", "xero_list_payments", "xero_list_manual_journals"]) {
    const result = await call(name, { fromDate, toDate, page: 2, pageSize: 20 });
    assert.equal(result.isError, undefined);
    assert.equal(resultData(result).page, 2);
    assert.equal(resultData(result).pageSize, 20);
    assert.equal(resultData(result).records.length, 1);
  }
  assert.equal(calls.length, 3);
  for (const [method, , options] of calls) {
    assert.equal(method, "GET");
    assert.match(options.query.where, /Date>=DateTime\(2025, 4, 1\) AND Date<=DateTime\(2026, 3, 31\)/);
  }
  assert.equal(resultData(await call("xero_list_payments", { fromDate, toDate, invoiceId })).records[0].invoice.invoiceNumber, "INV-1");
  assert.match(calls.at(-1)[2].query.where, /Invoice\.InvoiceID=guid/);
});

test("reported Xero page count avoids a guessed extra page", async (t) => {
  const { call } = await createHarness(t, () => ({
    pagination: { page: 1, pageSize: 1, pageCount: 1, itemCount: 1 },
    Payments: [{ PaymentID: invoiceId }],
  }));
  const result = resultData(await call("xero_list_payments", { fromDate, toDate, pageSize: 1 }));
  assert.equal(result.nextPage, null);
  assert.equal(result.nextPageBasis, "Xero pageCount");
});

test("report tools use fixed GET endpoints and retain Xero rows", async (t) => {
  const { call, calls } = await createHarness(t, () => ({ Reports: [{ ReportName: "Sample", Rows: [{ Cells: [{ Value: "123" }] }] }] }));
  for (const [name, args, path] of [
    ["xero_get_profit_and_loss", { fromDate, toDate }, "/Reports/ProfitAndLoss"],
    ["xero_get_balance_sheet", { date: toDate }, "/Reports/BalanceSheet"],
    ["xero_get_trial_balance", { date: toDate }, "/Reports/TrialBalance"],
  ]) {
    const result = await call(name, args);
    assert.equal(result.isError, undefined);
    assert.equal(calls.at(-1)[0], "GET");
    assert.equal(calls.at(-1)[1], path);
    assert.equal(calls.at(-1)[2].query.paymentsOnly, false);
    assert.equal(resultData(result).requestedBasis, "accrual");
    assert.equal(resultData(result).Reports[0].Rows[0].Cells[0].Value, "123");
  }
  const cash = await call("xero_get_profit_and_loss", { fromDate, toDate, paymentsOnly: true });
  assert.equal(resultData(cash).requestedBasis, "cash");
  assert.equal(calls.at(-1)[2].query.paymentsOnly, true);
});

test("GST report tools select only catalogue GSTReturn IDs and preserve fields", async (t) => {
  const reportId = "12345";
  const { call, calls } = await createHarness(t, (_method, path) => path === "/Reports"
    ? { Reports: [
      { ReportID: reportId, ReportType: "GSTReturn", ReportName: "GST and Provisional Tax Return", ReportDate: "01 Jun 2025 to 31 Jul 2025" },
      { ReportID: "54321", ReportType: "Other", ReportDate: "01 Jun 2025 to 31 Jul 2025" },
    ] }
    : { Reports: [{ ReportID: reportId, ReportType: "GSTReturn", Fields: [{ FieldID: "Box5", Value: "123" }] }] });
  const listed = resultData(await call("xero_list_gst_reports", { fromDate, toDate }));
  assert.equal(listed.reports.length, 1);
  assert.equal(listed.reports[0].reportId, reportId);
  const report = resultData(await call("xero_get_gst_report", { reportId }));
  assert.equal(report.report.Fields[0].Value, "123");
  assert.equal(report.filingStatus, "Not provided by the Xero Reports API");
  const rejected = await call("xero_get_gst_report", { reportId: "54321" });
  assert.equal(rejected.isError, true);
  assert.deepEqual(calls.map(([method, path]) => [method, path]), [["GET", "/Reports"], ["GET", "/Reports"], ["GET", "/Reports/12345"], ["GET", "/Reports"]]);
});

test("date and page validation stop requests before Xero", async (t) => {
  const { call, calls } = await createHarness(t);
  for (const args of [
    { fromDate: "2026-04-01", toDate: "2026-03-31" },
    { fromDate: "2024-01-01", toDate: "2026-03-31" },
    { fromDate, toDate, pageSize: 101 },
  ]) {
    const result = await call("xero_list_bank_transactions", args);
    assert.equal(result.isError, true);
  }
  assert.equal(calls.length, 0);
});
