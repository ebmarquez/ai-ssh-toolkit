---
name: ssh-session
description: Execute commands on remote hosts via SSH with PTY-based authentication and platform-aware prompt detection.
---

# SSH Session Management

## Overview

Connect to remote hosts via SSH, authenticate using pluggable credential backends, execute commands, and return scrubbed output. Uses node-pty for real TTY support (required for Windows OpenSSH keyboard-interactive auth).

## When to Use

- User wants to run commands on a remote host
- User wants to check switch/router configuration
- User needs to pull data from network devices (NX-OS, Dell OS10, SONiC)
- User asks to SSH somewhere and run something

## Workflow

### Step 1: Identify Target

Determine from user request:

- **Host**: IP address or hostname
- **Username**: SSH username
- **Commands**: What to execute
- **Platform**: nxos, os10, sonic, linux, or auto

### Step 2: Resolve Credentials

If password auth is needed:

1. Ask which credential backend to use (bitwarden, azure-keyvault, env)
2. Get the credential reference (item name, secret path, env prefix)
3. Credential is retrieved as Buffer, used for PTY auth, then zero-filled

### Step 3: Execute SSH Session

1. Spawn SSH via node-pty (ConPTY on Windows, Unix PTY on Linux/macOS)
2. Detect password prompt, write credential to PTY
3. Wait for shell prompt (platform-aware detection)
4. Execute each command, wait for prompt between commands
5. Send `exit`, collect all output

### Step 4: Return Results

1. Scrub output (remove password echoes, ANSI escapes)
2. Return clean command output to caller

## Platform Prompt Patterns

| Platform | Prompt Pattern | Example |
|----------|---------------|---------|
| NX-OS | `hostname#` or `hostname(config)#` | `switch01#` |
| Dell OS10 | `hostname#` or `hostname(conf)#` | `leaf-01#` |
| SONiC | `admin@hostname:~$` | `admin@sonic:~$` |
| Linux | `user@host:~$` or `#` | `root@server:~#` |

## Timing Constants

| Phase | Delay |
|-------|-------|
| Before password write | 300ms |
| Before carriage return | 100ms |
| Between commands | 400ms |
| Before exit | 500ms |

## Security Rules

- NEVER disable StrictHostKeyChecking
- NEVER write passwords to temp files
- NEVER pass passwords via command-line arguments
- ALWAYS zero-fill password Buffer after use
- ALWAYS scrub PTY output before returning
