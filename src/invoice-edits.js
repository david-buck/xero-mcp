import { createHash } from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function invoiceRevision(invoice) {
  return createHash("sha256").update(JSON.stringify(canonical(invoice))).digest("hex");
}

const fields = {
  description: "Description", quantity: "Quantity", unitAmount: "UnitAmount",
  accountCode: "AccountCode", itemCode: "ItemCode", taxType: "TaxType",
  discountRate: "DiscountRate", discountAmount: "DiscountAmount",
};
const writable = ["LineItemID", ...Object.values(fields), "AccountID", "TaxAmount", "LineAmount", "Tracking"];

export function patchInvoiceLines(existing, patches) {
  const byId = new Map();
  for (const patch of patches) {
    if (byId.has(patch.lineItemId)) throw new Error(`Duplicate line patch ${patch.lineItemId}.`);
    if (existing.filter((line) => line.LineItemID === patch.lineItemId).length !== 1) throw new Error(`Line ${patch.lineItemId} is missing or ambiguous. Read the invoice again.`);
    byId.set(patch.lineItemId, patch);
  }
  return existing.map((line) => {
    const patch = byId.get(line.LineItemID);
    const result = Object.fromEntries(writable.filter((key) => line[key] !== undefined).map((key) => [key, line[key]]));
    if (!patch) return result;
    if (Object.keys(patch).some((key) => !["lineItemId", "description"].includes(key)) && (line.Quantity === undefined || line.UnitAmount === undefined)) {
      throw new Error(`Line ${line.LineItemID} is description-only; only its description can be patched.`);
    }
    for (const [key, value] of Object.entries(patch)) if (fields[key]) result[fields[key]] = value;
    if (patch.accountCode !== undefined && patch.accountCode !== line.AccountCode) delete result.AccountID;
    if (patch.discountRate !== undefined) delete result.DiscountAmount;
    if (patch.discountAmount !== undefined) delete result.DiscountRate;
    if (["quantity", "unitAmount", "discountRate", "discountAmount", "taxType", "accountCode"].some((key) => patch[key] !== undefined && patch[key] !== line[fields[key]])) {
      // Let Xero recalculate derived values instead of sending the old totals as overrides.
      delete result.LineAmount;
      delete result.TaxAmount;
    }
    return result;
  });
}

export function preserveReplacementDiscounts(existing, replacements) {
  return replacements.map((line) => {
    const previous = existing.find((item) => item.LineItemID === line.LineItemID);
    if (!previous || line.Quantity === undefined || line.DiscountRate !== undefined || line.DiscountAmount !== undefined) return line;
    return { ...line, ...Object.fromEntries(["DiscountRate", "DiscountAmount"].filter((key) => previous[key] !== undefined).map((key) => [key, previous[key]])) };
  });
}

export function invoiceChanges(before, after) {
  const changes = [];
  function visit(left, right, path) {
    if (JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))) return;
    if (left && right && typeof left === "object" && typeof right === "object" && Array.isArray(left) === Array.isArray(right)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) visit(left[key], right[key], Array.isArray(left) ? `${path}[${key}]` : (path ? `${path}.${key}` : key));
    } else changes.push({ field: path, before: left ?? null, after: right ?? null });
  }
  const { revision: ignoredBefore, ...left } = before;
  const { revision: ignoredAfter, ...right } = after;
  visit(left, right, "");
  const totals = (invoice) => ({ subTotal: invoice.subTotal ?? null, totalTax: invoice.totalTax ?? null, total: invoice.total ?? null, currency: invoice.currency ?? null });
  return { fields: changes, before: totals(before), after: totals(after) };
}
