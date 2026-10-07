import { z } from "zod";

const topics = ["year_comparison", "trace_figure", "debtors_creditors", "gst"];

const topicLabels = {
  year_comparison: "Compare two financial periods",
  trace_figure: "Trace a figure to supporting Xero records",
  debtors_creditors: "Review debtors and creditors at a date",
  gst: "Review GST report figures",
};

const commonLimits = `
## Evidence and limits
- State the organisation, date range or as-at date, currency, and any accounting/report basis that is actually known. Ask for missing dates or organisation when needed; never silently assume a financial year.
- Start with the relevant Xero report, then drill into only the material or unexplained lines. Preserve Xero record IDs, dates, statuses, account codes, and amounts so findings can be checked.
- Period-list tools return pages. Follow nextPage until it is null; a full page is not proof that the result set is complete. Report which pages were fetched and whether completeness was established. Fetch full invoice, bank-transaction, or journal details when line-level evidence is needed.
- Separate observations from explanations and hypotheses. Cite the records that support each explanation and say what remains unverified. Do not infer a transaction's purpose from a payee or narration alone.
- A Xero bank transaction is not the underlying bank statement line, even when marked reconciled. Manual-journal endpoints cover manual journals, not the complete general journal. GST report figures do not establish that a return was filed, submitted, accepted, or paid.
- This is bookkeeping-data investigation, not tax, audit, or legal advice. Do not auto-reconcile, change accounting records, or claim a tax treatment is correct. Ask the user to confirm material ambiguity and refer tax/accounting judgements to their accountant.
- Keep any invoice-draft or other write capability separate from review. Do not create, edit, approve, or send records as part of an investigation unless the user explicitly asks for that separate action.
`;

const workflows = {
  year_comparison: `## Workflow: compare two periods
1. Start with xero_review_context to confirm the connected organisation and reporting context. Required: two exact, comparable inclusive YYYY-MM-DD ranges (for example, matching financial years) and the same report basis for both. Ask rather than guess if missing.
2. Call xero_get_profit_and_loss once per range with the same paymentsOnly value. Compare corresponding report rows using labels/codes and currency; show the arithmetic for absolute and percentage movements, handling zero or negative comparators explicitly.
3. Call xero_get_balance_sheet at each period end when position changes matter. These are point-in-time balances, not period activity; xero_get_trial_balance is an optional account-level closing-balance cross-check.
4. Rank material movements, explain only what the report and fetched supporting records establish, and list unexplained movements and likely next evidence to request.
5. Say clearly if the reports use a basis or tracking-category view that has not been verified. Do not present a comparison as a full audit or reconciliation.`,
  trace_figure: `## Workflow: trace a figure
1. Start with xero_review_context to confirm organisation and reporting context. Required: report/figure, exact period (fromDate/toDate) or as-at date, and any account/record clue. Clarify whether the target is a report total, account row, invoice, payment, or bank item.
2. Call xero_get_profit_and_loss, xero_get_balance_sheet, or xero_get_trial_balance as appropriate; identify the exact row/column/cell and period. Use xero_list_accounts to resolve account codes, including archived accounts.
3. xero_list_period_invoices supports dates, type, status, and contact (not account-code filtering); xero_list_payments additionally supports invoiceId; xero_list_bank_transactions and xero_list_manual_journals support date paging. xero_list_credit_notes supports dates, type, status, and contact. Follow every page through nextPage=null; then use xero_get_invoice, xero_get_bank_transaction, xero_get_manual_journal, or xero_get_credit_note for complete record details. Do not assume invoice date equals payment date.
4. Reconcile only what the returned evidence permits. State unmatched totals, possible timing/classification differences, and missing evidence; do not imply the API provides a complete general ledger or bank statement.`,
  debtors_creditors: `## Workflow: debtors and creditors
1. Start with xero_review_context. Required: as-at date (YYYY-MM-DD), currency, and whether sales (ACCREC), purchases (ACCPAY), or both. Clarify whether they need open items, period activity, or an ageing schedule.
2. Call xero_get_balance_sheet at the as-at date for receivables/payables control-account balances. Search xero_list_period_invoices for ACCREC/ACCPAY invoices in explicit date windows of at most 366 days; repeat earlier windows if older open items matter, and fetch material items with xero_get_invoice. Check xero_list_credit_notes and fetch material notes with xero_get_credit_note. Use xero_list_payments over explicit date windows to investigate settlement timing; invoice date and payment date differ.
3. Compare populations and totals cautiously: the available list is not a dedicated aged receivables/payables report, and an old invoice's current status/amountDue does not show what was open at the as-at date. Credit notes, allocations, later changes, and multicurrency can affect the result.
4. Present the report control balance separately from the source-record sample/population. State whether a complete historical ageing or subledger tie-out was possible; request an Xero ageing report/accountant export if not.`,
  gst: `## Workflow: GST
1. Start with xero_review_context to confirm organisation/country, but do not treat that as a tax ruling. Required: jurisdiction and exact return period (YYYY-MM-DD from/to); clarify whether the request concerns figures, supporting transactions, or filing status. Do not infer jurisdiction from currency.
2. Call xero_list_gst_reports for the period, select the exact report, then call xero_get_gst_report with its reportId. Preserve fields/boxes and displayed dates as returned.
3. If asked to explain a box, compare the report figures to relevant account/report rows and transaction evidence for the same basis and period. Be explicit about limitations and unresolved differences.
4. The report endpoint supplies figures, not filed/submitted/accepted/paid status. Direct the user to Xero/IRD or their accountant to verify filing status and tax treatment; never state or submit a return on the basis of these figures alone.`,
};

export const reviewServerInstructions = `For Xero review requests, use xero_review_context to establish connected-organisation context and xero_review_guide (or the xero_review prompt) to shape scope. Require explicit dates; preserve report rows and source IDs, follow paginated lists until nextPage is null, and disclose incomplete evidence. Separate facts from hypotheses. Do not claim bank transactions are statement lines, manual journals are the complete general journal, or GST figures prove filing status; do not auto-reconcile or give tax advice. Keep review read-only and any draft-invoice write request separate and explicitly user-directed.`;

function buildGuide({ topic, question, fromDate, toDate, comparisonFromDate, comparisonToDate, asAtDate, organisation }) {
  const dates = fromDate || toDate || comparisonFromDate || comparisonToDate || asAtDate
    ? `Requested dates: ${fromDate ?? "(start not supplied)"} to ${toDate ?? "(end not supplied)"}${comparisonFromDate || comparisonToDate ? `; comparison ${comparisonFromDate ?? "(start not supplied)"} to ${comparisonToDate ?? "(end not supplied)"}` : ""}${asAtDate ? `; as at ${asAtDate}` : ""}.`
    : "No dates supplied: ask for the relevant period or as-at date before querying Xero.";
  return `# Xero review guide: ${topicLabels[topic]}\n\n${question ? `Question: ${question}\n` : "Question: (not supplied; clarify the decision or figure the user wants to understand.)\n"}${organisation ? `Organisation: ${organisation}\n` : "Organisation: confirm the connected Xero organisation before interpreting records.\n"}${dates}\n\n${workflows[topic]}\n${commonLimits}`;
}

const inputSchema = {
  topic: z.enum(topics).describe("Kind of review: year_comparison, trace_figure, debtors_creditors, or gst"),
  question: z.string().trim().min(1).max(2000).optional().describe("What the user wants to understand, in their own words"),
  organisation: z.string().trim().min(1).max(255).optional().describe("Organisation name if already known; otherwise ask the user to confirm"),
  fromDate: z.iso.date().optional().describe("Inclusive period start (YYYY-MM-DD), when relevant"),
  toDate: z.iso.date().optional().describe("Inclusive period end (YYYY-MM-DD), when relevant"),
  comparisonFromDate: z.iso.date().optional().describe("Second period start for year comparison (YYYY-MM-DD)"),
  comparisonToDate: z.iso.date().optional().describe("Second period end for year comparison (YYYY-MM-DD)"),
  asAtDate: z.iso.date().optional().describe("Balance-sheet or open-item date (YYYY-MM-DD), when relevant"),
};

/** Register guidance-only MCP affordances. Neither handler has access to Xero. */
export function registerGuidance(server) {
  server.registerTool("xero_review_guide", {
    title: "Plan a Xero review",
    description: "Guidance only: shape a year comparison, trace a figure, review debtors/creditors, or inspect GST figures. Makes no Xero API calls and does not change records.",
    inputSchema,
  }, async (args) => ({ content: [{ type: "text", text: buildGuide(args) }] }));

  server.registerPrompt("xero_review", {
    title: "Investigate a Xero question",
    description: "Guided, evidence-led workflow for year comparisons, tracing figures, debtors/creditors, or GST. Clarify scope, paginate fully, and disclose limits.",
    argsSchema: inputSchema,
  }, async (args) => ({
    messages: [{ role: "user", content: { type: "text", text: buildGuide(args) } }],
  }));
}
