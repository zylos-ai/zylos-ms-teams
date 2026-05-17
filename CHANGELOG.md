# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-05-17

### Added
- Smart mode: per-group mode (`mention`/`smart`) — in smart mode, bot receives all messages and Claude decides whether to respond
- `set-group-mode` admin CLI command for switching groups between mention and smart modes
- Cold-start context replay: chat history persisted to JSONL files (`logs/<chat_id>.jsonl`), replayed from disk on restart — no longer solely dependent on Graph API fallback
- Per-group `historyLimit` config for customizable context window size per group
- Smart mode metadata-only media: attachments deferred when smart-no-mention, metadata note appended instead of downloading
- Voice message support: audio attachments transcribed via `~/zylos/bin/transcribe` (ASR), forwarded as `[Voice] <text>`; graceful fallback to regular attachment when ASR not installed
- Typing indicator on DM and group messages (suppressed in smart-no-mention mode)
- Reply-to threading: first message chunk chains to the trigger message via `replyToId`
- Rate limit retry: `send.js` retries on HTTP 429 with `Retry-After` header
- Auto-add: owner adding bot to a group auto-approves it; non-owner triggers pending approval with owner DM notification
- Bot context recording: outgoing messages logged to in-memory history and JSONL for accurate conversation context
- Markdown-aware message splitting module (`lib/markdown-split.js`) — respects code blocks, paragraph breaks, and word boundaries
- Outbound markdown support: messages sent with `textFormat: 'markdown'` (Teams renders natively)

### Changed
- Mention handling: bot @mentions replaced with display name instead of stripped (aligned with Telegram behavior)
- Content-based dedup in `recordHistoryEntry`: same user + same text within 5s window treated as duplicate (handles Graph API vs Bot Framework ID mismatch)

### Fixed
- `[unknown]` entries in group context: system event messages (member add/remove) with empty text now filtered in `formatContextBlock`
- Message splitting preserves code block fences across chunks

## [0.1.0] - 2026-05-13

Initial release.

### Added
- Microsoft Teams Bot Framework integration via @microsoft/teams.apps v2 SDK
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
