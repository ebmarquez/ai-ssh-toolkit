# ai-ssh-toolkit

MCP server for AI-driven SSH session management and secure credential retrieval. Enables GitHub Copilot to execute commands on remote hosts via SSH with pluggable credential backends.

## Features

- **SSH Command Execution** — Connect, authenticate, run commands on remote hosts via PTY
- **Persistent SSH Sessions** — Open an interactive shell once, run multiple commands, close when done
- **Pluggable Credentials** — Bitwarden CLI, Azure Key Vault, environment variables (extensible)
- **Network Device Support** — NX-OS, Dell OS10, SONiC, Linux with auto-prompt detection
- **Hardened Security** — No temp files, Buffer-only passwords, PTY output scrubbing, ephemeral session IDs
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

### VS Code / GitHub Copilot Chat

Add to your `.vscode/mcp.json` (workspace) or user `settings.json`:

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

Connect to a host via SSH, run a single command, return output, and close. Best for one-shot commands where you don't need to maintain state between invocations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `host` | string | ✅ | Hostname or IP |
| `username` | string | ❌* | SSH username |
| `command` | string | ✅ | Command to execute |
| `credential_backend` | string | ❌ | Backend name: bitwarden, azure-keyvault, env, google-secret-manager (default: google-secret-manager) |
| `credential_ref` | string | ❌ | Backend-specific reference (BW item name, AKV secret name) |
| `platform` | string | ❌ | Target OS hint: nxos, os10, sonic, linux, auto (default: auto) |
| `timeout_ms` | number | ❌ | Command timeout in ms (default: 30000) |

\*Optional when `credential_ref` provides a username.

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

---

## Persistent SSH Sessions

For multi-step workflows — entering config mode, making changes, verifying state — use the persistent session tools instead of calling `ssh_execute` repeatedly. A persistent session keeps one SSH connection open so each command runs in the same shell context.

### When to use persistent sessions vs `ssh_execute`

| Use case | Tool |
|----------|------|
| Run one command and you're done | `ssh_execute` |
| Need shell state across commands (env vars, `cd`, `configure`) | `ssh_session_open` + `ssh_session_execute` |
| Multi-step workflows on network devices (configure → commit) | Persistent sessions |
| Parallel commands across many hosts | `ssh_multi_execute` |

### Session lifecycle

```
ssh_session_open  →  ssh_session_execute (×N)  →  ssh_session_close
```

1. **`ssh_session_open`** — Opens an interactive shell. Returns a `session_id`.
2. **`ssh_session_execute`** — Sends a command and waits for the next shell prompt. Repeat as needed.
3. **`ssh_session_close`** — Sends `exit`, kills the PTY, and removes the session.

### Auto-expiry

Sessions auto-expire after **5 minutes of inactivity** (default). Each `ssh_session_execute` call resets the idle timer. You can override the timeout per session:

```json
{ "idle_timeout_ms": 600000 }  // 10-minute idle timeout
```

Expired sessions are cleaned up automatically — you don't need to explicitly close them, though it's good practice.

### Security

- Session IDs are **ephemeral `crypto.randomUUID()` values** — never logged, never included in error messages.
- Credentials are resolved once at open time and the password `Buffer` is zero-filled immediately after the PTY write.
- The env allowlist prevents full `process.env` leakage to SSH child processes.

### Tool reference

#### `ssh_session_open`

Open a persistent interactive SSH shell. Returns a `session_id` for subsequent calls.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `host` | string | ✅ | Hostname or IP address |
| `username` | string | ❌* | SSH username (overrides credential ref username) |
| `credential_ref` | string | ❌ | Credential reference (BW item name, AKV secret, etc.) |
| `credential_backend` | string | ❌ | Backend name: bitwarden, azure-keyvault, env, google-secret-manager (default: google-secret-manager) |
| `platform` | string | ❌ | Prompt detection hint: nxos, os10, sonic, linux, auto (default: auto) |
| `timeout_ms` | number | ❌ | Connect + initial prompt timeout in ms (default: 30000) |
| `idle_timeout_ms` | number | ❌ | Inactivity auto-close timeout in ms (default: 300000) |

\*Optional when `credential_ref` provides a username.

**Returns:**
```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "host": "myswitch.local",
  "username": "admin",
  "message": "Session opened successfully"
}
```

#### `ssh_session_execute`

Run a command inside an open session. Waits for the shell prompt to return before resolving.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | ✅ | Session ID from `ssh_session_open` |
| `command` | string | ✅ | Command to run |
| `timeout_ms` | number | ❌ | Command timeout in ms (default: 30000) |

**Returns:**
```json
{
  "output": "Linux myhost 5.15.0-91-generic ...",
  "exit_code": null,
  "session_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

> `exit_code` is `null` for interactive sessions — the shell doesn't produce an exit code until it closes.

#### `ssh_session_close`

Gracefully close a session. Sends `exit`, kills the PTY, and removes the session from the store.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | ✅ | Session ID from `ssh_session_open` |

**Returns:**
```json
{ "message": "Session closed" }
```

### Example: multi-step workflow on a Linux server

This example opens a session, runs a few commands in sequence (each inheriting the previous shell state), then closes.

```
1. ssh_session_open
   host: "myserver.local"
   username: "admin"
   credential_ref: "myserver-login"
   credential_backend: "bitwarden"
   platform: "linux"

   → session_id: "abc123..."

2. ssh_session_execute  (session_id: "abc123...")
   command: "cd /etc && pwd"
   → output: "/etc"

3. ssh_session_execute  (session_id: "abc123...")
   command: "ls *.conf | head -5"
   → output: "hosts  hostname  nsswitch.conf  ..."

4. ssh_session_execute  (session_id: "abc123...")
   command: "cat hostname"
   → output: "myserver"

5. ssh_session_close   (session_id: "abc123...")
   → message: "Session closed"
```

### Example: network device config workflow (NX-OS)

```
1. ssh_session_open
   host: "core-switch-01"
   username: "netadmin"
   credential_ref: "core-switch-01"
   credential_backend: "bitwarden"
   platform: "nxos"

2. ssh_session_execute  command: "configure terminal"
   → enters config mode, prompt changes to (config)#

3. ssh_session_execute  command: "interface Ethernet1/1"
   → prompt: (config-if)#

4. ssh_session_execute  command: "description Uplink to spine"

5. ssh_session_execute  command: "end"

6. ssh_session_execute  command: "copy running-config startup-config"

7. ssh_session_close
```

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

### Command Validation: Out of Scope (By Design)

`ssh_execute` and related tools accept any non-empty command string and do not enforce an allowlist, blocklist, or length restriction. This is intentional — `ai-ssh-toolkit` is a general-purpose tool and restricting commands would break legitimate use cases. Command validation and command-level authorization are out of scope; those controls remain the operator's responsibility (via `sshd_config`, TACACS+, sudoers, etc.). The tool's security guarantees cover credential handling and transport hardening — see [SECURITY.md](SECURITY.md) for details.

See [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md) for the full rationale.

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
