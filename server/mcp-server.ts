// ── H MCP Server Entry Point ──
// Run this file directly to start the MCP server in stdio mode.
//
// Usage:
//   npx tsx server/mcp-server.ts
//
// Or configure in an MCP client (Claude Desktop, Cursor, etc.):
//   {
//     "mcpServers": {
//       "h": {
//         "command": "npx",
//         "args": ["tsx", "server/mcp-server.ts"],
//         "cwd": "/path/to/h"
//       }
//     }
//   }

import { HMcpServer, runStdioServer } from "./mcp";

const projectRoot = process.argv[2] || process.cwd();
const server = new HMcpServer(projectRoot);

// Log to stderr so it doesn't interfere with the stdio JSON-RPC protocol
console.error(`[H MCP] Starting stdio server for project: ${projectRoot}`);

runStdioServer(server);
