import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGuidance } from "../src/guidance.js";

async function createGuidanceHarness(t) {
  const server = new McpServer({ name: "guidance-test", version: "1.0.0" });
  registerGuidance(server);
  const client = new Client({ name: "guidance-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test("review guide tool provides topic-specific workflow, evidence discipline, and limits without Xero access", async (t) => {
  const client = await createGuidanceHarness(t);
  const result = await client.callTool({
    name: "xero_review_guide",
    arguments: { topic: "debtors_creditors", question: "Who was overdue at year end?", asAtDate: "2026-03-31" },
  });
  const guide = result.content[0].text;
  assert.match(guide, /dedicated aged receivables\/payables report/);
  assert.match(guide, /xero_get_balance_sheet at the as-at date/);
  assert.match(guide, /xero_list_credit_notes/);
  assert.match(guide, /follow nextPage until it is null/i);
  assert.match(guide, /bank transaction is not the underlying bank statement line/);
  assert.match(guide, /GST report figures do not establish/);
  assert.match(guide, /do not create, edit, approve, or send records/i);
});

test("review prompt is discoverable and asks for missing scope while describing workflows", async (t) => {
  const client = await createGuidanceHarness(t);
  const listed = await client.listPrompts();
  assert.ok(listed.prompts.some((prompt) => prompt.name === "xero_review"));
  const result = await client.getPrompt({
    name: "xero_review",
    arguments: { topic: "year_comparison", question: "Why did profit change?" },
  });
  const guide = result.messages[0].content.text;
  assert.match(guide, /ask for the relevant period or as-at date/);
  assert.match(guide, /two exact, comparable inclusive YYYY-MM-DD ranges/);
  assert.match(guide, /xero_get_profit_and_loss/);
  assert.match(guide, /xero_get_balance_sheet at each period end/);
  assert.match(guide, /not tax, audit, or legal advice/);
});

test("guide validates topic and dates and includes the GST filing-status boundary", async (t) => {
  const client = await createGuidanceHarness(t);
  const invalidTopic = await client.callTool({ name: "xero_review_guide", arguments: { topic: "reconcile" } });
  assert.equal(invalidTopic.isError, true);
  await assert.rejects(client.getPrompt({ name: "xero_review", arguments: { topic: "gst", fromDate: "not-a-date" } }), /Invalid ISO date/);
  const gst = await client.callTool({ name: "xero_review_guide", arguments: { topic: "gst", fromDate: "2025-10-01", toDate: "2025-12-31" } });
  assert.match(gst.content[0].text, /figures, not filed\/submitted\/accepted\/paid status/);
});
