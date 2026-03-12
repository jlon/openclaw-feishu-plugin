import { describe, it, expect } from "vitest";
import {
  buildFeishuAgentBody,
  extractMentionedBotTokensFromText,
  extractMentionedOpenIds,
  parseFeishuMessageEvent,
} from "./bot.js";

// Helper to build a minimal FeishuMessageEvent for testing
function makeEvent(
  chatType: "p2p" | "group" | "private",
  mentions?: Array<{ key: string; name: string; id: { open_id?: string } }>,
  text = "hello",
) {
  return {
    sender: {
      sender_id: { user_id: "u1", open_id: "ou_sender" },
    },
    message: {
      message_id: "msg_1",
      chat_id: "oc_chat1",
      chat_type: chatType,
      message_type: "text",
      content: JSON.stringify({ text }),
      mentions,
    },
  };
}

function makePostEvent(content: unknown) {
  return {
    sender: { sender_id: { user_id: "u1", open_id: "ou_sender" } },
    message: {
      message_id: "msg_1",
      chat_id: "oc_chat1",
      chat_type: "group",
      message_type: "post",
      content: JSON.stringify(content),
      mentions: [],
    },
  };
}

function makeShareChatEvent(content: unknown) {
  return {
    sender: { sender_id: { user_id: "u1", open_id: "ou_sender" } },
    message: {
      message_id: "msg_1",
      chat_id: "oc_chat1",
      chat_type: "group",
      message_type: "share_chat",
      content: JSON.stringify(content),
      mentions: [],
    },
  };
}

describe("parseFeishuMessageEvent – mentionedBot", () => {
  const BOT_OPEN_ID = "ou_bot_123";

  it("returns mentionedBot=false when there are no mentions", () => {
    const event = makeEvent("group", []);
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID);
    expect(ctx.mentionedBot).toBe(false);
  });

  it("falls back to sender user_id when open_id is missing", () => {
    const event = makeEvent("p2p", []);
    (event as any).sender.sender_id = { user_id: "u_mobile_only" };

    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID);
    expect(ctx.senderOpenId).toBe("u_mobile_only");
    expect(ctx.senderId).toBe("u_mobile_only");
  });

  it("returns mentionedBot=true when bot is mentioned", () => {
    const event = makeEvent("group", [
      { key: "@_user_1", name: "Bot", id: { open_id: BOT_OPEN_ID } },
    ]);
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID);
    expect(ctx.mentionedBot).toBe(true);
  });

  it("returns mentionedBot=true when bot mention name differs from configured botName", () => {
    const event = makeEvent("group", [
      { key: "@_user_1", name: "OpenClaw Bot (Alias)", id: { open_id: BOT_OPEN_ID } },
    ]);
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID, "OpenClaw Bot");
    expect(ctx.mentionedBot).toBe(true);
  });

  it("returns mentionedBot=true when bot is referenced by plain-text @name", () => {
    const event = makeEvent("group", [], "@Flink-SRE 你在吗");
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID, "Flink-SRE");
    expect(ctx.mentionedBot).toBe(true);
  });

  it("returns mentionedBot=false when only other users are mentioned", () => {
    const event = makeEvent("group", [
      { key: "@_user_1", name: "Alice", id: { open_id: "ou_alice" } },
    ]);
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID);
    expect(ctx.mentionedBot).toBe(false);
  });

  it("returns mentionedBot=false when botOpenId is undefined (unknown bot)", () => {
    const event = makeEvent("group", [
      { key: "@_user_1", name: "Alice", id: { open_id: "ou_alice" } },
    ]);
    const ctx = parseFeishuMessageEvent(event as any, undefined);
    expect(ctx.mentionedBot).toBe(false);
  });

  it("returns mentionedBot=false when botOpenId is empty string (probe failed)", () => {
    const event = makeEvent("group", [
      { key: "@_user_1", name: "Alice", id: { open_id: "ou_alice" } },
    ]);
    const ctx = parseFeishuMessageEvent(event as any, "");
    expect(ctx.mentionedBot).toBe(false);
  });

  it("treats mention.name regex metacharacters as literals when stripping", () => {
    const event = makeEvent(
      "group",
      [{ key: "@_bot_1", name: ".*", id: { open_id: BOT_OPEN_ID } }],
      "@NotBot hello",
    );
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID);
    expect(ctx.content).toBe("@NotBot hello");
  });

  it("treats mention.key regex metacharacters as literals when stripping", () => {
    const event = makeEvent(
      "group",
      [{ key: ".*", name: "Bot", id: { open_id: BOT_OPEN_ID } }],
      "hello world",
    );
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID);
    expect(ctx.content).toBe("hello world");
  });

  it("returns mentionedBot=true for post message with at (no top-level mentions)", () => {
    const BOT_OPEN_ID = "ou_bot_123";
    const event = makePostEvent({
      content: [
        [{ tag: "at", user_id: BOT_OPEN_ID, user_name: "claw" }],
        [{ tag: "text", text: "What does this document say" }],
      ],
    });
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID);
    expect(ctx.mentionedBot).toBe(true);
  });

  it("returns mentionedBot=false for post message with no at", () => {
    const event = makePostEvent({
      content: [[{ tag: "text", text: "hello" }]],
    });
    const ctx = parseFeishuMessageEvent(event as any, "ou_bot_123");
    expect(ctx.mentionedBot).toBe(false);
  });

  it("returns mentionedBot=false for post message with at for another user", () => {
    const event = makePostEvent({
      content: [
        [{ tag: "at", user_id: "ou_other", user_name: "other" }],
        [{ tag: "text", text: "hello" }],
      ],
    });
    const ctx = parseFeishuMessageEvent(event as any, "ou_bot_123");
    expect(ctx.mentionedBot).toBe(false);
  });

  it("preserves post code and code_block content", () => {
    const event = makePostEvent({
      content: [
        [
          { tag: "text", text: "before " },
          { tag: "code", text: "inline()" },
        ],
        [{ tag: "code_block", language: "ts", text: "const x = 1;" }],
      ],
    });
    const ctx = parseFeishuMessageEvent(event as any, "ou_bot_123");
    expect(ctx.content).toContain("before `inline()`");
    expect(ctx.content).toContain("```ts\nconst x = 1;\n```");
  });

  it("uses share_chat body when available", () => {
    const event = makeShareChatEvent({
      body: "Merged and Forwarded Message",
      share_chat_id: "sc_abc123",
    });
    const ctx = parseFeishuMessageEvent(event as any, "ou_bot_123");
    expect(ctx.content).toBe("Merged and Forwarded Message");
  });

  it("falls back to share_chat identifier when body is unavailable", () => {
    const event = makeShareChatEvent({
      share_chat_id: "sc_abc123",
    });
    const ctx = parseFeishuMessageEvent(event as any, "ou_bot_123");
    expect(ctx.content).toBe("[Forwarded message: sc_abc123]");
  });

  it("extracts mentioned open ids from top-level mentions and post content without duplicates", () => {
    const event = {
      sender: { sender_id: { user_id: "u1", open_id: "ou_sender" } },
      message: {
        message_id: "msg_1",
        chat_id: "oc_chat1",
        chat_type: "group",
        message_type: "post",
        content: JSON.stringify({
          content: [
            [{ tag: "at", user_id: "ou_other", user_name: "other" }],
            [{ tag: "text", text: "hello" }],
          ],
        }),
        mentions: [{ key: "@_user_1", name: "Other", id: { open_id: "ou_other" } }],
      },
    };

    expect(extractMentionedOpenIds(event as any)).toEqual(["ou_other"]);
  });

  it("extracts plain-text bot tokens from text content", () => {
    const event = makeEvent("group", [], "@Flink-SRE @Starrocks-SRE 你俩互相打个招呼");
    expect(extractMentionedBotTokensFromText(event as any)).toEqual([
      "flinksre",
      "starrockssre",
    ]);
  });

  it("marks current mention targets as authoritative in the injected agent body", () => {
    const event = makeEvent(
      "p2p",
      [
        { key: "@_user_1", name: "SoulCoder", id: { open_id: "ou_target" } },
      ],
      "打个招呼",
    );
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID, "Bot");
    const body = buildFeishuAgentBody({
      ctx: {
        content: ctx.content,
        senderName: "user",
        senderOpenId: "ou_sender",
        mentionTargets: ctx.mentionTargets,
        messageId: ctx.messageId,
        hasAnyMention: ctx.hasAnyMention,
      },
      botOpenId: BOT_OPEN_ID,
    });
    expect(body).toContain("Your reply will automatically @mention: SoulCoder");
    expect(body).toContain("The current turn mention target(s) SoulCoder are authoritative.");
  });

  it("keeps current mention targets authoritative without auto mention text when disabled", () => {
    const event = makeEvent(
      "p2p",
      [
        { key: "@_user_1", name: "云上Bot", id: { open_id: "ou_target" } },
      ],
      "一个字描述下自己",
    );
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID, "Bot");
    const body = buildFeishuAgentBody({
      ctx: {
        content: ctx.content,
        senderName: "user",
        senderOpenId: "ou_sender",
        mentionTargets: ctx.mentionTargets,
        messageId: ctx.messageId,
        hasAnyMention: ctx.hasAnyMention,
      },
      botOpenId: BOT_OPEN_ID,
      autoMentionTargets: false,
    });
    expect(body).toContain(
      "The current turn mention target(s) 云上Bot are part of the request context. Do not automatically @mention them in your reply.",
    );
    expect(body).toContain("The current turn mention target(s) 云上Bot are authoritative.");
    expect(body).not.toContain("Your reply will automatically @mention:");
  });

  it("prefers mention targets parsed from content over mismatched mentions array", () => {
    const event = makeEvent(
      "p2p",
      [
        { key: "@_user_1", name: "云上Bot", id: { open_id: "ou_wrong_target" } },
      ],
      '<at user_id="ou_real_target">云上Bot</at> 你俩打个招呼',
    );
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID, "首席大管家");
    expect(ctx.mentionTargets).toEqual([
      { openId: "ou_real_target", name: "云上Bot", key: "@content_1" },
    ]);
  });

  it("does not treat group multi-bot mentions as mention-forward requests", () => {
    const event = makeEvent(
      "group",
      [
        { key: "@_user_1", name: "Bot", id: { open_id: BOT_OPEN_ID } },
        { key: "@_user_2", name: "Flink-SRE", id: { open_id: "ou_flink" } },
      ],
      '<at user_id="ou_flink">Flink-SRE</at> 一个字形容我',
    );
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID, "首席大管家");
    expect(ctx.mentionTargets).toBeUndefined();
    expect(ctx.mentionedBot).toBe(true);
  });

  it("injects direct-reply guard for group co-addressed prompts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "user: <at user_id=\"ou_flink\">Flink-SRE</at> 一个字描述下john",
        senderName: "user",
        senderOpenId: "ou_sender",
        messageId: "msg_1",
        hasAnyMention: true,
        groupCoAddressMode: "direct_reply",
      },
      botOpenId: BOT_OPEN_ID,
    });
    expect(body).toContain("This group message is co-addressed to multiple people or bots.");
    expect(body).toContain("Reply only for yourself.");
    expect(body).toContain("Do not delegate, do not call sessions_send, sessions_spawn, subagents, or message");
  });

  it("injects coordination guard for multi-bot coordination prompts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "user: @首席大管家 @Flink-SRE 帮我安排并汇总这次排查",
        senderName: "user",
        senderOpenId: "ou_sender",
        messageId: "msg_1",
        hasAnyMention: true,
        groupCoAddressMode: "coordinate",
      },
      botOpenId: BOT_OPEN_ID,
    });
    expect(body).toContain("This group message is a coordination request.");
    expect(body).toContain("You are the coordinator for this turn.");
  });

  it("still treats direct-message mentions as mention-forward requests", () => {
    const event = makeEvent(
      "p2p",
      [{ key: "@_user_1", name: "Flink-SRE", id: { open_id: "ou_flink" } }],
      '<at user_id="ou_flink">Flink-SRE</at> 帮我转达一句',
    );
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID, "首席大管家");
    expect(ctx.mentionTargets).toEqual([
      { openId: "ou_flink", name: "Flink-SRE", key: "@content_1" },
    ]);
  });
});
