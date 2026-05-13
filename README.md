# zylos-teams

Microsoft Teams communication channel for the [Zylos](https://github.com/zylos-ai) AI agent ecosystem.

Receives messages from Microsoft Teams via Bot Framework and routes them to the Zylos agent through the C4 communication bridge.

## Prerequisites

- Node.js 20+
- An Azure Bot Registration with:
  - Microsoft App ID
  - Microsoft App Password (client secret)
  - Messaging endpoint configured to your server
- Zylos core with comm-bridge (C4) installed

## Installation

```bash
zylos add teams
```

This will prompt for your Azure Bot credentials and set up the service.

## Configuration

### Credentials

Add to `~/zylos/.env`:

```bash
MSTEAMS_APP_ID=your_microsoft_app_id
MSTEAMS_APP_PASSWORD=your_microsoft_app_password
# Optional: for single-tenant bots
MSTEAMS_TENANT_ID=your_tenant_id
```

### Runtime Config

Config file: `~/zylos/components/teams/config.json`

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

### Messaging Endpoint

In Azure Bot Registration, set the messaging endpoint to:

```
https://<your-domain>/msteams/api/messages
```

## Access Control

### DM Policy

Controls who can send direct messages to the bot:

- `owner` (default) - Only the owner can DM
- `allowlist` - Only users in `dmAllowFrom` can DM
- `open` - Anyone can DM

### Group Policy

Controls which groups/channels the bot responds in:

- `allowlist` (default) - Only configured groups
- `open` - All groups where bot is @mentioned
- `disabled` - No group messages

### Owner

The first user to send a DM becomes the owner. The owner always bypasses all access control checks.

## Admin CLI

```bash
ADM="node ~/zylos/.claude/skills/teams/src/admin.js"

$ADM show                                    # Show config
$ADM show-owner                              # Show owner
$ADM set-dm-policy <open|allowlist|owner>     # Set DM policy
$ADM list-dm-allow                            # Show DM allowlist
$ADM add-dm-allow <aad_object_id>             # Add user
$ADM remove-dm-allow <aad_object_id>          # Remove user
$ADM list-groups                              # List groups
$ADM add-group <conversation_id> <name>       # Add group
$ADM remove-group <conversation_id>           # Remove group
$ADM set-group-policy <disabled|allowlist|open>
```

## Service Management

```bash
pm2 status zylos-teams
pm2 logs zylos-teams
pm2 restart zylos-teams
```

## License

MIT
