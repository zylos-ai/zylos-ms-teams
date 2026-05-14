---
name: teams
version: 0.2.0
description: >-
  Microsoft Teams communication channel.
  Use when: (1) replying to Teams messages (DM or group/channel @mentions),
  (2) sending proactive messages to Teams users or groups,
  (3) managing DM access control (dmPolicy: open/allowlist/owner, dmAllowFrom list),
  (4) managing group access control (groupPolicy, per-group allowFrom),
  (5) configuring the bot (admin CLI, credentials),
  (6) troubleshooting Teams bot or service issues.
  Config at ~/zylos/components/teams/config.json. Service: pm2 zylos-teams.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-teams
    entry: src/index.js
  data_dir: ~/zylos/components/teams
  hooks:
    configure: hooks/configure.js
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - data/

upgrade:
  repo: zylos-ai/zylos-teams
  branch: main

config:
  required:
    - name: MSTEAMS_APP_ID
      description: "Azure Bot Registration App ID (Microsoft App ID from Azure portal)"
    - name: MSTEAMS_APP_PASSWORD
      description: "Azure Bot Registration App Password (client secret)"
      sensitive: true

next-steps: "BEFORE starting the service: 1) Ensure MSTEAMS_APP_ID and MSTEAMS_APP_PASSWORD are set in ~/zylos/.env. 2) Optionally set MSTEAMS_TENANT_ID for single-tenant bots. 3) Configure the messaging endpoint in Azure Bot Registration to point to https://{domain}/teams/api/messages. 4) Start the service (pm2 restart zylos-teams)."

http_routes:
  - path: /teams/api/messages
    type: reverse_proxy
    target: localhost:3978
    strip_prefix: /teams

dependencies:
  - comm-bridge
---

# Microsoft Teams

Microsoft Teams communication channel for zylos.

Depends on: comm-bridge (C4 message routing).

## Sending Messages

```bash
# Via C4 bridge (standard path — always use stdin form)
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "teams" "<conversationId>|type:dm|user:<aadObjectId>"
Hello!
EOF
```

Direct send (bypasses C4 logging, for testing only):
```bash
node ~/zylos/.claude/skills/teams/scripts/send.js "<endpoint>" "Hello!"
```

## Admin CLI

Manage bot configuration via `admin.js`:

```bash
ADM="node ~/zylos/.claude/skills/teams/src/admin.js"

# General
$ADM show                                    # Show full config
$ADM show-owner                              # Show current owner
$ADM help                                    # Show all commands

# DM Access Control
$ADM set-dm-policy <open|allowlist|owner>     # Set DM policy
$ADM list-dm-allow                            # Show DM policy + allowFrom list
$ADM add-dm-allow <aad_object_id>             # Add user to dmAllowFrom
$ADM remove-dm-allow <aad_object_id>          # Remove user from dmAllowFrom

# Group Management
$ADM list-groups                              # List all configured groups
$ADM add-group <conversation_id> <name>       # Add group
$ADM remove-group <conversation_id>           # Remove a group
$ADM set-group-policy <disabled|allowlist|open>  # Set group policy
```

After changes, restart: `pm2 restart zylos-teams`

## Config Location

- Config: `~/zylos/components/teams/config.json`
- Logs: `~/zylos/components/teams/logs/`
- Conversations: `~/zylos/components/teams/conversations.json`

## Azure Bot Setup

### 1. Credentials

Add to `~/zylos/.env`:

```bash
MSTEAMS_APP_ID=your_app_id
MSTEAMS_APP_PASSWORD=your_app_password
# Optional: for single-tenant bots
MSTEAMS_TENANT_ID=your_tenant_id
```

Get these from your Azure Bot Registration:
- Azure Portal: [portal.azure.com](https://portal.azure.com) -> Bot Services

### 2. Messaging Endpoint

In the Azure Bot Registration settings, set the messaging endpoint to:
```
https://<your-domain>/teams/api/messages
```

The path is defined by `http_routes` in SKILL.md.

## Owner

First user to send a private message becomes the owner (primary partner).
Owner always bypasses all access checks (DM and group) regardless of policy settings.

Owner info stored in config.json:
```json
{
  "owner": {
    "bound": true,
    "aadObjectId": "xxx",
    "name": "Howard"
  }
}
```

## Access Control

### Permission Flow

DM and group access are controlled by **independent** top-level policies:

```json
{
  "dmPolicy": "owner",
  "dmAllowFrom": ["aad-object-id-1"],
  "groupPolicy": "allowlist",
  "groups": { ... }
}
```

**Private DM (dmPolicy):**
1. Owner? -> always allowed
2. `dmPolicy` = `open`? -> anyone can DM
3. `dmPolicy` = `owner`? -> only owner can DM
4. `dmPolicy` = `allowlist`? -> check `dmAllowFrom` list; not in list -> dropped

**Group/channel message (groupPolicy):**
1. `groupPolicy` = `disabled`? -> all group messages dropped
2. `groupPolicy` = `open`? -> respond to @mentions from any group
3. `groupPolicy` = `allowlist`? -> only configured groups; unlisted groups -> only owner passes

**Key points:**
- Owner always bypasses all access checks
- `dmPolicy` and `groupPolicy` are fully independent

## Service Management

```bash
pm2 status zylos-teams
pm2 logs zylos-teams
pm2 restart zylos-teams
```
