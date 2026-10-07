import { z } from "zod";

const date = z.iso.date().describe("Date in YYYY-MM-DD format");
const page = z.number().int().min(1).max(100000).default(1).describe("Xero page number, starting at 1");
const pageSize = z.number().int().min(1).max(100).default(100).describe("Credit notes per page (Xero supports up to 100)");
const uuid = z.string().uuid();

function text(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error) {
  return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
}

function wrap(handler) {
  return async (args) => {
    try { return text(await handler(args)); }
    catch (error) { return errorResult(error); }
  };
}

function dateRange(fromDate, toDate) {
  const start = Date.parse(`${fromDate}T00:00:00Z`);
  const end = Date.parse(`${toDate}T00:00:00Z`);
  if (end < start) throw new Error("toDate must be on or after fromDate.");
  // Inclusive calendar-day count must be at most 366.
  if (end - start >= 366 * 24 * 60 * 60 * 1000) {
    throw new Error("A single request may cover at most 366 calendar days. Split longer reviews into date ranges.");
  }
}

function xeroDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return `DateTime(${year}, ${month}, ${day})`;
}

function whereClause({ fromDate, toDate, type, status, contactId }) {
  dateRange(fromDate, toDate);
  const clauses = [
    `Date>=${xeroDate(fromDate)}`,
    `Date<=${xeroDate(toDate)}`,
  ];
  if (type) clauses.push(`Type=="${type}"`);
  if (status) clauses.push(`Status=="${status}"`);
  if (contactId) clauses.push(`Contact.ContactID=guid("${contactId}")`);
  return clauses.join(" AND ");
}

function mapContact(contact) {
  return contact ? { contactId: contact.ContactID, name: contact.Name } : null;
}

function mapLine(line) {
  return {
    lineItemId: line.LineItemID,
    description: line.Description,
    quantity: line.Quantity,
    unitAmount: line.UnitAmount,
    lineAmount: line.LineAmount,
    taxType: line.TaxType,
    taxAmount: line.TaxAmount,
    accountCode: line.AccountCode,
    itemCode: line.ItemCode,
    tracking: (line.Tracking ?? []).map((tracking) => ({
      categoryId: tracking.TrackingCategoryID,
      categoryName: tracking.Name,
      option: tracking.Option,
    })),
  };
}

function mapAllocation(allocation) {
  return {
    allocationId: allocation.AllocationID,
    date: allocation.DateString ?? allocation.Date,
    amount: allocation.Amount,
    invoice: allocation.Invoice ? {
      invoiceId: allocation.Invoice.InvoiceID,
      invoiceNumber: allocation.Invoice.InvoiceNumber,
      type: allocation.Invoice.Type,
    } : null,
  };
}

function mapPayment(payment) {
  return {
    paymentId: payment.PaymentID,
    date: payment.DateString ?? payment.Date,
    amount: payment.Amount,
    reference: payment.Reference,
    currencyRate: payment.CurrencyRate,
  };
}

function mapCreditNote(note) {
  return {
    creditNoteId: note.CreditNoteID,
    creditNoteNumber: note.CreditNoteNumber,
    type: note.Type,
    status: note.Status,
    date: note.DateString ?? note.Date,
    updatedDateUTC: note.UpdatedDateUTCString ?? note.UpdatedDateUTC,
    reference: note.Reference,
    contact: mapContact(note.Contact),
    currencyCode: note.CurrencyCode,
    currencyRate: note.CurrencyRate,
    lineAmountTypes: note.LineAmountTypes,
    subTotal: note.SubTotal,
    totalTax: note.TotalTax,
    total: note.Total,
    remainingCredit: note.RemainingCredit,
    hasAttachments: note.HasAttachments,
    allocations: (note.Allocations ?? []).map(mapAllocation),
    payments: (note.Payments ?? []).map(mapPayment),
    lineItems: (note.LineItems ?? []).map(mapLine),
  };
}

export function registerCreditNoteTools(server, xeroRequest) {
  server.registerTool("xero_list_credit_notes", {
    title: "List Xero credit notes for a review period",
    description: "Read one date-bounded page of customer and supplier credit notes. Xero pages credit notes (up to 100 per page) and includes line items; follow nextPage until null for a complete result. Filter by customer/supplier type, status, or contact. Credit-note date is not necessarily its allocation or payment date. This is read-only.",
    inputSchema: {
      fromDate: date,
      toDate: date,
      page,
      pageSize,
      type: z.enum(["ACCRECCREDIT", "ACCPAYCREDIT"]).optional().describe("Customer credit note (ACCRECCREDIT) or supplier credit note (ACCPAYCREDIT)"),
      status: z.enum(["DRAFT", "SUBMITTED", "AUTHORISED", "PAID", "VOIDED", "DELETED"]).optional(),
      contactId: uuid.optional().describe("Xero ContactID to restrict the list to one customer or supplier"),
    },
  }, wrap(async ({ fromDate, toDate, page, pageSize, type, status, contactId }) => {
    const where = whereClause({ fromDate, toDate, type, status, contactId });
    const response = await xeroRequest("GET", "/CreditNotes", {
      query: { where, order: "Date ASC", page, pageSize, unitdp: 4 },
    });
    const records = (response.CreditNotes ?? []).map(mapCreditNote);
    const pagination = response.pagination ?? null;
    const hasReportedPageCount = pagination?.pageCount != null;
    const nextPage = hasReportedPageCount
      ? (page < pagination.pageCount ? page + 1 : null)
      : (records.length === pageSize ? page + 1 : null);
    return {
      period: { fromDate, toDate },
      page,
      pageSize,
      returned: records.length,
      pagination,
      nextPage,
      nextPageBasis: hasReportedPageCount ? "Xero pageCount" : "full-page heuristic",
      source: { endpoint: "/CreditNotes", dateField: "Date", type: type ?? null, status: status ?? null, contactId: contactId ?? null },
      balanceTiming: "Status and remainingCredit reflect Xero's current record state, not the balance as at toDate.",
      records,
    };
  }));

  server.registerTool("xero_get_credit_note", {
    title: "Get Xero credit note details",
    description: "Read one credit note by Xero CreditNoteID, including lines, allocations to invoices, payments, remaining credit, and key identifiers. This is read-only.",
    inputSchema: { creditNoteId: uuid.describe("Xero CreditNoteID") },
  }, wrap(async ({ creditNoteId }) => {
    const response = await xeroRequest("GET", `/CreditNotes/${encodeURIComponent(creditNoteId)}`, { query: { unitdp: 4 } });
    const note = response.CreditNotes?.[0];
    if (!note) throw new Error(`Xero returned no credit note ${creditNoteId}. Check the ID and that it belongs to the connected organisation.`);
    return mapCreditNote(note);
  }));
}
