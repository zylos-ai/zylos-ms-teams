# Microsoft Teams Channel Deployment Guide

Detailed guide for connecting your Zylos AI agent to Microsoft Teams.

| Item | Details |
|------|---------|
| **Estimated time** | 15-20 minutes |
| **Channels supported** | DMs, group chats, Teams channels |
| **Connection mode** | Webhook (HTTPS endpoint required) |

## Prerequisites

| Item | Description |
|------|-------------|
| Azure account | With access to Azure Portal (Entra ID / App Registrations) |
| Microsoft 365 tenant | Where the bot will be installed |
| Zylos core | Installed with comm-bridge (C4) |
| HTTPS endpoint | Public URL for receiving webhooks (ngrok for testing, or a domain with SSL) |
| ~20 minutes | Time to complete deployment |

You do **not** need:
- Microsoft 365 admin access (for initial setup — admin consent is needed later for Graph API features)
- Visual Studio or Bot Framework SDK knowledge
- Azure Bot Service resource (we use direct webhook validation)

## Step 1: Create an Azure App Registration

1. Go to [Azure Portal](https://portal.azure.com) → **Microsoft Entra ID** → **App registrations**
2. Click **New registration**
3. Enter a name (e.g., `zylos-ms-teams`)
4. Under **Supported account types**, select **Single tenant** (recommended) or **Multitenant** depending on your needs
5. Leave **Redirect URI** blank — not needed for bot-only apps
6. Click **Register**

After registration, note down:
- **Application (client) ID** — this is your `MSTEAMS_APP_ID`
- **Directory (tenant) ID** — this is your `MSTEAMS_TENANT_ID`

## Step 2: Create a Client Secret

1. In your App Registration, go to **Certificates & secrets**
2. Click **New client secret**
3. Enter a description (e.g., `zylos-ms-teams-secret`) and select an expiry period
4. Click **Add**
5. **Copy the secret value immediately** — it is only shown once. This is your `MSTEAMS_APP_PASSWORD`

> **Important:** The secret value is displayed only once. Save it immediately. If lost, you must create a new secret.

## Step 3: Add Graph API Permissions (Optional but Recommended)

These permissions enable file attachments, chat history, and user resolution. They are not required for basic messaging but unlock the full feature set.

1. In your App Registration, go to **API permissions**
2. Click **Add a permission** → **Microsoft Graph** → **Application permissions**
3. Add the following:

| Permission | Purpose |
|------------|---------|
| `Files.Read.All` | Download files from OneDrive/SharePoint shared links |
| `Chat.Read.All` | Read DM and group chat history + attachments |
| `ChannelMessage.Read.All` | Read channel message history + attachments |
| `User.Read.All` | Resolve user mentions and search users |

4. Click **Grant admin consent for [your tenant]** — the status should change to a green checkmark for each permission

> **Note:** Admin consent requires tenant admin privileges. If you are not an admin, ask your IT department to grant consent.

## Step 4: Install zylos-ms-teams

```bash
zylos add ms-teams
```

Or install manually:

```bash
cd ~/zylos/.claude/skills/ms-teams
npm install
```

## Step 5: Configure Credentials

Add the following to `~/zylos/.env`:

```bash
MSTEAMS_APP_ID=your_application_client_id
MSTEAMS_APP_PASSWORD=your_client_secret_value
MSTEAMS_TENANT_ID=your_directory_tenant_id
```

## Step 6: Set Up HTTPS Endpoint

The bot needs a public HTTPS endpoint to receive webhooks from Teams. Choose one:

### Option A: ngrok (for testing)

```bash
ngrok http 3978
```

Note the HTTPS URL (e.g., `https://xxxx.ngrok-free.dev`). Your messaging endpoint will be:
```
https://xxxx.ngrok-free.dev/api/messages
```

### Option B: Production domain

Point your domain to the server running zylos-ms-teams and configure SSL (e.g., via Caddy or Cloudflare). Your messaging endpoint will be:
```
https://your-domain.com/api/messages
```

## Step 7: Create a Teams App Manifest

Create a `manifest.json` for your Teams app:

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
  "manifestVersion": "1.17",
  "version": "1.0.0",
  "id": "<your MSTEAMS_APP_ID>",
  "developer": {
    "name": "Your Organization",
    "websiteUrl": "https://your-domain.com",
    "privacyUrl": "https://your-domain.com/privacy",
    "termsOfUseUrl": "https://your-domain.com/terms"
  },
  "name": {
    "short": "Zylos",
    "full": "Zylos AI Agent"
  },
  "description": {
    "short": "AI agent for Teams",
    "full": "Zylos AI agent — your AI digital employee on Microsoft Teams."
  },
  "icons": {
    "color": "color.png",
    "outline": "outline.png"
  },
  "bots": [
    {
      "botId": "<your MSTEAMS_APP_ID>",
      "scopes": ["personal", "team", "groupChat"],
      "supportsFiles": true,
      "isNotificationOnly": false
    }
  ],
  "permissions": ["messageTeamMembers"],
  "validDomains": []
}
```

Replace `<your MSTEAMS_APP_ID>` with your actual Application (client) ID.

### Prepare the App Package

1. Create two icon files:
   - `color.png` — 192x192 full-color icon
   - `outline.png` — 32x32 transparent outline icon
2. Zip all three files together: `manifest.json`, `color.png`, `outline.png`

## Step 8: Install the App in Teams

### Sideloading (for development)

1. Open Microsoft Teams
2. Go to **Apps** → **Manage your apps** → **Upload a custom app**
3. Select the zip file from Step 7
4. Click **Add** to install for personal use, or **Add to a team** for channel access

### Admin deployment (for organization-wide rollout)

1. Go to [Teams Admin Center](https://admin.teams.microsoft.com)
2. Navigate to **Teams apps** → **Manage apps**
3. Click **Upload new app** and select the zip file
4. Configure app policies to make it available to your organization

## Step 9: Start the Service

```bash
pm2 start zylos-ms-teams
```

Or if using the zylos CLI:
```bash
zylos start teams
```

Verify the service is running:
```bash
pm2 logs zylos-ms-teams --lines 10
```

You should see:
```
[ms-teams] HTTP server running on 127.0.0.1:3978
[ms-teams] Bot identity: bot (<your app id>)
[ms-teams] Credentials: configured
```

## Step 10: Start Using

1. In Teams, search for your bot name (e.g., "Zylos")
2. Click to start a DM conversation
3. Send any message — the AI agent responds
4. Deployment complete!

### Group/Channel Usage

1. Add the bot to a team or group chat
2. @mention the bot to trigger a response
3. Configure group access via the admin CLI (see [Configuration](#configuration) below)

## Configuration

### Runtime Config

Config file: `~/zylos/components/ms-teams/config.json`

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable/disable the channel |
| `port` | `3978` | HTTP server port |
| `dmPolicy` | `"owner"` | DM access: `owner`, `allowlist`, or `open` |
| `groupPolicy` | `"allowlist"` | Group access: `allowlist`, `open`, or `disabled` |

### Admin CLI

```bash
# Show current config
node src/admin.js show

# DM access control
node src/admin.js set-dm-policy open|allowlist|owner
node src/admin.js add-dm-allow <aadObjectId>
node src/admin.js remove-dm-allow <aadObjectId>

# Group management
node src/admin.js add-group <conversationId> --name "Group Name"
node src/admin.js remove-group <conversationId>
node src/admin.js set-group-policy open|allowlist|disabled

# Check Graph API status
node src/admin.js graph-status
```

## Features

| Feature | Requires Graph | Status |
|---------|---------------|--------|
| DM messaging | No | Available |
| Group/channel messaging | No | Available |
| @mention detection | No | Available |
| Image attachments (inbound) | No* | Available |
| File attachments (inbound) | Yes | Available |
| OneDrive/SharePoint files | Yes | Available |
| Chat history context | Yes | Available |
| Proactive messaging | No | Available |
| Image sending (outbound) | No | Available |

\* Image download in DMs uses Bot Framework token; Graph is needed for channel images.

## Attachment Download

zylos-ms-teams uses a 3-tier download strategy for inbound file attachments:

| Tier | Method | Used For |
|------|--------|----------|
| 1 | Direct download | `file.download.info` attachments, `contentUrl` with SharePoint URL rewriting |
| 2 | Bot Framework v3 `/attachments/{id}` | DM conversations (`a:` or `8:orgid:` IDs) |
| 3 | Graph API message fetch | Group/channel conversations, SharePoint references, hosted content |

Each tier includes auth fallback: unauthenticated → Bot Framework token → Graph token.

## Known Limitations

| Limitation | Details |
|------------|---------|
| No direct file upload in bot DMs | Teams does not allow drag-and-drop file upload in bot DMs. Files arrive via OneDrive sharing or file cards. |
| Webhook timeouts | Teams expects a quick HTTP response. Slow processing may cause retries or dropped replies. zylos-ms-teams handles this by responding immediately and sending replies proactively. |
| Reactions require delegated auth | Reactions use Graph API with delegated permissions (`Chat.ReadWrite`, `ChannelMessage.Send`). A user must complete the OAuth sign-in flow once at `/auth/sign-in`. |
| Formatting limits | Teams markdown is more limited than Slack or Discord. Tables and nested lists may not render correctly. |

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Bot not responding | Check credentials in `~/zylos/.env`, verify HTTPS endpoint is reachable, check `pm2 logs zylos-ms-teams` |
| 401 on attachments | Ensure Graph API permissions are granted with admin consent |
| Duplicate messages | Normal — Teams may retry webhooks. zylos-ms-teams deduplicates automatically (5-minute window) |
| Bot not visible in Teams | Ensure the app manifest is correctly packaged and sideloaded/deployed |
| Graph features not working | Check `node src/admin.js graph-status` — all three credentials must be set and admin consent granted |

## Updating the App

When updating the bot (e.g., new features, icon changes):

1. Bump the `version` in `manifest.json`
2. Re-package the zip file
3. In Teams: **Apps** → **Manage your apps** → find your app → **Upload new version**
4. **Fully quit and relaunch Teams** to clear cached app metadata
