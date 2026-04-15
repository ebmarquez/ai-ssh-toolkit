# AI SSH Toolkit Skills

Skill documents for loading ai-ssh-toolkit capabilities into AI assistants as markdown instructions (alternative to MCP server mode).

## Available Skills

### [SSH Session Management](ssh-session/SKILL.md)

Execute commands on remote hosts via SSH with automatic prompt detection and credential integration.

### [Credential Retrieval](credential-get/SKILL.md)

Securely retrieve credentials from pluggable backends (Bitwarden, Azure Key Vault, environment variables).

## Usage

Copy the desired `SKILL.md` file into your AI assistant's skill/instruction directory:

- **GitHub Copilot CLI**: `.github/skills/<skill-name>/SKILL.md`
- **Claude**: Include in system prompt or project instructions
- **Other agents**: Follow your platform's instruction loading mechanism
