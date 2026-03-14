# Main Router / Runtime Orchestrator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rework Feishu multi-bot group collaboration so `main` acts only as the hidden entry classifier/router while runtime owns collaboration orchestration and natural multi-bot group messages work without explicit mode tags.

**Architecture:** Keep a single raw entry for multi-internal-bot group messages by routing them through `main`, but move collaboration decisions and turn progression fully into the plugin runtime. Natural language becomes a small deterministic classifier: lightweight prompts map to `direct_reply`, explicit coordination maps to `coordinate`, and all other multi-bot messages default to `peer_collab`. Explicit `#直答/#协作/#编排` remain as overrides only. Use task-scoped sessions and runtime-maintained collaboration state as the only source of truth.

**Tech Stack:** TypeScript, Vitest, OpenClaw Feishu extension runtime, task-scoped session keys

---

### Task 1: Lock the desired routing behavior in tests

**Files:**
- Modify: `src/group-collaboration-matrix.test.ts`
- Modify: `src/monitor.main-sibling-mention.test.ts`
- Modify: `src/bot.test.ts`

**Steps:**
1. Add failing tests for natural multi-bot group messages without explicit tags:
   - lightweight prompt => `direct_reply`
   - coordination prompt => `coordinate`
   - all other multi-bot prompts => `peer_collab`
2. Add failing tests proving multi-bot group messages only dispatch raw entry to `main`.
3. Add failing tests proving `main` stays hidden for `direct_reply`/`peer_collab` unless explicit summary/coordination requires visible main output.
4. Run focused tests and verify RED.

### Task 2: Refactor mode classification to humane defaults

**Files:**
- Modify: `src/mention.ts`
- Modify: `src/monitor.account.ts`
- Modify: `src/types.ts`

**Steps:**
1. Keep explicit tags as override only.
2. Refactor classification so natural multi-bot group messages default to `peer_collab` unless they match a small direct-reply set or clear coordination set.
3. Ensure `main` raw-entry routing uses canonical participant detection and no longer depends on brittle natural-language escalation.
4. Run focused tests and verify GREEN.

### Task 3: Make `main` a hidden classifier/router, not a collaboration actor

**Files:**
- Modify: `src/bot.ts`
- Modify: `src/collaboration.ts`
- Modify: `src/reply-dispatcher.ts` if needed

**Steps:**
1. Refactor group multi-bot handling so `main` seeds collaboration state and dispatches participant turns, but does not become the long-lived owner unless the mode is `coordinate` and the summary stage requires it.
2. Remove remaining assumptions that specialists directly own raw-entry protocol decisions.
3. Ensure runtime, not model output, decides next speaker and stop conditions for scripted peer collaboration.
4. Run focused tests and verify GREEN.

### Task 4: Tighten visible-layer choreography

**Files:**
- Modify: `src/bot.ts`
- Modify: `src/reply-dispatcher.test.ts`
- Modify: `src/bot.test.ts`

**Steps:**
1. Ensure `direct_reply` is one round only and specialists do not cue each other.
2. Ensure `peer_collab` shows natural continuity and visible mentions without exposing protocol markers.
3. Ensure `coordinate` keeps `main` hidden during specialist discussion and only surfaces `main` when summary/coordination output is required.
4. Run focused tests and verify GREEN.

### Task 5: Update docs to reflect the new primary UX

**Files:**
- Modify: `README.md`
- Modify: `docs/01-能力与兼容性.md`
- Modify: `docs/02-群聊协作模式.md`
- Modify: `docs/04-可见层协作协议与验收.md`

**Steps:**
1. Demote explicit tags to override/debug mode.
2. Document the primary natural usage model and explain `main` as hidden entry classifier.
3. Clarify that runtime owns control plane while visible `@` remains presentation only.
4. Run full tests and confirm docs match behavior.
