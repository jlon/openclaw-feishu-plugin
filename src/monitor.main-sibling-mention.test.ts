import { afterEach, describe, expect, it } from "vitest";
import type { FeishuMessageEvent } from "./bot.js";
import { botNames } from "./monitor.state.js";
import {
  clearFeishuBotOpenIdsForTesting,
  setFeishuBotOpenIdForTesting,
  shouldSkipDispatchForMentionPolicy,
} from "./monitor.account.js";

function makeGroupEvent(params: {
  mentions?: Array<{ openId?: string; name: string; key: string }>;
  messageType?: "text" | "post";
  content?: string;
}): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        user_id: "u1",
        open_id: "ou_sender",
      },
    },
    message: {
      message_id: "msg_1",
      chat_id: "oc_group_1",
      chat_type: "group",
      message_type: params.messageType ?? "text",
      content:
        params.content ??
        JSON.stringify({
          text: "hello",
        }),
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

describe("shouldSkipDispatchForMentionPolicy", () => {
  it("skips main when only a sibling bot is mentioned in a group message", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: makeGroupEvent({
          mentions: [{ openId: "ou_flink", name: "flink-sre", key: "@_user_1" }],
        }),
      }),
    ).toBe(true);
  });

  it("does not skip main when main itself is mentioned", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: makeGroupEvent({
          mentions: [
            { openId: "ou_main", name: "main", key: "@_user_1" },
            { openId: "ou_flink", name: "flink-sre", key: "@_user_2" },
          ],
        }),
      }),
    ).toBe(false);
  });

  it("skips child raw dispatch when main and the child are co-mentioned for a direct reply", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: makeGroupEvent({
          mentions: [
            { openId: "ou_main", name: "首席大管家", key: "@_user_1" },
            { openId: "ou_flink", name: "Flink-SRE", key: "@_user_2" },
          ],
          content: JSON.stringify({
            text: "@Flink-SRE @首席大管家 一个字描述下john",
          }),
        }),
      }),
    ).toBe(true);
  });

  it("does not skip non-main accounts when only main is mentioned", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: makeGroupEvent({
          mentions: [{ openId: "ou_main", name: "main", key: "@_user_1" }],
        }),
      }),
    ).toBe(false);
  });

  it("detects sibling bot mentions in post messages", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("starrocks-sre", "ou_starrocks");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: makeGroupEvent({
          messageType: "post",
          content: JSON.stringify({
            content: [
              [{ tag: "at", user_id: "ou_starrocks", user_name: "starrocks-sre" }],
              [{ tag: "text", text: "排查一下" }],
            ],
          }),
        }),
      }),
    ).toBe(true);
  });

  it("skips child dispatch when both main and the child are mentioned in a coordination request", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: makeGroupEvent({
          mentions: [
            { openId: "ou_main", name: "首席大管家", key: "@_user_1" },
            { openId: "ou_flink", name: "Flink-SRE", key: "@_user_2" },
          ],
          content: JSON.stringify({
            text: "@首席大管家 @Flink-SRE 让你协调并汇总这次排查",
          }),
        }),
      }),
    ).toBe(true);
  });

  it("skips child raw dispatch when main and the child are mentioned in a peer collaboration request", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: makeGroupEvent({
          mentions: [
            { openId: "ou_main", name: "首席大管家", key: "@_user_1" },
            { openId: "ou_flink", name: "Flink-SRE", key: "@_user_2" },
          ],
          content: JSON.stringify({
            text: "@首席大管家 @Flink-SRE 你们先一起看下这条链路",
          }),
        }),
      }),
    ).toBe(true);
  });

  it("keeps main as the raw entry for explicit peer collaboration with declared specialists", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");
    setFeishuBotOpenIdForTesting("starrocks-sre", "ou_starrocks");
    botNames.set("flink-sre", "Flink-SRE");
    botNames.set("starrocks-sre", "Starrocks-SRE");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: makeGroupEvent({
          mentions: [{ openId: "ou_main", name: "首席大管家", key: "@_user_1" }],
          content: JSON.stringify({
            text: "#协作(Flink-SRE,Starrocks-SRE) 你俩继续讨论什么是灵魂",
          }),
        }),
      }),
    ).toBe(false);
    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: makeGroupEvent({
          mentions: [{ openId: "ou_main", name: "首席大管家", key: "@_user_1" }],
          content: JSON.stringify({
            text: "#协作(Flink-SRE,Starrocks-SRE) 你俩继续讨论什么是灵魂",
          }),
        }),
      }),
    ).toBe(true);
  });

  it("does not skip main when it is co-mentioned for a direct reply", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: makeGroupEvent({
          mentions: [
            { openId: "ou_main", name: "首席大管家", key: "@_user_1" },
            { openId: "ou_flink", name: "Flink-SRE", key: "@_user_2" },
          ],
          content: JSON.stringify({
            text: "@Flink-SRE @首席大管家 一个字描述下john",
          }),
        }),
      }),
    ).toBe(false);
  });

  it("does not skip main when it is co-mentioned for a coordination request", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: makeGroupEvent({
          mentions: [
            { openId: "ou_main", name: "首席大管家", key: "@_user_1" },
            { openId: "ou_flink", name: "Flink-SRE", key: "@_user_2" },
          ],
          content: JSON.stringify({
            text: "@首席大管家 @Flink-SRE 帮我安排并汇总这次排查",
          }),
        }),
      }),
    ).toBe(false);
  });

  it("does not skip main when it is co-mentioned for a peer collaboration request", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: makeGroupEvent({
          mentions: [
            { openId: "ou_main", name: "首席大管家", key: "@_user_1" },
            { openId: "ou_flink", name: "Flink-SRE", key: "@_user_2" },
          ],
          content: JSON.stringify({
            text: "@首席大管家 @Flink-SRE 你们先一起看下这条链路",
          }),
        }),
      }),
    ).toBe(false);
  });

  it("does not skip child dispatch when only the child is mentioned", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: makeGroupEvent({
          mentions: [{ openId: "ou_flink", name: "flink-sre", key: "@_user_1" }],
        }),
      }),
    ).toBe(false);
  });

  it("keeps main as the raw entry when multiple specialist bots are co-addressed", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");
    setFeishuBotOpenIdForTesting("starrocks-sre", "ou_starrocks");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: makeGroupEvent({
          mentions: [
            { openId: "ou_flink", name: "flink-sre", key: "@_user_1" },
            { openId: "ou_starrocks", name: "starrocks-sre", key: "@_user_2" },
          ],
        }),
      }),
    ).toBe(false);
  });

  it("skips specialist raw dispatch when multiple specialist bots are co-addressed", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");
    setFeishuBotOpenIdForTesting("starrocks-sre", "ou_starrocks");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: makeGroupEvent({
          mentions: [
            { openId: "ou_flink", name: "flink-sre", key: "@_user_1" },
            { openId: "ou_starrocks", name: "starrocks-sre", key: "@_user_2" },
          ],
        }),
      }),
    ).toBe(true);
  });

  it("skips main when only a sibling bot name is recognized but open_id mapping does not match", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("starrocks-sre", "ou_starrocks");
    botNames.set("main", "小飞龙");
    botNames.set("starrocks-sre", "Starrocks-SRE");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: makeGroupEvent({
          mentions: [{ openId: "ou_unexpected", name: "Starrocks-SRE", key: "@_user_1" }],
        }),
      }),
    ).toBe(true);
  });

  it("keeps main as the raw entry when sibling bot names are referenced only in plain text", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");
    setFeishuBotOpenIdForTesting("starrocks-sre", "ou_starrocks");
    botNames.set("flink-sre", "Flink-SRE");
    botNames.set("starrocks-sre", "Starrocks-SRE");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: makeGroupEvent({
          content: JSON.stringify({
            text: "@Flink-SRE @Starrocks-SRE 你俩互相打个招呼",
          }),
        }),
      }),
    ).toBe(false);
  });
});
