<p align="center">
  <img src="./assets/logo.png" alt="Zylos" height="120">
</p>

<h1 align="center">zylos-ms-teams</h1>

<p align="center">
  <a href="https://github.com/zylos-ai/zylos-core">Zylos</a> 智能体的 Microsoft Teams 通讯组件。
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="Node.js"></a>
  <a href="https://discord.gg/GS2J39EGff"><img src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://x.com/ZylosAI"><img src="https://img.shields.io/badge/X-follow-000000?logo=x&logoColor=white" alt="X"></a>
  <a href="https://zylos.ai"><img src="https://img.shields.io/badge/website-zylos.ai-blue" alt="Website"></a>
  <a href="https://coco.xyz"><img src="https://img.shields.io/badge/Built%20by-Coco-orange" alt="Built by Coco"></a>
</p>

<p align="center">
  <a href="./README.md">English</a>
</p>

---

- **Teams 对话** — 你的 AI 智能体接入 Microsoft Teams，支持私聊和群聊
- **智能群组监控** — 自动关注指定群组的所有讨论，无需 @
- **语音消息** — 音频消息通过 ASR 转录并以文字形式转发
- **零配置启动** — 第一条私聊自动绑定为管理员，无需繁琐设置

## 快速开始

告诉你的 Zylos 智能体：

> "安装 ms-teams 组件"

或使用 CLI：

```bash
zylos add ms-teams
```

Zylos 会引导你完成设置，包括获取 Azure Bot Registration 凭证。安装完成后，在 Teams 上给机器人发消息 — 第一个交互的用户自动成为管理员。

## 管理机器人

直接告诉你的 Zylos 智能体：

| 操作 | 示例 |
|------|------|
| 添加用户到 DM 白名单 | "把用户 X 加入 Teams DM 白名单" |
| 启用智能群组 | "把这个 Teams 群设为 smart 模式" |
| 添加频道 | "把 General 频道加入 Teams" |
| 查看状态 | "看下 Teams 机器人状态" |
| 重启机器人 | "重启 Teams 机器人" |
| 升级组件 | "升级 Teams 组件" |

或通过 CLI 管理：

```bash
zylos upgrade ms-teams
zylos uninstall ms-teams
```

## 消息路由

| 场景 | 机器人响应 |
|------|-----------|
| 私聊（管理员/白名单） | 通过 Claude 回复 |
| 智能群组/频道消息 | 接收所有消息，智能体决定 |
| 在允许的群组/频道 @机器人 | 带上下文回复 |
| 管理员在任意群 @机器人 | 始终回复 |
| 未知用户私聊 | 拒绝并通知 |

## 文档

- [SKILL.md](./SKILL.md) — 组件规格说明
- [DESIGN.md](./DESIGN.md) — 架构与设计
- [CHANGELOG.md](./CHANGELOG.md) — 版本历史

## 参与贡献

请查看[贡献指南](https://github.com/zylos-ai/.github/blob/main/CONTRIBUTING.md)。

## 由 Coco 构建

Zylos 是 [Coco](https://coco.xyz/)（AI 员工平台）的开源核心基础设施。

我们构建 Zylos 是因为我们自己需要它：可靠的基础设施，让 AI 智能体 24/7 稳定运行。每个组件都在 Coco 生产环境中经过实战检验，服务于每天依赖 AI 员工的团队。

想要开箱即用？[Coco](https://coco.xyz/) 提供即开即用的 AI 员工——持久记忆、多渠道沟通、技能包——5 分钟完成部署。

## 许可证

[MIT](./LICENSE)
