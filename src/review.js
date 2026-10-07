import { z } from "zod";

const date = z.iso.date().describe("Date in YYYY-MM-DD format");
const page = z.number().int().min(1).max(100000).default(1);
const pageSize = z.number().int().min(1).max(100).default(100);
const uuid = z.string().uuid();

function text(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error) {
  return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
}

function dateRange(fromDate, toDate) {
  const start = Date.parse(`${fromDate}T00:00:00Z`);
  const end = Date.parse(`${toDate}T00:00:00Z`);
  if (end < start) throw new Error("toDate must be on or after fromDate.");
  if (end - start >= 366 * 24 * 60 * 60 * 1000) {
    throw new Error("A single request may cover at most 366 days. Split longer reviews into date ranges.");
  }
}

function xeroDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return `DateTime(${year}, ${month}, ${day})`;
}

function whereDates(fromDate, toDate) {
  dateRange(fromDate, toDate);
  return `Date>=${xeroDate(fromDate)} AND Date<=${xeroDate(toDate)}`;
}

function wrap(handler) {
  return async (args) => {
    try { return text(await handler(args)); }
    catch (error) { return errorResult(error); }
  };
}

function pagedResult(records, response, pageNumber, size, fromDate, toDate) {
  const reportedPageCount = Number(response.pagination?.pageCount);
  const hasReportedPageCount = response.pagination?.pageCount != null && Number.isInteger(reportedPageCount) && reportedPageCount >= 0;
  const nextPage = hasReportedPageCount
    ? (pageNumber < reportedPageCount ? pageNumber + 1 : null)
    : (records.length === size ? pageNumber + 1 : null);
  return {
    period: { fromDate, toDate },
    page: pageNumber,
    pageSize: size,
    returned: records.length,
    pagination: response.pagination ?? null,
    nextPage,
    nextPageBasis: hasReportedPageCount ? "Xero pageCount" : "full-page heuristic",
    records,
  };
}

function gstPeriod(reportDate) {
  const match = /^\s*(\d{1,2} [A-Za-z]{3} \d{4}) to (\d{1,2} [A-Za-z]{3} \d{4})\s*$/.exec(reportDate ?? "");
  if (!match) return null;
  const parsed = match.slice(1).map((part) => new Date(`${part} 00:00:00 GMT`));
  if (parsed.some((value) => Number.isNaN(value.getTime()))) return null;
  return { fromDate: parsed[0].toISOString().slice(0, 10), toDate: parsed[1].toISOString().slice(0, 10) };
}

export function registerReviewTools(server, xeroRequest) {
  server.registerTool("xero_list_accounts", {
    title: "List chart of accounts for review",
    description: "Read the chart of accounts, including archived accounts, so report account codes can be identified. This is not a general-ledger transaction listing.",
    inputSchema: {},
  }, wrap(async () => {
    const response = await xeroRequest("GET", "/Accounts");
    return (response.Accounts ?? []).map((account) => ({
      accountId: account.AccountID,
      code: account.Code,
      name: account.Name,
      class: account.Class,
      type: account.Type,
      status: account.Status,
      systemAccount: account.SystemAccount,
      taxType: account.TaxType,
      description: account.Description,
    })).sort((left, right) => String(left.code ?? "").localeCompare(String(right.code ?? "")));
  }));

  server.registerTool("xero_list_period_invoices", {
    title: "List invoices and bills for a review period",
    description: "Read one Xero page (up to 100) of invoices and supplier bills dated within a period. Filter by ACCREC or ACCPAY, status, or contact; use xero_get_invoice for complete lines. Invoice date is not payment date.",
    inputSchema: {
      fromDate: date, toDate: date, page,
      type: z.enum(["ACCREC", "ACCPAY"]).optional(),
      status: z.enum(["DRAFT", "SUBMITTED", "AUTHORISED", "PAID", "VOIDED", "DELETED"]).optional(),
      contactId: uuid.optional(),
    },
  }, wrap(async ({ fromDate, toDate, page, type, status, contactId }) => {
    const where = whereDates(fromDate, toDate) + (type ? ` AND Type=="${type}"` : "");
    const response = await xeroRequest("GET", "/Invoices", {
      query: {
        where, order: "Date ASC", page, unitdp: 4,
        ...(status ? { Statuses: status } : {}),
        ...(contactId ? { ContactIDs: contactId } : {}),
      },
    });
    const records = (response.Invoices ?? []).map((invoice) => ({
      invoiceId: invoice.InvoiceID,
      invoiceNumber: invoice.InvoiceNumber,
      type: invoice.Type,
      status: invoice.Status,
      date: invoice.DateString ?? invoice.Date,
      dueDate: invoice.DueDateString ?? invoice.DueDate,
      reference: invoice.Reference,
      contact: invoice.Contact && { contactId: invoice.Contact.ContactID, name: invoice.Contact.Name },
      currencyCode: invoice.CurrencyCode,
      subTotal: invoice.SubTotal,
      totalTax: invoice.TotalTax,
      total: invoice.Total,
      amountPaid: invoice.AmountPaid,
      amountCredited: invoice.AmountCredited,
      amountDue: invoice.AmountDue,
    }));
    return {
      ...pagedResult(records, response, page, 100, fromDate, toDate),
      source: { endpoint: "/Invoices", dateField: "Date", type: type ?? null, status: status ?? null, contactId: contactId ?? null },
      balanceTiming: "Status, amountPaid, amountCredited, and amountDue reflect Xero's current record state, not the balance as at toDate.",
    };
  }));

  server.registerTool("xero_list_bank_transactions", {
    title: "List bank transactions for accounts review",
    description: "Read one date-bounded page of spend/receive money transactions. Includes Xero IDs, account, contact, line items when returned, and reconciliation status. Use get_bank_transaction for complete lines; this is not a bank statement feed.",
    inputSchema: { fromDate: date, toDate: date, page, pageSize },
  }, wrap(async ({ fromDate, toDate, page, pageSize }) => {
    const response = await xeroRequest("GET", "/BankTransactions", {
      query: { where: whereDates(fromDate, toDate), order: "Date ASC", page, pageSize, unitdp: 4 },
    });
    const records = (response.BankTransactions ?? []).map((transaction) => ({
      bankTransactionId: transaction.BankTransactionID,
      type: transaction.Type,
      status: transaction.Status,
      date: transaction.DateString ?? transaction.Date,
      reference: transaction.Reference,
      contact: transaction.Contact && { contactId: transaction.Contact.ContactID, name: transaction.Contact.Name },
      bankAccount: transaction.BankAccount && { accountId: transaction.BankAccount.AccountID, code: transaction.BankAccount.Code, name: transaction.BankAccount.Name },
      isReconciled: transaction.IsReconciled,
      currencyCode: transaction.CurrencyCode,
      subTotal: transaction.SubTotal,
      totalTax: transaction.TotalTax,
      total: transaction.Total,
      lineItems: transaction.LineItems ?? null,
    }));
    return pagedResult(records, response, page, pageSize, fromDate, toDate);
  }));

  server.registerTool("xero_get_bank_transaction", {
    title: "Get bank transaction details",
    description: "Read one bank transaction by Xero ID, including all returned line items and reconciliation status.",
    inputSchema: { bankTransactionId: uuid },
  }, wrap(async ({ bankTransactionId }) => {
    const response = await xeroRequest("GET", `/BankTransactions/${bankTransactionId}`, { query: { unitdp: 4 } });
    const record = response.BankTransactions?.[0];
    if (!record) throw new Error(`Xero returned no bank transaction ${bankTransactionId}.`);
    return record;
  }));

  server.registerTool("xero_list_payments", {
    title: "List payments for accounts review",
    description: "Read one date-bounded page of payments, with payment, invoice, contact and bank-account identifiers. The API may not identify the matching bank statement line.",
    inputSchema: { fromDate: date, toDate: date, page, pageSize, invoiceId: uuid.optional() },
  }, wrap(async ({ fromDate, toDate, page, pageSize, invoiceId }) => {
    const where = whereDates(fromDate, toDate)
      + (invoiceId ? ` AND Invoice.InvoiceID=guid("${invoiceId}")` : "");
    const response = await xeroRequest("GET", "/Payments", { query: { where, order: "Date ASC", page, pageSize } });
    const records = (response.Payments ?? []).map((payment) => ({
      paymentId: payment.PaymentID,
      batchPaymentId: payment.BatchPaymentID,
      date: payment.DateString ?? payment.Date,
      reference: payment.Reference,
      status: payment.Status,
      paymentType: payment.PaymentType,
      isReconciled: payment.IsReconciled,
      amount: payment.Amount,
      bankAmount: payment.BankAmount,
      currencyRate: payment.CurrencyRate,
      invoice: payment.Invoice && {
        invoiceId: payment.Invoice.InvoiceID,
        invoiceNumber: payment.Invoice.InvoiceNumber,
        type: payment.Invoice.Type,
        contactId: payment.Invoice.Contact?.ContactID,
        contactName: payment.Invoice.Contact?.Name,
      },
      account: payment.Account && { accountId: payment.Account.AccountID, code: payment.Account.Code, name: payment.Account.Name },
    }));
    return pagedResult(records, response, page, pageSize, fromDate, toDate);
  }));

  server.registerTool("xero_list_manual_journals", {
    title: "List manual journals for accounts review",
    description: "Read one date-bounded page of manual journals, including lines where returned. Use get_manual_journal for full lines.",
    inputSchema: { fromDate: date, toDate: date, page, pageSize },
  }, wrap(async ({ fromDate, toDate, page, pageSize }) => {
    const response = await xeroRequest("GET", "/ManualJournals", {
      query: { where: whereDates(fromDate, toDate), order: "Date ASC", page, pageSize },
    });
    const records = (response.ManualJournals ?? []).map((journal) => ({
      manualJournalId: journal.ManualJournalID,
      date: journal.DateString ?? journal.Date,
      status: journal.Status,
      narration: journal.Narration,
      journalLines: journal.JournalLines ?? null,
      updatedDateUTC: journal.UpdatedDateUTC,
    }));
    return pagedResult(records, response, page, pageSize, fromDate, toDate);
  }));

  server.registerTool("xero_get_manual_journal", {
    title: "Get manual journal details",
    description: "Read one manual journal by Xero ID, including its journal lines and date.",
    inputSchema: { manualJournalId: uuid },
  }, wrap(async ({ manualJournalId }) => {
    const response = await xeroRequest("GET", `/ManualJournals/${manualJournalId}`);
    const record = response.ManualJournals?.[0];
    if (!record) throw new Error(`Xero returned no manual journal ${manualJournalId}.`);
    return record;
  }));

  server.registerTool("xero_get_profit_and_loss", {
    title: "Get Profit and Loss report",
    description: "Read the Xero Profit and Loss report for one explicit date range, at most 366 days. Choose cash-only or accrual basis explicitly; preserves report rows and cells.",
    inputSchema: { fromDate: date, toDate: date, paymentsOnly: z.boolean().default(false).describe("Request Xero cash-only basis; false requests accrual basis") },
  }, wrap(async ({ fromDate, toDate, paymentsOnly }) => {
    dateRange(fromDate, toDate);
    return { period: { fromDate, toDate }, requestedBasis: paymentsOnly ? "cash" : "accrual", ...(await xeroRequest("GET", "/Reports/ProfitAndLoss", { query: { fromDate, toDate, paymentsOnly } })) };
  }));

  server.registerTool("xero_get_balance_sheet", {
    title: "Get Balance Sheet report",
    description: "Read the Xero Balance Sheet as at an explicit date. Choose cash-only or accrual basis explicitly; preserves report rows and cells.",
    inputSchema: { date, paymentsOnly: z.boolean().default(false).describe("Request Xero cash-only basis; false requests accrual basis") },
  }, wrap(async ({ date: asAt, paymentsOnly }) => ({ asAt, requestedBasis: paymentsOnly ? "cash" : "accrual", ...(await xeroRequest("GET", "/Reports/BalanceSheet", { query: { date: asAt, paymentsOnly } })) })));

  server.registerTool("xero_get_trial_balance", {
    title: "Get Trial Balance report",
    description: "Read the Xero Trial Balance as at an explicit date. Choose cash-only or accrual basis explicitly; preserves report rows and cells.",
    inputSchema: { date, paymentsOnly: z.boolean().default(false).describe("Request Xero cash-only basis; false requests accrual basis") },
  }, wrap(async ({ date: asAt, paymentsOnly }) => ({ asAt, requestedBasis: paymentsOnly ? "cash" : "accrual", ...(await xeroRequest("GET", "/Reports/TrialBalance", { query: { date: asAt, paymentsOnly } })) })));

  server.registerTool("xero_list_gst_reports", {
    title: "List GST return reports",
    description: "Read Xero's report catalogue and return only GSTReturn entries overlapping an explicit date range. Use the returned report ID with get_gst_report. This does not show filing status.",
    inputSchema: { fromDate: date, toDate: date },
  }, wrap(async ({ fromDate, toDate }) => {
    dateRange(fromDate, toDate);
    const response = await xeroRequest("GET", "/Reports");
    return {
      requestedPeriod: { fromDate, toDate },
      reports: (response.Reports ?? [])
        .filter((report) => report.ReportType === "GSTReturn")
        .map((report) => ({ reportId: String(report.ReportID), reportName: report.ReportName, reportDate: report.ReportDate, period: gstPeriod(report.ReportDate) }))
        .filter((report) => report.period && report.period.fromDate <= toDate && report.period.toDate >= fromDate),
    };
  }));

  server.registerTool("xero_get_gst_report", {
    title: "Get GST return report figures",
    description: "Read a saved GSTReturn report by its catalogue ID, after verifying it is a GST report. Returns tax fields and period. Filing or submission status is not supplied by this API response.",
    inputSchema: { reportId: z.string().regex(/^(?:[0-9]+|[0-9a-fA-F-]{36})$/).describe("Report ID returned by xero_list_gst_reports") },
  }, wrap(async ({ reportId }) => {
    const catalogue = await xeroRequest("GET", "/Reports");
    const match = (catalogue.Reports ?? []).find((report) => String(report.ReportID).toLowerCase() === reportId.toLowerCase() && report.ReportType === "GSTReturn");
    if (!match) throw new Error("That report ID is not a GSTReturn report in the connected Xero organisation.");
    const response = await xeroRequest("GET", `/Reports/${encodeURIComponent(match.ReportID)}`);
    const report = response.Reports?.[0];
    if (!report || report.ReportType !== "GSTReturn") throw new Error("Xero did not return the requested GSTReturn report.");
    return { filingStatus: "Not provided by the Xero Reports API", report };
  }));
}
