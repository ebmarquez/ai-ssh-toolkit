# Changelog

## [0.3.0](https://github.com/ebmarquez/ai-ssh-toolkit/compare/v0.2.3...v0.3.0) (2026-05-07)


### Features

* add credential-map file for host→credential resolution ([#110](https://github.com/ebmarquez/ai-ssh-toolkit/issues/110)) ([1b74b85](https://github.com/ebmarquez/ai-ssh-toolkit/commit/1b74b85cd0c7ac2521c82926180b89b100ffbc72))
* add ssh-agent credential backend (SSH_AUTH_SOCK) ([#109](https://github.com/ebmarquez/ai-ssh-toolkit/issues/109)) ([038eea2](https://github.com/ebmarquez/ai-ssh-toolkit/commit/038eea23bd9a8b18f058e83ba72063d9f8146c60))
* honor ~/.ssh/config via ssh -G (issue [#75](https://github.com/ebmarquez/ai-ssh-toolkit/issues/75)) ([#95](https://github.com/ebmarquez/ai-ssh-toolkit/issues/95)) ([6ccffd5](https://github.com/ebmarquez/ai-ssh-toolkit/commit/6ccffd51dd36c56422e7faf3d396f8d79729492e))


### Bug Fixes

* skip Azure KV integration tests when OIDC secrets unavailable ([#112](https://github.com/ebmarquez/ai-ssh-toolkit/issues/112)) ([e4e3ebb](https://github.com/ebmarquez/ai-ssh-toolkit/commit/e4e3ebb267f4e185344005b49b1cde4ff433f444))

## [0.2.0](https://github.com/ebmarquez/ai-ssh-toolkit/compare/v0.1.0...v0.2.0) (2026-04-19)


### Features

* add Release Please for automated versioning ([f0913f8](https://github.com/ebmarquez/ai-ssh-toolkit/commit/f0913f8e4787aee907a551f9c3458fbcd8d01c92))
* add Release Please for automated versioning ([e4e58f8](https://github.com/ebmarquez/ai-ssh-toolkit/commit/e4e58f8686fc30e587dbaa33069409289cc66020)), closes [#18](https://github.com/ebmarquez/ai-ssh-toolkit/issues/18)
* add ssh_multi_execute for parallel multi-host SSH execution ([a9b4574](https://github.com/ebmarquez/ai-ssh-toolkit/commit/a9b4574f74b4f3127c3fe6e04f96ca37f3635f6b))
* add version_check MCP tool ([91fe636](https://github.com/ebmarquez/ai-ssh-toolkit/commit/91fe636cc5c7642eec62ee7d0568ed57f3aff807))
* wire MCP server entry point and add smoke test ([#21](https://github.com/ebmarquez/ai-ssh-toolkit/issues/21), [#22](https://github.com/ebmarquez/ai-ssh-toolkit/issues/22)) ([d44a99c](https://github.com/ebmarquez/ai-ssh-toolkit/commit/d44a99ca3982e6f88e231383a7d0d52cd923baff))
* wire MCP server entry point and smoke test ([8cc61f7](https://github.com/ebmarquez/ai-ssh-toolkit/commit/8cc61f7be1d3b1a0301a677cfbfe3d892e525491))


### Bug Fixes

* credential_ref validation, normalized error messages, add workflow_dispatch to CI (closes [#26](https://github.com/ebmarquez/ai-ssh-toolkit/issues/26), closes [#27](https://github.com/ebmarquez/ai-ssh-toolkit/issues/27)) ([8812766](https://github.com/ebmarquez/ai-ssh-toolkit/commit/88127663e0114d930f45e1f09e81d0a3e8d54616))
* err.code exit code check, cleanup in finally blocks, explicit zod dependency ([0e9bebb](https://github.com/ebmarquez/ai-ssh-toolkit/commit/0e9bebb75f87c6cf3f7a8d2e465fcc398b799435))
* harden ssh_multi_execute credential handling and PTY env ([cd86d7d](https://github.com/ebmarquez/ai-ssh-toolkit/commit/cd86d7d69610cfda021d2519e7d449435240fed8))
* scope package name for GitHub Packages publish ([a1dd2cf](https://github.com/ebmarquez/ai-ssh-toolkit/commit/a1dd2cf28437fc52b8959601e23ee0a6e8c5caa8))
* scope package name for GitHub Packages publish ([288009b](https://github.com/ebmarquez/ai-ssh-toolkit/commit/288009b7e47a1d53842c557ebdeba0e821a902f3))
* use fileURLToPath for Windows-compatible dist path in smoke test ([5ea00b7](https://github.com/ebmarquez/ai-ssh-toolkit/commit/5ea00b7d2cb279ecff20adfa81fae954d6dbc063))
* use StrictHostKeyChecking=accept-new instead of no (closes [#25](https://github.com/ebmarquez/ai-ssh-toolkit/issues/25)) ([0cfb035](https://github.com/ebmarquez/ai-ssh-toolkit/commit/0cfb035d4afde70bbbf37edb7166efb50dd030de))
* wire tool handlers to credential registry instance ([377ced4](https://github.com/ebmarquez/ai-ssh-toolkit/commit/377ced405a2e62befcfcb5becfd968ca754940ba))
