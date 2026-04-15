---
name: credential-get
description: Securely retrieve credentials from pluggable backends (Bitwarden CLI, Azure Key Vault, environment variables).
---

# Credential Retrieval

## Overview

Retrieve authentication credentials from multiple backend sources. Credentials are stored as Buffer (never string) and zero-filled after use. The MCP tool returns metadata only — never actual password values.

## When to Use

- User needs credentials for SSH authentication
- User wants to check if a credential backend is available
- User asks about stored passwords or secrets
- Before an SSH session that requires password auth

## Available Backends

### Bitwarden CLI

**Prerequisites**: `bw` CLI installed, vault unlocked

**Reference format**: Bitwarden item name (e.g., `my-switch-password`)

**How it works**:

1. Check `bw` is available and vault is unlocked
2. Run `bw get item <name> --session <token>` with session via flag
3. Parse JSON response for username/password
4. Return password as Buffer

### Azure Key Vault

**Prerequisites**: `az` CLI installed, authenticated (`az account show`)

**Reference format**: `vault-name/secret-name`

**How it works**:

1. Check `az` is available and authenticated
2. Run `az keyvault secret show --vault-name <vault> --name <secret>`
3. Parse JSON response for secret value
4. Return as Buffer

### Environment Variables

**Prerequisites**: Environment variables set

**Reference format**: Variable prefix (e.g., `MY_SWITCH`)

**How it works**:

1. Read `<PREFIX>_USERNAME` and `<PREFIX>_PASSWORD` from environment
2. Return password as Buffer

## Security Rules

- NEVER return password values to MCP clients
- NEVER write credentials to temp files
- NEVER pass secrets as CLI arguments (use stdin piping)
- ALWAYS store passwords as Buffer
- ALWAYS call Buffer.fill(0) in finally blocks
- ALWAYS pass BW_SESSION via --session flag, not env var
