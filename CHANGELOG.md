# Changelog

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
