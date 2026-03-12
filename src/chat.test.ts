import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerFeishuChatTools } from "./chat.js";
import { botNames, botOpenIds } from "./monitor.state.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

describe("registerFeishuChatTools", () => {
  const chatGetMock = vi.hoisted(() => vi.fn());
  const chatMembersGetMock = vi.hoisted(() => vi.fn());

  beforeEach(() => {
    vi.clearAllMocks();
    botOpenIds.clear();
    botNames.clear();
    createFeishuClientMock.mockReturnValue({
      im: {
        chat: { get: chatGetMock },
        chatMembers: { get: chatMembersGetMock },
      },
    });
  });

  function resolveFeishuChatTool(context: Record<string, unknown> = {}) {
    const registerTool = vi.fn();
    registerFeishuChatTools({
      config: {
        channels: {
          feishu: {
            enabled: true,
            appId: "app_id",
            appSecret: "app_secret", // pragma: allowlist secret
            tools: { chat: true },
          },
        },
      } as any,
      logger: { debug: vi.fn(), info: vi.fn() } as any,
      registerTool,
    } as any);

    expect(registerTool).toHaveBeenCalledTimes(1);
    const tool = registerTool.mock.calls
      .map((call) => call[0])
      .map((candidate) => (typeof candidate === "function" ? candidate(context) : candidate))
      .find((candidate) => candidate.name === "feishu_chat");
    expect(tool).toBeDefined();
    return tool as { execute: (callId: string, params: Record<string, unknown>) => Promise<any> };
  }

  it("registers feishu_chat and handles info/members actions", async () => {
    const tool = resolveFeishuChatTool();

    chatGetMock.mockResolvedValueOnce({
      code: 0,
      data: { name: "group name", user_count: 3 },
    });
    const infoResult = await tool.execute("tc_1", { action: "info", chat_id: "oc_1" });
    expect(infoResult.details).toEqual(
      expect.objectContaining({ chat_id: "oc_1", name: "group name", user_count: 3 }),
    );

    chatMembersGetMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: false,
        page_token: "",
        items: [{ member_id: "ou_1", name: "member1", member_id_type: "open_id" }],
      },
    });
    const membersResult = await tool.execute("tc_2", { action: "members", chat_id: "oc_1" });
    expect(membersResult.details).toEqual(
      expect.objectContaining({
        chat_id: "oc_1",
        members: [expect.objectContaining({ member_id: "ou_1", name: "member1" })],
      }),
    );
  });

  it("returns participant summary with visible human members and eligible internal bots", async () => {
    botOpenIds.set("main", "ou_main_bot");
    botOpenIds.set("flink-sre", "ou_flink_bot");
    botNames.set("main", "首席大管家");
    botNames.set("flink-sre", "Flink-SRE");

    const registerTool = vi.fn();
    registerFeishuChatTools({
      config: {
        channels: {
          feishu: {
            enabled: true,
            defaultAccount: "main",
            accounts: {
              main: {
                enabled: true,
                appId: "app_main",
                appSecret: "sec_main",
                groupPolicy: "allowlist",
                groupAllowFrom: ["oc_1"],
              },
              "flink-sre": {
                enabled: true,
                appId: "app_flink",
                appSecret: "sec_flink",
                groupPolicy: "allowlist",
                groupAllowFrom: ["oc_1"],
              },
              coder: {
                enabled: true,
                appId: "app_coder",
                appSecret: "sec_coder",
                groupPolicy: "disabled",
              },
            },
          },
        },
      } as any,
      logger: { debug: vi.fn(), info: vi.fn() } as any,
      registerTool,
    } as any);

    const tool = registerTool.mock.calls
      .map((call) => call[0])
      .map((candidate) => (typeof candidate === "function" ? candidate({ agentAccountId: "main" }) : candidate))
      .find((candidate) => candidate.name === "feishu_chat");
    expect(tool).toBeDefined();

    chatGetMock.mockResolvedValueOnce({
      code: 0,
      data: { name: "group name", user_count: 1, chat_type: "private" },
    });
    chatMembersGetMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: false,
        page_token: "",
        items: [{ member_id: "ou_1", name: "member1", member_id_type: "open_id" }],
      },
    });

    const result = await tool.execute("tc_3", { action: "participants", chat_id: "oc_1" });
    expect(result.details).toEqual(
      expect.objectContaining({
        chat_id: "oc_1",
        visible_member_count: 1,
        visible_members: [expect.objectContaining({ member_id: "ou_1", name: "member1" })],
        internal_bot_count: 2,
        internal_bots: [
          expect.objectContaining({
            account_id: "flink-sre",
            bot_open_id: "ou_flink_bot",
            display_name: "Flink-SRE",
          }),
          expect.objectContaining({
            account_id: "main",
            bot_open_id: "ou_main_bot",
            display_name: "首席大管家",
          }),
        ],
        external_bot_count_known: false,
      }),
    );
  });

  it("skips registration when chat tool is disabled", () => {
    const registerTool = vi.fn();
    registerFeishuChatTools({
      config: {
        channels: {
          feishu: {
            enabled: true,
            appId: "app_id",
            appSecret: "app_secret", // pragma: allowlist secret
            tools: { chat: false },
          },
        },
      } as any,
      logger: { debug: vi.fn(), info: vi.fn() } as any,
      registerTool,
    } as any);
    expect(registerTool).not.toHaveBeenCalled();
  });
});
