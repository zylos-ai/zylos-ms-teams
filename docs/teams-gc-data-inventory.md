# Teams GC Data Inventory — What's Available to an Azure Bot

Research date: 2026-05-15

## Currently Used in C4 Payload

| Data | Source | Status |
|------|--------|--------|
| Message text (plain + HTML) | Bot SDK activity | Used |
| Sender name + AAD ID | Bot SDK activity.from | Used |
| Conversation ID + type | Bot SDK activity.conversation | Used |
| @mentions (entities) | Bot SDK activity.entities | Used (stripping) |
| Attachments (files, images) | Bot SDK + Graph API Tier 1-3 | Used |
| Quoted replies | Bot SDK HTML attachment | Used |
| Group context (recent messages) | In-memory + Graph API fallback | Used |
| Reactions on bot messages | Bot SDK messageReaction | Not used |
| Tenant ID | Bot SDK channelData.tenant.id | Used (auth) |

---

## Available — High Value, Easy to Add

### 1. Group Member List
- **Bot SDK**: `TeamsInfo.getPagedMembers()` or `GET /v3/conversations/{id}/pagedmembers` — no extra permissions needed
- **Graph**: `GET /chats/{id}/members` — returns displayName, email, roles (owner/guest/member), userId
- **RSC**: `ChatMember.Read.Chat`
- **Use case**: Know who's in the group even if they haven't spoken

### 2. Chat Metadata (Topic/Title)
- **Graph**: `GET /chats/{id}` — returns topic, chatType, createdDateTime, lastUpdatedDateTime, webUrl
- **RSC**: `ChatSettings.Read.Chat`
- **Use case**: Know what the group is about

### 3. Sender Details (Job Title, Department, Email)
- **Bot SDK**: `TeamsInfo.getMember()` — returns givenName, surname, email, UPN, userRole (no extra permissions)
- **Graph**: `GET /users/{id}` — returns jobTitle, department, officeLocation, companyName, etc. (requires User.Read.All)
- **Use case**: Context about who you're talking to

### 4. User Presence/Status
- **Graph**: `GET /users/{id}/presence` — availability (Available/Away/Busy/DND/Offline), activity, outOfOffice message
- **Batch**: `POST /communications/getPresencesByUserId` — multiple users at once
- **Permissions**: Presence.Read.All
- **Use case**: Know if someone is available before suggesting to involve them

### 5. Reactions on All Messages
- **Graph**: Each chatMessage has `reactions[]` with reactionType, user, timestamp
- **Bot SDK**: Only reactions on bot's own messages (messageReaction activity)
- **Use case**: Gauge sentiment, see what people agreed/disagreed with

---

## Available — Medium Value

### 6. Pinned Messages
- **Graph**: `GET /chats/{id}/pinnedMessages` — pinned message content
- **Permissions**: Chat.Read.All or RSC ChatMessage.Read.Chat
- **Use case**: Important context the group has highlighted

### 7. Installed Apps & Tabs
- **Graph**: `GET /chats/{id}/installedApps`, `GET /chats/{id}/tabs`
- **RSC**: `TeamsAppInstallation.Read.Chat`, `TeamsTab.Read.Chat`
- **Use case**: Know what tools the group uses

### 8. Manager/Org Data
- **Graph**: `GET /users/{id}/manager`, `/directReports`, `/memberOf`
- **Permissions**: User.Read.All, Directory.Read.All
- **Use case**: Understand reporting relationships

### 9. Meeting Context
- **Graph**: `GET /chats/{id}` → onlineMeetingInfo → calendarEventId, joinWebUrl, organizer
- **Graph**: `GET /users/{id}/onlineMeetings/{id}` — full meeting details (subject, start/end, participants, recording settings)
- **RSC**: `OnlineMeeting.ReadBasic.Chat`
- **Use case**: If GC is linked to a meeting, know what it's about

### 10. Read Receipts
- **Bot SDK**: RSC `ChatMessageReadReceipt.Read.Chat` — lastReadMessageId
- **Use case**: Know if people have seen your message

---

## Available — Low Value / Specialized

### 11. Profile Photos
- **Graph**: `GET /users/{id}/photo/$value` — binary image data
- **Permissions**: User.Read.All

### 12. User's Teams Membership
- **Graph**: `GET /users/{id}/joinedTeams` — all teams the user belongs to
- **Permissions**: Team.ReadBasic.All

### 13. Change Notifications (Webhooks)
- **Graph**: Subscribe to `/chats/{id}/messages` for real-time message notifications
- **Graph**: Subscribe to `/chats/{id}` for chat metadata changes (topic, members)
- **Use case**: Could enable smart mode (receive all messages without @mention)

### 14. Message Edit/Delete History
- **Graph**: chatMessage has `lastEditedDateTime`, `deletedDateTime`, `messageHistory[]`
- **Bot SDK**: `messageUpdate` and `messageDelete` activity types

### 15. Activity Feed Notifications
- **RSC**: `TeamsActivity.Send.Chat` (always enabled)
- **Use case**: Push notifications to users' activity feed

---

## Not Available (Confirmed)

- Bookmarked messages (client-side only)
- Message forwarding history
- Per-chat permission policies (admin-level)
- Chat background/theme
- Typing indicators via Graph (Bot SDK only)
- Custom emoji reactions (only 6 types: like, heart, laugh, surprised, sad, angry)

---

## RSC Permissions Reference (Chat Context)

| Permission | What It Grants |
|------------|---------------|
| ChatMessage.Read.Chat | Read messages |
| ChatMessageReadReceipt.Read.Chat | Read receipts |
| ChatMember.Read.Chat | Read members |
| ChatSettings.Read.Chat | Read chat settings |
| Chat.Manage.Chat | Manage chat |
| TeamsTab.Read.Chat | Read tabs |
| TeamsAppInstallation.Read.Chat | Read installed apps |
| TeamsActivity.Send.Chat | Send activity feed notifications |
| OnlineMeeting.ReadBasic.Chat | Read meeting properties |
| OnlineMeetingTranscript.Read.Chat | Read transcripts |
| OnlineMeetingRecording.Read.Chat | Read recordings |

---

## Key Graph API Endpoints for GC

| Endpoint | Returns |
|----------|---------|
| `GET /chats/{id}` | Chat metadata (topic, type, dates) |
| `GET /chats/{id}/members` | Member list with roles |
| `GET /chats/{id}/messages` | Message history |
| `GET /chats/{id}/messages/{id}` | Single message with attachments |
| `GET /chats/{id}/pinnedMessages` | Pinned messages |
| `GET /chats/{id}/installedApps` | Installed apps |
| `GET /chats/{id}/tabs` | Tabs |
| `GET /chats/{id}/permissionGrants` | RSC permissions granted |
| `GET /users/{id}` | User profile (name, title, dept) |
| `GET /users/{id}/presence` | Online/away/busy status |
| `GET /users/{id}/manager` | Manager |
| `GET /users/{id}/photo/$value` | Profile photo |
