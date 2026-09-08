import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";

export async function createHarness(t, respond = () => ({ Invoices: [] })) {
  const calls = [];
  const server = createServer({ xeroRequest: async (...args) => {
    calls.push(args);
    return respond(...args);
  } });
  const client = new Client({ name: "offline-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, calls, call: (name, args) => client.callTool({ name, arguments: args }) };
}

export function resultData(result) {
  return JSON.parse(result.content[0].text);
}
