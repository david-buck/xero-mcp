import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { xeroRequest } from "./xero.js";

const server = createServer({ xeroRequest });
await server.connect(new StdioServerTransport());
