# xero-mcp

A local Xero MCP server for Claude Desktop and other STDIO MCP clients. It reads accounting records and reports, guides evidence-based reviews, and creates or edits drafts when explicitly requested.

Version 0.4.0 adds 16 tools to the previous eight-tool release. See [CHANGELOG.md](CHANGELOG.md).

## What it can change

- `xero_create_draft_invoice` creates an `ACCREC` sales invoice with `Status: DRAFT`.
- `xero_update_draft_invoice` edits reference, dates or lines on an existing `DRAFT` invoice after checking its revision. It also accepts draft supplier bills (`ACCPAY`); it does not restrict updates to sales invoices.
- There are no tools to create, edit, merge or clean up contacts; approve, send, email, pay, void or delete invoices; create payments, credit notes or journals; reconcile bank items; or submit a GST return.

The new review tools make only accounting-data `GET` requests. Token refresh separately uses Xero's OAuth endpoint. Draft-only restrictions are enforced by this code: the `accounting.invoices` OAuth scope itself grants broader invoice access. Review authorisation retains that scope, and this release has no read-only mode that removes the two draft tools. Review guidance asks the client to keep investigation separate from explicitly requested writes.

Draft updates reject stale revisions and overlapping updates within one server process. They cannot lock external Xero edits during a request. Local draft creation has no durable billing-event idempotency ledger: after a timeout, check Xero before creating another draft.

## Where it runs

The supported setup runs on your **Mac** using Node and a local STDIO MCP client. Claude Desktop starts the process on your computer. It is not an HTTPS connector, and cloning it does not make it available to Claude web/mobile or cloud routines. Hosted OAuth/storage work is not part of this supported release. See [Claude's local-versus-remote connector requirements](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

Tokens are stored locally as plaintext at `~/.xero-mcp/tokens.json`, with directory mode `0700` and file mode `0600`. Xero API requests go to Xero; returned records are passed to your MCP client/model. Use a private OS account and keep credentials, token files and exported financial data out of chat, Git and public issues. Each Mac user has one token-store location; multiple clones under the same OS user share it. Run one client process at a time to avoid competing refreshes.

## Setup for a new user

You need macOS, Git, Node **24 LTS recommended** (minimum Node 20.6 for `--env-file`), Claude Desktop or another STDIO client, and access to your own Xero organisation. Your Xero role must permit the requested records/reports; saved scopes alone do not establish that permission.

### 1. Create your own Xero developer app

1. Open [Xero Developer → My Apps](https://developer.xero.com/app/manage).
2. For the existing personal-script flow, create a **Web app** using **Standard auth code**.
3. Register exactly `http://localhost:3000/callback`, then copy its Client ID and generate its Client Secret.

Use **your own app credentials**, not the repo author's `.env`, client secret or saved tokens. The current code requires a secret. It does not implement PKCE or a shared-app onboarding service. Xero requires PKCE for distributed native desktop apps; a future shared desktop integration should use that flow instead of distributing a confidential app secret. See [Xero's OAuth guidance](https://developer.xero.com/documentation/guides/oauth2/overview).

### 2. Install and configure privately

```bash
git clone https://github.com/david-buck/xero-mcp.git
cd xero-mcp
npm ci
cp .env.example .env
chmod 600 .env
```

Edit `.env` locally, replacing `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET` with values from **your** app. Keep `XERO_REDIRECT_URI=http://localhost:3000/callback`. Do not paste credentials into Claude. These steps describe setup; no credential or grant is supplied by this repository.

`XERO_TENANT_ID` selects the exact organisation. If one organisation is connected, auth uses that sole connection and prints its name. If several are connected, auth refuses to choose and lists their names/tenant IDs in your terminal. Set `XERO_TENANT_ID` to your chosen ID in `.env` and run auth again. A configured ID that is not authorized is rejected. Confirm the resulting organisation before requesting records.

### 3. Authorize your own Xero connection

For the expanded accounting-review tools, run:

```bash
npm run auth:review
```

For just the original contact/invoice operations, use `npm run auth`. The listener binds to `localhost:3000`, opens Xero in your browser and waits up to ten minutes. Sign in as yourself, select only the intended organisation, review the requested access and approve it. The callback checks a random state before exchanging the code. The server then validates the chosen tenant and saves your tokens locally. It refreshes them automatically until revoked or renewal fails.

The base grant requests:

```text
offline_access accounting.contacts.read accounting.invoices accounting.settings.read
```

`auth:review` additionally requests `accounting.banktransactions.read`, `accounting.payments.read`, `accounting.manualjournals.read`, `accounting.reports.profitandloss.read`, `accounting.reports.balancesheet.read`, `accounting.reports.trialbalance.read` and `accounting.reports.taxreports.read`. Re-run review auth for these scopes; changing the app configuration alone does not update an existing grant. This grant still permits the existing draft tools.

To disconnect, revoke this app's access in Xero and quit the MCP client. Removing the local token file alone does not revoke a grant. To switch organisations, set the intended tenant and re-authorize; the current token store supports one selected tenant at a time.

### 4. Connect Claude Desktop

In Claude Desktop, open **Settings → Developer → Edit Config**. On macOS the file is `~/Library/Application Support/Claude/claude_desktop_config.json`. Merge this entry into existing `mcpServers` without removing other servers:

```json
{
  "mcpServers": {
    "xero": {
      "command": "/ABSOLUTE/PATH/TO/node",
      "args": [
        "--env-file=/ABSOLUTE/PATH/TO/xero-mcp/.env",
        "/ABSOLUTE/PATH/TO/xero-mcp/src/index.js"
      ]
    }
  }
}
```

Use `command -v node` to find your Node executable and `pwd` inside the clone for the repo path; substitute both absolute paths. Fully quit and reopen Claude Desktop, then check the Xero tools in the connectors list. See the [local MCP setup guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

For the first read, ask: **“Use xero_review_context to show which organisation, currency and financial year this connection uses. Do not create or edit anything.”** Confirm it is yours. The response shows scope names/gaps, never credentials. For a review, give exact dates and use `xero_review_guide`; for example: **“Compare profit for 2024-04-01 to 2025-03-31 and 2025-04-01 to 2026-03-31 on the same basis. Keep this read-only and show evidence and gaps.”**

Claude can walk you through this README. A useful setup request is: **“Help me install this local Xero MCP on my Mac, create my own Xero app, enter secrets privately, select the right tenant and configure Claude Desktop. Explain each step, keep credentials out of chat, and verify the organisation with a read only.”** You personally complete Xero sign-in and consent.

### Other clients and troubleshooting

For Codex, merge this into `~/.codex/config.toml`, replacing the absolute paths, then restart:

```toml
[mcp_servers.xero]
command = "/ABSOLUTE/PATH/TO/node"
args = ["--env-file=/ABSOLUTE/PATH/TO/xero-mcp/.env", "/ABSOLUTE/PATH/TO/xero-mcp/src/index.js"]
```

If Claude cannot start the server, check the absolute Node/repo paths, JSON syntax and `node --version`. If Xero consent fails, check the exact registered callback and whether port 3000 is already occupied. For missing review access, run `npm run auth:review` again and check the user's Xero role. Do not paste `.env`, token files or unredacted financial responses into troubleshooting conversations.

## Tools

Version 0.4.0 exposes **24 tools**: 22 read/context/guidance tools and the two draft-invoice write tools, plus the `xero_review` MCP prompt.

| Tool | What it does |
| --- | --- |
| `xero_find_contact` | Search contacts by name or email and return their Xero Contact ID. |
| `xero_get_contact_defaults` | Get a contact's default sales account code, tax type, currency, and line-amount preference. |
| `xero_list_revenue_accounts` | List active revenue/sales account codes that can be used on invoice lines. |
| `xero_list_revenue_tax_rates` | List active revenue tax types with their names, codes, and combined labels. |
| `xero_list_invoices` | List newest invoices by contact or number; optionally include full line items. |
| `xero_list_period_invoices` | Review invoices and supplier bills by invoice date, with optional type, status, and contact filters. |
| `xero_list_accounts` | Identify current and archived account codes behind report figures. |
| `xero_list_credit_notes` / `xero_get_credit_note` | Review customer and supplier credit notes, lines, allocations, and payments. |
| `xero_get_invoice` | Fetch an invoice including its line items. |
| `xero_create_draft_invoice` | Make a sales invoice with `Status: DRAFT`. |
| `xero_update_draft_invoice` | Patch an existing draft invoice or supplier bill with a checked revision and actual before/after summary. |
| `xero_list_bank_transactions` / `xero_get_bank_transaction` | Page through dated spend/receive transactions and inspect line details and reconciliation flags. |
| `xero_list_payments` | Page through dated payments with invoice and account identifiers; optionally filter by invoice ID. |
| `xero_list_manual_journals` / `xero_get_manual_journal` | Page through dated manual journals and inspect journal lines. |
| `xero_get_profit_and_loss` / `xero_get_balance_sheet` / `xero_get_trial_balance` | Read fixed reports for a date range or as-at date. |
| `xero_list_gst_reports` / `xero_get_gst_report` | Find saved GST returns overlapping a date range, then inspect one return's fields by its verified report ID. |
| `xero_review_context` | Check organisation currency, financial-year settings, and saved grant scope names without exposing tokens. |
| `xero_review_guide` | Get a no-API-call workflow for year comparison, tracing a figure, debtors/creditors, or GST. |

The date-bounded transaction and credit-note tools require `fromDate` and `toDate` (`YYYY-MM-DD`), and each request covers at most 366 calendar days. They return one page at a time (`page` starts at 1; `pageSize` defaults to 100 and cannot exceed 100 where supported), together with `returned`, any Xero pagination metadata, and `nextPage` when another page may exist. A full page may need one more call to establish that the list is complete. `xero_list_period_invoices` uses Xero's fixed 100-item invoice pages. Use the individual-record tools when a list response lacks lines. The new Xero review reads make only `GET` data requests; OAuth token refresh may separately call Xero's token endpoint.

Profit and Loss takes `fromDate` and `toDate`; Balance Sheet and Trial Balance take an as-at `date`. All three expose `paymentsOnly` (default `false` for requested accrual basis; `true` requests cash-only basis) and return the requested basis alongside Xero's report. Use the same basis on both sides of a comparison. GST report listing takes `fromDate` and `toDate`, and the detail tool takes a report ID returned by that listing. The GST date range selects saved returns whose periods overlap it; it does not recalculate an arbitrary period. Financial report tools preserve Xero's nested rows and cells; GST returns preserve their fields and values. The Reports API response does not establish whether a GST return was filed or submitted, so verify that status in Xero.

This server does not expose the full `/Journals` API. Xero gates it behind its Advanced developer tier, certification and use-case approval, plus Reports access for the authorising user. Manual journals are a separate endpoint and do not replace full general-ledger journals. The bank-transaction endpoint is not a bank statement feed, and a payment's account and reconciliation flag do not by themselves prove which imported statement line it matches.

## What a year-end review can answer

Start with `xero_review_context` to confirm the connected organisation, currency, and financial-year settings. Then call `xero_review_guide` with `topic: "year_comparison"`, `"trace_figure"`, `"debtors_creditors"`, or `"gst"`. The server also offers an `xero_review` MCP prompt for clients that surface prompts; the guide tool works without prompt support. Both give the client the question-shaped workflow and evidence limits, not an automatic answer or Xero write.

For a financial-year comparison, read Profit and Loss for both periods on the same basis, then Balance Sheet at each period end. Use `xero_list_accounts` to decode report account codes; `xero_list_period_invoices` finds sales invoices (`ACCREC`) or supplier bills (`ACCPAY`) in a chosen period, and `xero_list_credit_notes` finds related reversals. Their `fromDate` and `toDate` are **document dates**, not payment dates. Open material records for lines and allocations. Check payments separately by payment date, then inspect bank transactions and manual journals for other activity. Follow every page before calling a population complete.

An invoice or credit note dated in an old financial year is still returned with its **current** status and remaining balance. That is not a snapshot of what was owed at that year-end. Use dated reports for as-at balances; this MCP does not yet provide a historical aged debtors/creditors report. Its saved scope list is diagnostic, not proof that the authorising user can read every endpoint.

This is a way to investigate *what changed*, not an automatic reconciliation or a tax opinion. Report rows do not always expose the underlying record IDs. Manual journals cover only manual entries; the unavailable full Journals API would be needed for a complete journal-level trail. Bank transactions are not raw imported bank statement lines, and the GST reports API gives figures without proving filing status. Bank transfers, payroll, fixed assets, and year-end adjustments may also affect figures without being fully explained by these tools. Treat any mismatch or missing source as a question to verify in Xero or put to an accountant, rather than letting the MCP guess.

To retrieve older invoices, call `xero_list_invoices` with `{ "page": 2, "limit": 20 }`. Increment `page` until fewer than `limit` records return; an exact multiple may require a final empty page. Each call fetches one page and returns an array. Defaults remain page 1 and limit 20 (maximum 100).

For an exact number, use `{ "invoiceNumber": "INV-0123" }`; surrounding whitespace is trimmed, and numbers containing commas are unsupported. You can combine `invoiceNumber`, `contactId`, and pagination. Pass a returned `invoiceId` to `xero_get_invoice` to fetch its full details.

Monetary invoice lines require a description, quantity, unit amount, and account code, with optional tax type and either `discountRate` (0–100%) or `discountAmount` (a nonnegative fixed amount). Set a discount explicitly to 0 to remove it; do not provide both forms. Description-only lines contain just `description` (for example, `{ "description": "Project notes" }`) and optionally an existing `lineItemId`; they cannot contain quantity, unit amount, account, item, tax, or discount fields. Monetary lines can also carry an existing Xero item code and, during updates, a line-item ID.

Unit prices support at most four decimal places; more precise values are rejected without rounding.

Dates use `YYYY-MM-DD`. New drafts accept `lineAmountTypes`: `Exclusive`, `Inclusive`, or `NoTax`, defaulting to `Exclusive`. Contact preferences are not applied automatically. Full invoice responses include the tax basis returned by Xero as `lineAmountTypes`; updates preserve the existing basis by omitting it from the request. Inputs are schema-validated, and Xero API errors are returned intact instead of being papered over.

New drafts also accept optional `currencyCode`, for example `"USD"`; surrounding whitespace is trimmed and letters are uppercased. Omitting it leaves Xero's organisation base-currency default. The currency must be enabled in the organisation; Xero validates this. Unit amounts are denominated in the chosen currency and this server does not convert them or set an exchange rate. You may use contact defaults to choose an explicit code; they are not applied automatically. Existing invoice currency cannot be changed through this server.

For a narrow edit, first call `xero_get_invoice`, then pass its `revision` as `expectedRevision` to `xero_update_draft_invoice`. Use `lineItemPatches` with an existing line ID and only the fields you intend to change:

```json
{
  "invoiceId": "<invoiceId from the read>",
  "expectedRevision": "<revision from the read>",
  "lineItemPatches": [
    { "lineItemId": "<LineItemID from the read>", "taxType": "NONE" }
  ]
}
```

Patches preserve omitted quantities, unit prices, discounts, item codes, tracking, and untouched lines. Changing tax or pricing fields omits the edited line's old `TaxAmount` and `LineAmount` so Xero recalculates them. Description-only edits preserve existing amounts and tax overrides. Missing/duplicate line targets, empty patches, unknown patch fields, and mixing patches with complete replacement are rejected.

Every update requires `expectedRevision`, including reference/date changes. The server re-reads the draft and compares a fingerprint of the whole Xero record before sending the write. A stale revision is refused; read again and review the change. Overlapping updates within this server process are also refused. This is a preflight check, not an atomic external lock: another Xero client can still change the record between the check and the write. Older clients must fetch a revision before updating.

The updated invoice includes `changeSummary.fields`, with field paths and actual `before`/`after` values (null represents a missing value), plus `changeSummary.before` and `.after` totals and currency. These values come from Xero's read/write responses, not local total estimates. The response also contains a new `revision` for subsequent edits.

Updating `lineItems` intentionally replaces the invoice's complete line set. Preserve existing lines with their `lineItemId`; omit it only when creating a new line. For retained monetary line IDs, omitted discounts are inherited from the current invoice; explicit zero removes them. Other replacement fields must still be supplied, and omitted lines are removed. Prefer patches for tax-only edits.

For a compact contact billing lookup, call `xero_list_invoices` with `{ "contactId": "<ContactID>", "limit": 5, "includeLineItems": true }`. It returns the latest invoices by invoice date, with dates, status, currency, totals, revisions, and line items. Missing list details are fetched by invoice ID inside the tool; a page of N records may require up to N extra GET requests. Default summary-only listing and pagination remain unchanged.

Tax-rate responses include `name`, `taxType`, `rate`, and a combined `label`, such as `No GST (NONE)` or `Zero Rated (ZERORATED)` when those are the organisation's Xero names. Never choose a tax type from its percentage alone. Names are returned by Xero rather than inferred from the code. The supported line fields follow [Xero's invoice API](https://developer.xero.com/documentation/api/accounting/invoices/).

When drafting, start with the contact defaults, then use the account and tax-rate helpers if you need to choose or verify a code. If a line has no `taxType`, Xero uses the selected account's default tax rate.

## A quick local check

```bash
npm run check
npm test
npm start
```

`npm test` runs offline behavioral tests with synthetic credentials and owned temporary token directories. It does not use your .env, saved tokens, or a live Xero account.

`npm start` waits for MCP input. Hit `Ctrl-C` when you are done.

## Keep the private bits private

`.env` and `node_modules` are ignored by Git. Tokens live outside the repository at `~/.xero-mcp/tokens.json` with local-only file permissions. Do not commit your `.env` file or paste your Client Secret into an issue.
