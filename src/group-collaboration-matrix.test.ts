import { afterEach, describe, expect, it } from "vitest";
import { buildFeishuAgentBody, parseFeishuMessageEvent } from "./bot.js";
import { classifyGroupCoAddressMode } from "./mention.js";
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
}) {
  return {
    sender: {
      sender_id: {
        user_id: "u_sender",
        open_id: "ou_sender",
      },
    },
    message: {
      message_id: "msg_1",
      chat_id: "oc_group_1",
      chat_type: params.chatType ?? "group",
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

  it("4. main + specialist direct reply => both handle raw message", () => {
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
    ).toBe(false);
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

  it("6. two specialists without main => main skips, specialists both handle", () => {
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
    ).toBe(true);
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: event as any,
      }),
    ).toBe(false);
  });

  it("7. two specialists with collaboration intent become peer_collab", () => {
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

  it("8. main plus specialists with collaboration intent also become peer_collab", () => {
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
    ).toBe(false);
  });

  it("9. external bot + main direct reply does not trigger mention-forward", () => {
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

  it("10. direct-reply body tells main to answer only for itself", () => {
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
    expect(body).toContain("do not call sessions_send or sessions_spawn");
  });

  it("11. peer-collab body tells agents to stay in-role and avoid visible routing", () => {
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
          phase: "initial_assessment",
          participants: ["flink-sre", "starrocks-sre"],
          isCurrentOwner: false,
          allowedActions: ["collab_assess"],
        },
      },
      botOpenId: "ou_flink",
      autoMentionTargets: false,
      agentId: "flink-sre",
    });
    expect(body).toContain("peer collaboration request");
    expect(body).toContain("Reply only from your own role");
    expect(body).toContain("do not expose tool calls or internal routing");
    expect(body).toContain("Do not call sessions_send, sessions_spawn, subagents, or message");
    expect(body).toContain("Collaboration task task_x");
    expect(body).toContain('"action":"collab_assess"');
  });

  it("12. awaiting-accept body tells target how to respond to handoff", () => {
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

  it("13. DM mention-forward still works", () => {
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
