import { afterEach, describe, expect, it } from "vitest";
import { buildFeishuAgentBody, parseFeishuMessageEvent } from "./bot.js";
import { resolveCollaborationStateForMessage } from "./collaboration.js";
import {
  buildConfiguredBotAliasMap,
  classifyGroupCoAddressMode,
  extractMentionedBotAccountIds,
  resolveExplicitGroupCoAddressParticipants,
  resolveGroupIntentForEventWithActiveThread,
} from "./mention.js";
import { botNames } from "./monitor.state.js";
import {
  clearFeishuBotOpenIdsForTesting,
  setFeishuBotOpenIdForTesting,
  shouldSkipDispatchForMentionPolicy,
} from "./monitor.account.js";

function makeEvent(params: {
  chatType?: "group" | "p2p" | "private";
  text: string;
  mentions?: Array<{ openId?: string; name: string; key: string }>;
  rootId?: string;
  threadId?: string;
  messageId?: string;
}) {
  return {
    sender: {
      sender_id: {
        user_id: "u_sender",
        open_id: "ou_sender",
      },
    },
    message: {
      message_id: params.messageId ?? "msg_1",
      chat_id: "oc_group_1",
      chat_type: params.chatType ?? "group",
      root_id: params.rootId,
      thread_id: params.threadId,
      message_type: "text",
      content: JSON.stringify({ text: params.text }),
      mentions: (params.mentions ?? []).map((mention) => ({
        key: mention.key,
        name: mention.name,
        id: { open_id: mention.openId },
      })),
    },
  };
}

afterEach(() => {
  clearFeishuBotOpenIdsForTesting();
  botNames.clear();
});

describe("group collaboration matrix", () => {
  it("1. default group message stays with main when no bot is mentioned", () => {
    const event = makeEvent({ text: "大盘延迟了，谁帮我看下" });
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: event as any,
      }),
    ).toBe(false);
  });

  it("2. only specialist mentioned: main skips, specialist handles", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");
    const event = makeEvent({
      text: "@Flink-SRE 看下这个 lag",
      mentions: [{ openId: "ou_flink", name: "Flink-SRE", key: "@_user_1" }],
    });
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: event as any,
      }),
    ).toBe(true);
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: event as any,
      }),
    ).toBe(false);
  });

  it("3. plain-text specialist mention still skips main", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("starrocks-sre", "ou_sr");
    botNames.set("starrocks-sre", "Starrocks-SRE");
    const event = makeEvent({ text: "@Starrocks-SRE 看下慢查询" });
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: event as any,
      }),
    ).toBe(true);
  });

  it("4. main + specialist direct reply => main owns raw entry and fans out deterministically", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");
    const event = makeEvent({
      text: "@Flink-SRE @首席大管家 一个字描述下john",
      mentions: [
        { openId: "ou_flink", name: "Flink-SRE", key: "@_user_1" },
        { openId: "ou_main", name: "首席大管家", key: "@_user_2" },
      ],
    });
    expect(classifyGroupCoAddressMode({ event: event as any, mentionedBotCount: 2, mainMentioned: true })).toBe(
      "direct_reply",
    );
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: event as any,
      }),
    ).toBe(false);
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: event as any,
      }),
    ).toBe(true);
  });

  it("5. main + specialist coordination => only main handles raw message", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");
    const event = makeEvent({
      text: "@首席大管家 @Flink-SRE 帮我安排并汇总这次排查",
      mentions: [
        { openId: "ou_main", name: "首席大管家", key: "@_user_1" },
        { openId: "ou_flink", name: "Flink-SRE", key: "@_user_2" },
      ],
    });
    expect(classifyGroupCoAddressMode({ event: event as any, mentionedBotCount: 2, mainMentioned: true })).toBe(
      "coordinate",
    );
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: event as any,
      }),
    ).toBe(false);
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: event as any,
      }),
    ).toBe(true);
  });

  it("6. two specialists without main => main owns raw entry for deterministic direct reply fan-out", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");
    setFeishuBotOpenIdForTesting("starrocks-sre", "ou_sr");
    const event = makeEvent({
      text: "@Flink-SRE @Starrocks-SRE 你俩互相打个招呼",
      mentions: [
        { openId: "ou_flink", name: "Flink-SRE", key: "@_user_1" },
        { openId: "ou_sr", name: "Starrocks-SRE", key: "@_user_2" },
      ],
    });
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: event as any,
      }),
    ).toBe(false);
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: event as any,
      }),
    ).toBe(true);
    expect(classifyGroupCoAddressMode({ event: event as any, mentionedBotCount: 2, mainMentioned: false })).toBe(
      "direct_reply",
    );
  });

  it("7. generic multi-specialist asks default to peer_collab without explicit collaboration mode", () => {
    const event = makeEvent({
      text: "@Flink-SRE @Starrocks-SRE 你俩协作排查这个链路",
      mentions: [
        { openId: "ou_flink", name: "Flink-SRE", key: "@_user_1" },
        { openId: "ou_sr", name: "Starrocks-SRE", key: "@_user_2" },
      ],
    });
    expect(classifyGroupCoAddressMode({ event: event as any, mentionedBotCount: 2, mainMentioned: false })).toBe(
      "peer_collab",
    );
  });

  it("8. main plus specialists without explicit collaboration mode default to peer_collab under main-only raw entry", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");
    setFeishuBotOpenIdForTesting("starrocks-sre", "ou_sr");
    const event = makeEvent({
      text: "@首席大管家 @Flink-SRE @Starrocks-SRE 你们先各自看一下，再一起讨论判断",
      mentions: [
        { openId: "ou_main", name: "首席大管家", key: "@_user_1" },
        { openId: "ou_flink", name: "Flink-SRE", key: "@_user_2" },
        { openId: "ou_sr", name: "Starrocks-SRE", key: "@_user_3" },
      ],
    });
    expect(classifyGroupCoAddressMode({ event: event as any, mentionedBotCount: 3, mainMentioned: true })).toBe(
      "peer_collab",
    );
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: event as any,
      }),
    ).toBe(false);
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: event as any,
      }),
    ).toBe(true);
  });

  it("8b. main plus one specialist discussion stays in peer_collab and keeps main as a participant", () => {
    const event = makeEvent({
      text: "@首席大管家 @SoulCoder 你俩觉得明天会有太阳吗。为什么？可以互相讨论下",
      mentions: [
        { openId: "ou_main", name: "首席大管家", key: "@_user_1" },
        { openId: "ou_coder", name: "SoulCoder", key: "@_user_2" },
      ],
    });
    const intent = resolveGroupIntentForEventWithActiveThread({
      event: event as any,
      botOpenIdMap: new Map([
        ["main", "ou_main"],
        ["coder", "ou_coder"],
      ]),
      botNameMap: new Map([
        ["main", "首席大管家"],
        ["coder", "SoulCoder"],
      ]),
      mainAccountId: "main",
    });
    expect(intent).toEqual(
      expect.objectContaining({
        mode: "peer_collab",
        scope: "mentioned_only",
        mainMentioned: true,
        mainExplicitlyMentioned: true,
        participants: ["main", "coder"],
      }),
    );
  });

  it("8c. coordinator-only collective introduction expands to all internal participants as direct_reply", () => {
    const event = makeEvent({
      text: "@首席大管家 让大家互相介绍下",
      mentions: [{ openId: "ou_main", name: "首席大管家", key: "@_user_1" }],
    });
    const intent = resolveGroupIntentForEventWithActiveThread({
      event: event as any,
      botOpenIdMap: new Map([
        ["main", "ou_main"],
        ["coder", "ou_coder"],
        ["flink-sre", "ou_flink"],
      ]),
      botNameMap: new Map([
        ["main", "首席大管家"],
        ["coder", "SoulCoder"],
        ["flink-sre", "Flink-SRE"],
      ]),
      mainAccountId: "main",
    });
    expect(intent).toEqual(
      expect.objectContaining({
        mode: "direct_reply",
        scope: "all_internal",
        mainMentioned: true,
        mainExplicitlyMentioned: true,
        rawParticipants: ["main", "coder", "flink-sre"],
        participants: ["main", "coder", "flink-sre"],
      }),
    );
  });

  it("8d. coordinator-only collective discussion expands to all internal participants as peer_collab", () => {
    const event = makeEvent({
      text: "@首席大管家 让大家讨论下什么是灵魂",
      mentions: [{ openId: "ou_main", name: "首席大管家", key: "@_user_1" }],
    });
    const intent = resolveGroupIntentForEventWithActiveThread({
      event: event as any,
      botOpenIdMap: new Map([
        ["main", "ou_main"],
        ["coder", "ou_coder"],
        ["flink-sre", "ou_flink"],
      ]),
      botNameMap: new Map([
        ["main", "首席大管家"],
        ["coder", "SoulCoder"],
        ["flink-sre", "Flink-SRE"],
      ]),
      mainAccountId: "main",
    });
    expect(intent).toEqual(
      expect.objectContaining({
        mode: "peer_collab",
        scope: "all_internal",
        mainMentioned: true,
        mainExplicitlyMentioned: true,
        rawParticipants: ["main", "coder", "flink-sre"],
        participants: ["main", "coder", "flink-sre"],
      }),
    );
  });

  it("8e. coordinator-only collective summary expands to all internal participants as coordinate", () => {
    const event = makeEvent({
      text: "@首席大管家 让大家先看，最后给我一个结论",
      mentions: [{ openId: "ou_main", name: "首席大管家", key: "@_user_1" }],
    });
    const intent = resolveGroupIntentForEventWithActiveThread({
      event: event as any,
      botOpenIdMap: new Map([
        ["main", "ou_main"],
        ["coder", "ou_coder"],
        ["flink-sre", "ou_flink"],
      ]),
      botNameMap: new Map([
        ["main", "首席大管家"],
        ["coder", "SoulCoder"],
        ["flink-sre", "Flink-SRE"],
      ]),
      mainAccountId: "main",
    });
    expect(intent).toEqual(
      expect.objectContaining({
        mode: "coordinate",
        scope: "all_internal",
        mainMentioned: true,
        mainExplicitlyMentioned: true,
        rawParticipants: ["main", "coder", "flink-sre"],
        participants: ["main", "coder", "flink-sre"],
      }),
    );
  });

  it("8f. coordinator-only self request stays mentioned_only", () => {
    const event = makeEvent({
      text: "@首席大管家 你介绍下自己",
      mentions: [{ openId: "ou_main", name: "首席大管家", key: "@_user_1" }],
    });
    const intent = resolveGroupIntentForEventWithActiveThread({
      event: event as any,
      botOpenIdMap: new Map([
        ["main", "ou_main"],
        ["coder", "ou_coder"],
        ["flink-sre", "ou_flink"],
      ]),
      botNameMap: new Map([
        ["main", "首席大管家"],
        ["coder", "SoulCoder"],
        ["flink-sre", "Flink-SRE"],
      ]),
      mainAccountId: "main",
    });
    expect(intent).toEqual(
      expect.objectContaining({
        mode: "none",
        scope: "mentioned_only",
        mainMentioned: true,
        mainExplicitlyMentioned: true,
        rawParticipants: ["main"],
        participants: ["main"],
      }),
    );
  });

  it("8c. a non-main default account acts as the coordinator raw entry", () => {
    setFeishuBotOpenIdForTesting("dispatcher", "ou_dispatcher");
    setFeishuBotOpenIdForTesting("coder", "ou_coder");
    const event = makeEvent({
      text: "@调度员 @SoulCoder 你俩讨论下明天会更好吗",
      mentions: [
        { openId: "ou_dispatcher", name: "调度员", key: "@_user_1" },
        { openId: "ou_coder", name: "SoulCoder", key: "@_user_2" },
      ],
    });
    const intent = resolveGroupIntentForEventWithActiveThread({
      event: event as any,
      botOpenIdMap: new Map([
        ["dispatcher", "ou_dispatcher"],
        ["coder", "ou_coder"],
      ]),
      botNameMap: new Map([
        ["dispatcher", "调度员"],
        ["coder", "SoulCoder"],
      ]),
      mainAccountId: "dispatcher",
    });
    expect(intent).toEqual(
      expect.objectContaining({
        mode: "peer_collab",
        rawEntryAccountId: "dispatcher",
        participants: ["dispatcher", "coder"],
      }),
    );
  });

  it("8a. multi-bot requests that ask for a final answer route to coordinate even without @main", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");
    setFeishuBotOpenIdForTesting("starrocks-sre", "ou_sr");
    const event = makeEvent({
      text: "@Flink-SRE @Starrocks-SRE 你俩先看，最后给我一个结论",
      mentions: [
        { openId: "ou_flink", name: "Flink-SRE", key: "@_user_1" },
        { openId: "ou_sr", name: "Starrocks-SRE", key: "@_user_2" },
      ],
    });
    expect(classifyGroupCoAddressMode({ event: event as any, mentionedBotCount: 2, mainMentioned: false })).toBe(
      "coordinate",
    );
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: event as any,
      }),
    ).toBe(false);
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: event as any,
      }),
    ).toBe(true);
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "starrocks-sre",
        currentBotOpenId: "ou_sr",
        event: event as any,
      }),
    ).toBe(true);
  });

  it("8b. thread follow-up without re-mention resumes active peer collaboration via hidden main entry", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");
    setFeishuBotOpenIdForTesting("starrocks-sre", "ou_sr");
    resolveCollaborationStateForMessage({
      event: makeEvent({
        messageId: "msg_thread_start",
        rootId: "om_root_resume",
        threadId: "omt_resume",
        text: "@Flink-SRE @Starrocks-SRE 你俩讨论一下这条链路",
        mentions: [
          { openId: "ou_flink", name: "Flink-SRE", key: "@_user_1" },
          { openId: "ou_sr", name: "Starrocks-SRE", key: "@_user_2" },
        ],
      }) as any,
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre"],
      maxHops: 3,
    });
    const followUp = makeEvent({
      messageId: "msg_thread_followup",
      rootId: "om_root_resume",
      threadId: "omt_resume",
      text: "继续，补充一个事实",
    });
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: followUp as any,
      }),
    ).toBe(false);
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: followUp as any,
      }),
    ).toBe(true);
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "starrocks-sre",
        currentBotOpenId: "ou_sr",
        event: followUp as any,
      }),
    ).toBe(true);
  });

  it("8c. natural thread follow-up text also resumes the active collaboration without re-mention", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");
    setFeishuBotOpenIdForTesting("starrocks-sre", "ou_sr");
    resolveCollaborationStateForMessage({
      event: makeEvent({
        messageId: "msg_thread_start_natural",
        rootId: "om_root_resume_natural",
        threadId: "omt_resume_natural",
        text: "@Flink-SRE @Starrocks-SRE 你俩讨论一下这条链路",
        mentions: [
          { openId: "ou_flink", name: "Flink-SRE", key: "@_user_1" },
          { openId: "ou_sr", name: "Starrocks-SRE", key: "@_user_2" },
        ],
      }) as any,
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre"],
      maxHops: 3,
    });
    const followUp = makeEvent({
      messageId: "msg_thread_followup_natural",
      rootId: "om_root_resume_natural",
      threadId: "omt_resume_natural",
      text: "另外还有一个现象",
    });
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: followUp as any,
      }),
    ).toBe(false);
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: followUp as any,
      }),
    ).toBe(true);
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "starrocks-sre",
        currentBotOpenId: "ou_sr",
        event: followUp as any,
      }),
    ).toBe(true);
  });

  it("9. debate-style collaboration language without explicit mode defaults to peer_collab", () => {
    const event = makeEvent({
      text: "@SoulCoder @Starrocks-SRE 你俩辩论，怎么让自己拥有灵魂？允许多次发表意见，可以赞同或者反驳对方的观点",
      mentions: [
        { openId: "ou_coder", name: "SoulCoder", key: "@_user_1" },
        { openId: "ou_sr", name: "Starrocks-SRE", key: "@_user_2" },
      ],
    });
    expect(classifyGroupCoAddressMode({ event: event as any, mentionedBotCount: 2, mainMentioned: false })).toBe(
      "peer_collab",
    );
  });

  it("9a. configured account display names act as stable internal aliases", () => {
    const aliasMap = buildConfiguredBotAliasMap({
      channels: {
        feishu: {
          accounts: {
            coder: { name: "SoulCoder" },
          },
        },
      },
      agents: {
        list: [{ id: "coder", groupChat: { mentionPatterns: ["@coder"] } }],
      },
      bindings: [
        {
          agentId: "coder",
          match: {
            channel: "feishu",
            accountId: "coder",
          },
        },
      ],
    } as any);
    const event = makeEvent({
      text: "@SoulCoder 看下这个问题",
      mentions: [{ openId: "ou_unreliable_cross_app_id", name: "SoulCoder", key: "@_user_1" }],
    });
    expect(
      extractMentionedBotAccountIds({
        event: event as any,
        botOpenIdMap: new Map([["coder", "ou_self_coder"]]),
        accountAliasMap: aliasMap,
      }),
    ).toEqual(["coder"]);
  });

  it("9b. configured account display names let main skip when only that specialist is addressed", () => {
    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "main",
          accounts: {
            main: { name: "首席大管家" },
            coder: { name: "SoulCoder" },
          },
        },
      },
      agents: {
        list: [{ id: "main" }, { id: "coder", groupChat: { mentionPatterns: ["@coder"] } }],
      },
      bindings: [
        { agentId: "main", match: { channel: "feishu", accountId: "main" } },
        { agentId: "coder", match: { channel: "feishu", accountId: "coder" } },
      ],
    } as any;
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("coder", "ou_self_coder");
    const event = makeEvent({
      text: "@SoulCoder 看下这个问题",
      mentions: [{ openId: "ou_cross_app_view", name: "SoulCoder", key: "@_user_1" }],
    });
    expect(
      shouldSkipDispatchForMentionPolicy({
        cfg,
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: event as any,
      }),
    ).toBe(true);
  });

  it("8d. active thread follow-up can upgrade to coordinate without re-mentioning bots", () => {
    const event = makeEvent({
      text: "最后给我一个结论",
      rootId: "om_thread_upgrade_root",
      threadId: "om_thread_upgrade_root",
      messageId: "msg_thread_upgrade_followup",
    });
    const intent = resolveGroupIntentForEventWithActiveThread({
      event: event as any,
      botOpenIdMap: new Map([
        ["main", "ou_main"],
        ["flink-sre", "ou_flink"],
        ["starrocks-sre", "ou_sr"],
      ]),
      mainAccountId: "main",
      activeThreadState: {
        mode: "peer_collab",
        participants: ["flink-sre", "starrocks-sre"],
      },
    });
    expect(intent).toEqual(
      expect.objectContaining({
        mode: "coordinate",
        scope: "active_thread",
        participants: ["main", "flink-sre", "starrocks-sre"],
      }),
    );
  });

  it("8d-1. coordinator-only collective discussion in active thread stays scoped to active participants", () => {
    const event = makeEvent({
      text: "@首席大管家 让大家继续讨论下这个点",
      rootId: "om_thread_collective_root",
      threadId: "om_thread_collective_root",
      messageId: "msg_thread_collective_discussion",
      mentions: [{ openId: "ou_main", name: "首席大管家", key: "@_user_1" }],
    });
    const intent = resolveGroupIntentForEventWithActiveThread({
      event: event as any,
      botOpenIdMap: new Map([
        ["main", "ou_main"],
        ["coder", "ou_coder"],
        ["flink-sre", "ou_flink"],
        ["starrocks-sre", "ou_sr"],
      ]),
      botNameMap: new Map([
        ["main", "首席大管家"],
        ["coder", "SoulCoder"],
        ["flink-sre", "Flink-SRE"],
        ["starrocks-sre", "Starrocks-SRE"],
      ]),
      mainAccountId: "main",
      activeThreadState: {
        mode: "peer_collab",
        participants: ["coder", "flink-sre"],
      },
    });
    expect(intent).toEqual(
      expect.objectContaining({
        mode: "peer_collab",
        scope: "active_thread",
        rawParticipants: ["main", "coder", "flink-sre"],
        participants: ["main", "coder", "flink-sre"],
      }),
    );
  });

  it("8d-2. coordinator-only collective summary in active thread stays scoped to active participants", () => {
    const event = makeEvent({
      text: "@首席大管家 让大家先看，最后给我一个结论",
      rootId: "om_thread_collective_summary_root",
      threadId: "om_thread_collective_summary_root",
      messageId: "msg_thread_collective_summary",
      mentions: [{ openId: "ou_main", name: "首席大管家", key: "@_user_1" }],
    });
    const intent = resolveGroupIntentForEventWithActiveThread({
      event: event as any,
      botOpenIdMap: new Map([
        ["main", "ou_main"],
        ["coder", "ou_coder"],
        ["flink-sre", "ou_flink"],
        ["starrocks-sre", "ou_sr"],
      ]),
      botNameMap: new Map([
        ["main", "首席大管家"],
        ["coder", "SoulCoder"],
        ["flink-sre", "Flink-SRE"],
        ["starrocks-sre", "Starrocks-SRE"],
      ]),
      mainAccountId: "main",
      activeThreadState: {
        mode: "peer_collab",
        participants: ["coder", "flink-sre"],
      },
    });
    expect(intent).toEqual(
      expect.objectContaining({
        mode: "coordinate",
        scope: "active_thread",
        rawParticipants: ["main", "coder", "flink-sre"],
        participants: ["main", "coder", "flink-sre"],
      }),
    );
  });

  it("8e. plain non-follow-up text does not resume active thread collaboration", () => {
    const event = makeEvent({
      text: "收到",
      rootId: "om_thread_plain_root",
      threadId: "om_thread_plain_root",
      messageId: "msg_thread_plain_followup",
    });
    const intent = resolveGroupIntentForEventWithActiveThread({
      event: event as any,
      botOpenIdMap: new Map([
        ["main", "ou_main"],
        ["flink-sre", "ou_flink"],
        ["starrocks-sre", "ou_sr"],
      ]),
      mainAccountId: "main",
      activeThreadState: {
        mode: "peer_collab",
        participants: ["flink-sre", "starrocks-sre"],
      },
    });
    expect(intent).toEqual(
      expect.objectContaining({
        mode: "none",
        participants: [],
        rawParticipants: [],
      }),
    );
  });

  it("10. implicit discussion defaults to peer_collab without explicit collaboration mode", () => {
    const event = makeEvent({
      text: "@Flink-SRE @Starrocks-SRE 你俩先判断，再继续往下聊，最后形成一句话结论",
      mentions: [
        { openId: "ou_flink", name: "Flink-SRE", key: "@_user_1" },
        { openId: "ou_sr", name: "Starrocks-SRE", key: "@_user_2" },
      ],
    });
    expect(classifyGroupCoAddressMode({ event: event as any, mentionedBotCount: 2, mainMentioned: false })).toBe(
      "peer_collab",
    );
  });

  it("10a. mixed one-line phrasing plus continuation still stays in peer_collab", () => {
    const event = makeEvent({
      text: "@Flink-SRE @Starrocks-SRE 你俩先各说一句，再继续讨论，最后形成一句话结论",
      mentions: [
        { openId: "ou_flink", name: "Flink-SRE", key: "@_user_1" },
        { openId: "ou_sr", name: "Starrocks-SRE", key: "@_user_2" },
      ],
    });
    expect(classifyGroupCoAddressMode({ event: event as any, mentionedBotCount: 2, mainMentioned: false })).toBe(
      "peer_collab",
    );
  });

  it("10b. explicit #协作 overrides direct-reply phrasing", () => {
    const event = makeEvent({
      text: "@Flink-SRE @Starrocks-SRE #协作 你俩各说一句后继续往下讨论",
      mentions: [
        { openId: "ou_flink", name: "Flink-SRE", key: "@_user_1" },
        { openId: "ou_sr", name: "Starrocks-SRE", key: "@_user_2" },
      ],
    });
    expect(classifyGroupCoAddressMode({ event: event as any, mentionedBotCount: 2, mainMentioned: false })).toBe(
      "peer_collab",
    );
  });

  it("10f. explicit #协作 participant declaration keeps main as the raw entry even without @main", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");
    setFeishuBotOpenIdForTesting("starrocks-sre", "ou_sr");
    botNames.set("flink-sre", "Flink-SRE");
    botNames.set("starrocks-sre", "Starrocks-SRE");
    const event = makeEvent({
      text: "#协作(Flink-SRE,Starrocks-SRE) 你俩讨论什么是灵魂，先各自判断，再互相补充",
    });
    expect(classifyGroupCoAddressMode({ event: event as any, mentionedBotCount: 2, mainMentioned: false })).toBe(
      "peer_collab",
    );
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: event as any,
      }),
    ).toBe(false);
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: event as any,
      }),
    ).toBe(true);
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "starrocks-sre",
        currentBotOpenId: "ou_sr",
        event: event as any,
      }),
    ).toBe(true);
  });

  it("10b-1. explicit #协作 is claimed by main as the control entry", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");
    setFeishuBotOpenIdForTesting("starrocks-sre", "ou_starrocks");
    const event = makeEvent({
      text: "@Flink-SRE @Starrocks-SRE #协作 你俩各说一句后继续往下讨论",
      mentions: [
        { openId: "ou_flink", name: "Flink-SRE", key: "@_user_1" },
        { openId: "ou_starrocks", name: "Starrocks-SRE", key: "@_user_2" },
      ],
    });
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: event as any,
      }),
    ).toBe(false);
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: event as any,
      }),
    ).toBe(true);
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "starrocks-sre",
        currentBotOpenId: "ou_starrocks",
        event: event as any,
      }),
    ).toBe(true);
  });

  it("10c. explicit participant declaration resolves stable collaboration participants", () => {
    botNames.set("flink-sre", "Flink-SRE");
    botNames.set("starrocks-sre", "Starrocks-SRE");
    expect(
      resolveExplicitGroupCoAddressParticipants({
        text: "#协作(Flink-SRE,Starrocks-SRE) 你俩继续讨论",
        knownAccountIds: ["main", "flink-sre", "starrocks-sre"],
        botNameMap: botNames,
      }),
    ).toEqual(["flink-sre", "starrocks-sre"]);
  });

  it("10d. explicit #协作 participant declaration overrides sparse mention count", () => {
    const event = makeEvent({
      text: "#协作(Flink-SRE,Starrocks-SRE) 你俩继续讨论什么是灵魂",
      mentions: [{ openId: "ou_flink", name: "Flink-SRE", key: "@_user_1" }],
    });
    expect(classifyGroupCoAddressMode({ event: event as any, mentionedBotCount: 2, mainMentioned: false })).toBe(
      "peer_collab",
    );
  });

  it("10e. explicit #编排 works with declared specialists even when mentions are sparse", () => {
    const event = makeEvent({
      text: "#编排(Flink-SRE,Starrocks-SRE) 帮我安排并汇总这次排查",
      mentions: [{ openId: "ou_main", name: "首席大管家", key: "@_user_1" }],
    });
    expect(classifyGroupCoAddressMode({ event: event as any, mentionedBotCount: 2, mainMentioned: true })).toBe(
      "coordinate",
    );
  });

  it("10c. explicit #直答 forces direct_reply", () => {
    const event = makeEvent({
      text: "@Flink-SRE @Starrocks-SRE #直答 你俩继续讨论也没关系",
      mentions: [
        { openId: "ou_flink", name: "Flink-SRE", key: "@_user_1" },
        { openId: "ou_sr", name: "Starrocks-SRE", key: "@_user_2" },
      ],
    });
    expect(classifyGroupCoAddressMode({ event: event as any, mentionedBotCount: 2, mainMentioned: false })).toBe(
      "direct_reply",
    );
  });

  it("10c-1. explicit #直答 is also claimed by main for deterministic fan-out", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");
    setFeishuBotOpenIdForTesting("starrocks-sre", "ou_starrocks");
    const event = makeEvent({
      text: "@Flink-SRE @Starrocks-SRE #直答 你俩各说一句后继续往下讨论",
      mentions: [
        { openId: "ou_flink", name: "Flink-SRE", key: "@_user_1" },
        { openId: "ou_starrocks", name: "Starrocks-SRE", key: "@_user_2" },
      ],
    });
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: event as any,
      }),
    ).toBe(false);
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: event as any,
      }),
    ).toBe(true);
  });

  it("10d. explicit #编排 forces coordinate", () => {
    const event = makeEvent({
      text: "@首席大管家 @Flink-SRE @Starrocks-SRE #编排 你来统一安排",
      mentions: [
        { openId: "ou_main", name: "首席大管家", key: "@_user_1" },
        { openId: "ou_flink", name: "Flink-SRE", key: "@_user_2" },
        { openId: "ou_sr", name: "Starrocks-SRE", key: "@_user_3" },
      ],
    });
    expect(classifyGroupCoAddressMode({ event: event as any, mentionedBotCount: 3, mainMentioned: true })).toBe(
      "coordinate",
    );
  });

  it("10d-1. explicit #编排 is handled only by main", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");
    const event = makeEvent({
      text: "@首席大管家 @Flink-SRE #编排 你来统一安排",
      mentions: [
        { openId: "ou_main", name: "首席大管家", key: "@_user_1" },
        { openId: "ou_flink", name: "Flink-SRE", key: "@_user_2" },
      ],
    });
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: event as any,
      }),
    ).toBe(false);
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: event as any,
      }),
    ).toBe(true);
  });

  it("11. external bot + main direct reply does not trigger mention-forward", () => {
    const event = makeEvent({
      text: '<at user_id="ou_cloud">云上Bot</at> <at user_id="ou_main">首席大管家</at> 你俩用一句话赞美下我',
      mentions: [
        { openId: "ou_cloud", name: "云上Bot", key: "@_user_1" },
        { openId: "ou_main", name: "首席大管家", key: "@_user_2" },
      ],
    });
    const ctx = parseFeishuMessageEvent(event as any, "ou_main", "首席大管家");
    expect(ctx.mentionTargets).toBeUndefined();
  });

  it("11a. coordinator-only collective scope ignores external bot mentions and expands only internal participants", () => {
    const event = makeEvent({
      text: "@首席大管家 @云上Bot 让大家互相介绍下",
      mentions: [
        { openId: "ou_main", name: "首席大管家", key: "@_user_1" },
        { openId: "ou_external", name: "云上Bot", key: "@_user_2" },
      ],
    });
    const intent = resolveGroupIntentForEventWithActiveThread({
      event: event as any,
      botOpenIdMap: new Map([
        ["main", "ou_main"],
        ["coder", "ou_coder"],
        ["flink-sre", "ou_flink"],
      ]),
      botNameMap: new Map([
        ["main", "首席大管家"],
        ["coder", "SoulCoder"],
        ["flink-sre", "Flink-SRE"],
      ]),
      mainAccountId: "main",
    });
    expect(intent).toEqual(
      expect.objectContaining({
        mode: "direct_reply",
        scope: "all_internal",
        rawParticipants: ["main", "coder", "flink-sre"],
        participants: ["main", "coder", "flink-sre"],
      }),
    );
  });

  it("11b. parseFeishuMessageEvent strips explicit mode tags from content", () => {
    const event = makeEvent({
      text: "@Flink-SRE @Starrocks-SRE #协作 你俩讨论什么是灵魂",
      mentions: [
        { openId: "ou_flink", name: "Flink-SRE", key: "@_user_1" },
        { openId: "ou_sr", name: "Starrocks-SRE", key: "@_user_2" },
      ],
    });
    const ctx = parseFeishuMessageEvent(event as any, "ou_flink", "Flink-SRE");
    expect(ctx.explicitGroupCoAddressMode).toBe("peer_collab");
    expect(ctx.content).toContain("你俩讨论什么是灵魂");
    expect(ctx.content).not.toContain("#协作");
  });

  it("12. direct-reply body tells main to answer only for itself", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "user: @Flink-SRE @首席大管家 一个字描述下john",
        senderName: "user",
        senderOpenId: "ou_sender",
        messageId: "msg_1",
        hasAnyMention: true,
        groupCoAddressMode: "direct_reply",
      },
      botOpenId: "ou_main",
      autoMentionTargets: false,
    });
    expect(body).toContain("Reply only for yourself.");
    expect(body).toContain("Do not delegate, do not call sessions_send, sessions_spawn, subagents, or message");
  });

  it("13. peer-collab body tells agents to stay in-role and avoid visible routing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "user: @Flink-SRE @Starrocks-SRE 你俩协作排查这个链路",
        senderName: "user",
        senderOpenId: "ou_sender",
        messageId: "msg_1",
        hasAnyMention: true,
        groupCoAddressMode: "peer_collab",
        collaboration: {
          taskId: "task_x",
          mode: "peer_collab",
          protocol: "runtime",
          phase: "initial_assessment",
          participants: ["flink-sre", "starrocks-sre"],
          isCurrentOwner: false,
          allowedActions: [],
        },
      },
      botOpenId: "ou_flink",
      autoMentionTargets: false,
      agentId: "flink-sre",
    });
    expect(body).toContain("peer collaboration request");
    expect(body).toContain("Reply only from your own role");
    expect(body).toContain("do not expose tool calls or internal routing");
    expect(body).toContain("do not call sessions_send, sessions_spawn, subagents, or message");
    expect(body).toContain("Collaboration task task_x");
    expect(body).toContain("This is the initial assessment stage.");
    expect(body).toContain('"action":"collab_assess"');
  });

  it("14. awaiting-accept body tells target how to respond to handoff", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "user: @Flink-SRE @Starrocks-SRE 继续协作",
        senderName: "user",
        senderOpenId: "ou_sender",
        messageId: "msg_2",
        hasAnyMention: true,
        groupCoAddressMode: "peer_collab",
        collaboration: {
          taskId: "task_y",
          mode: "peer_collab",
          phase: "awaiting_accept",
          participants: ["flink-sre", "starrocks-sre"],
          currentOwner: "flink-sre",
          speakerToken: "starrocks-sre",
          isCurrentOwner: false,
          activeHandoff: {
            handoffId: "handoff_1",
            fromAgentId: "flink-sre",
            targetAgentId: "starrocks-sre",
            status: "awaiting_accept",
            timeWindow: "18:20-18:35",
            currentFinding: "sink 吞吐下降",
            unresolvedQuestion: "查询层是否是独立源头",
            evidencePaths: ["shared/tasks/task_y/evidence/02-compute.md"],
          },
          allowedActions: ["agent_handoff_accept", "agent_handoff_reject", "agent_handoff_need_info"],
        },
      },
      botOpenId: "ou_starrocks",
      autoMentionTargets: false,
      agentId: "starrocks-sre",
    });
    expect(body).toContain("AllowedActions=agent_handoff_accept,agent_handoff_reject,agent_handoff_need_info");
    expect(body).toContain("is handing this task to you");
    expect(body).toContain("handoffId handoff_1");
    expect(body).toContain("Do not call sessions_send, sessions_spawn, subagents, or message");
  });

  it("15. DM mention-forward still works", () => {
    const event = makeEvent({
      chatType: "p2p",
      text: '<at user_id="ou_flink">Flink-SRE</at> 帮我转达一句',
      mentions: [{ openId: "ou_flink", name: "Flink-SRE", key: "@_user_1" }],
    });
    const ctx = parseFeishuMessageEvent(event as any, "ou_main", "首席大管家");
    expect(ctx.mentionTargets).toEqual([
      { openId: "ou_flink", name: "Flink-SRE", key: "@content_1" },
    ]);
  });
});
