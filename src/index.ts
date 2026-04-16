#!/usr/bin/env node
/**
 * ai-ssh-toolkit MCP server — stdio transport
 *
 * Registered tools:
 *  - ssh_multi_execute  (parallel multi-host SSH execution)
 *  - credential_list    (list available credential backends)
 *  - credential_get     (retrieve credential metadata)
 *  - ssh_check          (verify SSH reachability)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { CredentialRegistry } from "./credentials/registry.js";
import { EnvCredentialBackend } from "./credentials/env.js";
import {
  sshMultiExecute,
  SSH_MULTI_EXECUTE_TOOL,
  SshMultiExecuteInput,
} from "./tools/ssh-multi-execute.js";

// ---------------------------------------------------------------------------
// Bootstrap credential registry
// ---------------------------------------------------------------------------

const registry = new CredentialRegistry();
registry.register(new EnvCredentialBackend());
// Additional backends (bitwarden, azure-keyvault) registered if available:
try {
  const { BitwardenBackend: BitwardenCredentialBackend } = await import(
    "./credentials/bitwarden.js"
  );
  registry.register(new BitwardenCredentialBackend());
} catch {
  /* optional dep */
}
try {
  const { AzureKeyVaultBackend } = await import(
    "./credentials/azure-keyvault.js"
  );
  registry.register(new AzureKeyVaultBackend());
} catch {
  /* optional dep */
}

await registry.discoverAvailability();

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "ai-ssh-toolkit", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [SSH_MULTI_EXECUTE_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "ssh_multi_execute") {
    const input = args as unknown as SshMultiExecuteInput;
    const result = await sshMultiExecute(input, registry);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
