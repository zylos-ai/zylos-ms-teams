# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-13

Initial release.

### Added
- Microsoft Teams Bot Framework integration via CloudAdapter
- Owner auto-binding (first DM sender becomes owner)
- DM access control (dmPolicy: open/allowlist/owner)
- Group and channel message support with access control (groupPolicy: open/allowlist/disabled)
- Message deduplication with TTL
- C4 protocol integration with structured endpoint routing
- Conversation reference store for proactive messaging
- Admin CLI for managing groups, DM policy, and owner
- PM2 service management via ecosystem.config.cjs
- Hooks-based lifecycle (post-install, pre-upgrade, post-upgrade)
- Config hot-reload via fs.watch
