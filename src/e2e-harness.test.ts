import { describe, expect, it } from "vitest";
import { parseFeishuMessageEvent } from "./bot.js";
import { botNames, botOpenIds } from "./monitor.state.js";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import {
  buildSyntheticGroupMessageEvent,
  filterSyntheticDispatchAccountIds,
  resolveSyntheticDeliveryAccountIds,
} from "./e2e-harness.js";

describe("e2e harness helpers", () => {
  it("replaces inline @mentions with placeholder tokens instead of prebuilt at tags", () => {
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
    expect(parsed.text).toContain("@_user_1");
    expect(parsed.text).toContain("@_user_2");
    expect(parsed.text).toContain("只回复 E2E-OK");
    expect(parsed.text).not.toContain("@MainBot");
    expect(parsed.text).not.toContain("@FlinkBot");
    expect(parsed.text).not.toContain("<at user_id=");
  });

  it("prefixes placeholder tokens only when the text does not already contain inline mentions", () => {
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

    expect(parsed.text).toContain("@_user_1");
    expect(parsed.text).toContain("只回复 E2E-OK");
    expect(parsed.text).not.toContain("<at user_id=");
  });

  it("preserves root and thread identifiers when provided", () => {
    const event = buildSyntheticGroupMessageEvent({
      messageId: "msg-e2e-thread",
      groupId: "oc-test-group",
      senderOpenId: "ou-user",
      text: "继续讨论",
      rootId: "om_root_001",
      threadId: "omt_thread_001",
    });

    expect(event.message.root_id).toBe("om_root_001");
    expect(event.message.thread_id).toBe("omt_thread_001");
  });

  it("matches inline mentions case-insensitively against account ids", () => {
    const event = buildSyntheticGroupMessageEvent({
      messageId: "msg-e2e-3",
      groupId: "oc-test-group",
      senderOpenId: "ou-user",
      text: "@Flink-SRE 和 @Starrocks-SRE 只回复一个字",
      mentions: [
        {
          accountId: "flink-sre",
          openId: "ou-flink",
          name: "flink-sre",
        },
        {
          accountId: "starrocks-sre",
          openId: "ou-starrocks",
          name: "starrocks-sre",
        },
      ],
    });

    const parsed = JSON.parse(event.message.content) as { text: string };

    expect(parsed.text).toContain("@_user_1");
    expect(parsed.text).toContain("@_user_2");
    expect(parsed.text).not.toContain("@Flink-SRE");
    expect(parsed.text).not.toContain("@Starrocks-SRE");
  });

  it("parses synthetic events without generating nested at tags", () => {
    const event = buildSyntheticGroupMessageEvent({
      messageId: "msg-e2e-4",
      groupId: "oc-test-group",
      senderOpenId: "ou-user",
      text: "@Flink-SRE 和 @Starrocks-SRE 只回复一个字",
      mentions: [
        {
          accountId: "flink-sre",
          openId: "ou-flink",
          name: "Flink-SRE",
        },
        {
          accountId: "starrocks-sre",
          openId: "ou-starrocks",
          name: "Starrocks-SRE",
        },
      ],
    });

    const parsed = parseFeishuMessageEvent(event, "ou-main", "首席大管家");

    expect(parsed.content).toContain('<at user_id="ou-flink">Flink-SRE</at>');
    expect(parsed.content).toContain('<at user_id="ou-starrocks">Starrocks-SRE</at>');
    expect(parsed.content.match(/<at user_id=/g)).toHaveLength(2);
    expect(parsed.content).not.toContain('<at user_id="ou-flink"><at');
  });

  it("filters synthetic dispatch targets with the same mention arbitration as live monitor", () => {
    botOpenIds.clear();
    botNames.clear();
    botOpenIds.set("main", "ou-main");
    botOpenIds.set("flink-sre", "ou-flink");
    botOpenIds.set("starrocks-sre", "ou-starrocks");
    botNames.set("main", "首席大管家");
    botNames.set("flink-sre", "Flink-SRE");
    botNames.set("starrocks-sre", "Starrocks-SRE");

    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "main",
          accounts: {
            main: { appId: "cli_main", appSecret: "secret_main" },
            "flink-sre": { appId: "cli_flink", appSecret: "secret_flink" },
            "starrocks-sre": { appId: "cli_starrocks", appSecret: "secret_starrocks" },
          },
        },
      },
    } as ClawdbotConfig;

    const event = buildSyntheticGroupMessageEvent({
      messageId: "msg-e2e-5",
      groupId: "oc-test-group",
      senderOpenId: "ou-user",
      text: "你们两个一个字描述下john，只回复一个字",
      mentions: [
        {
          accountId: "flink-sre",
          openId: "ou-flink",
          name: "Flink-SRE",
        },
        {
          accountId: "starrocks-sre",
          openId: "ou-starrocks",
          name: "Starrocks-SRE",
        },
      ],
    });

    const targets = filterSyntheticDispatchAccountIds({
      cfg,
      event,
      candidateAccountIds: ["coder", "flink-sre", "main", "starrocks-sre"],
      botOpenIdMap: botOpenIds,
      botNameMap: botNames,
    });

    expect(targets).toEqual(["main"]);
  });

  it("routes default synthetic group messages only to main", () => {
    botOpenIds.clear();
    botNames.clear();
    botOpenIds.set("main", "ou-main");
    botOpenIds.set("flink-sre", "ou-flink");
    botNames.set("main", "首席大管家");
    botNames.set("flink-sre", "Flink-SRE");

    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "main",
          accounts: {
            main: { appId: "cli_main", appSecret: "secret_main" },
            "flink-sre": { appId: "cli_flink", appSecret: "secret_flink" },
          },
        },
      },
    } as ClawdbotConfig;

    const event = buildSyntheticGroupMessageEvent({
      messageId: "msg-e2e-6",
      groupId: "oc-test-group",
      senderOpenId: "ou-user",
      text: "帮我看下今天的延迟情况",
    });

    const targets = filterSyntheticDispatchAccountIds({
      cfg,
      event,
      candidateAccountIds: ["coder", "flink-sre", "main"],
      botOpenIdMap: botOpenIds,
      botNameMap: botNames,
    });

    expect(targets).toEqual(["main"]);
  });

  it("routes default synthetic group messages only to the configured coordinator account", () => {
    botOpenIds.clear();
    botNames.clear();
    botOpenIds.set("dispatcher", "ou-dispatcher");
    botOpenIds.set("flink-sre", "ou-flink");
    botNames.set("dispatcher", "协调账号");
    botNames.set("flink-sre", "Flink-SRE");

    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "dispatcher",
          accounts: {
            dispatcher: {
              appId: "cli_dispatcher",
              appSecret: "secret_dispatcher",
            },
            "flink-sre": {
              appId: "cli_flink",
              appSecret: "secret_flink",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event = buildSyntheticGroupMessageEvent({
      messageId: "msg-e2e-6b",
      groupId: "oc-test-group",
      senderOpenId: "ou-user",
      text: "帮我看下今天的延迟情况",
    });

    const targets = filterSyntheticDispatchAccountIds({
      cfg,
      event,
      candidateAccountIds: ["dispatcher", "flink-sre"],
      botOpenIdMap: botOpenIds,
      botNameMap: botNames,
    });

    expect(targets).toEqual(["dispatcher"]);
  });

  it("routes single-specialist synthetic group messages only to the mentioned specialist", () => {
    botOpenIds.clear();
    botNames.clear();
    botOpenIds.set("main", "ou-main");
    botOpenIds.set("flink-sre", "ou-flink");
    botOpenIds.set("starrocks-sre", "ou-starrocks");
    botNames.set("main", "首席大管家");
    botNames.set("flink-sre", "Flink-SRE");
    botNames.set("starrocks-sre", "Starrocks-SRE");

    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "main",
          accounts: {
            main: { appId: "cli_main", appSecret: "secret_main" },
            "flink-sre": { appId: "cli_flink", appSecret: "secret_flink" },
            "starrocks-sre": { appId: "cli_starrocks", appSecret: "secret_starrocks" },
          },
        },
      },
    } as ClawdbotConfig;

    const event = buildSyntheticGroupMessageEvent({
      messageId: "msg-e2e-7",
      groupId: "oc-test-group",
      senderOpenId: "ou-user",
      text: "一个字描述下john，只回复一个字",
      mentions: [
        {
          accountId: "flink-sre",
          openId: "ou-flink",
          name: "Flink-SRE",
        },
      ],
    });

    const targets = filterSyntheticDispatchAccountIds({
      cfg,
      event,
      candidateAccountIds: ["coder", "flink-sre", "main", "starrocks-sre"],
      botOpenIdMap: botOpenIds,
      botNameMap: botNames,
    });

    expect(targets).toEqual(["flink-sre"]);
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
