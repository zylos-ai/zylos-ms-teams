---
name: ms-teams
version: 0.1.3
description: >-
  Microsoft Teams communication channel.
  Use when: (1) replying to Teams messages (DM or group/channel @mentions),
  (2) sending proactive messages to Teams users or groups,
  (3) managing DM access control (dmPolicy: open/allowlist/owner, dmAllowFrom list),
  (4) managing group access control (groupPolicy, per-group allowFrom),
  (5) configuring the bot (admin CLI, credentials),
  (6) troubleshooting Teams bot or service issues.
  Config at ~/zylos/components/ms-teams/config.json. Service: pm2 zylos-ms-teams.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-ms-teams
    entry: src/index.js
  data_dir: ~/zylos/components/ms-teams
  hooks:
    configure: hooks/configure.js
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - conversations.json
    - delegated-tokens.json
    - reaction-cache.json
    - channel-subscriptions.json
    - data/
    - logs/

upgrade:
  repo: zylos-ai/zylos-ms-teams
  branch: main

config:
  required:
    - name: MSTEAMS_APP_ID
      description: "Azure Bot Registration App ID (Microsoft App ID from Azure portal)"
    - name: MSTEAMS_APP_PASSWORD
      description: "Azure Bot Registration App Password (client secret)"
      sensitive: true
  optional:
    - name: MSTEAMS_TENANT_ID
      description: "Azure AD Tenant ID (for single-tenant bots)"
    - name: MSTEAMS_GRAPH_TOKEN
      description: "Graph API token (enables chat history fallback)"
      sensitive: true
    - name: MSTEAMS_PUBLIC_URL
      description: "Canonical public HTTPS URL for OAuth redirects and Graph subscriptions. Falls back to x-forwarded-* headers if not set."

next-steps: "BEFORE starting the service: 1) Ensure MSTEAMS_APP_ID and MSTEAMS_APP_PASSWORD are set in ~/zylos/.env. 2) Optionally set MSTEAMS_TENANT_ID for single-tenant bots. 3) Configure the messaging endpoint in Azure Bot Registration to point to https://{domain}/ms-teams/api/messages. 4) Start the service (pm2 restart zylos-ms-teams)."

http_routes:
  - path: /ms-teams/api/messages
    type: reverse_proxy
    target: localhost:3978
    strip_prefix: /ms-teams
  - path: /ms-teams/api/notifications
    type: reverse_proxy
    target: localhost:3978
    strip_prefix: /ms-teams

dependencies:
  - comm-bridge
---

# Microsoft Teams

Microsoft Teams communication channel for zylos.

Depends on: comm-bridge (C4 message routing). Optional: voice-asr (auto-detected via ~/zylos/bin/transcribe; disabled gracefully when absent).

## Sending Messages

```bash
# Via C4 bridge (standard path — always use stdin form)
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "ms-teams" "<conversationId>|type:dm|user:<aadObjectId>"
Hello!
EOF
```

Direct send (bypasses C4 logging, for testing only):
```bash
node ~/zylos/.claude/skills/ms-teams/scripts/send.js "<endpoint>" "Hello!"
```

## Media Messages

```bash
# Send image
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "ms-teams" "<conversationId>|type:dm|user:<aadObjectId>"
[MEDIA:image]/path/to/photo.png
EOF

# Send file
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "ms-teams" "<conversationId>|type:dm|user:<aadObjectId>"
[MEDIA:file]/path/to/document.pdf
EOF
```

Images are sent as inline base64 attachments. Other file types are sent as a text reference.

## On-Demand Attachment Download

For smart-mode conversations, attachments may not be included in the webhook payload. Use the on-demand download script:

```bash
node ~/zylos/.claude/skills/ms-teams/scripts/download-attachments.js <conversationId> <messageId>
```

## Admin CLI

Manage bot configuration via `admin.js`:

```bash
ADM="node ~/zylos/.claude/skills/ms-teams/src/admin.js"

# General
$ADM show                                       # Show full config
$ADM show-owner                                  # Show current owner
$ADM help                                        # Show all commands

# DM Access Control
$ADM set-dm-policy <open|allowlist|owner>         # Set DM policy
$ADM list-dm-allow                                # Show DM policy + allowFrom list
$ADM add-dm-allow <aad_object_id>                 # Add user to dmAllowFrom
$ADM remove-dm-allow <aad_object_id>              # Remove user from dmAllowFrom

# Group Chat Management
$ADM list-groups                                  # List all configured group chats
$ADM add-group <conv_id> <name> [mode]            # Add a group chat (mode: mention|smart)
$ADM remove-group <conversation_id>               # Remove a group chat
$ADM set-group-policy <disabled|allowlist|open>    # Set group policy
$ADM set-group-mode <conv_id> <mention|smart>      # Set group chat mode
$ADM add-group-allow <conv_id> <aad_id>           # Add user to per-group allowFrom
$ADM remove-group-allow <conv_id> <aad_id>        # Remove user from per-group allowFrom
$ADM list-group-allow <conv_id>                   # Show per-group allowFrom list

# Channel Management
$ADM list-channels                                # List all configured channels
$ADM add-channel <channelId> <teamId> <name>      # Add a channel
$ADM remove-channel <channelId>                   # Remove a channel
$ADM set-channel-mode <channelId> <mention|smart>  # Set channel mode
$ADM add-channel-allow <chId> <aad_id>            # Add user to per-channel allowFrom
$ADM remove-channel-allow <chId> <aad_id>         # Remove user from per-channel allowFrom
$ADM list-channel-allow <chId>                    # Show per-channel allowFrom list

# Diagnostics
$ADM graph-status                                 # Show Graph API configuration state

# Delegated Auth (reactions)
$ADM auth-status                                  # Show delegated auth users
$ADM auth-url <base-url>                          # Generate sign-in URL
$ADM auth-revoke <aad_object_id>                  # Revoke delegated auth for a user
```

After changes, restart: `pm2 restart zylos-ms-teams`

## Config Location

- Config: `~/zylos/components/ms-teams/config.json`
- Logs: `~/zylos/components/ms-teams/logs/`
- Conversations: `~/zylos/components/ms-teams/conversations.json`
- Delegated tokens: `~/zylos/components/ms-teams/delegated-tokens.json`
- Reaction cache: `~/zylos/components/ms-teams/reaction-cache.json`
- Channel subscriptions: `~/zylos/components/ms-teams/channel-subscriptions.json`

## Environment Variables

Required in `~/zylos/.env`:

```bash
# Azure Bot Registration (required)
MSTEAMS_APP_ID=your_app_id
MSTEAMS_APP_PASSWORD=your_app_password

# Optional: for single-tenant bots
MSTEAMS_TENANT_ID=your_tenant_id

# Optional: enables Graph API for chat history fallback
MSTEAMS_GRAPH_TOKEN=your_graph_token

# Optional: canonical public URL for OAuth redirects and Graph subscriptions
# Must be HTTPS. Falls back to x-forwarded-* headers if not set (less trusted).
MSTEAMS_PUBLIC_URL=https://bot.example.com
```

## Owner

First user to send a private message becomes the owner.
Owner bypasses DM and group/channel access checks, except when `groupPolicy: disabled` — that setting is absolute and blocks all group messages for everyone, including the owner.

## Access Control

### Permission Flow

DM and group access are controlled by **independent** top-level policies.

**Private DM (dmPolicy):**
1. Owner? -> always allowed
2. `dmPolicy` = `open`? -> anyone can DM
3. `dmPolicy` = `owner`? -> only owner can DM
4. `dmPolicy` = `allowlist`? -> check `dmAllowFrom` list

**Group/channel message (groupPolicy):**
1. `groupPolicy` = `disabled`? -> all group messages dropped
2. `groupPolicy` = `open`? -> respond to @mentions from any group
3. `groupPolicy` = `allowlist`? -> only configured groups; owner always passes

Per-group/channel options: `mode` (mention/smart), `allowFrom` (restrict senders), `historyLimit`.

## Smart Mode

Groups and channels can operate in two modes:

- **mention** (default): Bot only responds to @mentions
- **smart**: Bot receives all messages; agent decides whether to respond

Channels in smart mode use Microsoft Graph API subscriptions (auto-renewed every 10 min) to receive messages without @mention.

## Group Context

Recent message history is included for group/channel replies. Context is built from in-memory history with Graph API fallback. Chat history is persisted to JSONL files for cold-start replay.

## Voice Messages

When `~/zylos/bin/transcribe` exists, audio attachments are transcribed and forwarded as `[Voice] <transcription>`.

## Service Management

```bash
pm2 status zylos-ms-teams
pm2 logs zylos-ms-teams
pm2 restart zylos-ms-teams
```

Run `node ~/zylos/.claude/skills/ms-teams/src/admin.js help` for all commands.
