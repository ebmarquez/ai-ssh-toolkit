# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x | ✅ Current development |

## Reporting a Vulnerability

Please report security vulnerabilities by opening a [GitHub Security Advisory](https://github.com/ebmarquez/ai-ssh-toolkit/security/advisories/new).

Do **not** open a public issue for security vulnerabilities.

## Security Design Principles

### Credential Handling

- **Buffer-only passwords**: All password values stored as Node.js `Buffer`, never as `string`. Buffers are zero-filled (`Buffer.fill(0)`) in `finally` blocks after every use.
- **No temp files**: Credentials are never written to disk, even temporarily.
- **No argv secrets**: CLI backends pass secrets via stdin piping, never as command-line arguments visible in process listings.
- **Metadata-only MCP responses**: The `credential_get` tool returns `{ username, has_password, backend }` — never the actual password value.

### SSH Security

- **StrictHostKeyChecking**: Host key checking is **never** disabled. If the host key is unknown, the connection fails with a clear error.
- **PTY output scrubbing**: Password prompts and echoes are scrubbed from output before returning to the MCP client.
- **Stateless sessions**: Each `ssh_execute` call is a complete connect → authenticate → execute → disconnect cycle. No persistent sessions leak state.

### Process Security

- **CLI path resolution**: External tool paths (`ssh`, `bw`, `az`) are resolved to absolute paths at startup, preventing PATH hijacking attacks.
- **Env var isolation**: Child processes do not inherit sensitive environment variables. `BW_SESSION` is passed via `--session` flag only.
- **Graceful cleanup**: `SIGTERM`, `SIGINT`, and uncaught exceptions trigger credential cleanup before exit.

### Shadow Security Reviews

All pull requests are reviewed by the Shadow agent (black hat security reviewer) who checks for:

- Temp file credential staging
- String-type password storage
- Disabled SSH host key checking
- Secrets in command-line arguments
- Missing `Buffer.fill(0)` cleanup
- Credential values in logs or error messages

PRs with security violations are **blocked** until remediated.

## Design Decisions

### No Host Allowlist — Network Security is the Operator's Responsibility

**Decision:** ai-ssh-toolkit will connect to any host/IP the caller specifies. There is no built-in host allowlist or IP blocklist.

**Rationale:** This tool is a general-purpose SSH MCP server. Restricting which hosts it can connect to would break legitimate use cases — for example, Azure Local uses the `169.254.x.x` (APIPA/link-local) range for cluster network validation. Blocking that range or any other would silently break real workflows for network engineers and cloud operators.

Endpoint security is not the responsibility of this tool. If a particular IP address or range needs to be protected from unauthorized SSH connections, that protection belongs at the infrastructure layer — firewall rules, network segmentation, IAM policies, and endpoint hardening — not in the SSH client.

**Operator guidance:** Operators deploying this MCP server are responsible for:

- Controlling what network the process runs on
- Restricting which MCP clients can call it (process-level isolation)
- Applying firewall/ACL rules at the network layer if specific destinations must be off-limits

**Status:** Won't fix / by design. This was a finding from a security review ([PR #23](https://github.com/ebmarquez/ai-ssh-toolkit/pull/23)) and was deliberately evaluated and rejected. The decision is documented here for the record. See [Issue #24](https://github.com/ebmarquez/ai-ssh-toolkit/issues/24).

## Design Decisions

### `credential_list_backends` Is Intentionally Public

**Decision:** Won't Fix / By Design

`credential_list_backends` returns the list of registered credential backends and their availability to any caller with no access control.

**Rationale:**

- The response contains **backend names and availability status only** — no credential values, tokens, passwords, or secrets are ever returned.
- This information is useful diagnostic context for operators troubleshooting configuration and for AI models selecting an appropriate backend at runtime.
- Restricting access would add friction without meaningful security benefit given the tool's trust model: the MCP server runs over stdio with process-level isolation, meaning callers are already trusted by virtue of being co-located in the same process group.
- The risk surface is low: knowing which backends are configured (e.g., `keychain`, `bitwarden`, `azure-keyvault`) does not enable credential theft.

**Source:** Security review of PR #23. Documented in issue [#29](https://github.com/ebmarquez/ai-ssh-toolkit/issues/29).

## Threat Model

| Attack Surface | Mitigation |
|---------------|------------|
| Temp file snooping | No temp files — memory-only credential flow |
| Process listing (`ps aux`) | Secrets via stdin, never argv |
| PTY buffer capture | Output scrubbed before MCP response |
| PATH hijacking | Absolute CLI paths resolved at startup |
| Env var leakage | Sensitive vars not inherited by children |
| MCP response interception | Passwords never in MCP tool responses |
| SSH MITM | StrictHostKeyChecking always enforced |
