# Design Decisions

This document records architectural and security design decisions for `ai-ssh-toolkit`. Each entry explains what was decided, why, and the outcome — including decisions to _not_ implement a feature.

---

## DD-001: No command validation in `ssh_execute`

**Status:** Won't Fix / By Design  
**Issue:** [#28](https://github.com/ebmarquez/ai-ssh-toolkit/issues/28)  
**Came from:** Security review of PR #23

### Decision

The `command` field in `ssh_execute` (and related tools) accepts any non-empty string. The tool does not impose an allowlist, blocklist, or other content-based validation on commands; basic sanity checks such as rejecting empty input are still enforced. This is intentional and will not change.

### Rationale

`ai-ssh-toolkit` is a **general-purpose SSH execution tool**. The set of commands that callers might legitimately submit is unbounded — from simple `show` commands on network devices, to multi-stage configuration sequences, to arbitrary shell pipelines on Linux hosts.

Imposing a command allowlist or blocklist would:

- Break legitimate use cases across the diverse set of supported hosts and platforms
- Create a false sense of security (blocklists are easily bypassed)
- Shift responsibility away from the operator, where it belongs

**What commands are submitted to the destination host is the caller's and operator's responsibility — not the tool's.**

### Security Contract

The tool is designed to avoid exposing credentials used during tool-managed SSH authentication flows. Everything else is out of scope.

Concretely, the current implementation provides these protections:
- Passwords are kept in memory as `Buffer` objects where practical, converted to a JS string only transiently at PTY write time (because `node-pty` requires strings), and the `Buffer` is zero-filled after every use
- Credentials are never written to disk (no temp files)
- Password values are not placed in process arguments (`argv`)
- PTY output receives best-effort scrubbing of common credential prompt patterns before returning to the MCP client — this is not a guarantee against arbitrary echoed secret content
- MCP responses are intended not to include credentials supplied by the tool itself, but may still contain secrets printed by remote commands or remote hosts

Command content, access control, and authorization are the responsibility of the operator and the infrastructure being accessed (e.g., SSH server ACLs, sudoers policy, network device privilege levels). Operators must not run commands that print passwords, tokens, or private keys if they do not want those values returned to the MCP client.

### What This Means for Operators

If you need command-level restrictions, implement them at the infrastructure layer:

- SSH server `ForceCommand` or `Match` blocks in `sshd_config`
- Network device privilege levels and command authorization (AAA/TACACS+)
- Linux `sudoers` with command allowlists
- Bastion host or jump server policies

---

## DD-002: No Host Allowlist — Network Security is the Operator's Responsibility

**Status:** Won't Fix / By Design  
**Issue:** [#24](https://github.com/ebmarquez/ai-ssh-toolkit/issues/24)  
**Came from:** Security review of PR #23

### Decision

`ai-ssh-toolkit` will connect to any host/IP the caller specifies. There is no built-in host allowlist or IP blocklist.

### Rationale

This tool is a general-purpose SSH MCP server. Restricting which hosts it can connect to would break legitimate use cases across the diverse environments this tool is deployed in.

Endpoint security is not the responsibility of this tool. If a particular IP address or range needs to be protected from unauthorized SSH connections, that protection belongs at the infrastructure layer — firewall rules, network segmentation, IAM policies, and endpoint hardening — not in the SSH client.

### What This Means for Operators

Operators deploying this MCP server are responsible for:

- Controlling what network the process runs on
- Restricting which MCP clients can call it (process-level isolation)
- Applying firewall/ACL rules at the network layer if specific destinations must be off-limits

---

*Additional design decisions will be added here as they arise.*
