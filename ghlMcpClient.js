// Direct MCP client for the ghl-coaching-mcp server - used when application code needs to
// call a tool deterministically (no Claude involved), unlike claude.js's mcpServers config
// which lets Claude decide when/how to call tools during a chat turn. Same server, same
// identity-token auth (mintIdentityToken/JWT_SECRET), same ownership scoping
// (assertContactAccess) - this just skips the LLM for calls whose logic is already fully
// decided in JS (see budgetParser.js + server.js's call-review budget backfill).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mintIdentityToken } from "./identity.js";

/**
 * Calls one tool on the ghl-coaching-mcp server directly, bypassing Claude entirely.
 * Opens a fresh connection per call since the server is stateless (fresh McpServer +
 * transport per request server-side too - see server-http.js).
 * @param {{name: string, role: string}} identity - same shape askClaude passes to mintIdentityToken
 * @param {string} toolName - e.g. "get_opportunities_for_contact", "update_opportunity_value"
 * @param {object} args - tool arguments
 * @returns {Promise<any>} the tool's JSON result (parsed from its text content)
 */
export async function callGhlMcpTool(identity, toolName, args) {
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
    const result = await client.callTool({ name: toolName, arguments: args });
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
