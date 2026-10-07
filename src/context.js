import { loadTokens as defaultLoadTokens } from "./token-store.js";

const reviewScopes = [
  "accounting.banktransactions.read",
  "accounting.payments.read",
  "accounting.manualjournals.read",
  "accounting.reports.profitandloss.read",
  "accounting.reports.balancesheet.read",
  "accounting.reports.trialbalance.read",
  "accounting.reports.taxreports.read",
];

export function registerContextTool(server, xeroRequest, loadTokens = defaultLoadTokens) {
  server.registerTool("xero_review_context", {
    title: "Check Xero review context",
    description: "Read the connected organisation's reporting context and saved OAuth scope names before shaping a year-end request. No credentials are returned. A granted scope is not proof of the user's endpoint permissions.",
    inputSchema: {},
  }, async () => {
    try {
      const [tokens, result] = await Promise.all([
        loadTokens(),
        xeroRequest("GET", "/Organisation"),
      ]);
      const organisation = result.Organisations?.[0];
      if (!organisation) throw new Error("Xero returned no organisation details.");
      const grantedScopes = typeof tokens?.scope === "string" ? tokens.scope.split(/\s+/).filter(Boolean) : null;
      const data = {
        organisation: {
          organisationId: organisation.OrganisationID,
          name: organisation.Name,
          countryCode: organisation.CountryCode,
          baseCurrency: organisation.BaseCurrency,
          financialYearEndDay: organisation.FinancialYearEndDay,
          financialYearEndMonth: organisation.FinancialYearEndMonth,
          timezone: organisation.Timezone,
        },
        savedGrant: {
          known: grantedScopes !== null,
          reviewScopesPresent: grantedScopes === null ? null : reviewScopes.filter((scope) => grantedScopes.includes(scope)),
          reviewScopesMissing: grantedScopes === null ? null : reviewScopes.filter((scope) => !grantedScopes.includes(scope)),
          invoiceWriteScopePresent: grantedScopes === null ? null : grantedScopes.includes("accounting.invoices"),
        },
        limitations: [
          "Saved scope names do not prove that the authorising user's role can read every endpoint.",
          "Financial-year fields describe organisation settings; confirm the period requested before comparing reports.",
        ],
      };
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
}
