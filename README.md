# xero-mcp

A small, local Xero MCP server for looking up contacts and invoices from Codex—and making draft invoices when you actually mean draft invoices.

It runs on your Mac, talks to Xero over OAuth, and keeps its tokens in `~/.xero-mcp/tokens.json`. No database, no hosted service, no mystery background process.

## The guardrails

- It can find contacts, list invoices, and fetch a full invoice.
- It can create an `ACCREC` sales invoice as `DRAFT`.
- It can update an invoice only after checking that it is still `DRAFT`.
- It cannot approve, authorise, pay, send, email, void, or delete an invoice.

The point is to make the useful bit easy without giving an AI a route to finalise something in your books.

## What you need

- macOS
- Node 20+ (Node 25 is fine)
- A Xero organisation you can access
- A Xero OAuth Web app

## Set up the Xero app

1. Go to [Xero Developer → My Apps](https://developer.xero.com/app/manage) and create a **Web app** using **Standard auth code**.
2. Add this exact OAuth redirect URI:

   ```text
   http://localhost:3000/callback
   ```

   Xero allows `localhost` for this local flow, but not `127.0.0.1`.
3. In the app's **Configuration** page, copy the Client ID and generate a Client Secret.

The app requests the smallest useful set of scopes:

```text
offline_access accounting.contacts.read accounting.invoices accounting.settings.read
```

## First run

```bash
git clone https://github.com/david-buck/xero-mcp.git
cd xero-mcp
cp .env.example .env
# Add the Client ID and Client Secret from Xero to .env
npm install
npm run auth
```

The auth command starts a short-lived listener on `localhost:3000`, opens the Xero approval page (and prints the URL if macOS does not open it), then saves the token locally. After that, it refreshes tokens automatically—no browser required unless access is revoked or refresh fails.

If you can access more than one Xero organisation, set `XERO_TENANT_ID` in `.env` before running auth. Otherwise it uses the first connected organisation.

## Add it to Codex

Add this to `~/.codex/config.toml` and replace the path with wherever you cloned the repo:

```toml
[mcp_servers.xero]
command = "node"
args = ["--env-file=/ABSOLUTE/PATH/TO/xero-mcp/.env", "/ABSOLUTE/PATH/TO/xero-mcp/src/index.js"]
```

Restart Codex. The server uses stdio, so it stays quiet unless there is something useful to report back through an MCP tool call.

## Tools

| Tool | What it does |
| --- | --- |
| `xero_find_contact` | Search contacts by name or email and return their Xero Contact ID. |
| `xero_get_contact_defaults` | Get a contact's default sales account code, tax type, currency, and line-amount preference. |
| `xero_list_revenue_accounts` | List active revenue/sales account codes that can be used on invoice lines. |
| `xero_list_revenue_tax_rates` | List active revenue tax types with their names, codes, and combined labels. |
| `xero_list_invoices` | List newest invoices by contact or number; optionally include full line items. |
| `xero_get_invoice` | Fetch an invoice including its line items. |
| `xero_create_draft_invoice` | Make a sales invoice with `Status: DRAFT`. |
| `xero_update_draft_invoice` | Patch a draft invoice with a checked revision and actual before/after summary. |

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
