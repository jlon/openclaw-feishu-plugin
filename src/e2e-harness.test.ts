import { describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { buildSyntheticGroupMessageEvent, resolveSyntheticDeliveryAccountIds } from "./e2e-harness.js";

describe("e2e harness helpers", () => {
  it("replaces inline @mentions with feishu at tags without duplicating them", () => {
    const event = buildSyntheticGroupMessageEvent({
      messageId: "msg-e2e-1",
      groupId: "oc-test-group",
      senderOpenId: "ou-user",
      text: "@MainBot 和 @FlinkBot 只回复 E2E-OK",
      mentions: [
        {
          accountId: "main",
          openId: "ou-main",
          name: "MainBot",
        },
        {
          accountId: "flink-sre",
          openId: "ou-flink",
          name: "FlinkBot",
        },
      ],
    });

    const parsed = JSON.parse(event.message.content) as { text: string };

    expect(event.message.chat_type).toBe("group");
    expect(event.message.mentions).toHaveLength(2);
    expect(parsed.text).toContain('<at user_id="ou-main">@_user_1</at>');
    expect(parsed.text).toContain('<at user_id="ou-flink">@_user_2</at>');
    expect(parsed.text).toContain("只回复 E2E-OK");
    expect(parsed.text).not.toContain("@MainBot");
    expect(parsed.text).not.toContain("@FlinkBot");
    expect(parsed.text.match(/<at user_id=/g)).toHaveLength(2);
  });

  it("prefixes mention tags only when the text does not already contain inline mentions", () => {
    const event = buildSyntheticGroupMessageEvent({
      messageId: "msg-e2e-2",
      groupId: "oc-test-group",
      senderOpenId: "ou-user",
      text: "只回复 E2E-OK",
      mentions: [
        {
          accountId: "main",
          openId: "ou-main",
          name: "MainBot",
        },
      ],
    });

    const parsed = JSON.parse(event.message.content) as { text: string };

    expect(parsed.text).toContain('<at user_id="ou-main">@_user_1</at>');
    expect(parsed.text).toContain("只回复 E2E-OK");
    expect(parsed.text.match(/<at user_id=/g)).toHaveLength(1);
  });

  it("resolves enabled configured accounts allowed for the group", () => {
    const cfg = {
      channels: {
        feishu: {
          accounts: {
            main: {
              appId: "cli_main",
              appSecret: "secret_main",
              groupAllowFrom: ["oc-test-group"],
            },
            "flink-sre": {
              appId: "cli_flink",
              appSecret: "secret_flink",
              groupAllowFrom: ["oc-test-group"],
            },
            "starrocks-sre": {
              enabled: false,
              appId: "cli_sr",
              appSecret: "secret_sr",
              groupAllowFrom: ["oc-test-group"],
            },
          },
        },
      },
    } as ClawdbotConfig;

    expect(resolveSyntheticDeliveryAccountIds(cfg, "oc-test-group")).toEqual(["flink-sre", "main"]);
  });
});
