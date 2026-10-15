import { z } from 'zod';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerPdfTools(server, xeroRequest) {
  for (const [kind, collection] of [['quote', 'Quotes'], ['invoice', 'Invoices']]) {
    const idKey = `${kind}Id`;
    const uriFor = (id) => `xero-pdf:///${kind}/${id}.pdf`;
    async function resource(id) {
      z.string().uuid().parse(id);
      // Xero's OpenAPI /pdf operation has x-path /Quotes/{QuoteID} (and Invoices).
      const bytes = await xeroRequest('GET', `/${collection}/${id}`, { responseType: 'pdf' });
      if (!Buffer.isBuffer(bytes) || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('Xero did not return PDF bytes.');
      return { uri: uriFor(id), mimeType: 'application/pdf', blob: bytes.toString('base64') };
    }
    server.registerResource(`${kind}-pdf`, new ResourceTemplate(`xero-pdf:///${kind}/{id}.pdf`, { list: undefined }), { mimeType: 'application/pdf', description: `Authenticated Xero ${kind} PDF; fetched on read, no persistent cache.` }, async (_uri, { id }) => ({ contents: [await resource(id)] }));
    server.registerTool(`xero_get_${kind}_pdf`, {
      title: `Download ${kind} PDF`, description: `Retrieve original Xero ${kind} PDF as an embedded binary file resource. Requires client support for MCP blob resources; no uploads or local paths.`,
      inputSchema: z.object({ [idKey]: z.string().uuid() }).strict(), annotations: { readOnlyHint: true },
    }, async (input) => {
      try { return { content: [{ type: 'resource', resource: await resource(input[idKey]) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.message ?? String(error) }] }; }
    });
  }
}
