# Zylos Channel Component — Standardized Test Suite

> Canonical test suite for validating zylos channel components (Teams, Lark, WeCom, etc.).
> Tests are platform-agnostic where possible; platform-specific details noted inline.
>
> Source: [Lark Wiki](https://sigweb3labs.sg.larksuite.com/wiki/UphUwqJsxio9nkk1wgFl9l2NgSc)

## Prerequisites

- Two user accounts: **Owner** (admin, AAD/platform ID known) and **Non-Owner** (standard user)
- At least one group chat and one channel (if the platform supports channels)
- Admin CLI available: `ADM="node $HOME/zylos/.claude/skills/<component>/src/admin.js"`
- Component service running via PM2

---

## 1. Core Messaging

| ID | Test | Method | Expected |
|----|------|--------|----------|
| CM-1 | DM text send/receive | Send prompts via DM; verify bot recreates message content accurately | PASS — full text round-trip |
| CM-2 | @mention parsing | @mention bot in group chat; verify username + platform user ID correctly extracted from logs | PASS |
| CM-3 | Quoted reply detection | Reply to a previous message with @mention; verify bot extracts and references the quoted reply content | PASS |
| CM-4 | Message deduplication | Send a message in group chat; verify via PM2 logs it was delivered to C4 exactly once (no duplicate processing) | PASS |
| CM-5 | System event filtering | Add a member to group chat; verify system event (e.g. memberAdded) is silently ignored — no crash, no log entry in message processing | PASS |
| CM-6 | Cold restart context reload | Run `pm2 restart <service>`; send @mention asking "what are we talking about"; verify bot replays JSONL context and references prior conversation accurately | PASS |
| CM-7 | Typing indicator | Send DM message; verify "typing..." indicator appears while bot processes, stops after reply sent | PASS |
| CM-8 | Emoji reaction on receive (DM) | Send DM; verify reaction (e.g. 💬) appears on message immediately, removed after bot replies | PASS |
| CM-9 | Emoji reaction on receive (channel) | @mention in channel; verify reaction set via platform API, removed after reply | PASS |
| CM-10 | Emoji reaction on receive (group chat) | Send message in group chat; verify reaction set and removed after reply. Note: may require different API path than DM reactions | PASS |

## 2. Media & Attachments

| ID | Test | Method | Expected |
|----|------|--------|----------|
| MA-1 | Group chat image attachment (@mention) | Send image with @mention in group chat; verify bot describes image content accurately and file is downloaded to media directory | PASS |
| MA-2 | Group chat file attachment — PDF (@mention) | Send PDF with @mention in group chat; verify bot summarizes document content and file is saved with original filename | PASS |
| MA-3 | Group chat smart mode on-demand download (image) | Send image in smart-mode group chat without @mention; verify on-demand download script fetches it from platform API | PASS |
| MA-4 | Group chat smart mode on-demand download (PDF) | Send PDF in smart-mode group chat without @mention; verify on-demand script fetches from platform API and bot summarizes content | PASS |
| MA-5 | Group chat smart mode combined (image + PDF) | Send both image and PDF in single smart-mode group chat message; verify on-demand download fetches both and bot processes correctly | PASS |
| MA-6 | Channel smart mode on-demand download (image + PDF) | Send image + PDF in smart-mode channel; verify subscription notification triggers and on-demand script fetches both via platform API | PASS |
| MA-7 | Channel mention mode attachment (image + PDF) | @mention with image + PDF in mention-mode channel; verify attachments eagerly downloaded on receipt and bot processes both | PASS |
| MA-8 | Group chat mention mode attachment download | @mention with non-standard file (e.g. .tex) in mention-mode group chat; verify file eagerly downloaded and bot identifies content | PASS |
| MA-9 | Channel mention mode attachment (PDF only) | @mention with PDF in mention-mode channel; verify eagerly downloaded and bot provides detailed summary | PASS |
| MA-10 | Smart media — no download without @mention | Send image in mention-mode group chat without @mention; verify via `ls -lt` that no new file is downloaded. Re-send with @mention; verify file appears | PASS |
| MA-11 | Voice memo transcription | Send voice message in group chat; verify bot transcribes audio content and responds with transcript | PASS |

## 3. Smart Mode & Context

| ID | Test | Method | Expected |
|----|------|--------|----------|
| SC-1 | Group chat smart mode (respond without @mention) | Set group chat mode to smart; send message without @mention; verify bot responds to message content | PASS |
| SC-2 | Group chat mention-only mode (ignore non-@mention) | Set group chat mode to mention; send message without @mention — no response. Send with @mention — bot responds | PASS |
| SC-3 | Channel smart mode (subscriptions) | Enable smart mode for channel; verify platform API subscription created with webhook endpoint. Channel messages received without @mention via change notifications. Auto-renewal confirmed | PASS |
| SC-4 | Channel mention-only mode | Set channel to mention mode; send without @mention — no response. @mention — bot responds | PASS |
| SC-5 | Subscription cleanup on mode switch | Switch channel from smart to mention mode; verify platform API subscription is deleted (not left stale) | PASS |
| SC-6 | Group context window | Send multiple messages in group chat, then ask bot to summarize conversation; verify response includes accurate references to prior messages from context window | PASS |
| SC-7 | On-demand download command always included | In smart mode, verify download command is always appended to C4 message regardless of whether webhook detected attachments | PASS |

## 4. Access Control

| ID | Test | Method | Expected |
|----|------|--------|----------|
| AC-1 | DM policy: owner | Set dmPolicy=owner; non-owner sends DM — receives rejection message. Owner DM works | PASS |
| AC-2 | DM policy: allowlist | Set dmPolicy=allowlist; add non-owner via add-dm-allow — DM accepted. Remove via remove-dm-allow — DM rejected | PASS |
| AC-3 | DM policy: open | Set dmPolicy=open; non-owner (not in allowlist) sends DM — accepted and responded to | PASS |
| AC-4 | Group chat per-group allowFrom | Set allowFrom to owner-only on a group chat; non-owner @mentions — receives rejection. Clear allowFrom; non-owner @mention accepted | PASS |
| AC-5 | Group chat group policy: allowlist | Set groupPolicy=allowlist; only allowlisted group chats process messages. Non-allowlisted group chat messages ignored | PASS |
| AC-6 | Group chat group policy: open | Set groupPolicy=open; messages from any group chat processed regardless of allowlist | PASS |
| AC-7 | Channel allowFrom | Configure channel with allowFrom for specific user; verify only that user's @mentions are processed | PASS |

## 5. Admin CLI

| ID | Test | Method | Expected |
|----|------|--------|----------|
| CLI-1 | show-owner | `$ADM show-owner` → displays owner name + platform user ID | PASS |
| CLI-2 | show (full config) | `$ADM show` → displays complete JSON config with all fields (owner, policies, groups, channels) | PASS |
| CLI-3 | set-dm-policy | Toggle between owner → allowlist → open → owner; each change confirmed via list-dm-allow output | PASS |
| CLI-4 | add-dm-allow / remove-dm-allow | Add non-owner user ID, verify in list; remove, verify gone | PASS |
| CLI-5 | list-dm-allow | Displays current DM policy + allowlist entries (or "none") | PASS |
| CLI-6 | set-group-policy | Toggle allowlist ↔ open; verify via list-groups output | PASS |
| CLI-7 | list-groups | Lists all group chats with name, mode (smart/mention), and allowFrom | PASS |
| CLI-8 | add-group / remove-group | Remove group chat, verify gone in list; re-add, verify present | PASS |
| CLI-9 | set-group-mode | Set group chat mode to mention, verify via list-groups. Set back to smart, verify | PASS |
| CLI-10 | list-channels | Lists channels with name, team ID, mode, and allowFrom | PASS |
| CLI-11 | set-channel-mode | Set channel to mention mode, verify subscription cleaned up. Set to smart, verify subscription created | PASS |
| CLI-12 | add-channel / remove-channel | Add channel with team ID, verify in list; remove, verify gone | PASS |

## 6. Not Tested

| ID | Test | Reason |
|----|------|--------|
| NT-1 | Multi-tenant (cross-organization) | Single-tenant test environment; multi-tenant requires separate identity provider tenant |
| NT-2 | Rate limit / throttle handling | Would require sustained high message volume; not practical in manual testing |

---

## Summary

- **Total: 47 tests** — 45 PASS, 2 N/A
- Tests conducted: 2026-05-17 and 2026-05-18
- Platform: Microsoft Teams
- Accounts: Felix Lin (owner), Felix Lin 2 (non-owner)
- Groups: "Zylos Test GC" (smart), "group" (mention)
- Channels: "General" (mention)

### Final Config State (post-testing)

- DM policy: owner (reverted)
- Group policy: allowlist
- Groups: "Zylos Test GC" (smart), "group" (mention)
- Channels: "General" (mention)
- Owner: Felix Lin (6a23b843)
