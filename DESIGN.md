# zylos-ms-teams Design Document

**Version**: v0.1.7
**Date**: 2026-06-02
**Author**: Zylos Team
**Repository**: https://github.com/zylos-ai/zylos-ms-teams
**Status**: Production readiness review

---

## 1. Overview

Microsoft Teams communication component for Zylos. It provides bidirectional messaging between a Zylos AI agent and Microsoft Teams users through private DMs, group chats, and Teams channels using the Teams Apps SDK v2, Bot Framework authentication, Microsoft Graph, and the Zylos C4 communication bridge.

The component supports:

- DM, group chat, and channel messaging
- Smart-mode group/channel monitoring without explicit mentions
- Channel Graph subscriptions with renewal
- Proactive outbound sends through C4
- Threaded channel replies or top-level reply style
- Voice transcription through optional ASR integration
- Delegated-auth Graph reactions
- DM pairing approval flow and disabled-DM policy
- Welcome cards and first-contact DM welcome messages
- Inbound debounce and message deduplication
- Sovereign cloud endpoint selection and diagnostics

## 2. Architecture

### 2.1 Component Structure

```text
zylos-ms-teams/
  src/
    index.js                         Main Express/Teams SDK process and message routing
    routes.js                        HTTP routes for internal sends, media, reactions, OAuth, health, Graph notifications
    admin.js                         Admin CLI for config, ACLs, diagnostics, delegated auth, pairing
    lib/
      access.js                      Access control and mention helpers
      activity-events.js             Edit/delete/card action event formatting
      activity-store.js              Recent conversation activity cache for mutation warnings
      allowlist.js                   Glob/wildcard and configured-entry matching
      allowlist-resolution.js        Graph-backed display-name and group allowlist resolution
      atomic-write.js                Atomic JSON write helper
      attachments.js                 Inbound media resolution
      auth.js                        Bot Framework JWT validation
      bot-connector.js               Bot Connector response/error helpers
      c4.js                          C4 send/retry integration
      card-extractor.js              Adaptive card text extraction
      card-send.js                   Card outbound helpers
      channel-subscriptions.js       Graph subscription lifecycle for smart-mode channels
      cloud.js                       Microsoft cloud endpoint definitions and probes
      config.js                      Config loading, defaults, route config, hot reload, env fallback
      context.js                     JSONL persistence and cold-start replay
      conversation-store.js          Conversation reference persistence
      delegated-auth.js              OAuth2 delegated tokens and Graph reactions
      dm-pairing.js                  DM pairing state and owner notifications
      dm-welcome.js                  Seen-DM tracking and welcome message delivery
      doctor.js                      Configuration/connectivity diagnostics
      errors.js                      User-facing error classification
      fetch-utils.js                 Fetch helpers and redirect handling
      format.js                      Message formatting, endpoints, escaping, Teams ID parsing
      graph.js                       Graph token acquisition, probes, history, chat/channel APIs
      history.js                     In-memory context, replay, reply-chain formatting
      html.js                        HTML-to-text/Markdown conversion and reply extraction
      inbound-content.js             Unsupported inbound content replies
      inbound-debounce.js            Per-conversation inbound debounce
      markdown-split.js              Markdown-aware outbound message splitting
      message-dedup.js               TTL message deduplication
      sent-message-cache.js          Recently sent bot message tracking
      thread-parent-cache.js         Thread parent context cache
      transcribe.js                  Voice transcription provider wrapper
      welcome-card.js                Welcome card attachment builder
  scripts/
    send.js                          C4 outbound message entrypoint
    download-attachments.js          On-demand smart-mode attachment download
  hooks/
    configure.js                     Install-time config collection
    post-install.js                  Data directory/config bootstrap
    pre-upgrade.js                   Pre-upgrade backup
    post-upgrade.js                  Config schema migration
  SKILL.md                           Component manifest and runtime usage reference
  ecosystem.config.cjs               PM2 service configuration
```

### 2.2 Data Flow

**Inbound Teams message to agent:**

1. Teams sends an activity to `/api/messages`.
2. `auth.js` validates the Bot Framework JWT when credentials are configured.
3. `message-dedup.js` filters duplicate activities.
4. `conversation-store.js` persists the conversation reference for proactive replies.
5. `access.js` evaluates DM policy, group/channel policy, owner bypass, per-conversation `allowFrom`, and resolved allowlist entries.
6. `html.js`, `card-extractor.js`, and `attachments.js` normalize text, cards, replies, and media.
7. Optional voice media is transcribed through `transcribe.js`.
8. `history.js` records accepted messages and builds context for group/channel replies.
9. `inbound-content.js` replies to unsupported content when the bot is directly addressed.
10. `inbound-debounce.js` optionally merges rapid messages for the same endpoint.
11. `c4.js` sends the normalized message to C4 with rejection/failure callbacks.

**Smart-mode channel notification to agent:**

1. Microsoft Graph sends lifecycle or message notifications to `/api/notifications`.
2. `channel-subscriptions.js` validates `clientState` and fetches the message or reply through Graph.
3. The fetched activity is routed through the same access, content, history, and C4 path as Bot Framework messages.
4. Channel subscriptions are renewed periodically and recreated when renewal fails.

**Outbound agent reply to Teams:**

1. C4 calls `scripts/send.js` with an endpoint and message body.
2. `send.js` splits large Markdown messages, handles `[SKIP]`, media markers, retry/backoff, and internal token authentication.
3. `/internal/send` resolves the saved conversation reference and route config.
4. `replyStyle: "thread"` preserves `replyToId` where supported; `replyStyle: "new"` suppresses `replyToId`.
5. Bot Connector REST is used when an activity ID is needed or channel thread delivery requires it; otherwise the Teams SDK sends the message.
6. `sent-message-cache.js` and `history.js` record outbound bot messages for reply detection and context.
7. `/internal/react` can set or remove Graph reactions using delegated auth state.

**Diagnostics and startup probes:**

1. Startup checks Bot Framework credentials, Graph token scopes, delegated auth tokens, and configured cloud endpoints.
2. `admin.js doctor` runs the same diagnostic families on demand and reports failures before production use.
3. Cloud mismatch detection compares configured cloud endpoints with token metadata/login behavior.

## 3. Configuration

### 3.1 Credentials

Credentials are stored in `config.json` under `credentials` with legacy `~/zylos/.env` fallback. Config values take precedence.

| Field / variable | Required | Description |
| --- | --- | --- |
| `credentials.appId` / `MSTEAMS_APP_ID` | Yes | Azure Bot Registration App ID |
| `credentials.appPassword` / `MSTEAMS_APP_PASSWORD` | Yes | Azure Bot Registration client secret |
| `credentials.tenantId` / `MSTEAMS_TENANT_ID` | No | Tenant ID for single-tenant bots, Graph, and cloud probes |
| `publicUrl` / `MSTEAMS_PUBLIC_URL` | No | Canonical HTTPS public base URL including `/ms-teams` |
| `cloud` / `MSTEAMS_CLOUD` | No | Microsoft cloud endpoint set: `public`, `gcc`, `gccHigh`, `dod`, `china` |
| `teamsAppCatalogId` / `MSTEAMS_APP_CATALOG_ID` | No | Teams app catalog ID for deterministic DM reactions |

### 3.2 Config File

Located at `~/zylos/components/ms-teams/config.json`.

```json
{
  "enabled": true,
  "port": 3978,
  "credentials": {
    "appId": "",
    "appPassword": "",
    "tenantId": ""
  },
  "publicUrl": "https://bot.example.com/ms-teams",
  "cloud": "public",
  "owner": {
    "bound": false,
    "aadObjectId": "",
    "name": ""
  },
  "dmPolicy": "owner",
  "dmAllowFrom": [],
  "dmWelcomeMessage": "",
  "dmDisabledMessage": "Sorry, I'm not available for private messages.",
  "dmPairingPendingMessage": "Your DM access request has been sent for approval.",
  "dmPairingDeniedMessage": "Sorry, your DM access request was denied.",
  "promptStarters": ["What can you do?", "Help me draft a message", "Summarize a document"],
  "welcomeCardTitle": null,
  "groupPolicy": "allowlist",
  "groups": {},
  "channels": {},
  "debounceMs": 0,
  "replyStyle": "thread",
  "voiceTranscription": "auto",
  "whisperModel": "",
  "teamsAppCatalogId": "",
  "allowlistResolutionIntervalMs": 3600000,
  "graphRequiredScopes": ["ChannelMessage.Read.All", "Chat.Read.All", "Group.Read.All", "User.Read.All"],
  "message": {
    "context_messages": 10
  }
}
```

Policy fields:

- `dmPolicy`: `owner`, `allowlist`, `open`, `pairing`, or `disabled`
- `groupPolicy`: `allowlist`, `open`, or `disabled`
- `replyStyle`: `thread` or `new`
- `voiceTranscription`: `auto`, provider-specific values, or disabled by provider configuration
- `debounceMs`: non-negative delay used to merge rapid inbound messages per endpoint

Conversation route fields:

```json
{
  "groups": {
    "19:chat@thread.v2": {
      "name": "Engineering",
      "mode": "smart",
      "allowFrom": ["aad-object-id", "Felix Lin", "group:Admins", "*@example.com"],
      "replyStyle": "thread"
    }
  },
  "channels": {
    "19:channel@thread.tacv2": {
      "name": "General",
      "teamId": "team-id",
      "mode": "mention",
      "allowFrom": [],
      "replyStyle": "new",
      "posts": {}
    }
  }
}
```

## 4. Integration with Zylos

### 4.1 Lifecycle

- **Install**: Hook creates data directories and default `config.json`.
- **Configure**: Hook writes credentials and public URL into component config.
- **Start**: PM2 launches `src/index.js`.
- **Hot reload**: `config.js` watches `config.json` and reloads settings.
- **Stop**: Graceful shutdown closes the HTTP server, stops config watching, renewal loops, typing timers, and dedup cleanup.
- **Upgrade**: Zylos preserves runtime data listed in `SKILL.md` and runs post-upgrade config migrations.

### 4.2 Data Files

- `config.json` - Runtime config
- `conversations.json` - Conversation references for proactive sends
- `delegated-tokens.json` - Delegated OAuth token state
- `dm-pairing.json` - Pending/denied DM pairing state
- `allowlist-resolution.json` - Graph-resolved allowlist cache
- `conversation-activity.json` - Recent activity cache for mutation warnings
- `seen-dm-users.json` - First-contact DM welcome tracking
- `reaction-cache.json` - Reaction context persistence
- `channel-subscriptions.json` - Graph subscription state
- `logs/*.jsonl` - Conversation history replay logs
- `data/` and `media/` - Runtime scratch/media data

### 4.3 HTTP Routes

Public routes proxied by Caddy:

- `/ms-teams/api/messages` -> `localhost:3978/api/messages`
- `/ms-teams/api/notifications` -> `localhost:3978/api/notifications`
- `/ms-teams/auth/callback` -> `localhost:3978/auth/callback`
- `/ms-teams/auth/sign-in` -> `localhost:3978/auth/sign-in`
- `/ms-teams/health` -> `localhost:3978/health`

Internal localhost-only routes protected by an internal token:

- `/internal/send` - C4 outbound message delivery
- `/internal/send-media` - Media delivery
- `/internal/react` - Reaction set/remove

## 5. Security

- **Bot Framework JWT validation**: Inbound `/api/messages` requests are verified against Microsoft OpenID metadata for the configured cloud and app ID.
- **Tenant-aware issuer validation**: Single-tenant mode constrains accepted issuers to the configured tenant; multi-tenant mode keeps broader legacy issuer support.
- **Credential handling**: Secrets are read from component config or `.env` fallback and are never written to docs or logs intentionally.
- **Owner binding**: The first DM sender binds as owner. Owner bypasses normal allowlists except disabled policies.
- **DM policies**: `owner`, `allowlist`, `open`, `pairing`, and `disabled` provide progressively broader or stricter DM access.
- **Group/channel policies**: `groupPolicy: disabled` blocks all group/channel messages, including owner messages. `allowlist` restricts to configured conversations.
- **Per-conversation allowlists**: `allowFrom` can include AAD object IDs, display names, glob entries, and `group:<name>` entries resolved through Graph.
- **Delegated auth separation**: User-level Graph tokens are stored separately from bot credentials and can be revoked through the admin CLI.
- **Internal endpoint token**: `/internal/*` routes require the runtime-generated internal token.
- **OAuth safety**: OAuth state is consumed atomically, callback output is escaped, and public URL is preferred for redirect URI construction.
- **Sovereign cloud awareness**: Token, Graph, and login endpoints are selected from the configured Microsoft cloud, with startup and doctor mismatch warnings.
- **File preservation**: Upgrade manifests preserve config, tokens, caches, pairing state, subscriptions, history, and data directories.

## 6. Error Handling and Resilience

- Message deduplication prevents duplicate activity handling.
- Inbound unsupported content gets an explicit reply when the bot was addressed.
- Agent/C4 failures trigger user-visible fallback replies where available.
- Bot Connector and Graph failures are classified into clearer user-facing errors.
- Channel subscription renewal recreates subscriptions when renewal fails.
- Graph scope, delegated-auth, credential, and cloud probes surface configuration issues at startup and through `doctor`.
- Inbound debounce reduces bursty multi-message dispatch while preserving rejection/failure callbacks.
- Conversation history is stored in JSONL logs and replayed after cold start.
- Thread parent and sent-message caches improve reply-chain context without requiring every response to query Graph.
- Voice transcription degrades gracefully when ASR is unavailable or transcription fails.

## 7. Future Improvements

- Graph pagination for very large `group:<name>` allowlist resolution.
- Optional pruning of old activity-store entries.
- Failure callback for pairing C4 notifications.
- Legacy alias support for `replyStyle: "top-level"` if existing configs need it.
- Video understanding through frame extraction and a separate privacy/performance review.
- Read receipts through Microsoft Graph `chatMessage` readReceipt resources when permissions and privacy review allow it.
