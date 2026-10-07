import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, resultData } from "./helpers/mcp.js";

test("review context identifies the organisation and scope gaps without exposing credentials", async (t) => {
  const { call, calls } = await createHarness(t, () => ({ Organisations: [{
    OrganisationID: "org-1", Name: "Example", CountryCode: "NZ", BaseCurrency: "NZD",
    FinancialYearEndDay: 31, FinancialYearEndMonth: 3, Timezone: "NEWZEALANDSTANDARDTIME",
  }] }), { loadTokens: async () => ({
    scope: "offline_access accounting.invoices accounting.payments.read",
    access_token: "secret-access-token", refresh_token: "secret-refresh-token", tenantId: "secret-tenant",
  }) });
  const result = await call("xero_review_context", {});
  assert.equal(result.isError, undefined);
  const data = resultData(result);
  assert.equal(data.organisation.baseCurrency, "NZD");
  assert.equal(data.organisation.financialYearEndMonth, 3);
  assert.deepEqual(data.savedGrant.reviewScopesPresent, ["accounting.payments.read"]);
  assert.equal(data.savedGrant.invoiceWriteScopePresent, true);
  assert.equal(JSON.stringify(data).includes("secret-"), false);
  assert.deepEqual(calls.map(([method, path]) => [method, path]), [["GET", "/Organisation"]]);
});

test("review context does not infer scopes when saved grant lacks scope metadata", async (t) => {
  const { call } = await createHarness(t, () => ({ Organisations: [{ Name: "Example" }] }), {
    loadTokens: async () => ({ access_token: "secret" }),
  });
  const data = resultData(await call("xero_review_context", {}));
  assert.equal(data.savedGrant.known, false);
  assert.equal(data.savedGrant.reviewScopesMissing, null);
});
