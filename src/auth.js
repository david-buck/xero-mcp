import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { exchangeAuthorizationCode, fetchConnections, getConfiguredTenantId } from "./xero.js";
import { getTokenPath, saveTokens } from "./token-store.js";

const scopes = [
  "offline_access",
  "accounting.contacts.read",
  "accounting.invoices",
  "accounting.settings.read",
];

function config() {
  const clientId = process.env.XERO_CLIENT_ID;
  const redirectUri = process.env.XERO_REDIRECT_URI;
  if (!clientId || !process.env.XERO_CLIENT_SECRET || !redirectUri) {
    throw new Error("Missing XERO_CLIENT_ID, XERO_CLIENT_SECRET, or XERO_REDIRECT_URI in .env.");
  }
  const parsed = new URL(redirectUri);
  if (parsed.protocol !== "http:" || parsed.hostname !== "localhost") {
    throw new Error("XERO_REDIRECT_URI must use http://localhost (not 127.0.0.1) for this local flow.");
  }
  return { clientId, redirectUri, parsed };
}

function waitForCallback({ redirectUri, expectedState }) {
  const { port, pathname } = new URL(redirectUri);
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url, redirectUri);
      if (requestUrl.pathname !== pathname) {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("Not found");
        return;
      }
      const finish = (error, code) => {
        server.close();
        if (error) reject(error);
        else resolve(code);
      };
      const oauthError = requestUrl.searchParams.get("error");
      if (oauthError) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<h1>Xero authorisation was not completed</h1><p>You can close this tab.</p>");
        finish(new Error(`Xero authorisation failed: ${oauthError} ${requestUrl.searchParams.get("error_description") ?? ""}`));
        return;
      }
      if (requestUrl.searchParams.get("state") !== expectedState) {
        response.writeHead(400, { "Content-Type": "text/plain" });
        response.end("Invalid OAuth state.");
        finish(new Error("Xero OAuth callback state did not match."));
        return;
      }
      const code = requestUrl.searchParams.get("code");
      if (!code) {
        response.writeHead(400, { "Content-Type": "text/plain" });
        response.end("No authorisation code received.");
        finish(new Error("Xero OAuth callback did not include a code."));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<h1>Xero connected</h1><p>You can close this tab and return to the terminal.</p>");
      finish(null, code);
    });
    server.once("error", reject);
    server.listen(Number(port || 80), "localhost");
    setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for Xero OAuth callback after 10 minutes."));
    }, 10 * 60 * 1000).unref();
  });
}

async function main() {
  const { clientId, redirectUri } = config();
  const state = randomBytes(24).toString("hex");
  const authoriseUrl = new URL("https://login.xero.com/identity/connect/authorize");
  authoriseUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
    state,
  }).toString();

  const callback = waitForCallback({ redirectUri, expectedState: state });
  console.log("Open this URL in your browser to connect Xero:\n");
  console.log(authoriseUrl.href);
  const opener = spawn("open", [authoriseUrl.href], { detached: true, stdio: "ignore" });
  opener.unref();

  const code = await callback;
  const tokens = await exchangeAuthorizationCode(code, redirectUri);
  const connections = await fetchConnections(tokens.access_token);
  const configuredTenantId = getConfiguredTenantId();
  const tenant = configuredTenantId
    ? connections.find((connection) => connection.tenantId === configuredTenantId)
    : connections[0];
  if (!tenant) {
    throw new Error(configuredTenantId
      ? `XERO_TENANT_ID ${configuredTenantId} is not available to this authorised user.`
      : "No Xero organisations were connected for this authorised user.");
  }
  await saveTokens({ ...tokens, tenantId: tenant.tenantId });
  console.log(`\nConnected to ${tenant.tenantName ?? tenant.tenantId}.`);
  console.log(`Tokens saved to ${getTokenPath()}`);
}

main().catch((error) => {
  console.error(`Authentication failed: ${error.message}`);
  process.exitCode = 1;
});
