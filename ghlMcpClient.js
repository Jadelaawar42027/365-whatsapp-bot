// Direct MCP client for the ghl-coaching-mcp server - used when application code needs to
// call a tool deterministically (no Claude involved), unlike claude.js's mcpServers config
// which lets Claude decide when/how to call tools during a chat turn. Same server, same
// identity-token auth (mintIdentityToken/JWT_SECRET), same ownership scoping
// (assertContactAccess) - this just skips the LLM for calls whose logic is already fully
// decided in JS (see budgetParser.js + server.js's call-review budget backfill).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mintIdentityToken } from "./identity.js";

// The MCP SDK's own default request timeout (see node_modules/@modelcontextprotocol/sdk's
// protocol.js DEFAULT_REQUEST_TIMEOUT_MSEC) - fine for most tools, but get_broker_leads_overview
// loops a real GHL API call per assigned contact server-side (sequentially, ~150ms apart) and
// can genuinely take longer than this for a broker with many leads. Confirmed in production:
// the budget-backfill sweep's very first broker timed out here and (before per-broker error
// isolation existed) took the entire multi-broker run down with it.
const DEFAULT_TOOL_TIMEOUT_MS = 60000;

/**
 * Calls one tool on the ghl-coaching-mcp server directly, bypassing Claude entirely.
 * Opens a fresh connection per call since the server is stateless (fresh McpServer +
 * transport per request server-side too - see server-http.js).
 * @param {{name: string, role: string}} identity - same shape askClaude passes to mintIdentityToken
 * @param {string} toolName - e.g. "get_opportunities_for_contact", "update_opportunity_value"
 * @param {object} args - tool arguments
 * @param {number} [timeoutMs] - overrides the MCP request timeout for slow tools (e.g. a
 *   broker-wide scan) - the identity token's own 2-minute TTL is unaffected, since the server
 *   verifies it once at the top of the HTTP request, before the (possibly slow) tool runs.
 * @returns {Promise<any>} the tool's JSON result (parsed from its text content)
 */
export async function callGhlMcpTool(identity, toolName, args, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS) {
  const url = process.env.GHL_MCP_URL;
  if (!url) {
    throw new Error("Missing GHL_MCP_URL in .env - required to call the GHL MCP server directly.");
  }
  const identityToken = mintIdentityToken(identity, 2);

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { Authorization: `Bearer ${identityToken}` },
    },
  });
  const client = new Client({ name: "aibot-direct-client", version: "1.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: toolName, arguments: args }, undefined, { timeout: timeoutMs });
    if (result.isError) {
      const message = result.content?.[0]?.type === "text" ? result.content[0].text : "unknown MCP tool error";
      throw new Error(`GHL MCP tool "${toolName}" returned an error: ${message}`);
    }
    const textContent = result.content?.find((c) => c.type === "text");
    if (!textContent) {
      throw new Error(`GHL MCP tool "${toolName}" returned no text content.`);
    }
    return JSON.parse(textContent.text);
  } finally {
    await client.close().catch(() => {});
  }
}
