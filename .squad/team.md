# Squad Team

> ai-ssh-toolkit autonomous repo squad for triage, implementation routing, testing, and security review.

## Coordinator

| Name | Role | Notes |
|------|------|-------|
| Ralph | Lead Coordinator | Primary triage lead. Routes issues, assigns work, and escalates when routing is ambiguous. |

## Members

| Name | Role | Charter | Status |
|------|------|---------|--------|
| Dev | TypeScript Engineer | `.squad/agents/dev/charter.md` | ✅ Active |
| QA | Test Engineer | `.squad/agents/qa/charter.md` | ✅ Active |
| Shadow | Security Adversary & Secret Leak Auditor | `.squad/agents/shadow/charter.md` | ✅ Active |
| Scribe | Session Logger | `.squad/agents/scribe/charter.md` | 📋 Silent |
| Ralph | Work Monitor / Lead | `.squad/agents/ralph/charter.md` | 🔄 Active |

## Coding Agent

<!-- copilot-auto-assign: true -->

| Name | Role | Charter | Status |
|------|------|---------|--------|
| @copilot | Coding Agent | — | 🤖 Coding Agent |

### Capabilities

**🟢 Good fit — auto-route when enabled:**
- bug fixes with clear reproduction steps
- test coverage (missing tests, flaky test fixes)
- lint/format fixes and code style cleanup
- dependency updates and version bumps
- small isolated features with clear specs
- documentation fixes and README updates
- GitHub Actions / CI fixes with clear failure logs

**🟡 Needs review — route to @copilot but require squad member PR review:**
- medium TypeScript features with clear acceptance criteria
- refactors with existing test coverage
- workflow or release automation changes
- MCP tool additions following existing patterns

**🔴 Not suitable — route to squad member instead:**
- architecture/system design decisions
- ambiguous requirements needing clarification
- security-critical credential handling changes
- SSH auth / encryption / secret storage changes
- performance-critical work requiring benchmarking

## Project Context

- **Owner:** Eric Marquez
- **Stack:** TypeScript, Node.js, MCP SDK, Vitest, GitHub Actions
- **Description:** MCP server for AI-driven SSH sessions with pluggable credential backends and network automation workflows
- **Created:** 2026-04-15
