# Release Checklist

Before publishing a new version of **ai-ssh-toolkit**, verify each step in order.

1. [ ] All repo tests pass (`npm test`)
2. [ ] `npm pack` creates a tarball successfully
3. [ ] Tarball installs cleanly in a temp directory (`npm install --prefix /tmp/pkg-test <tarball>`)
4. [ ] Packaged MCP server starts and responds to `tools/list` (`scripts/mcp-smoke.sh /tmp/pkg-test`)
5. [ ] `serverInfo.name` is `"ai-ssh-toolkit"` and `serverInfo.version` matches `package.json`
6. [ ] Mocked Bitwarden smoke test passes from packaged artifact (`scripts/bw-smoke.sh /tmp/pkg-test`)
7. [ ] Only publish using the verified tarball (`npm publish <tarball>`)
8. [ ] Tag the release in git (automated via release-please)
9. [ ] Verify npm registry shows correct version after publish
