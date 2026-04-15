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
