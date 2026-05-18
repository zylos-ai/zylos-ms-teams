# CLAUDE.md

Development guidelines for zylos-teams.

## Project Conventions

- **ESM only** — Use `import`/`export`, never `require()`. All files use ES Modules (`"type": "module"` in package.json)
- **Node.js 20+** — Minimum runtime version
- **Conventional commits** — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
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
- `src/admin.js` — Admin CLI (config, groups, channels, DM policy management)
- `src/lib/config.js` — Config loader with hot-reload, smart mode helpers
- `src/lib/context.js` — JSONL persistence and cold-start replay for group context
- `src/lib/conversation-store.js` — File-based conversation reference store
- `src/lib/message-dedup.js` — Message deduplication with TTL
- `src/lib/format.js` — Message formatting, endpoint building, XML escaping
- `src/lib/html.js` — HTML-to-text conversion, reply blockquote extraction
- `src/lib/graph.js` — Microsoft Graph API integration (chat/channel history)
- `src/lib/auth.js` — JWT validation middleware for Bot Framework
- `src/lib/attachments.js` — Inbound media download and resolution
- `src/lib/channel-subscriptions.js` — Graph API subscription lifecycle for smart-mode channels
- `src/lib/delegated-auth.js` — OAuth2 delegated token acquisition for Graph reactions
- `src/lib/markdown-split.js` — Markdown-aware message splitting
- `scripts/send.js` — C4 outbound message interface (splitting, reply-to, rate limit retry)
- `scripts/download-attachments.js` — On-demand attachment download for smart-mode conversations
- `hooks/` — Lifecycle hooks (configure, post-install, pre-upgrade, post-upgrade)
- `ecosystem.config.cjs` — PM2 service config (CommonJS required by PM2)
