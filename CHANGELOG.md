# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-05-15

### Added
- Typing indicator on message receipt
- Reply-to threading (outbound messages chain to trigger message via replyToId)
- Rate limit retry (429 handling with Retry-After for text and media sends)
- Auto-add group handling (owner adds → auto-approve, non-owner → pending + DM notification)
- Outbound markdown formatting (textFormat: 'markdown')
- Bot context recording (outgoing messages appear in group context)
- RSC permission `ChatMessage.Read.Chat` in manifest (for future smart mode)

### Changed
- Manifest version bumped to 1.2.0
- Removed unused Graph enrichment functions (fetchChatMembers, fetchChatInfo, fetchUserProfile)
- Reverted GC enrichment (member list, chat topic, sender details) — group context now only includes last N messages

## [0.2.0] - 2026-05-13

### Added
- Microsoft Graph API integration (opt-in via MSTEAMS_TENANT_ID)
  - Token management with auto-refresh
  - Chat/channel message history fetching
  - Hosted content (image) download
  - Chat/team member lookup
- Group context (`<group-context>` block) for group/channel messages, matching zylos-lark pattern
- In-memory chat history with per-conversation tracking
- Image attachment handling for inbound messages
- Outbound media support (`[MEDIA:image]` and `[MEDIA:file]` prefixes in send.js)
- Internal `/send-media` endpoint for image/file attachments
- `graph-status` admin CLI command
- Graph status in health check endpoint

### Changed
- `formatMessage()` now accepts `contextBlock` parameter for group context injection
- Health check includes `hasGraph` field

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
