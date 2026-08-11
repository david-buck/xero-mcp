import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { xeroRequest } from "./xero.js";

const server = new McpServer({ name: "xero-mcp", version: "0.1.0" });

const lineItemSchema = z.object({
  description: z.string().min(1).max(4000),
  quantity: z.number().positive(),
  unitAmount: z.number().finite(),
  accountCode: z.string().min(1).max(20),
  taxType: z.string().min(1).max(50).optional(),
});

function text(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function apiError(error) {
  return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
}

function invoiceSummary(invoice) {
  return {
    invoiceId: invoice.InvoiceID,
    invoiceNumber: invoice.InvoiceNumber,
    type: invoice.Type,
    status: invoice.Status,
    contact: invoice.Contact && { contactId: invoice.Contact.ContactID, name: invoice.Contact.Name },
    date: invoice.DateString ?? invoice.Date,
    dueDate: invoice.DueDateString ?? invoice.DueDate,
    total: invoice.Total,
    amountDue: invoice.AmountDue,
    currency: invoice.CurrencyCode,
  };
}

function fullInvoice(invoice) {
  return {
    ...invoiceSummary(invoice),
    reference: invoice.Reference,
    subTotal: invoice.SubTotal,
    totalTax: invoice.TotalTax,
    amountPaid: invoice.AmountPaid,
    amountCredited: invoice.AmountCredited,
    lineItems: invoice.LineItems,
  };
}

function toXeroLineItems(lineItems) {
  return lineItems.map((line) => ({
    Description: line.description,
    Quantity: line.quantity,
    UnitAmount: line.unitAmount,
    AccountCode: line.accountCode,
    ...(line.taxType ? { TaxType: line.taxType } : {}),
  }));
}

async function getDraftInvoice(invoiceId) {
  const result = await xeroRequest("GET", `/Invoices/${encodeURIComponent(invoiceId)}`);
  const invoice = result.Invoices?.[0];
  if (!invoice) throw new Error(`Xero did not return invoice ${invoiceId}.`);
  if (invoice.Status !== "DRAFT") {
    throw new Error(`Invoice ${invoiceId} is ${invoice.Status}, not DRAFT. This server only modifies draft invoices.`);
  }
  return invoice;
}

server.registerTool(
  "xero_find_contact",
  {
    title: "Find Xero contact",
    description: "Search Xero contacts by name or email and return their identifying information, including ContactID.",
    inputSchema: {
      query: z.string().trim().min(1).max(255).describe("Contact name or email to search for"),
      limit: z.number().int().min(1).max(100).default(20).describe("Maximum contacts to return"),
    },
  },
  async ({ query, limit }) => {
    try {
      const result = await xeroRequest("GET", "/Contacts", {
        query: { searchTerm: query, page: 1, pageSize: limit, summaryOnly: true },
      });
      return text((result.Contacts ?? []).map((contact) => ({
        contactId: contact.ContactID,
        name: contact.Name,
        email: contact.EmailAddress,
        contactNumber: contact.ContactNumber,
        accountNumber: contact.AccountNumber,
        status: contact.ContactStatus,
      })));
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "xero_list_invoices",
  {
    title: "List Xero invoices",
    description: "List recent Xero invoices. Optionally restrict the result to one contact.",
    inputSchema: {
      contactId: z.string().uuid().optional().describe("Optional Xero ContactID filter"),
      limit: z.number().int().min(1).max(100).default(20).describe("Maximum invoices to return"),
    },
  },
  async ({ contactId, limit }) => {
    try {
      const result = await xeroRequest("GET", "/Invoices", {
        query: {
          page: 1,
          pageSize: limit,
          order: "Date DESC",
          ...(contactId ? { ContactIDs: contactId } : {}),
        },
      });
      return text((result.Invoices ?? []).map(invoiceSummary));
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "xero_get_invoice",
  {
    title: "Get Xero invoice",
    description: "Fetch one Xero invoice, including all its line items.",
    inputSchema: { invoiceId: z.string().uuid().describe("Xero InvoiceID") },
  },
  async ({ invoiceId }) => {
    try {
      const result = await xeroRequest("GET", `/Invoices/${encodeURIComponent(invoiceId)}`);
      const invoice = result.Invoices?.[0];
      if (!invoice) throw new Error(`Xero did not return invoice ${invoiceId}.`);
      return text(fullInvoice(invoice));
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "xero_create_draft_invoice",
  {
    title: "Create draft Xero sales invoice",
    description: "Create an ACCREC sales invoice with status DRAFT only. It never approves, emails, or sends invoices.",
    inputSchema: {
      contactId: z.string().uuid().describe("Xero ContactID"),
      reference: z.string().max(255).optional(),
      invoiceDate: z.string().date().describe("Invoice date as YYYY-MM-DD"),
      dueDate: z.string().date().describe("Due date as YYYY-MM-DD"),
      lineItems: z.array(lineItemSchema).min(1).max(100),
    },
  },
  async ({ contactId, reference, invoiceDate, dueDate, lineItems }) => {
    try {
      const result = await xeroRequest("POST", "/Invoices", {
        body: {
          Invoices: [{
            Type: "ACCREC",
            Status: "DRAFT",
            Contact: { ContactID: contactId },
            Date: invoiceDate,
            DueDate: dueDate,
            ...(reference ? { Reference: reference } : {}),
            LineItems: toXeroLineItems(lineItems),
          }],
        },
      });
      const invoice = result.Invoices?.[0];
      if (!invoice) throw new Error("Xero did not return the created invoice.");
      if (invoice.Status !== "DRAFT") throw new Error(`Safety check failed: Xero returned ${invoice.Status}, expected DRAFT.`);
      return text(fullInvoice(invoice));
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "xero_update_draft_invoice",
  {
    title: "Update draft Xero invoice",
    description: "Update only a DRAFT Xero invoice. Authorised, paid, sent, and other non-draft invoices are rejected.",
    inputSchema: {
      invoiceId: z.string().uuid().describe("Xero InvoiceID"),
      reference: z.string().max(255).optional(),
      invoiceDate: z.string().date().optional().describe("Replacement invoice date as YYYY-MM-DD"),
      dueDate: z.string().date().optional().describe("Replacement due date as YYYY-MM-DD"),
      lineItems: z.array(lineItemSchema).min(1).max(100).optional(),
    },
  },
  async ({ invoiceId, reference, invoiceDate, dueDate, lineItems }) => {
    try {
      if (reference === undefined && invoiceDate === undefined && dueDate === undefined && lineItems === undefined) {
        throw new Error("Provide at least one field to update.");
      }
      await getDraftInvoice(invoiceId);
      const result = await xeroRequest("POST", `/Invoices/${encodeURIComponent(invoiceId)}`, {
        body: {
          Invoices: [{
            InvoiceID: invoiceId,
            Status: "DRAFT",
            ...(reference !== undefined ? { Reference: reference } : {}),
            ...(invoiceDate !== undefined ? { Date: invoiceDate } : {}),
            ...(dueDate !== undefined ? { DueDate: dueDate } : {}),
            ...(lineItems !== undefined ? { LineItems: toXeroLineItems(lineItems) } : {}),
          }],
        },
      });
      const invoice = result.Invoices?.[0];
      if (!invoice) throw new Error(`Xero did not return updated invoice ${invoiceId}.`);
      if (invoice.Status !== "DRAFT") throw new Error(`Safety check failed: Xero returned ${invoice.Status}, expected DRAFT.`);
      return text(fullInvoice(invoice));
    } catch (error) {
      return apiError(error);
    }
  },
);

await server.connect(new StdioServerTransport());
