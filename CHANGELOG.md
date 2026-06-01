# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.5] - 2026-06-01

### Fixed
- `getTeamsAppCatalogId()` now falls back to the `MSTEAMS_APP_CATALOG_ID`
  environment variable when not present in `config.json` (config value still
  takes precedence), mirroring `getCredentials()` and `getPublicUrl()`. This
  makes a dashboard-provisioned App Catalog ID (written to the VM `.env`)
  actually take effect at runtime; previously the value was ignored unless
  also written to `config.json`. The `[0.1.4]` changelog already described
  this fallback, but it was only implemented for `getPublicUrl()`.

## [0.1.4] - 2026-05-26

### Added
- Admin CLI: per-group allowFrom management — `add-group-allow`, `remove-group-allow`, `list-group-allow`
- Admin CLI: per-channel allowFrom management — `add-channel-allow`, `remove-channel-allow`, `list-channel-allow`
- Admin CLI: `add-group` now accepts optional `[mode]` parameter (mention|smart), matching Lark CLI
- Admin CLI: `set-teams-app-catalog-id` command for configuring deterministic DM reaction mapping
- `escapeHtml` helper in format.js for HTML output contexts
- `getPublicUrl()` and `getTeamsAppCatalogId()` config helpers with legacy env fallback
- File size bound (25 MB) on send-media endpoint

### Changed
- Groups auto-added by owner now include `mode: "mention"` by default (previously omitted, causing inconsistent metadata)
- Standardized group config schema: all groups now have `name`, `mode`, `allowFrom`, `added_at` fields
- Configure hook writes credentials and publicUrl to config.json only (no longer writes to global .env)
- `getCredentials()` reads from `config.json` first, falls back to environment variables
- `buildRedirectUri()` reads public URL from config via `getPublicUrl()` instead of `process.env` directly
- DM reactions disabled by default; enabled only when `teamsAppCatalogId` is configured (deterministic installed-app Graph filter replaces unreliable recency-based matching)
- OAuth state binding is now atomic: `consumeState()` replaces separate `validateState()`/delete, stored `redirectUri` used for token exchange instead of reconstructing from callback request
- Conversation-store load/save uses async file I/O (`fs/promises`)
- Send-media endpoint uses async file read
- Subscription renewal loop passes `notificationUrl` for recreation on failure
- Delegated auth token reload is mtime-aware
- `[SKIP]` in send.js now cleans up thinking reaction before exiting
- Post-install and admin CLI instructions reference config.json instead of .env
- DESIGN.md clarifies internal endpoints are localhost-only (not Caddy-proxied)
- Admin CLI help text documents groupPolicy:disabled owner exception

### Fixed
- XSS: HTML-escape `displayName` and `error_description` in OAuth callback pages
- Subscription renewal: recreate subscription after failed renewal

### Removed
- Dead `downloadHostedContent` function from graph.js
- Dead `MSTEAMS_GRAPH_TOKEN` references from README.md and SKILL.md
- `appendEnvVar` from configure hook (config.json is the sole write target)

## [0.1.3] - 2026-05-25

### Added
- Route prefix validation: reject `X-Forwarded-Prefix` containing `//`, `?`, `#`, `%`, `\`, `..`, control characters, whitespace, HTML metacharacters (`<>"'\`&`)
- Subscription redirect validation: `notificationUrl` validated against configured public URL to prevent open redirect
- Test suite expanded from 138 to 178 tests

### Changed
- Conversation-store uses bounded async I/O for load/save operations
- Credential values stripped from pre-ACL log output
- Public URL validated before use in subscription creation

### Fixed
- XSS via `X-Forwarded-Prefix` injection in OAuth redirect URI construction
- Open redirect in Graph subscription `notificationUrl` when `X-Forwarded-*` headers are attacker-controlled

## [0.1.2] - 2026-05-18

### Added
- Channel management: separate `channels` top-level config with independent mode (smart/mention) and allowFrom per channel
- Channel smart mode via Microsoft Graph API subscriptions with webhook endpoint (`/api/notifications`) and auto-renewal every 10 min
- On-demand attachment download script (`scripts/download-attachments.js`) for smart-mode conversations where webhook payloads omit attachments
- Subscription cleanup: stale Graph subscriptions deleted when channel switches from smart to mention mode
- Admin CLI: `list-channels`, `add-channel`, `remove-channel`, `set-channel-mode` commands
- Delegated auth admin commands: `auth-status`, `auth-url`, `auth-revoke`
- Emoji reaction (💬) on message receive for DM, group chat, and channel — removed after reply
- Delegated auth flow for Graph API reactions (user-level token acquisition)
- Reaction cache persistence (`reaction-cache.json`) across restarts
- Standardized channel component test suite (`CHANNEL_TESTSUITE.md`, 47 tests)

### Changed
- Config restructured: channels separated from groups into own top-level section
- Removed `teamOverrides` config key in favor of flat `channels` map
- Admin CLI help reorganized into Group Chat / Channel / DM sections
- `list-groups` now always shows mode (defaults to "mention" when field absent)
- Typing indicator removed — 💬 reaction is now the sole processing indicator

### Fixed
- Group chat reaction bug: `resolveGraphChatId` was querying oneOnOne chats only; fixed to use `conversationId` directly for group chats
- Channel attachment downloads in mention mode working for all file types (.pdf, .tex, images)

## [0.1.1] - 2026-05-17

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
