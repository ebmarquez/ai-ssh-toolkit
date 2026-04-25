# ai-ssh-toolkit

MCP server for AI-driven SSH session management and secure credential retrieval. Enables AI assistants (GitHub Copilot CLI, Claude, ChatGPT) to execute commands on remote hosts via SSH with pluggable credential backends.

## Features

- **SSH Command Execution** — Connect, authenticate, run commands on remote hosts via PTY
- **Pluggable Credentials** — Bitwarden CLI, Azure Key Vault, environment variables (extensible)
- **Network Device Support** — NX-OS, Dell OS10, SONiC, Linux with auto-prompt detection
- **Hardened Security** — No temp files, Buffer-only passwords, PTY output scrubbing
- **Cross-Platform** — Windows (ConPTY) + Linux/macOS (Unix PTY) from day one

## Quick Start

### GitHub Copilot CLI

Add to your MCP config:

```json
{
  "mcpServers": {
    "ai-ssh-toolkit": {
      "command": "npx",
      "args": ["-y", "ai-ssh-toolkit"]
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ai-ssh-toolkit": {
      "command": "npx",
      "args": ["-y", "ai-ssh-toolkit"]
    }
  }
}
```

## MCP Tools

### `ssh_execute`

Connect to a host via SSH, run commands, return output.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `host` | string | ✅ | Hostname or IP |
| `username` | string | ✅ | SSH username |
| `commands` | string[] | ✅ | Commands to execute |
| `credential_backend` | string | ❌ | Backend name (bitwarden, azure-keyvault, env) |
| `credential_ref` | string | ❌ | Backend-specific reference (BW item name, AKV secret name) |
| `platform_hint` | string | ❌ | Target OS hint: nxos, os10, sonic, linux, auto (default: auto) |
| `port` | number | ❌ | SSH port (default: 22) |

### `credential_get`

Retrieve credential metadata (never returns actual passwords).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `backend` | string | ✅ | Backend name |
| `ref` | string | ✅ | Backend-specific reference |

### `credential_list_backends`

Discover available credential backends on the system.

No parameters required.

### `ssh_check_host`

Check TCP reachability of a host with latency measurement.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `host` | string | ✅ | Hostname or IP |
| `port` | number | ❌ | Port to check (default: 22) |

## Credential Backends

### Bitwarden CLI

Requires `bw` CLI installed and unlocked. Reference items by name.

```text
credential_backend: "bitwarden"
credential_ref: "my-switch-password"
```

### Azure Key Vault

Requires `az` CLI installed and authenticated. Reference secrets by vault/name.

```text
credential_backend: "azure-keyvault"
credential_ref: "my-vault/my-secret"
```

### Environment Variables

Read credentials from environment variables. Reference by variable name prefix.

```text
credential_backend: "env"
credential_ref: "MY_SWITCH"  → reads MY_SWITCH_USERNAME and MY_SWITCH_PASSWORD
```

## Platform Support

| Platform | SSH Client | PTY Type |
|----------|-----------|----------|
| Windows | OpenSSH (System32) | ConPTY via node-pty |
| Linux | /usr/bin/ssh | Unix PTY via node-pty |
| macOS | /usr/bin/ssh | Unix PTY via node-pty |

## Security Model

- Passwords stored as `Buffer`, zero-filled after use
- No temporary files for credential staging
- CLI secrets passed via stdin (never command-line arguments)
- PTY output scrubbed for password echoes
- `StrictHostKeyChecking=no` is never used
- External CLI paths resolved to absolute at startup

See [SECURITY.md](SECURITY.md) for full details and vulnerability reporting.

## Development

```bash
git clone https://github.com/ebmarquez/ai-ssh-toolkit.git
cd ai-ssh-toolkit
npm install
npm run build
npm test
```

## Integration Tests

Integration tests run against live Azure resources and require the `az` CLI to be authenticated.

### Run locally

```bash
# Authenticate first (SP login or az login)
bash ~/.config/azure/sp-login.sh   # service principal
# or
az login

# Run Azure Key Vault integration tests
AZURE_KV_ENABLED=true AZURE_KV_NAME=rg-ut-bw npx vitest run test/integration/
```

The SSH end-to-end test also requires `SSH_E2E_ENABLED=true` and `surface-aac-1.local` to be reachable:

```bash
AZURE_KV_ENABLED=true SSH_E2E_ENABLED=true AZURE_KV_NAME=rg-ut-bw npx vitest run test/integration/mcp-azure-keyvault.integration.test.ts
```

### GitHub Actions

The `.github/workflows/integration.yml` workflow runs the Azure KV integration test automatically on push and pull request using **OIDC authentication** — no long-lived secrets or credentials to rotate.

Required repository secrets:

| Secret | Description |
|---|---|
| `AZURE_CLIENT_ID` | OIDC app registration client ID |
| `AZURE_TENANT_ID` | Azure AD tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID |
| `AZURE_KV_NAME` | Key vault name (e.g. `rg-ut-bw`) |

> **Note:** The SSH E2E test is excluded from CI — `surface-aac-1.local` is not reachable from GitHub runners. Run it locally.

## License

MIT
