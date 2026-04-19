# Work Routing

How to decide who handles what in ai-ssh-toolkit.

## Routing Table

| Work Type | Route To | Examples |
|-----------|----------|----------|
| TypeScript implementation | Dev | MCP tools, credential backends, CLI wiring, workflow-related code |
| Testing / validation | QA | Vitest coverage, regression tests, smoke tests, reproductions |
| Security review / credential handling | Shadow | secret handling, SSH auth behavior, env leakage, prompt scrubbing |
| Release / CI triage | Ralph | GitHub Actions failures, publish blockers, release coordination |
| Code review | Shadow | PR review with security emphasis; QA for test-quality follow-up |
| Scope & priorities | Ralph | what to build next, trade-offs, issue routing |
| Session logging | Scribe | automatic — never needs routing |

## Issue Routing

| Label | Action | Who |
|-------|--------|-----|
| `squad` | Triage: analyze issue, assign `squad:{member}` label | Ralph |
| `squad:{name}` | Pick up issue and complete the work | Named member |

### How Issue Assignment Works

1. When a GitHub issue gets the `squad` label, **Ralph** triages it.
2. Ralph assigns the best `squad:{member}` label based on issue content.
3. If the task is a good fit for `@copilot`, route to `squad:copilot` and expect PR review from Shadow or QA when appropriate.
4. Members can reassign by removing their label and adding another member's label.
5. The `squad` label is the inbox for untriaged work.

## Rules

1. **Ralph owns triage.** If work is ambiguous, route to Ralph first.
2. **Security-sensitive changes route to Shadow.** Credential paths, SSH auth, env handling, and secret exposure are never “generic bug fixes.”
3. **All implementation needs tests.** QA should be involved for regression coverage on non-trivial fixes.
4. **Use @copilot for clear, bounded coding tasks.** Require review for medium-risk work.
5. **Track via GitHub Issues + PRs.** No silent direct pushes for substantive work.
6. **Escalate release blockers.** Publish/release failures are P0 until both required registries/paths are green.
