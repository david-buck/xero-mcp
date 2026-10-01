import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { invoiceRevision, patchInvoiceLines, preserveReplacementDiscounts, invoiceChanges } from "./invoice-edits.js";

export function createServer({ xeroRequest }) {
  const server = new McpServer({ name: "xero-mcp", version: "0.3.0" }, { instructions: `For explicitly requested draft-invoice edits, first read xero_get_invoice and pass its revision as expectedRevision. Prefer lineItemPatches for narrow changes; preserve discounts and other omitted fields. Report changeSummary fields and resulting totals. Choose tax types using names and codes together, never the percentage alone. For recent contact billing, use xero_list_invoices with contactId and includeLineItems: true.` });

  function hasSupportedUnitPrecision(value) {
    const [mantissa, exponent = "0"] = String(value).split("e");
    const fractionalDigits = (mantissa.split(".")[1] ?? "").length;
    return fractionalDigits - Number(exponent) <= 4;
  }

  const updatesInFlight = new Set();
  const discountFields = {
    discountRate: z.number().finite().min(0).max(100).optional().describe("Percentage discount; set 0 explicitly to remove"),
    discountAmount: z.number().finite().nonnegative().optional().describe("Fixed discount; set 0 explicitly to remove"),
  };
  const monetaryLineSchema = z.object({
    lineItemId: z.string().uuid().optional().describe("Existing Xero LineItemID to preserve when replacing draft invoice lines"),
    itemCode: z.string().min(1).max(30).optional().describe("Optional existing Xero item code"),
    ...discountFields,
    description: z.string().min(1).max(4000),
    quantity: z.number().positive(),
    unitAmount: z.number().finite().refine(hasSupportedUnitPrecision, "Unit amount must have at most 4 decimal places."),
    accountCode: z.string().min(1).max(20),
    taxType: z.string().min(1).max(50).optional(),
  }).refine((line) => line.discountRate === undefined || line.discountAmount === undefined, "Choose discountRate or discountAmount, not both.");

  const descriptionLineSchema = z.object({
    description: z.string().min(1).max(4000),
    lineItemId: z.string().uuid().optional(),
    quantity: z.never().optional(),
    unitAmount: z.never().optional(),
    accountCode: z.never().optional(),
    itemCode: z.never().optional(),
    taxType: z.never().optional(),
    discountRate: z.never().optional(),
    discountAmount: z.never().optional(),
  });
  const lineItemSchema = z.union([monetaryLineSchema, descriptionLineSchema])
    .describe("A monetary line, or a description-only line with optional existing lineItemId and no monetary, item, or tax fields");

  const linePatchSchema = z.object({
    lineItemId: z.string().uuid(),
    description: z.string().min(1).max(4000).optional(),
    quantity: z.number().positive().optional(),
    unitAmount: z.number().finite().refine(hasSupportedUnitPrecision, "Unit amount must have at most 4 decimal places.").optional(),
    accountCode: z.string().min(1).max(20).optional(),
    itemCode: z.string().min(1).max(30).optional(),
    taxType: z.string().min(1).max(50).optional(),
    ...discountFields,
  }).strict().refine((line) => Object.keys(line).length > 1, "Provide at least one field to patch.")
    .refine((line) => line.discountRate === undefined || line.discountAmount === undefined, "Choose discountRate or discountAmount, not both.");

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
      revision: invoiceRevision(invoice),
      reference: invoice.Reference,
      lineAmountTypes: invoice.LineAmountTypes,
      subTotal: invoice.SubTotal,
      totalTax: invoice.TotalTax,
      amountPaid: invoice.AmountPaid,
      amountCredited: invoice.AmountCredited,
      lineItems: invoice.LineItems,
    };
  }

  function toXeroLineItems(lineItems) {
    return lineItems.map((line) => ({
      ...(line.lineItemId ? { LineItemID: line.lineItemId } : {}),
      ...(line.itemCode ? { ItemCode: line.itemCode } : {}),
      Description: line.description,
      ...(line.quantity !== undefined ? {
        Quantity: line.quantity,
        UnitAmount: line.unitAmount,
        AccountCode: line.accountCode,
      } : {}),
      ...(line.taxType ? { TaxType: line.taxType } : {}),
      ...(line.discountRate !== undefined ? { DiscountRate: line.discountRate } : {}),
      ...(line.discountAmount !== undefined ? { DiscountAmount: line.discountAmount } : {}),
    }));
  }

  function contactSalesDefaults(contact) {
    return {
      contactId: contact.ContactID,
      name: contact.Name,
      email: contact.EmailAddress,
      salesDefaultAccountCode: contact.SalesDefaultAccountCode,
      accountsReceivableTaxType: contact.AccountsReceivableTaxType,
      salesDefaultLineAmountType: contact.SalesDefaultLineAmountType,
      defaultCurrency: contact.DefaultCurrency,
    };
  }

  async function getDraftInvoice(invoiceId) {
    const result = await xeroRequest("GET", `/Invoices/${encodeURIComponent(invoiceId)}`, { query: { unitdp: 4 } });
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
    "xero_get_contact_defaults",
    {
      title: "Get Xero contact sales defaults",
      description: "Get a contact's invoice-relevant sales defaults, including its preferred account code and tax type.",
      inputSchema: { contactId: z.string().uuid().describe("Xero ContactID") },
    },
    async ({ contactId }) => {
      try {
        const result = await xeroRequest("GET", `/Contacts/${encodeURIComponent(contactId)}`);
        const contact = result.Contacts?.[0];
        if (!contact) throw new Error(`Xero did not return contact ${contactId}.`);
        return text(contactSalesDefaults(contact));
      } catch (error) {
        return apiError(error);
      }
    },
  );

  server.registerTool(
    "xero_list_revenue_accounts",
    {
      title: "List Xero revenue accounts",
      description: "List active revenue/sales accounts and their valid account codes for draft invoice line items.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await xeroRequest("GET", "/Accounts");
        const accounts = (result.Accounts ?? [])
          .filter((account) => account.Status === "ACTIVE")
          .filter((account) => account.Class === "REVENUE" || account.Type === "REVENUE" || account.Type === "SALES")
          .sort((left, right) => String(left.Code ?? "").localeCompare(String(right.Code ?? "")))
          .map((account) => ({
            accountId: account.AccountID,
            code: account.Code,
            name: account.Name,
            type: account.Type,
            defaultTaxType: account.TaxType,
            description: account.Description,
          }));
        return text(accounts);
      } catch (error) {
        return apiError(error);
      }
    },
  );

  server.registerTool(
    "xero_list_revenue_tax_rates",
    {
      title: "List Xero revenue tax rates",
      description: "List active tax types that Xero says can be applied to revenue invoice lines.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await xeroRequest("GET", "/TaxRates");
        const taxRates = (result.TaxRates ?? [])
          .filter((taxRate) => taxRate.Status === "ACTIVE" && String(taxRate.CanApplyToRevenue).toLowerCase() === "true")
          .map((taxRate) => ({
            taxType: taxRate.TaxType,
            name: taxRate.Name,
            label: `${taxRate.Name} (${taxRate.TaxType})`,
            rate: taxRate.DisplayTaxRate ?? taxRate.EffectiveRate,
            canApplyToRevenue: taxRate.CanApplyToRevenue,
          }));
        return text(taxRates);
      } catch (error) {
        return apiError(error);
      }
    },
  );

  server.registerTool(
    "xero_list_invoices",
    {
      title: "List Xero invoices",
      description: "List one page of invoices, newest by invoice date first. Optional contact and exact invoice-number filters combine. Use includeLineItems for a contact billing lookup with full invoice details in one response. Increment page until fewer than limit records are returned.",
      inputSchema: {
        contactId: z.string().uuid().optional().describe("Optional Xero ContactID filter"),
        limit: z.number().int().min(1).max(100).default(20).describe("Maximum invoices to return"),
        page: z.number().int().positive().default(1).describe("Page of matching invoices to return"),
        includeLineItems: z.boolean().default(false).describe("Include full line items for compact contact billing lookup"),
        invoiceNumber: z.string().trim().min(1).max(255).refine((value) => !value.includes(","), "Provide one invoice number without commas.").optional().describe("Exact invoice number; commas are not supported"),
      },
    },
    async ({ contactId, limit, page, invoiceNumber, includeLineItems }) => {
      try {
        const result = await xeroRequest("GET", "/Invoices", {
          query: {
            page,
            pageSize: limit,
            order: "Date DESC",
            unitdp: 4,
            ...(contactId ? { ContactIDs: contactId } : {}),
            ...(invoiceNumber !== undefined ? { InvoiceNumbers: invoiceNumber } : {}),
          },
        });
        const invoices = result.Invoices ?? [];
        if (!includeLineItems) return text(invoices.map(invoiceSummary));
        const details = [];
        for (const invoice of invoices) {
          if (Array.isArray(invoice.LineItems) && invoice.LineItems.length > 0) details.push(fullInvoice(invoice));
          else {
            const detail = await xeroRequest("GET", `/Invoices/${encodeURIComponent(invoice.InvoiceID)}`, { query: { unitdp: 4 } });
            if (!detail.Invoices?.[0]) throw new Error(`Xero did not return invoice ${invoice.InvoiceID}.`);
            details.push(fullInvoice(detail.Invoices[0]));
          }
        }
        return text(details);
      } catch (error) {
        return apiError(error);
      }
    },
  );

  server.registerTool(
    "xero_get_invoice",
    {
      title: "Get Xero invoice",
      description: "Fetch one Xero invoice including line items and a revision required as expectedRevision for any update.",
      inputSchema: { invoiceId: z.string().uuid().describe("Xero InvoiceID") },
    },
    async ({ invoiceId }) => {
      try {
        const result = await xeroRequest("GET", `/Invoices/${encodeURIComponent(invoiceId)}`, { query: { unitdp: 4 } });
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
        currencyCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Currency code must contain exactly three ASCII letters.").optional().describe("Optional currency enabled in Xero; unit amounts use this currency. Omission uses the organisation base currency."),
        lineAmountTypes: z.enum(["Exclusive", "Inclusive", "NoTax"]).default("Exclusive").describe("Invoice tax basis; omitted values use Exclusive"),
        lineItems: z.array(lineItemSchema).min(1).max(100),
      },
    },
    async ({ contactId, reference, invoiceDate, dueDate, currencyCode, lineAmountTypes, lineItems }) => {
      try {
        const result = await xeroRequest("POST", "/Invoices", {
          query: { unitdp: 4 },
          body: {
            Invoices: [{
              Type: "ACCREC",
              Status: "DRAFT",
              LineAmountTypes: lineAmountTypes,
              ...(currencyCode !== undefined ? { CurrencyCode: currencyCode } : {}),
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
        if (invoice.HasErrors || invoice.ValidationErrors?.length) throw new Error(`Xero rejected invoice: ${JSON.stringify(invoice.ValidationErrors ?? [])}`);
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
      description: "Update only a DRAFT invoice using expectedRevision from xero_get_invoice. Prefer lineItemPatches for narrow edits: omitted fields and other lines are preserved. lineItems intentionally replaces the complete line set; existing IDs preserve omitted discounts. Returns actual before/after changes and totals. Rejects stale revisions before writing; external edits during the request cannot be locked.",
      inputSchema: {
        invoiceId: z.string().uuid().describe("Xero InvoiceID"),
        reference: z.string().max(255).optional(),
        invoiceDate: z.string().date().optional().describe("Replacement invoice date as YYYY-MM-DD"),
        dueDate: z.string().date().optional().describe("Replacement due date as YYYY-MM-DD"),
        expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).describe("Revision returned by xero_get_invoice; stale reads are rejected"),
        lineItemPatches: z.array(linePatchSchema).min(1).max(100).optional(),
        lineItems: z.array(lineItemSchema).min(1).max(100).optional(),
      },
    },
    async ({ invoiceId, expectedRevision, reference, invoiceDate, dueDate, lineItems, lineItemPatches }) => {
      let ownsLock = false;
      try {
        if (reference === undefined && invoiceDate === undefined && dueDate === undefined && lineItems === undefined && lineItemPatches === undefined) {
          throw new Error("Provide at least one field to update.");
        }
        if (lineItems !== undefined && lineItemPatches !== undefined) throw new Error("Choose lineItemPatches or complete lineItems replacement, not both.");
        if (updatesInFlight.has(invoiceId)) throw new Error("An update to this invoice is already in progress. Read it again after that update completes.");
        updatesInFlight.add(invoiceId);
        ownsLock = true;
        const before = await getDraftInvoice(invoiceId);
        if (invoiceRevision(before) !== expectedRevision) throw new Error("Invoice changed since it was read. No update was sent. Read the invoice again and review your changes.");
        const replacementLines = lineItemPatches !== undefined
          ? patchInvoiceLines(before.LineItems ?? [], lineItemPatches)
          : lineItems !== undefined ? preserveReplacementDiscounts(before.LineItems ?? [], toXeroLineItems(lineItems)) : undefined;
        const result = await xeroRequest("POST", `/Invoices/${encodeURIComponent(invoiceId)}`, {
          query: { unitdp: 4 },
          body: {
            Invoices: [{
              InvoiceID: invoiceId,
              Status: "DRAFT",
              ...(reference !== undefined ? { Reference: reference } : {}),
              ...(invoiceDate !== undefined ? { Date: invoiceDate } : {}),
              ...(dueDate !== undefined ? { DueDate: dueDate } : {}),
              ...(replacementLines !== undefined ? { LineItems: replacementLines } : {}),
            }],
          },
        });
        const invoice = result.Invoices?.[0];
        if (!invoice) throw new Error(`Xero did not return updated invoice ${invoiceId}.`);
        if (invoice.HasErrors || invoice.ValidationErrors?.length) throw new Error(`Xero rejected invoice: ${JSON.stringify(invoice.ValidationErrors ?? [])}`);
        if (invoice.Status !== "DRAFT") throw new Error(`Safety check failed: Xero returned ${invoice.Status}, expected DRAFT.`);
        const after = fullInvoice(invoice);
        return text({ ...after, changeSummary: invoiceChanges(fullInvoice(before), after) });
      } catch (error) {
        return apiError(error);
      } finally {
        if (ownsLock) updatesInFlight.delete(invoiceId);
      }
    },
  );

  return server;
}
