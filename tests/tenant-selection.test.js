import test from "node:test";
import assert from "node:assert/strict";
import { selectTenant } from "../src/tenant-selection.js";

const first = { tenantId: "11111111-1111-4111-8111-111111111111", tenantName: "First fixture" };
const second = { tenantId: "22222222-2222-4222-8222-222222222222", tenantName: "Second fixture" };

test("one connection is selected without guessing among organisations", () => {
  assert.equal(selectTenant([first]), first);
});
test("multiple connections require an explicit tenant and identify the available choices", () => {
  assert.throws(() => selectTenant([first, second]), (error) => {
    assert.match(error.message, /Set XERO_TENANT_ID/);
    assert.ok(error.message.includes(first.tenantId));
    assert.ok(error.message.includes(second.tenantId));
    return true;
  });
});
test("explicit tenant selection returns that connection irrespective of list order", () => {
  assert.equal(selectTenant([first, second], second.tenantId), second);
});
test("unavailable configured tenant is rejected instead of using another connection", () => {
  assert.throws(() => selectTenant([first], second.tenantId), /not available to this authorised user/);
});
test("no connected organisations are rejected", () => {
  assert.throws(() => selectTenant([]), /No Xero organisations/);
});
