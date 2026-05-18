# zylos-ms-teams Design Document

**Version**: v1.2.0
**Date**: 2026-05-18
**Author**: Zylos Team
**Repository**: https://github.com/zylos-ai/zylos-ms-teams
**Status**: Released

---

## 1. Overview

Microsoft Teams communication component for Zylos. Enables bidirectional messaging between the Zylos AI agent and Microsoft Teams users via DMs, group chats, and Teams channels using the Teams Apps SDK v2 with direct JWT validation.

## 2. Architecture

### 2.1 Component Structure

```
zylos-ms-teams/
  src/
    index.js              — Express server, Bot Framework adapter, message routing
    admin.js              — CLI for config/ACL management
    lib/
      config.js           — Config loader with hot-reload (fs.watch), smart mode helpers
      auth.js             — JWT middleware for Bot Framework token validation
      html.js             — HTML-to-text conversion, reply blockquote extraction
      graph.js            — Microsoft Graph API client (chat history, file download)
      attachments.js      — Inbound media resolver (3-tier download strategy)
      channel-subscriptions.js — Graph API subscription lifecycle for smart-mode channels
      context.js          — JSONL persistence and cold-start replay for group context
      conversation-store.js — File-based conversation reference persistence
      delegated-auth.js   — OAuth2 delegated token acquisition for Graph reactions
      format.js           — Message formatting, endpoint building, XML escaping
      markdown-split.js   — Markdown-aware message splitting
      message-dedup.js    — TTL-based message deduplication
  scripts/
    send.js               — C4 outbound message handler
    download-attachments.js — On-demand attachment download for smart-mode conversations
  hooks/
    configure.js          — Install-time config collection (stdin JSON → config.json)
    post-install.js       — Post-install setup (dirs, default config, env check)
    pre-upgrade.js        — Pre-upgrade config backup
    post-upgrade.js       — Post-upgrade config schema migration
  SKILL.md                — Component specification
  ecosystem.config.cjs    — PM2 service configuration
```

### 2.2 Data Flow

**Inbound (Teams → Agent):**
1. Teams sends activity to `/api/messages` (Express endpoint)
2. JWT middleware validates Bot Framework token
3. Message deduplication filters duplicates
4. Activity processed: HTML → text, attachments resolved via 3-tier strategy
5. Dispatched to C4 bridge via `c4-receive.js`

**Outbound (Agent → Teams):**
1. C4 bridge calls `scripts/send.js` with endpoint + message
2. send.js loads conversation reference from store
3. Message sent via Bot Framework REST API (proactive messaging)

### 2.3 Attachment Download Strategy (OpenClaw 3-Tier)

1. **Tier 1** — Direct URL: `file.download.info` card + `contentUrl` on image attachments
2. **Tier 2** — Bot Framework v3 API: bot-scoped token → attachment content endpoint
3. **Tier 3** — Graph API: requires `Files.Read.All` admin consent for OneDrive/SharePoint files

## 3. Configuration

### 3.1 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MSTEAMS_APP_ID` | Yes | Azure App Registration ID |
| `MSTEAMS_APP_PASSWORD` | Yes | Azure App Registration client secret |
| `MSTEAMS_TENANT_ID` | No | Tenant ID (single-tenant mode) |

### 3.2 Config File

Located at `~/zylos/components/ms-teams/config.json`:

```json
{
  "enabled": true,
  "port": 3978,
  "dmPolicy": "owner",
  "groupPolicy": "allowlist",
  "owner": { "bound": true, "aadObjectId": "...", "name": "..." },
  "dmAllowFrom": [],
  "groups": {},
  "channels": {}
}
```

## 4. Integration with Zylos

### 4.1 Lifecycle

- **Start**: PM2 launches `src/index.js` via `ecosystem.config.cjs`
- **Stop**: Graceful shutdown on SIGTERM (Express server close, config watcher stop)

### 4.2 Message Flow

- Inbound: Teams webhook → Express → C4 `c4-receive.js`
- Outbound: C4 `c4-send.js` → `scripts/send.js` → Bot Framework REST API

### 4.3 HTTP Routes

Caddy proxies:
- `/teams/api/messages` → `localhost:3978/api/messages` (Bot Framework webhook)
- `/teams/api/notifications` → `localhost:3978/api/notifications` (Graph subscription webhook for smart-mode channels)

## 5. Security

- **JWT validation**: All inbound activities verified against Bot Framework OpenID metadata
- **Owner binding**: First DM sender auto-bound as owner; owner bypasses all ACL
- **DM policy**: `owner` (default), `allowlist`, or `open`
- **Group policy**: `allowlist` (default), `open`, or `disabled`
- **Token caching**: Per-scope Map with 60s expiry margin

## 6. Error Handling

- HTTP 401/403 for invalid JWT or unauthorized senders
- Message deduplication with configurable TTL prevents double-processing
- Graph API failures logged but non-fatal (attachment download degrades gracefully)
- Config hot-reload on file change; invalid JSON logged and skipped

## 7. Future Improvements

- Adaptive Card rendering for rich outbound messages
- Thread/reply-chain awareness for multi-turn group conversations
- Multi-tenant support (cross-organization)
