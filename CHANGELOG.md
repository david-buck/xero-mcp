# Changelog

## 0.4.0 — 2026-10-07

### Added

- Sixteen local tools, bringing the server to 24: chart of accounts; date-filtered invoices and supplier bills; bank transaction lists/details; payments; manual journal lists/details; Profit and Loss, Balance Sheet and Trial Balance; saved GST return lists/details; credit-note lists/details; organisation/review context; and a guidance tool.
- An `xero_review` MCP prompt and question-specific workflows for year comparisons, tracing figures, debtors/creditors and GST. Guidance makes no API calls and requires explicit dates, complete pagination and clear evidence limits.
- `npm run auth:review` for the additional read scopes. Existing grants need new consent; review auth retains the original invoice write scope.
- Claude Desktop setup with absolute paths, private configuration, first consent and a read-only organisation check. New users configure their own Xero developer app; no author credentials or tokens are supplied.

### Changed

- Authentication now refuses to pick the first organisation when several are connected. It lists their names/IDs and requires `XERO_TENANT_ID`; unavailable selections are rejected before saving tokens.
- Review lists are paginated and date-bounded to at most 366 days. Reports retain Xero rows/cells and the requested cash/accrual basis; credit notes retain lines, allocations and payments.
- Documentation states the exact write scope: sales-draft creation and editing existing draft invoices, including draft supplier bills. There are no contact-change/cleanup, payment, journal, credit-note, reconciliation, invoice-finalisation or GST-submission tools.
- Minimum Node version is 20.6 for `--env-file`; Node 24 LTS is recommended. MCP and package versions are 0.4.0; dependency versions are unchanged.

### Limits

- This is a local STDIO release. Cloud routines and remote HTTPS connectors are unsupported; unfinished hosted code is excluded.
- Invoice/credit-note balances reflect current records, not historical ageing. Bank transactions are not statement lines; manual journals are not the full general ledger; GST figures do not prove filing status. Review results remain evidence-led investigations, not automatic reconciliation or tax advice.
- Draft safeguards are in code, not a draft-only Xero scope. Local creation has no durable billing-event idempotency; uncertain writes need checking in Xero before retrying. The personal-script OAuth flow requires the user's own app secret; shared native-app PKCE onboarding is not implemented.

### Validation

- All 123 offline local-release tests pass against the staged source on Node 26.7.0. Coverage includes bounded/paginated GET reads, nested reports, credit-note details, context without credential disclosure, guidance/prompt discovery, existing draft guards and explicit tenant selection.
- A separate staged-source STDIO smoke check advertises version 0.4.0, exactly 24 tools and the review prompt. Staged JavaScript syntax, version/lockfile consistency, diff whitespace and a bounded credential-pattern scan pass. No live Xero credentials, grants or financial records were used.

## 2026-10-02

### Added

- Narrow draft-invoice edits through `lineItemPatches`, preserving omitted quantities, rates, discounts, item codes, tracking, and untouched lines.
- Actual before/after field changes and totals in `changeSummary` on invoice updates.
- Combined tax names and codes in revenue-tax labels, distinguishing zero-percent tax types.
- Optional `includeLineItems` on invoice listing for a contact's latest billing details in one response.

### Changed

- Every draft update now requires `expectedRevision` from an invoice read. Stale revisions and overlapping writes within one server process are refused before writing. This preflight check does not lock out external edits during the API request.
- Invoice reads and write responses now include a revision for subsequent edits.
- Monetary lines accept either percentage or fixed discounts. Complete line replacement preserves omitted discounts for retained line IDs; explicit zero removes a discount.
- Tax and pricing patches let Xero recalculate the affected line amounts and tax. Description-only edits retain existing amount and tax overrides.
- Per-invoice Xero validation errors are reported as failures instead of successful writes.

### Validation

- Added 29 offline tests covering preservation, summaries, stale revisions, overlapping writes, validation errors, tax labels, and billing lookup.
- The isolated release snapshot passes all 102 offline tests and syntax checks. Existing invoice tests now supply the required revision. No live Xero records were used or changed during validation.
