# Discord Hook Points — Migration Mapping

This document identifies every point where Discord is currently wired into the daemon (`daemon/src/index.ts`) and maps each to the hook it will move into. This serves as the implementation checklist for Phase 4.

---

## Current Glue in `daemon/src/index.ts`

### 1. Platform URN Registration

**Current code:**
```ts
import { discordPlatformRegistration } from "@shoggoth/platform-discord";
import { registerPlatform as registerMessagingPlatform } from "@shoggoth/messaging";
registerMessagingPlatform(discordPlatformRegistration);
```

**Target hook:** `platform.register`

**Plugin implementation:**
```ts
"platform.register"(ctx) {
  ctx.registerPlatform(discordPlatformRegistration);
}
```

---

### 2. Health Probe Registration

**Current code:**
```ts
import { createDiscordProbe } from "@shoggoth/platform-discord";
rt.health.register(createDiscordProbe({ getToken: resolvedDiscordBotToken }));
```

**Target hook:** `health.register`

**Plugin implementation:**
```ts
"health.register"(ctx) {
  ctx.registerProbe(createDiscordProbe({ getToken: () => resolvedDiscordBotToken() }));
}
```

---

### 3. Gateway + Messaging Runtime Startup

**Current code:**
```ts
discordMessaging = await startDaemonDiscordMessaging({
  logger, config, botToken, noticeResolver,
  onInteractionCreate: createDiscordInteractionHandler({...}),
  onMessageReactionAdd: (ev) => { ... },
  reactionBotUserIdRef,
});
if (discordMessaging) {
  interactionTransportRef.current = discordMessaging.discordRestTransport;
  rt.shutdown.registerDrain("discord-messaging", () => discordMessaging!.stop());
}
```

**Target hook:** `platform.start`

---

### 4. Interaction Handler (Slash Commands)

**Current code:**
```ts
onInteractionCreate: createDiscordInteractionHandler({
  transport: ...,
  applicationId: ...,
  logger,
  abortSession: ...,
  invokeControlOp: ...,
  resolveSessionForChannel: ...,
})
```

**Target hook:** `platform.start` (internal wiring within the Discord plugin)

---

### 5. HITL Reaction Handler

**Current code:**
```ts
onMessageReactionAdd: (ev) => {
  const consumed = handleDiscordHitlReactionAdd({
    ev, pending, registry, autoApprove, ownerUserId, botUserIdRef, logger,
  });
  if (!consumed) reactionPassthroughRef.current?.(ev);
}
```

**Target hook:** `message.reaction` — HITL reaction-based approval is a presentation-layer concern, not Discord-specific. Any platform declaring `reactions` capability can provide HITL approval. The presentation layer listens on `message.reaction`, checks the notice registry, and resolves pending actions. The Discord plugin simply fires `message.reaction` when it receives a `MESSAGE_REACTION_ADD` gateway event.

---

### 6. Discord Platform Startup (sessions, HITL, MCP, orchestrator)

**Current code:**
```ts
const discordPlatform = await startDiscordPlatform({
  db, config, configRef, policyEngine,
  hitlConfigRef, hitlPending, hitlDiscordNoticeRegistry,
  hitlAutoApproveGate, logger, discord: dm, deps,
});
registerPlatform("discord", discordPlatform);
```

**Target hook:** `platform.start`

---

### 7. Platform Adapter Ref

**Current code:**
```ts
platformAdapterRef.current = discordPlatform.adapter;
```

**Target hook:** `platform.start` → `ctx.setPlatformAdapter(discordPlatform.adapter)`

---

### 8. Reaction Passthrough Wiring

**Current code:**
```ts
reactionPassthroughRef.current = (ev) => {
  // ~30 lines: resolve session, fetch message, call handleReactionPassthrough
};
```

**Target hook:** `platform.start` (internal wiring within the Discord plugin)

---

### 9. Subagent Runtime Extension

**Current code:**
```ts
const subagentExt = {
  runSessionModelTurn: discordPlatform.runSessionModelTurn,
  subscribeSubagentSession: discordPlatform.subscribeSubagentSession,
  registerPlatformThreadBinding: dm.registerPlatformThreadBinding,
  announcePersistentSubagentSessionEnded: discordPlatform.announcePersistentSubagentSessionEnded,
};
setSubagentRuntimeExtension(subagentExt);
```

**Target hook:** `platform.start` → `ctx.setSubagentRuntimeExtension(subagentExt)`

---

### 10. Message Tool Context

**Current code:**
```ts
messageToolContextRef.current = {
  slice: messageToolSliceFromCapabilities(dm.capabilities),
  execute: (sessionId, args) => executeMessageToolAction({
    capabilities: dm.capabilities,
    transport: dm.discordRestTransport,
    sessionToChannel: ...,
    sessionToGuild: ...,
    getSessionWorkspace: ...,
    downloadFile: ...,
  }, sessionId, args),
};
```

**Target hook:** `platform.start` → `ctx.setMessageToolContext({...})`

---

### 11. Persistent Subagent Reconciliation

**Current code:**
```ts
const subRecon = reconcilePersistentSubagents({ db, config, ext: subagentExt });
```

**Target hook:** `platform.start` (runs after subagent extension is set)

---

### 12. Platform Shutdown Drain

**Current code:**
```ts
rt.shutdown.registerDrain("platforms", async () => {
  await stopAllPlatforms();
  setSubagentRuntimeExtension(undefined);
  messageToolContextRef.current = undefined;
});
```

**Target hook:** `platform.stop`

**Plugin implementation:**
```ts
async "platform.stop"(ctx) {
  await state.platform?.stop();
  await state.messaging?.stop();
  // Clear refs via ctx helpers
}
```

---

### 13. HITL Notice Registry + Auto-Approve Gate Creation

**Current code:**
```ts
hitlDiscordNoticeRegistry = createHitlDiscordNoticeRegistry();
hitlAutoApproveGate = createPersistingHitlAutoApproveGate({...});
```

**Target hook:** `platform.start` for the notice registry (platform-specific message→pending mapping), but the reaction-based approval logic itself belongs in the presentation layer. Any platform with `reactions` capability can provide HITL approval — the presentation layer owns the notice→pending resolution flow, and platforms just fire `message.reaction` events.

---

## Summary Table

| # | Integration Point | Current Location | Target Hook | Lines Moved |
|---|---|---|---|---|
| 1 | URN policy registration | `index.ts:L~60` | `platform.register` | 2 |
| 2 | Health probe | `index.ts:L~380` | `health.register` | 1 |
| 3 | Gateway startup | `index.ts:L~150-200` | `platform.start` | ~50 |
| 4 | Interaction handler | `index.ts:L~160-220` | `platform.start` | ~60 |
| 5 | HITL reaction handler | `index.ts:L~130-145` | `message.reaction` (presentation) | ~15 |
| 6 | Platform startup | `index.ts:L~290-300` | `platform.start` | ~10 |
| 7 | Platform adapter ref | `index.ts:L~301` | `platform.start` | 1 |
| 8 | Reaction passthrough | `index.ts:L~305-340` | `platform.start` | ~35 |
| 9 | Subagent extension | `index.ts:L~342-350` | `platform.start` | ~8 |
| 10 | Message tool context | `index.ts:L~351-380` | `platform.start` | ~30 |
| 11 | Subagent reconciliation | `index.ts:L~381-390` | `platform.start` | ~10 |
| 12 | Shutdown drain | `index.ts:L~391-396` | `platform.stop` | ~5 |
| 13 | HITL notice registry | `index.ts:L~120-128` | `platform.start` | ~8 |

**Total:** ~235 lines of Discord-specific glue removed from `daemon/src/index.ts`.

---

## Discord-Specific Hook Points for Future Platforms

These are the capabilities/behaviors that a Telegram (or other) platform plugin would need to implement equivalently:

| Capability | Discord Implementation | Platform-Agnostic Abstraction |
|---|---|---|
| Inbound message routing | Gateway `MESSAGE_CREATE` → adapter → bus | `PlatformRuntime.bus` subscription |
| Outbound message delivery | REST `POST /channels/{id}/messages` | `PlatformOutbound.send()` |
| Message splitting | 2000-char limit, code block aware | `PlatformAdapter.sendBody()` (platform decides limit) |
| Streaming responses | Edit-in-place via REST PATCH | `PlatformStreamingOutbound.start()` |
| Typing indicator | REST `POST /channels/{id}/typing` | `PlatformRuntime.notifyAgentTypingForSession()` |
| Reactions (HITL) | REST PUT/DELETE reactions | Presentation layer via `message.reaction` hook; platform provides reaction transport |
| Threads | REST thread creation/deletion | `PlatformRuntime.registerPlatformThreadBinding()` |
| Slash commands | REST bulk command registration + interaction handler | Platform-specific command surface |
| Health probe | REST `GET /users/@me` | `HealthProbe.check()` |
| Owner gate | `ownerUserId` config + message metadata | Platform-specific auth/identity |
| Attachments | Multipart form-data upload | `PlatformOutbound` with attachments |
| Message search | REST guild message search | `builtin-message` search action |

---

## `MessagingPlatformPlugin` Required vs Optional Hooks

| Hook | Required | Rationale |
|---|---|---|
| `platform.register` | Yes | Every platform must register its URN policy |
| `platform.start` | Yes | Every platform must connect to its service |
| `platform.stop` | Yes | Every platform must disconnect gracefully |
| `health.register` | Yes | Every platform should expose health status |
| `message.inbound` | No | Platforms fire this; they don't consume it |
| `message.outbound` | No | Only if the platform wants to transform outbound messages |
| `message.reaction` | No | Only if the platform supports reactions |
| `daemon.startup` | No | General setup not tied to platform lifecycle |
| `daemon.shutdown` | No | Covered by `platform.stop` for most cases |
| `session.turn.before` | No | Observability concern, not platform concern |
| `session.turn.after` | No | Same |
