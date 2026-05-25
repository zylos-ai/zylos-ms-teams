<p align="center">
  <img src="./assets/logo.png" alt="Zylos" height="120">
</p>

<h1 align="center">zylos-ms-teams</h1>

<p align="center">
  Microsoft Teams communication channel for <a href="https://github.com/zylos-ai/zylos-core">Zylos</a> agents.
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="Node.js"></a>
  <a href="https://discord.gg/GS2J39EGff"><img src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://x.com/ZylosAI"><img src="https://img.shields.io/badge/X-follow-000000?logo=x&logoColor=white" alt="X"></a>
  <a href="https://zylos.ai"><img src="https://img.shields.io/badge/website-zylos.ai-blue" alt="Website"></a>
  <a href="https://coco.xyz"><img src="https://img.shields.io/badge/Built%20by-Coco-orange" alt="Built by Coco"></a>
</p>

---

- **Chat on Teams** — your AI agent lives in Microsoft Teams, supporting DMs and group conversations
- **Smart group monitoring** — automatically follow designated group discussions, no @mention needed
- **Voice messages** — audio messages transcribed via ASR and forwarded as text
- **Zero-config start** — first DM auto-binds you as owner, no setup wizards

## Getting Started

Tell your Zylos agent:

> "Install the ms-teams component"

Or use the CLI:

```bash
zylos add ms-teams
```

Zylos will guide you through the setup, including obtaining Azure Bot Registration credentials. Once installed, message your bot on Teams — the first user to DM becomes the owner.

### Prerequisites

- Node.js 20+
- An Azure Bot Registration with:
  - Microsoft App ID
  - Microsoft App Password (client secret)
  - Messaging endpoint configured to your server
- Zylos core with comm-bridge (C4) installed

## Configuration

### Credentials

Run the configure hook to set credentials (stored in `config.json`):

```bash
zylos configure ms-teams
```

This prompts for `MSTEAMS_APP_ID`, `MSTEAMS_APP_PASSWORD`, and optionally `MSTEAMS_TENANT_ID` and `MSTEAMS_PUBLIC_URL`, and stores them in the component config.

> **Legacy fallback:** existing `~/zylos/.env` values are still read if not present in config.json.

Get credentials from your Azure Bot Registration:
- Azure Portal: [portal.azure.com](https://portal.azure.com) -> Bot Services

### Messaging Endpoint

In Azure Bot Registration, set the messaging endpoint to:

```
https://<your-domain>/ms-teams/api/messages
```

### Runtime Config

Config file: `~/zylos/components/ms-teams/config.json`

```json
{
  "enabled": true,
  "port": 3978,
  "dmPolicy": "owner",
  "dmAllowFrom": [],
  "groupPolicy": "allowlist",
  "groups": {},
  "owner": {
    "bound": false,
    "aadObjectId": "",
    "name": ""
  }
}
```

## Managing the Bot

Just tell your Zylos agent what you need:

| Task | Example |
|------|---------|
| Add user to DM allowlist | "Add user X to ms-teams DM allowlist" |
| Enable smart group | "Set this Teams group to smart mode" |
| Add a channel | "Add the General channel to ms-teams" |
| Check status | "Show ms-teams bot status" |
| Restart bot | "Restart ms-teams bot" |
| Upgrade | "Upgrade ms-teams component" |

Or manage via admin CLI:

```bash
ADM="node ~/zylos/.claude/skills/ms-teams/src/admin.js"

# General
$ADM show                                       # Show full config
$ADM show-owner                                  # Show current owner

# DM Access Control
$ADM set-dm-policy <open|allowlist|owner>         # Set DM policy
$ADM list-dm-allow                                # Show DM policy + allowFrom list
$ADM add-dm-allow <aad_object_id>                 # Add user to DM allowlist
$ADM remove-dm-allow <aad_object_id>              # Remove user from DM allowlist

# Group Chat Management
$ADM list-groups                                  # List all configured group chats
$ADM add-group <conv_id> <name> [mode]            # Add group chat (mode: mention|smart)
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

# Delegated Auth (reactions)
$ADM auth-status                                  # Show delegated auth users
$ADM auth-url <base-url>                          # Generate sign-in URL
$ADM auth-revoke <aad_object_id>                  # Revoke delegated auth
```

## Access Control

### DM Policy

Controls who can send direct messages to the bot:

- `owner` (default) — Only the owner can DM
- `allowlist` — Only users in `dmAllowFrom` can DM
- `open` — Anyone can DM

### Group Policy

Controls which groups/channels the bot responds in:

- `allowlist` (default) — Only configured groups
- `open` — All groups where bot is @mentioned
- `disabled` — No group messages

### Owner

The first user to send a DM becomes the owner. The owner bypasses DM and group/channel access control checks, except when `groupPolicy: disabled` — that setting is absolute and blocks all group messages for everyone, including the owner.

## Smart Mode

Groups and channels can operate in two modes:

- **mention** (default) — Bot only responds to @mentions
- **smart** — Bot receives all messages; agent decides whether to respond

Channels in smart mode use Microsoft Graph API subscriptions (auto-renewed every 10 min) to receive messages without @mention. A 💬 reaction is set on incoming messages as a processing indicator and removed after the reply is sent.

In smart mode without @mention:
- Attachments are fetched on-demand via `download-attachments.js`
- Agent sees the full conversation and can choose to skip

## Message Routing

| Scenario | Bot Response |
|----------|--------------|
| Private DM (owner/allowlisted) | Responds via agent |
| Smart group/channel message | Receives all messages, agent decides |
| @mention in allowed group/channel | Responds with recent context |
| Owner @mention in any group | Always responds |
| Unknown user DM | Rejected with notice |

## Voice Messages

When `~/zylos/bin/transcribe` exists (voice-asr skill installed), audio attachments are transcribed and forwarded as `[Voice] <transcription>`. Works in both DMs and group chats.

In smart mode, voice messages are always downloaded and transcribed even without @mention.

## Documentation

- [SKILL.md](./SKILL.md) — Component specification and usage reference
- [CHANGELOG.md](./CHANGELOG.md) — Version history
- [DESIGN.md](./DESIGN.md) — Architecture and design

## Built by Coco

Zylos is the open-source core of [Coco](https://coco.xyz/) — the AI employee platform.

## License

[MIT](./LICENSE)
