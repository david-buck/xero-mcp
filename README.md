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
offline_access accounting.contacts.read accounting.invoices
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
| `xero_list_invoices` | List recent invoices, optionally for one contact. |
| `xero_get_invoice` | Fetch an invoice including its line items. |
| `xero_create_draft_invoice` | Make a sales invoice with `Status: DRAFT`. |
| `xero_update_draft_invoice` | Change a draft invoice only. |

Invoice line items take a description, quantity, unit amount, account code, and optional tax type. Dates use `YYYY-MM-DD`. Inputs are schema-validated, and Xero API errors are returned intact instead of being papered over.

## A quick local check

```bash
npm run check
npm start
```

`npm start` waits for MCP input. Hit `Ctrl-C` when you are done.

## Keep the private bits private

`.env` and `node_modules` are ignored by Git. Tokens live outside the repository at `~/.xero-mcp/tokens.json` with local-only file permissions. Do not commit your `.env` file or paste your Client Secret into an issue.
