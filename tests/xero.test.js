import test from "node:test";
import assert from "node:assert/strict";
import { createXeroClient } from "../src/xero.js";

const now = 1_800_000_000_000;
const tokens = { access_token: "synthetic-access", refresh_token: "synthetic-refresh", tenantId: "synthetic-tenant", expires_at: now + 300_000 };
function client(overrides = {}) {
  return createXeroClient({ now: () => now, getConfig: () => ({ clientId: "synthetic-id", clientSecret: "synthetic-secret" }), loadTokens: async () => tokens, saveTokens: async () => { assert.fail("Unexpected persistence"); }, fetch: async () => { assert.fail("Unexpected HTTP"); }, ...overrides });
}

test("valid token maps URL, query, headers and JSON body without refresh", async () => {
  const calls = [];
  const api = client({ fetch: async (...args) => { calls.push(args); return new Response(JSON.stringify({ Invoices: [] })); } });
  assert.deepEqual(await api.xeroRequest("POST", "/Invoices", { query: { page: 2, ignored: undefined, empty: "", absent: null, flag: false }, body: { Invoices: [{ Status: "DRAFT" }] } }), { Invoices: [] });
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0][0]), "https://api.xero.com/api.xro/2.0/Invoices?page=2&flag=false");
  assert.deepEqual(calls[0][1], { method: "POST", headers: { Authorization: "Bearer synthetic-access", "xero-tenant-id": "synthetic-tenant", Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ Invoices: [{ Status: "DRAFT" }] }) });
});

test("missing tokens fail before HTTP", async () => {
  await assert.rejects(client({ loadTokens: async () => null }).xeroRequest("GET", "/Invoices"), /not authorised yet/);
});

test("missing tenant fails before HTTP", async () => {
  await assert.rejects(client({ loadTokens: async () => ({ ...tokens, tenantId: undefined }) }).xeroRequest("GET", "/Invoices"), /no tenant ID/);
});

test("single successful refresh persists rotated token and retains tenant", async () => {
  const calls = [];
  const saved = [];
  const api = client({ loadTokens: async () => ({ ...tokens, expires_at: now }), saveTokens: async (value) => saved.push(value), fetch: async (...args) => {
    calls.push(args);
    if (calls.length === 1) return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800 }));
    assert.equal(saved.length, 1, "persistence completes before API request");
    return new Response(JSON.stringify({ Invoices: [] }));
  } });
  await api.xeroRequest("GET", "/Invoices");
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "https://identity.xero.com/connect/token");
  assert.equal(calls[0][1].method, "POST");
  assert.equal(calls[0][1].headers.Authorization, `Basic ${Buffer.from("synthetic-id:synthetic-secret").toString("base64")}`);
  assert.equal(calls[0][1].body.toString(), "grant_type=refresh_token&refresh_token=synthetic-refresh");
  assert.deepEqual(saved, [{ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800, obtained_at: now, expires_at: now + 1_800_000, tenantId: "synthetic-tenant" }]);
  assert.equal(calls[1][1].headers.Authorization, "Bearer new-access");
});

for (const body of [JSON.stringify({ Message: "synthetic failure" }), "synthetic failure"]) {
  test(`HTTP error preserves status and response detail: ${body}`, async () => {
    const api = client({ fetch: async () => new Response(body, { status: 400, statusText: "Bad Request" }) });
    await assert.rejects(api.xeroRequest("GET", "/Invoices", { query: { page: 2 } }), /Xero API GET \/Invoices\?page=2 failed \(400 Bad Request\): .*synthetic failure/);
  });
}

test("failed refresh reports error and never persists or issues API request", async () => {
  let count = 0;
  const api = client({ loadTokens: async () => ({ ...tokens, expires_at: now }), fetch: async () => { count++; return new Response("invalid_grant", { status: 400, statusText: "Bad Request" }); } });
  await assert.rejects(api.xeroRequest("GET", "/Invoices"), /invalid_grant/);
  assert.equal(count, 1);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const failure of [null, "refresh", "save"]) {
  test(`concurrent refresh is shared and recovers after ${failure ?? "success"}`, async () => {
    const refreshGate = deferred();
    const refreshEntered = deferred();
    const saveGate = deferred();
    const saveEntered = deferred();
    const allLoaded = deferred();
    const loadGate = deferred();
    const expectedFailure = new Error(`synthetic ${failure} failure`);
    let savedTokens = { ...tokens, expires_at: now };
    let loads = 0;
    let refreshes = 0;
    let saves = 0;
    const requests = [];
    const api = client({
      loadTokens: async () => {
        loads++;
        if (loads === 4) allLoaded.resolve();
        await loadGate.promise;
        return savedTokens;
      },
      saveTokens: async (value) => {
        saves++;
        if (saves === 1) {
          saveEntered.resolve();
          await saveGate.promise;
        }
        savedTokens = value;
      },
      fetch: async (url, options) => {
        if (String(url).includes("/connect/token")) {
          refreshes++;
          if (refreshes === 1) {
            refreshEntered.resolve();
            await refreshGate.promise;
          }
          return new Response(JSON.stringify({ access_token: "shared-access", refresh_token: "rotated-refresh", expires_in: 1800 }));
        }
        requests.push(options.headers);
        assert.equal(savedTokens.access_token, "shared-access", "save must finish before every API request");
        return new Response('{"Invoices":[]}');
      },
    });
    const pending = Array.from({ length: 4 }, () => api.xeroRequest("GET", "/Invoices"));
    const outcomes = Promise.allSettled(pending);
    await allLoaded.promise;
    loadGate.resolve();
    await refreshEntered.promise;
    assert.equal(refreshes, 1);
    assert.equal(saves, 0);
    assert.equal(requests.length, 0);
    if (failure === "refresh") {
      refreshGate.reject(expectedFailure);
    } else {
      refreshGate.resolve();
      await saveEntered.promise;
      assert.equal(saves, 1);
      assert.equal(requests.length, 0);
      if (failure === "save") saveGate.reject(expectedFailure);
      else saveGate.resolve();
    }
    const results = await outcomes;
    assert.equal(refreshes, 1);
    assert.equal(saves, failure === "refresh" ? 0 : 1);
    if (failure) {
      assert.equal(requests.length, 0);
      for (const result of results) {
        assert.equal(result.status, "rejected");
        assert.equal(result.reason, expectedFailure);
      }
      // A refresh failure never entered persistence; unblock the retry's first save.
      saveGate.resolve();
      await api.xeroRequest("GET", "/Invoices");
      assert.equal(refreshes, 2);
      assert.equal(saves, failure === "refresh" ? 1 : 2);
      assert.equal(requests.length, 1);
    } else {
      for (const result of results) assert.equal(result.status, "fulfilled");
      assert.equal(requests.length, 4);
      // Read the saved fresh token on the next call instead of refreshing again.
      await api.xeroRequest("GET", "/Invoices");
      assert.equal(refreshes, 1);
      assert.equal(saves, 1);
    }
    for (const headers of requests) {
      assert.equal(headers.Authorization, "Bearer shared-access");
      assert.equal(headers["xero-tenant-id"], tokens.tenantId);
    }
    // Clearing the successful flight must allow a later expiry to refresh again.
    savedTokens = { ...savedTokens, expires_at: now };
    await api.xeroRequest("GET", "/Invoices");
    assert.equal(refreshes, failure ? 3 : 2);
  });
}

test("refresh flights are isolated to each client configuration", async () => {
  const gate = deferred();
  const bothRefreshing = deferred();
  let refreshes = 0;
  const saves = [];
  const apis = ["first", "second"].map((name) => client({
    loadTokens: async () => ({ ...tokens, tenantId: name, expires_at: now }),
    saveTokens: async (value) => { saves.push(value); },
    fetch: async (url, options) => {
      if (String(url).includes("/connect/token")) {
        if (++refreshes === 2) bothRefreshing.resolve();
        await gate.promise;
        return new Response(JSON.stringify({ access_token: name, refresh_token: `synthetic-${name}`, expires_in: 1800 }));
      }
      assert.equal(options.headers.Authorization, `Bearer ${name}`);
      assert.equal(options.headers["xero-tenant-id"], name);
      return new Response('{}');
    },
  }));
  const requests = Promise.all(apis.map((api) => api.xeroRequest("GET", "/Invoices")));
  await bothRefreshing.promise;
  gate.resolve();
  await requests;
  assert.equal(refreshes, 2);
  assert.equal(saves.length, 2);
  assert.deepEqual(saves.map((value) => value.tenantId).sort(), ["first", "second"]);
});
