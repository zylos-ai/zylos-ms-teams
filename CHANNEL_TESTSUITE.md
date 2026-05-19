# Zylos Channel Component — Standardized Test Suite

> Generic test checklist for validating zylos communication channel components.
> Tests are split into **Core** (applies to all channels) and **Platform-Specific**
> (only relevant to platforms with that capability).
>
> When testing a new channel, run all Core tests and applicable Platform-Specific tests.

## Prerequisites

- Two user accounts: **Owner** (admin, platform ID known) and **Non-Owner** (standard user)
- At least one group chat (and one channel, if the platform supports channels)
- Admin CLI available: `ADM="node $HOME/zylos/.claude/skills/<component>/src/admin.js"`
- Component service running via PM2

---

# Core Tests

These tests apply to **all** channel components (Teams, Lark, WeCom, Telegram, etc.).

## C1. DM Messaging

| ID | Test | Method | Expected | Result |
|----|------|--------|----------|--------|
| C1-1 | Text round-trip | Send text DM; verify bot responds with accurate content | Full text round-trip works | |
| C1-2 | Multi-line message | Send a message with multiple lines/paragraphs | Bot receives and processes all lines | |
| C1-3 | Long message splitting | Trigger a response longer than platform limit; verify message splits correctly | Multiple chunks sent, no content lost | |
| C1-4 | Owner auto-binding | First DM from a new user auto-binds them as owner | Owner recorded in config | |

## C2. Group Messaging

| ID | Test | Method | Expected | Result |
|----|------|--------|----------|--------|
| C2-1 | @mention response | @mention bot in group; verify bot responds | Response references message content | |
| C2-2 | @mention parsing | @mention bot; verify sender name + platform ID extracted correctly in logs | Correct identity in C4 message | |
| C2-3 | Ignore without @mention (mention mode) | Send message in mention-mode group without @mention | No response, no error | |
| C2-4 | Smart mode response | Set group to smart mode; send without @mention | Bot receives and may respond | |
| C2-5 | Quoted reply detection | Reply to a previous message with @mention; verify bot extracts quoted content | Quoted content included in C4 message | |
| C2-6 | Message deduplication | Send message in group; verify via logs it reaches C4 exactly once | No duplicate processing | |
| C2-7 | System event filtering | Add/remove a member; verify system event silently ignored | No crash, no processing | |
| C2-8 | Context window | Send several messages, then ask bot to summarize; verify it references prior messages | Accurate context recall | |
| C2-9 | Cold restart context | `pm2 restart <service>`; send @mention asking about prior conversation | Bot replays persisted context | |
| C2-10 | Auto-add group (owner) | Owner adds bot to a new group; verify group auto-added to config | Group appears in config with mode: mention | |
| C2-11 | Auto-add group (non-owner) | Non-owner adds bot to a group; verify pending approval flow | Owner notified, group not auto-approved | |

## C3. DM Access Control

| ID | Test | Method | Expected | Result |
|----|------|--------|----------|--------|
| C3-1 | dmPolicy: owner | Set policy to owner; non-owner DMs → rejected; owner DMs → accepted | Correct access enforcement | |
| C3-2 | dmPolicy: allowlist | Set policy to allowlist; add non-owner → accepted; remove → rejected | Allowlist add/remove works | |
| C3-3 | dmPolicy: open | Set policy to open; any user can DM | No access restrictions | |
| C3-4 | Owner bypass | Owner always gets through regardless of dmPolicy setting | Owner never blocked | |

## C4. Group Access Control

| ID | Test | Method | Expected | Result |
|----|------|--------|----------|--------|
| C4-1 | groupPolicy: allowlist | Only groups in config are active; messages from unlisted groups ignored | Correct filtering | |
| C4-2 | groupPolicy: open | Any group the bot is in processes messages | No group restrictions | |
| C4-3 | groupPolicy: disabled | No group messages processed at all | All group messages dropped | |
| C4-4 | Per-group allowFrom | Set allowFrom on a group to owner only; non-owner @mentions → rejected; clear → accepted | Sender filtering works | |
| C4-5 | Owner bypass in groups | Owner messages always processed regardless of allowFrom or mode | Owner never blocked | |

## C5. Media & Attachments

| ID | Test | Method | Expected | Result |
|----|------|--------|----------|--------|
| C5-1 | Image in DM | Send image via DM; verify bot describes content | Image downloaded and processed | |
| C5-2 | File in DM | Send document (PDF, etc.) via DM; verify bot summarizes | File downloaded and processed | |
| C5-3 | Image in group (@mention) | Send image with @mention in group; verify downloaded and described | File saved, content accurate | |
| C5-4 | File in group (@mention) | Send document with @mention in group; verify downloaded and summarized | File saved, content accurate | |
| C5-5 | No download without @mention (mention mode) | Send image in mention-mode group without @mention; verify no download | No file in media directory | |
| C5-6 | Voice transcription | Send voice message; verify transcription via ASR | `[Voice] <transcript>` delivered to C4 | |
| C5-7 | Voice ASR unavailable | Stop/remove ASR; send voice message; verify graceful fallback | Error message to user, no crash | |

## C6. Admin CLI

| ID | Test | Method | Expected | Result |
|----|------|--------|----------|--------|
| C6-1 | show | `$ADM show` → full JSON config | All fields displayed | |
| C6-2 | show-owner | `$ADM show-owner` → owner name + ID | Correct identity | |
| C6-3 | set-dm-policy | Toggle owner → allowlist → open → owner | Each change persisted | |
| C6-4 | add/remove-dm-allow | Add user, verify in list; remove, verify gone | Allowlist updated | |
| C6-5 | list-dm-allow | Displays policy + allowlist entries | Correct output | |
| C6-6 | set-group-policy | Toggle allowlist ↔ open ↔ disabled | Each change persisted | |
| C6-7 | list-groups | Lists groups with name, mode, allowFrom | Correct metadata | |
| C6-8 | add-group / remove-group | Add group with name + mode; remove; verify | Config updated both ways | |
| C6-9 | set-group-mode | Switch mention ↔ smart; verify via list | Mode change persisted | |
| C6-10 | add/remove-group-allow | Add user to per-group allowFrom; remove; verify | Per-group allowlist updated | |
| C6-11 | list-group-allow | Show per-group allowFrom list | Correct output | |

## C7. Configuration & Metadata Consistency

| ID | Test | Method | Expected | Result |
|----|------|--------|----------|--------|
| C7-1 | Auto-added group has default mode | Owner adds bot to new group; check config.json | Group has `mode: "mention"` set | |
| C7-2 | Standardized group metadata | Inspect all groups in config; verify each has name, mode, allowFrom, added_at | Consistent schema across all groups | |
| C7-3 | Admin CLI add-group with mode | `$ADM add-group <id> <name> smart`; verify mode in config | Mode set on creation | |
| C7-4 | Admin CLI add-group default mode | `$ADM add-group <id> <name>` (no mode); verify defaults to mention | Default mode applied | |
| C7-5 | Endpoint path consistency | Verify webhook endpoint in platform config matches Caddy/proxy route | No path mismatch between proxy and docs | |

## C8. Service Lifecycle

| ID | Test | Method | Expected | Result |
|----|------|--------|----------|--------|
| C8-1 | Service start/stop | `pm2 start/stop <service>` | Clean start and stop | |
| C8-2 | Config hot-reload | Edit config.json while running; verify changes take effect | No restart needed | |
| C8-3 | Graceful error on missing credentials | Remove API credentials; restart; verify clear error message | No crash, helpful log | |

---

# Platform-Specific Tests

Run these only if the platform supports the capability.

## P1. Channels (Teams, Slack, Discord)

Platforms with a separate "channel" concept (team channels distinct from group chats).

| ID | Test | Method | Expected | Result |
|----|------|--------|----------|--------|
| P1-1 | Channel @mention response | @mention bot in channel; verify response | Bot responds in channel | |
| P1-2 | Channel smart mode (subscriptions) | Enable smart mode; verify platform subscription created and messages received without @mention | Subscription active, messages flow | |
| P1-3 | Channel mention mode | Set to mention; verify only @mentions processed | Non-mentions ignored | |
| P1-4 | Subscription cleanup on mode switch | Switch smart → mention; verify subscription deleted | No stale subscriptions | |
| P1-5 | Channel allowFrom | Set channel allowFrom to specific user; verify only that user processed | Sender filtering works | |
| P1-6 | Channel admin CLI | list-channels, add-channel, remove-channel, set-channel-mode, add/remove/list-channel-allow | All commands work | |
| P1-7 | Channel attachments (smart) | Send file in smart-mode channel; verify on-demand download | File fetched via platform API | |
| P1-8 | Channel attachments (mention) | @mention with file in mention-mode channel; verify eager download | File downloaded on receipt | |

## P2. Reactions / Processing Indicators (Teams, Lark, Slack)

Platforms where bots can set emoji reactions on messages.

| ID | Test | Method | Expected | Result |
|----|------|--------|----------|--------|
| P2-1 | Reaction on DM receive | Send DM; verify thinking reaction appears, removed after reply | Reaction lifecycle correct | |
| P2-2 | Reaction on group receive | Send group @mention; verify reaction set and removed | Reaction lifecycle correct | |
| P2-3 | Multiple pending reactions | Send two messages quickly; verify both reactions removed on reply | All pending reactions cleared | |

## P3. Typing Indicator (Telegram, some platforms)

Platforms that support a "typing..." status.

| ID | Test | Method | Expected | Result |
|----|------|--------|----------|--------|
| P3-1 | Typing on DM | Send DM; verify typing indicator while processing | Indicator shown, stops after reply | |

## P4. Delegated Auth (Teams, platforms requiring user-level tokens)

| ID | Test | Method | Expected | Result |
|----|------|--------|----------|--------|
| P4-1 | Auth sign-in flow | Generate auth URL; complete sign-in; verify token stored | auth-status shows active user | |
| P4-2 | Auth revoke | Revoke user auth; verify removed | auth-status no longer lists user | |

## P5. Smart Mode On-Demand Download (Teams, platforms without full webhook payloads)

Platforms where smart-mode webhooks don't include attachment payloads.

| ID | Test | Method | Expected | Result |
|----|------|--------|----------|--------|
| P5-1 | On-demand image download | Send image in smart group without @mention; run download script | Image fetched from API | |
| P5-2 | On-demand file download | Send file in smart group without @mention; run download script | File fetched from API | |
| P5-3 | Download command in C4 message | Verify download command always appended to smart-mode C4 messages | Command present regardless of webhook payload | |

---

# Not Typically Testable

| ID | Area | Reason |
|----|------|--------|
| NT-1 | Multi-tenant / cross-org | Requires separate identity provider tenant |
| NT-2 | Rate limit / throttle handling | Requires sustained high message volume |
| NT-3 | Webhook signature verification | Internal security; not user-facing |

---

## How to Use This Checklist

1. **New channel component**: Run all Core tests (C1–C8). Check which Platform-Specific sections apply and run those.
2. **Upgrade/regression**: Re-run Core tests + any Platform-Specific tests related to changed functionality.
3. **Recording results**: Fill in the Result column with PASS / FAIL / N/A and the date.

### Platform Capability Matrix

| Capability | Teams | Lark | Telegram | WeCom | Slack | Discord |
|-----------|-------|------|----------|-------|-------|---------|
| DM | Yes | Yes | Yes | Yes | Yes | Yes |
| Groups | Yes | Yes | Yes | Yes | Yes | Yes |
| Channels | Yes | No | No | No | Yes | Yes |
| Reactions | Yes | Yes | No | No | Yes | Yes |
| Typing indicator | No | No | Yes | No | Yes | No |
| Delegated auth | Yes | No | No | No | Yes | No |
| On-demand download | Yes | No | No | No | No | No |
