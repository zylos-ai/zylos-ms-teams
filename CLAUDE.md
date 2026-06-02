# CLAUDE.md

Development guidelines for zylos-ms-teams.

## Project Conventions

- **ESM only** — Use `import`/`export`, never `require()`. All files use ES Modules (`"type": "module"` in package.json)
- **Node.js 20+** — Minimum runtime version
- **Conventional commits** — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- **No `files` in package.json** — Rely on `.gitignore` to exclude unnecessary files. Use `.npmignore` if publishing to npm
- **Secrets in `.env` only** — Never commit secrets. Use `~/zylos/.env` for credentials, `config.json` for non-sensitive runtime config
- **English for code** — Comments, commit messages, PR descriptions, and documentation in English

## Release Process

When releasing a new version, **all four files** must be updated in the same commit:

1. **`package.json`** — Bump `version` field
2. **`package-lock.json`** — Run `npm install` after bumping package.json to sync the lock file
3. **`SKILL.md`** — Update `version` in YAML frontmatter to match package.json
4. **`CHANGELOG.md`** — Add new version entry following [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format

Version bump commit message: `chore: bump version to X.Y.Z`

After merge, create a GitHub Release with tag `vX.Y.Z` from the merge commit.

## Architecture

This is a **communication component** for the Zylos agent ecosystem.

- `src/index.js` — Main entry point (Express server with Teams SDK adapter)
- `src/routes.js` — HTTP routes for internal send/media/react, Graph notifications, OAuth, and health
- `src/admin.js` — Admin CLI (config, groups, channels, DM policy, diagnostics, delegated auth)
- `src/lib/access.js` — DM/group/channel access control and mention helpers
- `src/lib/activity-events.js` — Message edit/delete and adaptive card action formatting
- `src/lib/activity-store.js` — Recent conversation activity tracking for mutable allowlist warnings
- `src/lib/allowlist.js` — Glob, wildcard, and configured-conversation matching
- `src/lib/allowlist-resolution.js` — Graph-backed display-name and group allowlist resolution cache
- `src/lib/atomic-write.js` — Atomic JSON write helper
- `src/lib/attachments.js` — Inbound media download and resolution
- `src/lib/auth.js` — JWT validation middleware for Bot Framework
- `src/lib/bot-connector.js` — Bot Connector response parsing and error messages
- `src/lib/c4.js` — C4 send/retry integration
- `src/lib/card-extractor.js` — Adaptive card text extraction
- `src/lib/card-send.js` — Card outbound helpers
- `src/lib/channel-subscriptions.js` — Graph API subscription lifecycle for smart-mode channels
- `src/lib/cloud.js` — Microsoft cloud endpoint definitions and mismatch probes
- `src/lib/config.js` — Config loader with hot-reload, route config, smart mode helpers, and env fallback
- `src/lib/context.js` — JSONL persistence and cold-start replay for group context
- `src/lib/conversation-store.js` — File-based conversation reference store
- `src/lib/delegated-auth.js` — OAuth2 delegated token acquisition for Graph reactions
- `src/lib/dm-pairing.js` — Pending DM access approval state and notifications
- `src/lib/dm-welcome.js` — First-contact DM welcome tracking
- `src/lib/doctor.js` — Configuration and connectivity diagnostics
- `src/lib/errors.js` — User-facing error classification
- `src/lib/fetch-utils.js` — Fetch helpers with redirect handling
- `src/lib/format.js` — Message formatting, endpoint building, XML/HTML escaping
- `src/lib/graph.js` — Microsoft Graph API integration, token probes, and history fetches
- `src/lib/history.js` — In-memory context, cold-start replay, reply-chain formatting
- `src/lib/html.js` — HTML-to-text/Markdown conversion and reply blockquote extraction
- `src/lib/inbound-content.js` — Unsupported inbound content handling
- `src/lib/inbound-debounce.js` — Per-conversation inbound debounce/merge helper
- `src/lib/markdown-split.js` — Markdown-aware message splitting
- `src/lib/message-dedup.js` — Message deduplication with TTL
- `src/lib/sent-message-cache.js` — Recently sent bot message tracking for reply detection
- `src/lib/thread-parent-cache.js` — Thread parent fetch/injection cache for channel replies
- `src/lib/transcribe.js` — Voice transcription provider detection and execution
- `src/lib/welcome-card.js` — Welcome card attachment builder
- `scripts/send.js` — C4 outbound message interface (splitting, reply style, rate limit retry)
- `scripts/download-attachments.js` — On-demand attachment download for smart-mode conversations
- `hooks/` — Lifecycle hooks (configure, post-install, pre-upgrade, post-upgrade)
- `ecosystem.config.cjs` — PM2 service config (CommonJS required by PM2)

See [DESIGN.md](./DESIGN.md) for full architecture documentation.
