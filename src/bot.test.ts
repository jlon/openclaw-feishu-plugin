import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk/feishu";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyCollaborationActions,
  clearCollaborationStateForTesting,
  ensureCollaborationState,
  getCollaborationStateForTesting,
  resolveCollaborationStateForMessage,
} from "./collaboration.js";
import { botNames, botOpenIds } from "./monitor.state.js";
import { createPluginRuntimeMock } from "./test-support/plugin-runtime-mock.js";
import type { FeishuMessageEvent } from "./bot.js";
import {
  buildBroadcastSessionKey,
  buildFeishuAgentBody,
  clearBotCachesForTesting,
  getBotCacheStatsForTesting,
  handleFeishuMessage,
  isSessionFileLockError,
  primeBotCachesForTesting,
  resolveBroadcastAgents,
  runCollaborationDispatchWithRetry,
  sweepBotCachesForTesting,
  toMessageResourceType,
} from "./bot.js";
import { setFeishuRuntime } from "./runtime.js";

const {
  mockCreateFeishuReplyDispatcher,
  mockSendMessageFeishu,
  mockGetMessageFeishu,
  mockDownloadMessageResourceFeishu,
  mockCreateFeishuClient,
  mockResolveAgentRoute,
} = vi.hoisted(() => ({
  mockCreateFeishuReplyDispatcher: vi.fn(() => ({
    dispatcher: vi.fn(),
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  })),
  mockSendMessageFeishu: vi.fn().mockResolvedValue({ messageId: "pairing-msg", chatId: "oc-dm" }),
  mockGetMessageFeishu: vi.fn().mockResolvedValue(null),
  mockDownloadMessageResourceFeishu: vi.fn().mockResolvedValue({
    buffer: Buffer.from("video"),
    contentType: "video/mp4",
    fileName: "clip.mp4",
  }),
  mockCreateFeishuClient: vi.fn(),
  mockResolveAgentRoute: vi.fn(() => ({
    agentId: "main",
    channel: "feishu",
    accountId: "default",
    sessionKey: "agent:main:feishu:dm:ou-attacker",
    mainSessionKey: "agent:main:main",
    matchedBy: "default",
  })),
}));

vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: mockCreateFeishuReplyDispatcher,
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: mockSendMessageFeishu,
  getMessageFeishu: mockGetMessageFeishu,
}));

vi.mock("./media.js", () => ({
  downloadMessageResourceFeishu: mockDownloadMessageResourceFeishu,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

function createRuntimeEnv(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  } as RuntimeEnv;
}

async function dispatchMessage(params: { cfg: ClawdbotConfig; event: FeishuMessageEvent }) {
  await handleFeishuMessage({
    cfg: params.cfg,
    event: params.event,
    runtime: createRuntimeEnv(),
  });
}

describe("buildFeishuAgentBody", () => {
  it("builds message id, speaker, quoted content, mentions, and permission notice in order", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "hello world",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-42",
        mentionTargets: [{ openId: "ou-target", name: "Target User", key: "@_user_1" }],
      },
      quotedContent: "previous message",
      permissionErrorForAgent: {
        code: 99991672,
        message: "permission denied",
        grantUrl: "https://open.feishu.cn/app/cli_test",
      },
    });

    expect(body).toBe(
      '[message_id: msg-42]\nSender Name: [Replying to: "previous message"]\n\nhello world\n\n[System: Your reply will automatically @mention: Target User. Do not write @xxx yourself.]\n[System: The current turn mention target(s) Target User are authoritative. Do not continue prior rounds with different agents or users unless they are explicitly mentioned again in this turn.]\n\n[System: The bot encountered a Feishu API permission error. Please inform the user about this issue and provide the permission grant URL for the admin to authorize. Permission grant URL: https://open.feishu.cn/app/cli_test]',
    );
  });

  it("keeps mention targets as context without auto-mention instructions when disabled", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "describe yourself",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-43",
        mentionTargets: [{ openId: "ou-target", name: "Target User", key: "@_user_1" }],
      },
      autoMentionTargets: false,
    });

    expect(body).toContain(
      "[System: The current turn mention target(s) Target User are part of the request context. Do not automatically @mention them in your reply.]",
    );
    expect(body).not.toContain("Your reply will automatically @mention:");
  });

  it("treats visible mention targets in non-collaboration group turns as display-only context", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        chatType: "group",
        content: "我先回答自己的部分",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-44",
        visibleMentionTargets: [{ openId: "ou-target", name: "SoulCoder", key: "@_user_1" }],
      },
    });

    expect(body).toContain(
      "Your visible reply will automatically @mention SoulCoder for display only.",
    );
    expect(body).toContain("These other current-turn mentions are display context only.");
  });

  it("uses a minimal body for synthetic debug messages when enabled", () => {
    const previous = process.env.OPENCLAW_FEISHU_SYNTHETIC_MINIMAL_BODY;
    process.env.OPENCLAW_FEISHU_SYNTHETIC_MINIMAL_BODY = "1";
    try {
      const body = buildFeishuAgentBody({
        ctx: {
          content: '<at user_id="ou-target">@_user_1</at> synthetic test',
          senderName: "Sender Name",
          senderOpenId: "ou-sender",
          messageId: "synthetic_msg_1",
          mentionTargets: [{ openId: "ou-target", name: "Target User", key: "@_user_1" }],
          hasAnyMention: true,
          groupCoAddressMode: "peer_collab",
        },
        autoMentionTargets: false,
        agentId: "main",
      });

      expect(body).toContain('[message_id: synthetic_msg_1]\nSender Name: <at user_id="ou-target">@_user_1</at> synthetic test');
      expect(body).toContain("[System: The content may include mention tags in the form <at user_id=\"...\">name</at>.");
      expect(body).toContain("[System: This group message is a peer collaboration request among multiple bots.");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_FEISHU_SYNTHETIC_MINIMAL_BODY;
      } else {
        process.env.OPENCLAW_FEISHU_SYNTHETIC_MINIMAL_BODY = previous;
      }
    }
  });

  it("forbids user follow-up questions during peer collaboration initial assessment", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "user: @Flink-SRE @Starrocks-SRE 你俩协作排查这个链路",
        senderName: "user",
        senderOpenId: "ou_sender",
        messageId: "msg-peer-initial",
        hasAnyMention: true,
        groupCoAddressMode: "peer_collab",
        collaboration: {
          taskId: "task_peer_initial",
          mode: "peer_collab",
          protocol: "runtime",
          phase: "initial_assessment",
          participants: ["flink-sre", "starrocks-sre"],
          currentOwner: undefined,
          speakerToken: undefined,
          isCurrentOwner: false,
          allowedActions: [],
        },
      },
      botOpenId: "ou_flink",
      autoMentionTargets: false,
      agentId: "flink-sre",
    });

    expect(body).toContain("Do not ask the user follow-up questions");
    expect(body).toContain(
      "Visible reply should be exactly one short sentence about what you will inspect from your own side.",
    );
    expect(body).toContain('"action":"collab_assess"');
  });

  it("uses runtime-managed peer guidance for explicit collaboration", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "user: @Flink-SRE @Starrocks-SRE 你俩讨论什么是灵魂",
        senderName: "user",
        senderOpenId: "ou_sender",
        messageId: "msg-scripted-peer-initial",
        hasAnyMention: true,
        groupCoAddressMode: "peer_collab",
        collaboration: {
          taskId: "task_scripted_peer_initial",
          mode: "peer_collab",
          protocol: "runtime",
          phase: "initial_assessment",
          participants: ["flink-sre", "starrocks-sre"],
          coordinatorAccountId: "dispatcher",
          handoffCount: 0,
          maxHops: 2,
          isCurrentOwner: false,
          allowedActions: [],
        },
      },
      botOpenId: "ou_flink",
      autoMentionTargets: false,
      agentId: "flink-sre",
    });

    expect(body).toContain("CollaborationRuntimeManaged=true.");
    expect(body).toContain(
      "Runtime owns participant routing, visible @ display, turn order, and whether the coordinator account (dispatcher) participates.",
    );
    expect(body).toContain("This is the initial assessment stage.");
    expect(body).toContain('"action":"collab_assess"');
    expect(body).toContain("hidden control block");
  });

  it("injects recent visible turns into runtime peer prompts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "user: @Flink-SRE @Starrocks-SRE 你俩讨论什么是灵魂",
        senderName: "user",
        senderOpenId: "ou_sender",
        messageId: "msg-scripted-peer-recent-turns",
        hasAnyMention: true,
        groupCoAddressMode: "peer_collab",
        collaboration: {
          taskId: "task_scripted_peer_recent_turns",
          mode: "peer_collab",
          protocol: "runtime",
          phase: "active_collab",
          participants: ["flink-sre", "starrocks-sre"],
          currentOwner: "starrocks-sre",
          speakerToken: "starrocks-sre",
          handoffCount: 1,
          autoTurnCount: 2,
          maxHops: 3,
          isCurrentOwner: true,
          allowedActions: [],
          recentVisibleTurns: [
            { agentId: "flink-sre", text: "灵魂像持续的身份认同。", timestampMs: 1 },
            { agentId: "starrocks-sre", text: "还得补持久化和恢复。", timestampMs: 2 },
          ],
        },
      },
      botOpenId: "ou_starrocks",
      autoMentionTargets: false,
      agentId: "starrocks-sre",
    });

    expect(body).toContain("Continue from the latest visible collaboration turns");
    expect(body).toContain(
      "RecentVisibleTurns=flink-sre: 灵魂像持续的身份认同。 | starrocks-sre: 还得补持久化和恢复。",
    );
    expect(body).toContain("YourPreviousVisibleTurn=还得补持久化和恢复。");
    expect(body).toContain("Stay consistent with YourPreviousVisibleTurn unless you explicitly refine or revise it.");
  });

  it("tells the final runtime peer speaker to synthesize and stop", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "user: @Flink-SRE @Starrocks-SRE 你俩讨论什么是灵魂",
        senderName: "user",
        senderOpenId: "ou_sender",
        messageId: "msg-scripted-peer-final",
        hasAnyMention: true,
        groupCoAddressMode: "peer_collab",
        collaboration: {
          taskId: "task_scripted_peer_final",
          mode: "peer_collab",
          protocol: "runtime",
          phase: "active_collab",
          participants: ["flink-sre", "starrocks-sre"],
          currentOwner: "starrocks-sre",
          speakerToken: "starrocks-sre",
          handoffCount: 2,
          autoTurnCount: 2,
          maxHops: 2,
          isCurrentOwner: true,
          allowedActions: [],
        },
      },
      botOpenId: "ou_starrocks",
      autoMentionTargets: false,
      agentId: "starrocks-sre",
    });

    expect(body).toContain("The handoff limit has been reached for this task.");
    expect(body).toContain("Use the findings already gathered in this task to produce the best current conclusion you can from your role.");
    expect(body).toContain("append exactly one hidden control block with action agent_handoff_complete");
  });

  it("forces direct reply turns to stay single-shot and non-delegating", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "user: @Flink-SRE @Starrocks-SRE 你俩各用一句话说下你们处理问题先看什么",
        senderName: "user",
        senderOpenId: "ou_sender",
        messageId: "msg-direct-reply",
        hasAnyMention: true,
        groupCoAddressMode: "direct_reply",
      },
      botOpenId: "ou_starrocks",
      autoMentionTargets: false,
      agentId: "starrocks-sre",
    });

    expect(body).toContain("Reply only for yourself.");
    expect(body).toContain("Assume the other mentioned participants will receive this same turn on their own.");
    expect(body).toContain("Visible reply should be exactly one short sentence.");
    expect(body).toContain("Do not cue another participant");
    expect(body).toContain("Do not send follow-up confirmation");
  });

  it("tells the coordinator to assign specialists in parallel without initial handoff", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "user: @首席大管家 @Flink-SRE @Starrocks-SRE 帮我安排并汇总这次排查",
        senderName: "user",
        senderOpenId: "ou_sender",
        messageId: "msg-coordinate-owner",
        hasAnyMention: true,
        groupCoAddressMode: "coordinate",
        collaboration: {
          taskId: "task_coordinate_owner",
          coordinatorAccountId: "main",
          mode: "coordinate",
          phase: "active_collab",
          participants: ["main", "flink-sre", "starrocks-sre"],
          currentOwner: "main",
          speakerToken: "main",
          handoffCount: 0,
          maxHops: 3,
          isCurrentOwner: true,
          allowedActions: ["agent_handoff", "agent_handoff_complete"],
        },
      },
      botOpenId: "ou_main",
      autoMentionTargets: false,
      agentId: "main",
    });

    expect(body).toContain("You are coordinating this task.");
    expect(body).toContain("assign the relevant participants in parallel");
    expect(body).toContain("do not append an agent_handoff control block");
  });

  it("tells coordinate specialists to send one concise role update only", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "user: @首席大管家 @Flink-SRE @Starrocks-SRE 帮我安排并汇总这次排查",
        senderName: "user",
        senderOpenId: "ou_sender",
        messageId: "msg-coordinate-specialist",
        hasAnyMention: true,
        groupCoAddressMode: "coordinate",
        collaboration: {
          taskId: "task_coordinate_specialist",
          coordinatorAccountId: "main",
          mode: "coordinate",
          phase: "active_collab",
          participants: ["main", "flink-sre", "starrocks-sre"],
          currentOwner: "main",
          speakerToken: "main",
          handoffCount: 0,
          maxHops: 3,
          isCurrentOwner: false,
          allowedActions: ["collab_report_complete"],
        },
      },
      botOpenId: "ou_flink",
      autoMentionTargets: false,
      agentId: "flink-sre",
    });

    expect(body).toContain("participating as a specialist in a coordinated task");
    expect(body).toContain("Visible reply should be exactly one short sentence");
    expect(body).toContain("Do not @ other participants");
    expect(body).toContain('"action":"collab_report_complete"');
  });

  it("tells the coordinator to summarize once all specialists have replied", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "user: @首席大管家 @Flink-SRE @Starrocks-SRE 帮我安排并汇总这次排查",
        senderName: "user",
        senderOpenId: "ou_sender",
        messageId: "msg-coordinate-summary",
        hasAnyMention: true,
        groupCoAddressMode: "coordinate",
        collaboration: {
          taskId: "task_coordinate_summary",
          coordinatorAccountId: "main",
          mode: "coordinate",
          phase: "active_collab",
          participants: ["main", "flink-sre", "starrocks-sre"],
          currentOwner: "main",
          speakerToken: "main",
          handoffCount: 0,
          autoTurnCount: 0,
          maxHops: 3,
          isCurrentOwner: true,
          coordinateCompletedAgents: ["flink-sre", "starrocks-sre"],
          coordinateSummaryPending: true,
          allowedActions: [],
        },
      },
      botOpenId: "ou_main",
      autoMentionTargets: false,
      agentId: "main",
    });

    expect(body).toContain("All responding specialists have settled. Your job now is to produce the coordinator summary.");
    expect(body).toContain("Do not assign more participants");
    expect(body).not.toContain("do not append an agent_handoff control block. The mentioned specialists will be dispatched automatically.");
  });
});

describe("bot cache cleanup", () => {
  beforeEach(() => {
    clearBotCachesForTesting();
  });

  it("sweeps expired sender and permission cache entries", () => {
    const now = Date.now();
    primeBotCachesForTesting({
      senderEntries: [
        { key: "ou_alive", name: "Alive", expireAt: now + 60_000 },
        { key: "ou_expired", name: "Expired", expireAt: now - 1 },
      ],
      permissionEntries: [
        { key: "app_alive", value: now - 60_000 },
        { key: "app_expired", value: now - 10 * 60_000 },
      ],
    });

    expect(getBotCacheStatsForTesting()).toEqual({
      senderNameCache: 2,
      permissionErrorNotifiedAt: 2,
    });

    sweepBotCachesForTesting(now);

    expect(getBotCacheStatsForTesting()).toEqual({
      senderNameCache: 1,
      permissionErrorNotifiedAt: 1,
    });
  });
});

describe("runCollaborationDispatchWithRetry", () => {
  it("retries session lock errors and eventually succeeds", async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("session file locked (timeout 10000ms): pid=1 /tmp/x.lock"))
      .mockResolvedValueOnce("ok");
    const sleep = vi.fn(async () => {});
    const log = vi.fn();

    await expect(
      runCollaborationDispatchWithRetry({
        run,
        sleep,
        log,
        retryDelaysMs: [1],
      }),
    ).resolves.toBe("ok");

    expect(run).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("collaboration dispatch retry after session lock"),
    );
  });

  it("does not retry non-lock errors", async () => {
    const run = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("boom"));
    const sleep = vi.fn(async () => {});

    await expect(
      runCollaborationDispatchWithRetry({
        run,
        sleep,
        retryDelaysMs: [1, 2],
      }),
    ).rejects.toThrow("boom");

    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("classifies session file lock errors by message", () => {
    expect(isSessionFileLockError(new Error("session file locked (timeout 10000ms): pid=1 x.lock"))).toBe(true);
    expect(isSessionFileLockError(new Error("boom"))).toBe(false);
  });
});

describe("handleFeishuMessage command authorization", () => {
  const mockFinalizeInboundContext = vi.fn((ctx: unknown) => ctx);
  const mockDispatchReplyFromConfig = vi
    .fn()
    .mockResolvedValue({ queuedFinal: false, counts: { final: 1 } });
  const mockWithReplyDispatcher = vi.fn(
    async ({
      dispatcher,
      run,
      onSettled,
    }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
      try {
        return await run();
      } finally {
        dispatcher.markComplete();
        try {
          await dispatcher.waitForIdle();
        } finally {
          await onSettled?.();
        }
      }
    },
  );
  const mockResolveCommandAuthorizedFromAuthorizers = vi.fn(() => false);
  const mockShouldComputeCommandAuthorized = vi.fn(() => true);
  const mockReadAllowFromStore = vi.fn().mockResolvedValue([]);
  const mockUpsertPairingRequest = vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false });
  const mockBuildPairingReply = vi.fn(() => "Pairing response");
  const mockEnqueueSystemEvent = vi.fn();
  const mockSaveMediaBuffer = vi.fn().mockResolvedValue({
    id: "inbound-clip.mp4",
    path: "/tmp/inbound-clip.mp4",
    size: Buffer.byteLength("video"),
    contentType: "video/mp4",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearCollaborationStateForTesting();
    botOpenIds.clear();
    botNames.clear();
    mockShouldComputeCommandAuthorized.mockReset().mockReturnValue(true);
    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "default",
      sessionKey: "agent:main:feishu:dm:ou-attacker",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    });
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
    });
    mockEnqueueSystemEvent.mockReset();
    setFeishuRuntime(
      createPluginRuntimeMock({
        system: {
          enqueueSystemEvent: mockEnqueueSystemEvent,
        },
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext:
              mockFinalizeInboundContext as unknown as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: mockShouldComputeCommandAuthorized,
            resolveCommandAuthorizedFromAuthorizers: mockResolveCommandAuthorizedFromAuthorizers,
          },
          media: {
            saveMediaBuffer:
              mockSaveMediaBuffer as unknown as PluginRuntime["channel"]["media"]["saveMediaBuffer"],
          },
          pairing: {
            readAllowFromStore: mockReadAllowFromStore,
            upsertPairingRequest: mockUpsertPairingRequest,
            buildPairingReply: mockBuildPairingReply,
          },
        },
        media: {
          detectMime: vi.fn(async () => "application/octet-stream"),
        },
      }),
    );
  });

  it("does not enqueue inbound preview text as system events", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-no-system-preview",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hi there" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockEnqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("skips reply-to for synthetic inbound when synthetic no-reply mode is enabled", async () => {
    const previous = process.env.OPENCLAW_FEISHU_SYNTHETIC_NO_REPLY_TO;
    process.env.OPENCLAW_FEISHU_SYNTHETIC_NO_REPLY_TO = "1";
    try {
      const cfg: ClawdbotConfig = {
        channels: {
          feishu: {
            groups: {
              "oc-group": {
                requireMention: true,
              },
            },
          },
        },
      } as ClawdbotConfig;

      const event: FeishuMessageEvent = {
        sender: {
          sender_id: {
            open_id: "ou-user",
          },
        },
        message: {
          message_id: "synthetic_test_message",
          chat_id: "oc-group",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({
            text: '<at user_id="bot-open-id">@_user_1</at> synthetic test',
          }),
          mentions: [
            {
              key: "@_user_1",
              id: { open_id: "bot-open-id" },
              name: "Bot",
              tenant_key: "",
            },
          ],
        },
      };

      await handleFeishuMessage({
        cfg,
        event,
        botOpenId: "bot-open-id",
        runtime: createRuntimeEnv(),
      });

      expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
        expect.objectContaining({
          replyToMessageId: undefined,
        }),
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_FEISHU_SYNTHETIC_NO_REPLY_TO;
      } else {
        process.env.OPENCLAW_FEISHU_SYNTHETIC_NO_REPLY_TO = previous;
      }
    }
  });

  it("dispatches handoff accept to the target agent after a coordinated handoff", async () => {
    mockCreateFeishuReplyDispatcher.mockImplementation((params) => ({
      dispatcher: {
        markComplete: vi.fn(),
        waitForIdle: vi.fn(async () => {}),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      _params: params,
    }));
    botOpenIds.set("main", "ou_main");
    botOpenIds.set("starrocks-sre", "ou_starrocks");
    botNames.set("main", "首席大管家");
    botNames.set("starrocks-sre", "Starrocks-SRE");

    let dispatchCount = 0;
    let taskId = "";
    mockDispatchReplyFromConfig.mockImplementation(async ({ ctx }: { ctx: Record<string, string> }) => {
      taskId ||= ctx.CollaborationTaskId;
      dispatchCount += 1;
      if (dispatchCount == 1) {
        applyCollaborationActions([
          {
            action: "agent_handoff",
            taskId: ctx.CollaborationTaskId,
            handoffId: "handoff_chain_1",
            fromAgentId: "main",
            targetAgentId: "starrocks-sre",
            timeWindow: "",
            currentFinding: "请 StarRocks-SRE 继续",
            unresolvedQuestion: "请 StarRocks-SRE 继续",
            evidencePaths: [],
          },
        ]);
      } else if (dispatchCount == 2) {
        const state = getCollaborationStateForTesting(ctx.CollaborationTaskId);
        const handoffId = state?.activeHandoffState?.handoffId;
        if (!handoffId) {
          throw new Error("expected active handoff before accept");
        }
        applyCollaborationActions([
          {
            action: "agent_handoff_accept",
            taskId: ctx.CollaborationTaskId,
            handoffId,
            agentId: "starrocks-sre",
          },
        ]);
      }
      return { queuedFinal: false, counts: { final: 1 } };
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          enabled: true,
          defaultAccount: "main",
          accounts: {
            main: {
              enabled: true,
              appId: "app_main",
              appSecret: "secret_main",
              groupPolicy: "open",
              requireMention: false,
              renderMode: "raw",
              streaming: false,
            },
            "starrocks-sre": {
              enabled: true,
              appId: "app_starrocks",
              appSecret: "secret_starrocks",
              groupPolicy: "open",
              requireMention: true,
              renderMode: "raw",
              streaming: false,
            },
          },
        },
      },
      agents: {
        list: [{ id: "main" }, { id: "starrocks-sre" }],
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-user",
        },
      },
      message: {
        message_id: "msg-peer-handoff-chain",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({
          text: '<at user_id="ou_main">首席大管家</at> #编排(Starrocks-SRE) 帮我安排并汇总这次排查',
        }),
        mentions: [
          { key: "@_user_1", name: "首席大管家", id: { open_id: "ou_main" } },
        ],
      },
    };

    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "main",
      sessionKey: "agent:main:feishu:group:oc-group",
      mainSessionKey: "agent:main:main",
      matchedBy: "explicit",
    });
    await handleFeishuMessage({
      cfg,
      event,
      accountId: "main",
      botOpenId: "ou_main",
      botName: "首席大管家",
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(2);
    expect(mockDispatchReplyFromConfig).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        ctx: expect.objectContaining({
          AccountId: "starrocks-sre",
          MessageSid: expect.stringContaining("::handoff::"),
          CollaborationPhase: "awaiting_accept",
          CollaborationCurrentOwner: "main",
          CollaborationMode: "coordinate",
          CollaborationParticipants: "starrocks-sre",
          CollaborationActiveHandoffTarget: "starrocks-sre",
          CollaborationAllowedActions:
            "agent_handoff_accept,agent_handoff_reject,agent_handoff_need_info",
        }),
      }),
    );
  });

  it("dispatches an owner kickoff turn after peer collaboration assessments elect an owner", async () => {
    mockCreateFeishuReplyDispatcher.mockImplementation((params) => ({
      dispatcher: {
        markComplete: vi.fn(),
        waitForIdle: vi.fn(async () => {}),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      _params: params,
    }));
    botOpenIds.set("flink-sre", "ou_flink");
    botOpenIds.set("starrocks-sre", "ou_starrocks");
    botNames.set("flink-sre", "Flink-SRE");
    botNames.set("starrocks-sre", "Starrocks-SRE");

    let dispatchCount = 0;
    mockDispatchReplyFromConfig.mockImplementation(async ({ ctx }: { ctx: Record<string, string> }) => {
      dispatchCount += 1;
      if (dispatchCount === 1) {
        applyCollaborationActions([
          {
            action: "collab_assess",
            taskId: ctx.CollaborationTaskId,
            agentId: "flink-sre",
            ownershipClaim: "owner_candidate",
            currentFinding: "需要确认 Flink 作业和时间窗",
            nextCheck: "准备看作业状态和 checkpoint",
            needsWorker: false,
          },
        ]);
      } else if (dispatchCount === 2) {
        applyCollaborationActions([
          {
            action: "collab_assess",
            taskId: ctx.CollaborationTaskId,
            agentId: "starrocks-sre",
            ownershipClaim: "supporting",
            currentFinding: "等待 sink 表和集群信息",
            nextCheck: "准备看导入和 CN 状态",
            needsWorker: false,
          },
        ]);
      }
      return { queuedFinal: false, counts: { final: 1 } };
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          enabled: true,
          defaultAccount: "main",
          accounts: {
            main: {
              enabled: true,
              appId: "app_main",
              appSecret: "secret_main",
              groupPolicy: "open",
              requireMention: false,
              renderMode: "raw",
              streaming: false,
            },
            "flink-sre": {
              enabled: true,
              appId: "app_flink",
              appSecret: "secret_flink",
              groupPolicy: "open",
              requireMention: true,
              renderMode: "raw",
              streaming: false,
            },
            "starrocks-sre": {
              enabled: true,
              appId: "app_starrocks",
              appSecret: "secret_starrocks",
              groupPolicy: "open",
              requireMention: true,
              renderMode: "raw",
              streaming: false,
            },
          },
        },
      },
      agents: {
        list: [{ id: "main" }, { id: "flink-sre" }, { id: "starrocks-sre" }],
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-user",
        },
      },
      message: {
        message_id: "msg-peer-owner-kickoff",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({
          text: '<at user_id="ou_flink">Flink-SRE</at> <at user_id="ou_starrocks">Starrocks-SRE</at> #协作 你俩协作排查这个链路',
        }),
        mentions: [
          { key: "@_user_1", name: "Flink-SRE", id: { open_id: "ou_flink" } },
          { key: "@_user_2", name: "Starrocks-SRE", id: { open_id: "ou_starrocks" } },
        ],
      },
    };

    mockResolveAgentRoute.mockReturnValue({
      agentId: "flink-sre",
      channel: "feishu",
      accountId: "flink-sre",
      sessionKey: "agent:flink-sre:feishu:group:oc-group",
      mainSessionKey: "agent:main:main",
      matchedBy: "explicit",
    });
    await handleFeishuMessage({
      cfg,
      event,
      accountId: "flink-sre",
      botOpenId: "ou_flink",
      botName: "Flink-SRE",
      runtime: createRuntimeEnv(),
    });

    mockResolveAgentRoute.mockReturnValue({
      agentId: "starrocks-sre",
      channel: "feishu",
      accountId: "starrocks-sre",
      sessionKey: "agent:starrocks-sre:feishu:group:oc-group",
      mainSessionKey: "agent:main:main",
      matchedBy: "explicit",
    });
    await handleFeishuMessage({
      cfg,
      event,
      accountId: "starrocks-sre",
      botOpenId: "ou_starrocks",
      botName: "Starrocks-SRE",
      runtime: createRuntimeEnv(),
    });

    const ownerKickoffCalls = mockDispatchReplyFromConfig.mock.calls
      .map((call) => call[0] as { ctx: Record<string, string> })
      .filter((call) => call.ctx.MessageSid?.includes("::owner::"));
    expect(ownerKickoffCalls.length).toBeGreaterThanOrEqual(1);
    expect(ownerKickoffCalls[0]).toEqual(
      expect.objectContaining({
        ctx: expect.objectContaining({
          AccountId: "flink-sre",
          MessageSid: expect.stringContaining("::owner::"),
          CollaborationPhase: "active_collab",
          CollaborationCurrentOwner: "flink-sre",
          CollaborationIsCurrentOwner: true,
          CollaborationMode: "peer_collab",
        }),
      }),
    );
    const ownerKickoffParams = mockCreateFeishuReplyDispatcher.mock.calls
      .map((call) => call[0] as { visibleMentionTargets?: Array<{ openId: string; name: string }> })
      .find((call) =>
        (call.visibleMentionTargets ?? []).some((target) => target.openId === "ou_starrocks"),
      );
    expect(ownerKickoffParams?.visibleMentionTargets).toEqual([
      expect.objectContaining({ openId: "ou_starrocks", name: "Starrocks-SRE" }),
    ]);
    const collaborationSessionKeys = mockFinalizeInboundContext.mock.calls
      .map((call: unknown[]) => call[0] as { SessionKey?: string; CollaborationTaskId?: string })
      .filter((ctx) => typeof ctx.CollaborationTaskId === "string");
    expect(collaborationSessionKeys.length).toBeGreaterThan(0);
    for (const ctx of collaborationSessionKeys) {
      expect(ctx.SessionKey).toContain(`:task:${ctx.CollaborationTaskId}`);
    }
  });

  it("auto-advances runtime peer collaboration turns when no explicit handoff is emitted", async () => {
    mockCreateFeishuReplyDispatcher.mockImplementation((params) => ({
      dispatcher: {
        markComplete: vi.fn(),
        waitForIdle: vi.fn(async () => {}),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      _params: params,
    }));
    botOpenIds.set("flink-sre", "ou_flink");
    botOpenIds.set("starrocks-sre", "ou_starrocks");
    botNames.set("flink-sre", "Flink-SRE");
    botNames.set("starrocks-sre", "Starrocks-SRE");

    let dispatchCount = 0;
    mockDispatchReplyFromConfig.mockImplementation(async ({ ctx }: { ctx: Record<string, string> }) => {
      dispatchCount += 1;
      if (dispatchCount === 1) {
        applyCollaborationActions([
          {
            action: "collab_assess",
            taskId: ctx.CollaborationTaskId,
            agentId: "flink-sre",
            ownershipClaim: "owner_candidate",
            currentFinding: "先从 Flink 视角给一个判断",
            nextCheck: "再补一层系统恢复视角",
            needsWorker: false,
          },
        ]);
      } else if (dispatchCount === 2) {
        applyCollaborationActions([
          {
            action: "collab_assess",
            taskId: ctx.CollaborationTaskId,
            agentId: "starrocks-sre",
            ownershipClaim: "supporting",
            currentFinding: "先从 StarRocks 视角给一个判断",
            nextCheck: "再补一层存储与持久化视角",
            needsWorker: false,
          },
        ]);
      }
      return { queuedFinal: false, counts: { final: 1 } };
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          enabled: true,
          defaultAccount: "main",
          collaboration: {
            maxHops: 1,
          },
          accounts: {
            main: {
              enabled: true,
              appId: "app_main",
              appSecret: "secret_main",
              groupPolicy: "open",
              requireMention: false,
              renderMode: "raw",
              streaming: false,
            },
            "flink-sre": {
              enabled: true,
              appId: "app_flink",
              appSecret: "secret_flink",
              groupPolicy: "open",
              requireMention: true,
              renderMode: "raw",
              streaming: false,
            },
            "starrocks-sre": {
              enabled: true,
              appId: "app_starrocks",
              appSecret: "secret_starrocks",
              groupPolicy: "open",
              requireMention: true,
              renderMode: "raw",
              streaming: false,
            },
          },
        },
      },
      agents: {
        list: [{ id: "main" }, { id: "flink-sre" }, { id: "starrocks-sre" }],
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-user",
        },
      },
      message: {
        message_id: "msg-peer-scripted-advance",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({
          text: '<at user_id="ou_flink">Flink-SRE</at> <at user_id="ou_starrocks">Starrocks-SRE</at> #协作 讨论什么是灵魂',
        }),
        mentions: [
          { key: "@_user_1", name: "Flink-SRE", id: { open_id: "ou_flink" } },
          { key: "@_user_2", name: "Starrocks-SRE", id: { open_id: "ou_starrocks" } },
        ],
      },
    };

    mockResolveAgentRoute.mockReturnValue({
      agentId: "flink-sre",
      channel: "feishu",
      accountId: "flink-sre",
      sessionKey: "agent:flink-sre:feishu:group:oc-group",
      mainSessionKey: "agent:main:main",
      matchedBy: "explicit",
    });
    await handleFeishuMessage({
      cfg,
      event,
      accountId: "flink-sre",
      botOpenId: "ou_flink",
      botName: "Flink-SRE",
      runtime: createRuntimeEnv(),
    });

    mockResolveAgentRoute.mockReturnValue({
      agentId: "starrocks-sre",
      channel: "feishu",
      accountId: "starrocks-sre",
      sessionKey: "agent:starrocks-sre:feishu:group:oc-group",
      mainSessionKey: "agent:main:main",
      matchedBy: "explicit",
    });
    await handleFeishuMessage({
      cfg,
      event,
      accountId: "starrocks-sre",
      botOpenId: "ou_starrocks",
      botName: "Starrocks-SRE",
      runtime: createRuntimeEnv(),
    });

    const ownerCalls = mockDispatchReplyFromConfig.mock.calls
      .map((call) => call[0] as { ctx: Record<string, string> })
      .filter((call) => call.ctx.MessageSid?.includes("::owner::"));
    expect(ownerCalls.length).toBe(2);
    expect(ownerCalls[0]).toEqual(
      expect.objectContaining({
        ctx: expect.objectContaining({
          AccountId: "flink-sre",
          MessageSid: expect.stringContaining("::owner::"),
          CollaborationPhase: "active_collab",
          CollaborationCurrentOwner: "flink-sre",
          CollaborationIsCurrentOwner: true,
        }),
      }),
    );
    expect(ownerCalls[1]).toEqual(
      expect.objectContaining({
        ctx: expect.objectContaining({
          AccountId: "starrocks-sre",
          MessageSid: expect.stringContaining("::owner::"),
          CollaborationPhase: "active_collab",
          CollaborationCurrentOwner: "starrocks-sre",
          CollaborationIsCurrentOwner: true,
        }),
      }),
    );
    const firstAssessmentParams = mockCreateFeishuReplyDispatcher.mock.calls[0]?.[0] as
      | { visibleMentionTargets?: Array<{ openId: string; name: string }> }
      | undefined;
    const secondAssessmentParams = mockCreateFeishuReplyDispatcher.mock.calls[1]?.[0] as
      | { visibleMentionTargets?: Array<{ openId: string; name: string }> }
      | undefined;
    const firstOwnerParams = mockCreateFeishuReplyDispatcher.mock.calls[2]?.[0] as
      | { visibleMentionTargets?: Array<{ openId: string; name: string }> }
      | undefined;
    const secondOwnerParams = mockCreateFeishuReplyDispatcher.mock.calls[3]?.[0] as
      | { visibleMentionTargets?: Array<{ openId: string; name: string }> }
      | undefined;
    expect(firstAssessmentParams?.visibleMentionTargets).toEqual([
      expect.objectContaining({ openId: "ou_starrocks", name: "Starrocks-SRE" }),
    ]);
    expect(secondAssessmentParams?.visibleMentionTargets).toEqual([
      expect.objectContaining({ openId: "ou_flink", name: "Flink-SRE" }),
    ]);
    expect(firstOwnerParams?.visibleMentionTargets).toEqual([
      expect.objectContaining({ openId: "ou_starrocks", name: "Starrocks-SRE" }),
    ]);
    expect(secondOwnerParams?.visibleMentionTargets).toEqual([
      expect.objectContaining({ openId: "ou_flink", name: "Flink-SRE" }),
    ]);
    const taskId = (
      mockDispatchReplyFromConfig.mock.calls[3]?.[0] as { ctx?: Record<string, string> } | undefined
    )?.ctx?.CollaborationTaskId;
    expect(taskId).toBeTruthy();
    expect(getCollaborationStateForTesting(taskId!)?.phase).toBe("completed");
  });

  it("fans out coordinate specialist turns in parallel and then dispatches a coordinator summary", async () => {
    mockCreateFeishuReplyDispatcher.mockImplementation((params) => ({
      dispatcher: {
        markComplete: vi.fn(),
        waitForIdle: vi.fn(async () => {}),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      _params: params,
    }));
    botOpenIds.set("main", "ou_main");
    botOpenIds.set("flink-sre", "ou_flink");
    botOpenIds.set("starrocks-sre", "ou_starrocks");
    botNames.set("main", "首席大管家");
    botNames.set("flink-sre", "Flink-SRE");
    botNames.set("starrocks-sre", "Starrocks-SRE");

    mockDispatchReplyFromConfig.mockResolvedValue({ queuedFinal: false, counts: { final: 1 } });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          enabled: true,
          defaultAccount: "main",
          accounts: {
            main: {
              enabled: true,
              appId: "app_main",
              appSecret: "secret_main",
              groupPolicy: "open",
              requireMention: false,
              renderMode: "raw",
              streaming: false,
            },
            "flink-sre": {
              enabled: true,
              appId: "app_flink",
              appSecret: "secret_flink",
              groupPolicy: "open",
              requireMention: true,
              renderMode: "raw",
              streaming: false,
            },
            "starrocks-sre": {
              enabled: true,
              appId: "app_starrocks",
              appSecret: "secret_starrocks",
              groupPolicy: "open",
              requireMention: true,
              renderMode: "raw",
              streaming: false,
            },
          },
        },
      },
      agents: {
        list: [{ id: "main" }, { id: "flink-sre" }, { id: "starrocks-sre" }],
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-user",
        },
      },
      message: {
        message_id: "msg-coordinate-fanout",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({
          text: '<at user_id="ou_main">首席大管家</at> <at user_id="ou_flink">Flink-SRE</at> <at user_id="ou_starrocks">Starrocks-SRE</at> 帮我安排并汇总这次排查',
        }),
        mentions: [
          { key: "@_user_1", name: "首席大管家", id: { open_id: "ou_main" } },
          { key: "@_user_2", name: "Flink-SRE", id: { open_id: "ou_flink" } },
          { key: "@_user_3", name: "Starrocks-SRE", id: { open_id: "ou_starrocks" } },
        ],
      },
    };

    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "main",
      sessionKey: "agent:main:feishu:group:oc-group",
      mainSessionKey: "agent:main:main",
      matchedBy: "explicit",
    });
    mockDispatchReplyFromConfig.mockImplementation(async ({ ctx }: { ctx: Record<string, string> }) => {
      if (ctx.AccountId === "flink-sre" || ctx.AccountId === "starrocks-sre") {
        applyCollaborationActions([
          {
            action: "collab_report_complete",
            taskId: ctx.CollaborationTaskId,
            agentId: ctx.AccountId,
          },
        ]);
      }
      return { queuedFinal: false, counts: { final: 1 } };
    });

    await handleFeishuMessage({
      cfg,
      event,
      accountId: "main",
      botOpenId: "ou_main",
      botName: "首席大管家",
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(4);

    const specialistCalls = mockDispatchReplyFromConfig.mock.calls
      .slice(1, 3)
      .map(([params]) => params.ctx)
      .sort((a, b) => String(a.AccountId).localeCompare(String(b.AccountId)));

    expect(specialistCalls).toEqual([
      expect.objectContaining({
        AccountId: "flink-sre",
        MessageSid: expect.stringContaining("::coordinate::"),
        CollaborationMode: "coordinate",
        CollaborationPhase: "active_collab",
        CollaborationCurrentOwner: "main",
        CollaborationIsCurrentOwner: false,
      }),
      expect.objectContaining({
        AccountId: "starrocks-sre",
        MessageSid: expect.stringContaining("::coordinate::"),
        CollaborationMode: "coordinate",
        CollaborationPhase: "active_collab",
        CollaborationCurrentOwner: "main",
        CollaborationIsCurrentOwner: false,
      }),
    ]);

    expect(mockDispatchReplyFromConfig.mock.calls[3]?.[0]).toEqual(
      expect.objectContaining({
        ctx: expect.objectContaining({
          AccountId: "main",
          MessageSid: expect.stringContaining("::coordinate-summary::"),
          CollaborationMode: "coordinate",
          CollaborationPhase: "active_collab",
          CollaborationCurrentOwner: "main",
          CollaborationCoordinateSummaryPending: "true",
        }),
      }),
    );
    const summaryTaskId = (mockDispatchReplyFromConfig.mock.calls[3]?.[0] as {
      ctx?: Record<string, string>;
    })?.ctx?.CollaborationTaskId;
    expect(summaryTaskId).toBeTruthy();
    expect(getCollaborationStateForTesting(summaryTaskId! as string)?.phase).toBe("completed");
  });

  it("uses the configured default account as the coordinate owner and summary dispatcher", async () => {
    mockCreateFeishuReplyDispatcher.mockImplementation((params) => ({
      dispatcher: {
        markComplete: vi.fn(),
        waitForIdle: vi.fn(async () => {}),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      _params: params,
    }));
    botOpenIds.set("dispatcher", "ou_dispatcher");
    botOpenIds.set("flink-sre", "ou_flink");
    botOpenIds.set("starrocks-sre", "ou_starrocks");
    botNames.set("dispatcher", "调度员");
    botNames.set("flink-sre", "Flink-SRE");
    botNames.set("starrocks-sre", "Starrocks-SRE");

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          enabled: true,
          defaultAccount: "dispatcher",
          accounts: {
            dispatcher: {
              enabled: true,
              appId: "app_dispatcher",
              appSecret: "secret_dispatcher",
              groupPolicy: "open",
              requireMention: false,
              renderMode: "raw",
              streaming: false,
            },
            "flink-sre": {
              enabled: true,
              appId: "app_flink",
              appSecret: "secret_flink",
              groupPolicy: "open",
              requireMention: true,
              renderMode: "raw",
              streaming: false,
            },
            "starrocks-sre": {
              enabled: true,
              appId: "app_starrocks",
              appSecret: "secret_starrocks",
              groupPolicy: "open",
              requireMention: true,
              renderMode: "raw",
              streaming: false,
            },
          },
        },
      },
      agents: {
        list: [{ id: "dispatcher" }, { id: "flink-sre" }, { id: "starrocks-sre" }],
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-user",
        },
      },
      message: {
        message_id: "msg-coordinate-default-account",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({
          text: '<at user_id="ou_flink">Flink-SRE</at> <at user_id="ou_starrocks">Starrocks-SRE</at> 你俩先看，最后给我一个结论',
        }),
        mentions: [
          { key: "@_user_1", name: "Flink-SRE", id: { open_id: "ou_flink" } },
          { key: "@_user_2", name: "Starrocks-SRE", id: { open_id: "ou_starrocks" } },
        ],
      },
    };

    mockResolveAgentRoute.mockReturnValue({
      agentId: "flink-sre",
      channel: "feishu",
      accountId: "flink-sre",
      sessionKey: "agent:flink-sre:feishu:group:oc-group",
      mainSessionKey: "agent:flink-sre:main",
      matchedBy: "explicit",
    });
    mockDispatchReplyFromConfig.mockImplementation(async ({ ctx }: { ctx: Record<string, string> }) => {
      if (ctx.AccountId === "flink-sre" || ctx.AccountId === "starrocks-sre") {
        applyCollaborationActions([
          {
            action: "collab_report_complete",
            taskId: ctx.CollaborationTaskId,
            agentId: ctx.AccountId,
          },
        ]);
      }
      return { queuedFinal: false, counts: { final: 1 } };
    });

    await handleFeishuMessage({
      cfg,
      event,
      accountId: "dispatcher",
      botOpenId: "ou_dispatcher",
      botName: "调度员",
      runtime: createRuntimeEnv(),
    });

    const specialistCalls = mockDispatchReplyFromConfig.mock.calls
      .slice(1, 3)
      .map(([params]) => params.ctx)
      .sort((a, b) => String(a.AccountId).localeCompare(String(b.AccountId)));

    expect(specialistCalls).toEqual([
      expect.objectContaining({
        AccountId: "flink-sre",
        CollaborationMode: "coordinate",
        CollaborationCurrentOwner: "dispatcher",
      }),
      expect.objectContaining({
        AccountId: "starrocks-sre",
        CollaborationMode: "coordinate",
        CollaborationCurrentOwner: "dispatcher",
      }),
    ]);

    expect(mockDispatchReplyFromConfig.mock.calls[3]?.[0]).toEqual(
      expect.objectContaining({
        ctx: expect.objectContaining({
          AccountId: "dispatcher",
          MessageSid: expect.stringContaining("::coordinate-summary::"),
          CollaborationCurrentOwner: "dispatcher",
        }),
      }),
    );
  });

  it("still dispatches a coordinator summary when one specialist stays silent", async () => {
    mockCreateFeishuReplyDispatcher.mockImplementation((params) => ({
      dispatcher: {
        markComplete: vi.fn(),
        waitForIdle: vi.fn(async () => {}),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      _params: params,
    }));
    botOpenIds.set("main", "ou_main");
    botOpenIds.set("flink-sre", "ou_flink");
    botOpenIds.set("starrocks-sre", "ou_starrocks");
    botNames.set("main", "首席大管家");
    botNames.set("flink-sre", "Flink-SRE");
    botNames.set("starrocks-sre", "Starrocks-SRE");

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          enabled: true,
          defaultAccount: "main",
          accounts: {
            main: {
              enabled: true,
              appId: "app_main",
              appSecret: "secret_main",
              groupPolicy: "open",
              requireMention: false,
              renderMode: "raw",
              streaming: false,
            },
            "flink-sre": {
              enabled: true,
              appId: "app_flink",
              appSecret: "secret_flink",
              groupPolicy: "open",
              requireMention: true,
              renderMode: "raw",
              streaming: false,
            },
            "starrocks-sre": {
              enabled: true,
              appId: "app_starrocks",
              appSecret: "secret_starrocks",
              groupPolicy: "open",
              requireMention: true,
              renderMode: "raw",
              streaming: false,
            },
          },
        },
      },
      agents: {
        list: [{ id: "main" }, { id: "flink-sre" }, { id: "starrocks-sre" }],
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-user",
        },
      },
      message: {
        message_id: "msg-coordinate-silent-specialist",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({
          text: '<at user_id="ou_main">首席大管家</at> <at user_id="ou_flink">Flink-SRE</at> <at user_id="ou_starrocks">Starrocks-SRE</at> 帮我安排并汇总这次排查',
        }),
        mentions: [
          { key: "@_user_1", name: "首席大管家", id: { open_id: "ou_main" } },
          { key: "@_user_2", name: "Flink-SRE", id: { open_id: "ou_flink" } },
          { key: "@_user_3", name: "Starrocks-SRE", id: { open_id: "ou_starrocks" } },
        ],
      },
    };

    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "main",
      sessionKey: "agent:main:feishu:group:oc-group",
      mainSessionKey: "agent:main:main",
      matchedBy: "explicit",
    });
    mockDispatchReplyFromConfig.mockImplementation(async ({ ctx }: { ctx: Record<string, string> }) => {
      if (ctx.AccountId === "flink-sre") {
        applyCollaborationActions([
          {
            action: "collab_report_complete",
            taskId: ctx.CollaborationTaskId,
            agentId: ctx.AccountId,
          },
        ]);
        return { queuedFinal: false, counts: { final: 1 } };
      }
      if (ctx.AccountId === "starrocks-sre") {
        return { queuedFinal: false, counts: { final: 0 } };
      }
      return { queuedFinal: false, counts: { final: 1 } };
    });

    await handleFeishuMessage({
      cfg,
      event,
      accountId: "main",
      botOpenId: "ou_main",
      botName: "首席大管家",
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(4);
    const summaryTaskId = (mockDispatchReplyFromConfig.mock.calls[3]?.[0] as {
      ctx?: Record<string, string>;
    })?.ctx?.CollaborationTaskId;
    expect(summaryTaskId).toBeTruthy();
    expect(getCollaborationStateForTesting(summaryTaskId! as string)).toEqual(
      expect.objectContaining({
        phase: "completed",
        coordinateCompletedAgents: ["flink-sre"],
        coordinateFailedAgents: ["starrocks-sre"],
      }),
    );
  });

  it("overrides upstream routing so natural multi-bot direct replies still enter through hidden main", async () => {
    botOpenIds.set("main", "ou_main");
    botOpenIds.set("flink-sre", "ou_flink");
    botOpenIds.set("starrocks-sre", "ou_starrocks");
    botNames.set("main", "首席大管家");
    botNames.set("flink-sre", "Flink-SRE");
    botNames.set("starrocks-sre", "Starrocks-SRE");
    mockDispatchReplyFromConfig.mockResolvedValue({ queuedFinal: false, counts: { final: 1 } });
    mockResolveAgentRoute.mockReturnValue({
      agentId: "flink-sre",
      channel: "feishu",
      accountId: "flink-sre",
      sessionKey: "agent:flink-sre:feishu:group:oc-group",
      mainSessionKey: "agent:main:main",
      matchedBy: "explicit",
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          enabled: true,
          defaultAccount: "main",
          accounts: {
            main: {
              enabled: true,
              appId: "app_main",
              appSecret: "secret_main",
              groupPolicy: "open",
              requireMention: false,
              renderMode: "raw",
              streaming: false,
            },
            "flink-sre": {
              enabled: true,
              appId: "app_flink",
              appSecret: "secret_flink",
              groupPolicy: "open",
              requireMention: true,
              renderMode: "raw",
              streaming: false,
            },
            "starrocks-sre": {
              enabled: true,
              appId: "app_starrocks",
              appSecret: "secret_starrocks",
              groupPolicy: "open",
              requireMention: true,
              renderMode: "raw",
              streaming: false,
            },
          },
        },
      },
      agents: {
        list: [{ id: "main" }, { id: "flink-sre" }, { id: "starrocks-sre" }],
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-user",
        },
      },
      message: {
        message_id: "msg-natural-direct",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({
          text: '<at user_id="ou_flink">Flink-SRE</at> <at user_id="ou_starrocks">Starrocks-SRE</at> 你俩各说一句先看什么',
        }),
        mentions: [
          { key: "@_user_1", name: "Flink-SRE", id: { open_id: "ou_flink" } },
          { key: "@_user_2", name: "Starrocks-SRE", id: { open_id: "ou_starrocks" } },
        ],
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      accountId: "main",
      botOpenId: "ou_main",
      botName: "首席大管家",
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(2);
    const dispatchedAccounts = mockDispatchReplyFromConfig.mock.calls
      .map(([params]) => (params.ctx as Record<string, string>).AccountId)
      .sort();
    expect(dispatchedAccounts).toEqual(["flink-sre", "starrocks-sre"]);
  });

  it("overrides upstream routing so natural multi-bot collaboration still enters through hidden main", async () => {
    botOpenIds.set("main", "ou_main");
    botOpenIds.set("flink-sre", "ou_flink");
    botOpenIds.set("starrocks-sre", "ou_starrocks");
    botNames.set("main", "首席大管家");
    botNames.set("flink-sre", "Flink-SRE");
    botNames.set("starrocks-sre", "Starrocks-SRE");
    mockDispatchReplyFromConfig.mockResolvedValue({ queuedFinal: false, counts: { final: 1 } });
    mockResolveAgentRoute.mockReturnValue({
      agentId: "starrocks-sre",
      channel: "feishu",
      accountId: "starrocks-sre",
      sessionKey: "agent:starrocks-sre:feishu:group:oc-group",
      mainSessionKey: "agent:main:main",
      matchedBy: "explicit",
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          enabled: true,
          defaultAccount: "main",
          collaboration: {
            maxHops: 1,
          },
          accounts: {
            main: {
              enabled: true,
              appId: "app_main",
              appSecret: "secret_main",
              groupPolicy: "open",
              requireMention: false,
              renderMode: "raw",
              streaming: false,
            },
            "flink-sre": {
              enabled: true,
              appId: "app_flink",
              appSecret: "secret_flink",
              groupPolicy: "open",
              requireMention: true,
              renderMode: "raw",
              streaming: false,
            },
            "starrocks-sre": {
              enabled: true,
              appId: "app_starrocks",
              appSecret: "secret_starrocks",
              groupPolicy: "open",
              requireMention: true,
              renderMode: "raw",
              streaming: false,
            },
          },
        },
      },
      agents: {
        list: [{ id: "main" }, { id: "flink-sre" }, { id: "starrocks-sre" }],
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-user",
        },
      },
      message: {
        message_id: "msg-natural-peer-collab",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({
          text: '<at user_id="ou_flink">Flink-SRE</at> <at user_id="ou_starrocks">Starrocks-SRE</at> 你俩讨论一下这条链路各自怎么看',
        }),
        mentions: [
          { key: "@_user_1", name: "Flink-SRE", id: { open_id: "ou_flink" } },
          { key: "@_user_2", name: "Starrocks-SRE", id: { open_id: "ou_starrocks" } },
        ],
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      accountId: "main",
      botOpenId: "ou_main",
      botName: "首席大管家",
      runtime: createRuntimeEnv(),
    });

    const collaborationCalls = mockDispatchReplyFromConfig.mock.calls
      .map(([params]) => params.ctx as Record<string, string>)
      .filter((ctx) => ctx.CollaborationMode === "peer_collab");
    expect(collaborationCalls.length).toBeGreaterThanOrEqual(2);
    expect(new Set(collaborationCalls.map((ctx) => ctx.AccountId))).toEqual(
      new Set(["flink-sre", "starrocks-sre"]),
    );
  });

  it("dispatches an owner kickoff after hidden main collects both peer assessments", async () => {
    botOpenIds.set("main", "ou_main");
    botOpenIds.set("flink-sre", "ou_flink");
    botOpenIds.set("starrocks-sre", "ou_starrocks");
    botNames.set("main", "首席大管家");
    botNames.set("flink-sre", "Flink-SRE");
    botNames.set("starrocks-sre", "Starrocks-SRE");
    mockCreateFeishuReplyDispatcher.mockImplementation((params) => ({
      dispatcher: {
        markComplete: vi.fn(),
        waitForIdle: vi.fn(async () => {}),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      _params: params,
    }));
    let dispatchCount = 0;
    mockDispatchReplyFromConfig.mockImplementation(async ({ ctx }: { ctx: Record<string, string> }) => {
      dispatchCount += 1;
      if (dispatchCount === 1) {
        applyCollaborationActions([
          {
            action: "collab_assess",
            taskId: ctx.CollaborationTaskId,
            agentId: "flink-sre",
            ownershipClaim: "owner_candidate",
            currentFinding: "先看 Flink 侧状态和 checkpoint",
            nextCheck: "再补恢复与状态一致性",
            needsWorker: false,
          },
        ]);
      } else if (dispatchCount === 2) {
        applyCollaborationActions([
          {
            action: "collab_assess",
            taskId: ctx.CollaborationTaskId,
            agentId: "starrocks-sre",
            ownershipClaim: "supporting",
            currentFinding: "再看 StarRocks 持久化与导入链路",
            nextCheck: "准备回应 Flink 侧观点",
            needsWorker: false,
          },
        ]);
      }
      return { queuedFinal: false, counts: { final: 1 } };
    });

    mockResolveAgentRoute.mockReturnValue({
      agentId: "starrocks-sre",
      channel: "feishu",
      accountId: "starrocks-sre",
      sessionKey: "agent:starrocks-sre:feishu:group:oc-group",
      mainSessionKey: "agent:main:main",
      matchedBy: "explicit",
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          enabled: true,
          defaultAccount: "main",
          collaboration: {
            maxHops: 1,
          },
          accounts: {
            main: {
              enabled: true,
              appId: "app_main",
              appSecret: "secret_main",
              groupPolicy: "open",
              requireMention: false,
              renderMode: "raw",
              streaming: false,
            },
            "flink-sre": {
              enabled: true,
              appId: "app_flink",
              appSecret: "secret_flink",
              groupPolicy: "open",
              requireMention: true,
              renderMode: "raw",
              streaming: false,
            },
            "starrocks-sre": {
              enabled: true,
              appId: "app_starrocks",
              appSecret: "secret_starrocks",
              groupPolicy: "open",
              requireMention: true,
              renderMode: "raw",
              streaming: false,
            },
          },
        },
      },
      agents: {
        list: [{ id: "main" }, { id: "flink-sre" }, { id: "starrocks-sre" }],
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-user",
        },
      },
      message: {
        message_id: "msg-hidden-main-owner-kickoff",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({
          text: '<at user_id="ou_flink">Flink-SRE</at> <at user_id="ou_starrocks">Starrocks-SRE</at> 你俩讨论一下这条链路各自怎么看',
        }),
        mentions: [
          { key: "@_user_1", name: "Flink-SRE", id: { open_id: "ou_flink" } },
          { key: "@_user_2", name: "Starrocks-SRE", id: { open_id: "ou_starrocks" } },
        ],
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      accountId: "main",
      botOpenId: "ou_main",
      botName: "首席大管家",
      runtime: createRuntimeEnv(),
    });

    const ownerKickoffCalls = mockDispatchReplyFromConfig.mock.calls
      .map(([params]) => params.ctx as Record<string, string>)
      .filter((ctx) => ctx.MessageSid?.includes("::owner::"));
    expect(ownerKickoffCalls.length).toBeGreaterThanOrEqual(1);
    expect(ownerKickoffCalls[0]).toEqual(
      expect.objectContaining({
        AccountId: "flink-sre",
        CollaborationMode: "peer_collab",
        CollaborationPhase: "active_collab",
        CollaborationCurrentOwner: "flink-sre",
        CollaborationIsCurrentOwner: true,
      }),
    );
  });

  it("keeps explicitly mentioned main inside peer_collab participants", async () => {
    botOpenIds.set("main", "ou_main");
    botOpenIds.set("flink-sre", "ou_flink");
    botOpenIds.set("starrocks-sre", "ou_starrocks");
    botNames.set("main", "首席大管家");
    botNames.set("flink-sre", "Flink-SRE");
    botNames.set("starrocks-sre", "Starrocks-SRE");
    mockDispatchReplyFromConfig.mockResolvedValue({ queuedFinal: false, counts: { final: 1 } });
    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "main",
      sessionKey: "agent:main:feishu:group:oc-group",
      mainSessionKey: "agent:main:main",
      matchedBy: "explicit",
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          enabled: true,
          defaultAccount: "main",
          collaboration: {
            maxHops: 1,
          },
          accounts: {
            main: {
              enabled: true,
              appId: "app_main",
              appSecret: "secret_main",
              groupPolicy: "open",
              requireMention: false,
              renderMode: "raw",
              streaming: false,
            },
            "flink-sre": {
              enabled: true,
              appId: "app_flink",
              appSecret: "secret_flink",
              groupPolicy: "open",
              requireMention: true,
              renderMode: "raw",
              streaming: false,
            },
            "starrocks-sre": {
              enabled: true,
              appId: "app_starrocks",
              appSecret: "secret_starrocks",
              groupPolicy: "open",
              requireMention: true,
              renderMode: "raw",
              streaming: false,
            },
          },
        },
      },
      agents: {
        list: [{ id: "main" }, { id: "flink-sre" }, { id: "starrocks-sre" }],
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-user",
        },
      },
      message: {
        message_id: "msg-main-plus-peer",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({
          text: '<at user_id="ou_main">首席大管家</at> <at user_id="ou_flink">Flink-SRE</at> <at user_id="ou_starrocks">Starrocks-SRE</at> 你们先讨论一下这条链路',
        }),
        mentions: [
          { key: "@_user_1", name: "首席大管家", id: { open_id: "ou_main" } },
          { key: "@_user_2", name: "Flink-SRE", id: { open_id: "ou_flink" } },
          { key: "@_user_3", name: "Starrocks-SRE", id: { open_id: "ou_starrocks" } },
        ],
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      accountId: "main",
      botOpenId: "ou_main",
      botName: "首席大管家",
      runtime: createRuntimeEnv(),
    });

    const collaborationCalls = mockDispatchReplyFromConfig.mock.calls
      .map(([params]) => params.ctx as Record<string, string>)
      .filter((ctx) => ctx.CollaborationMode === "peer_collab");
    expect(collaborationCalls.length).toBeGreaterThanOrEqual(2);
    expect(collaborationCalls.some((ctx) => ctx.AccountId === "main")).toBe(true);
    expect(collaborationCalls.some((ctx) => ctx.AccountId === "flink-sre")).toBe(true);
    for (const call of collaborationCalls) {
      expect(call.CollaborationParticipants).toBe("main,flink-sre,starrocks-sre");
    }
  });

  it("injects hard no-routing instructions for peer collaboration owners", async () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "user: @Flink-SRE @Starrocks-SRE 先各自判断，再互相补充",
        senderName: "user",
        senderOpenId: "ou_sender",
        messageId: "msg-owner",
        hasAnyMention: true,
        groupCoAddressMode: "peer_collab",
        collaboration: {
          taskId: "task_owner",
          mode: "peer_collab",
          phase: "active_collab",
          participants: ["flink-sre", "starrocks-sre"],
          currentOwner: "flink-sre",
          speakerToken: "flink-sre",
          handoffCount: 0,
          maxHops: 3,
          isCurrentOwner: true,
          allowedActions: ["agent_handoff", "agent_handoff_complete"],
        },
      },
      botOpenId: "ou_flink",
      autoMentionTargets: false,
      agentId: "flink-sre",
    });

    expect(body).toContain("You are the current owner of this collaboration.");
    expect(body).toContain("Do not call sessions_send, sessions_spawn, subagents, or message");
    expect(body).toContain('"action":"agent_handoff"');
    expect(body).toContain('"handoffTo":"target-agent-id"');
    expect(body).toContain('"handoffReason":"一句话说明为什么交给对方"');
  });

  it("does not offer handoff instructions when the owner has reached max hops", async () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "user: @Flink-SRE @Starrocks-SRE 持续下钻后给一句结论",
        senderName: "user",
        senderOpenId: "ou_sender",
        messageId: "msg-owner-max-hop",
        hasAnyMention: true,
        groupCoAddressMode: "peer_collab",
        collaboration: {
          taskId: "task_owner_limit",
          mode: "peer_collab",
          phase: "active_collab",
          participants: ["flink-sre", "starrocks-sre"],
          currentOwner: "flink-sre",
          speakerToken: "flink-sre",
          handoffCount: 1,
          maxHops: 1,
          isCurrentOwner: true,
          allowedActions: ["agent_handoff_complete"],
        },
      },
      botOpenId: "ou_flink",
      autoMentionTargets: false,
      agentId: "flink-sre",
    });

    expect(body).toContain("You are the current owner of this collaboration.");
    expect(body).toContain("The handoff limit has been reached for this task.");
    expect(body).toContain("Finish from your own role and append exactly one hidden control block with action agent_handoff_complete.");
    expect(body).toContain("Use the findings already gathered in this task to produce the best current conclusion you can from your role.");
    expect(body).toContain("Do not defer the conclusion back to the user or ask another participant to finish it for you.");
    expect(body).not.toContain('"action":"agent_handoff"');
    expect(body).not.toContain('"handoffTo":"target-agent-id"');
  });

  it("adds natural transition guidance for peer collaboration owners who can still hand off", async () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "user: @Flink-SRE @Starrocks-SRE 你俩协作讨论什么是灵魂",
        senderName: "user",
        senderOpenId: "ou_sender",
        messageId: "msg-owner-visible-baton",
        hasAnyMention: true,
        groupCoAddressMode: "peer_collab",
        collaboration: {
          taskId: "task_owner_visible_baton",
          mode: "peer_collab",
          phase: "active_collab",
          participants: ["flink-sre", "starrocks-sre"],
          currentOwner: "flink-sre",
          speakerToken: "flink-sre",
          handoffCount: 0,
          maxHops: 3,
          isCurrentOwner: true,
          allowedActions: ["agent_handoff", "agent_handoff_complete"],
        },
      },
      botOpenId: "ou_flink",
      autoMentionTargets: false,
      agentId: "flink-sre",
    });

    expect(body).toContain(
      "Visible reply should first add one deeper point from your own role in one or two short sentences.",
    );
    expect(body).toContain(
      "If you hand off, end the visible reply with one short natural transition into the next participant's domain before the hidden control block.",
    );
    expect(body).toContain("Do not use explicit baton language");
    expect(body).toContain("After the visible transition, stop.");
  });

  it("adds natural continuation guidance for awaiting_accept targets", async () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "user: @Flink-SRE @Starrocks-SRE 你俩协作讨论什么是灵魂",
        senderName: "user",
        senderOpenId: "ou_sender",
        messageId: "msg-awaiting-accept-visible-baton",
        hasAnyMention: true,
        groupCoAddressMode: "peer_collab",
        collaboration: {
          taskId: "task_awaiting_accept_visible_baton",
          mode: "peer_collab",
          phase: "awaiting_accept",
          participants: ["flink-sre", "starrocks-sre"],
          currentOwner: "flink-sre",
          speakerToken: "flink-sre",
          handoffCount: 0,
          maxHops: 3,
          isCurrentOwner: false,
          allowedActions: [
            "agent_handoff_accept",
            "agent_handoff_reject",
            "agent_handoff_need_info",
          ],
          activeHandoff: {
            handoffId: "handoff_visible_baton",
            fromAgentId: "flink-sre",
            targetAgentId: "starrocks-sre",
            status: "awaiting_accept",
            timeWindow: "",
            currentFinding: "请从存储持久化视角补一句",
            unresolvedQuestion: "请从存储持久化视角补一句",
            evidencePaths: [],
            createdAt: Date.now(),
            lastUpdatedAt: Date.now(),
          },
        },
      },
      botOpenId: "ou_starrocks",
      autoMentionTargets: false,
      agentId: "starrocks-sre",
    });

    expect(body).toContain(
      "Visible reply should continue naturally from your own role in one or two short sentences before the hidden control block.",
    );
    expect(body).toContain("Do not explicitly say '收到接力棒'");
    expect(body).toContain("After your contribution, stop.");
    expect(body).toContain("include taskId task_awaiting_accept_visible_baton");
    expect(body).toContain("handoffId handoff_visible_baton");
  });

  it("injects collaboration max hops and handoff count into runtime context", async () => {
    botOpenIds.set("flink-sre", "ou_flink");
    botOpenIds.set("starrocks-sre", "ou_starrocks");
    botNames.set("flink-sre", "Flink-SRE");
    botNames.set("starrocks-sre", "Starrocks-SRE");
    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-user",
        },
      },
      message: {
        message_id: "msg-collab-max-hops",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({
          text: '<at user_id="ou_main">首席大管家</at> #协作(Flink-SRE,Starrocks-SRE) 你俩协作排查下',
        }),
        mentions: [
          {
            key: "@_user_1",
            id: { open_id: "ou_main" },
            name: "首席大管家",
            tenant_key: "",
          },
        ],
      },
    };
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          enabled: true,
          defaultAccount: "main",
          collaboration: {
            maxHops: 2,
          },
          accounts: {
            main: {
              enabled: true,
              appId: "app_main",
              appSecret: "secret_main",
              groupPolicy: "open",
              requireMention: false,
              renderMode: "raw",
              streaming: false,
            },
            "flink-sre": {
              enabled: true,
              appId: "app_flink",
              appSecret: "secret_flink",
              groupPolicy: "open",
              requireMention: true,
              renderMode: "raw",
              streaming: false,
            },
            "starrocks-sre": {
              enabled: true,
              appId: "app_starrocks",
              appSecret: "secret_starrocks",
              groupPolicy: "open",
              requireMention: true,
              renderMode: "raw",
              streaming: false,
            },
          },
        },
      },
      agents: {
        list: [{ id: "main" }, { id: "flink-sre" }, { id: "starrocks-sre" }],
      },
    } as ClawdbotConfig;
    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "main",
      sessionKey: "agent:main:feishu:group:oc-group",
      mainSessionKey: "agent:main:main",
      matchedBy: "explicit",
    });
    await handleFeishuMessage({
      cfg,
      event,
      accountId: "main",
      botOpenId: "ou_main",
      botName: "首席大管家",
      runtime: createRuntimeEnv(),
    });
    expect(
      mockFinalizeInboundContext.mock.calls.some(([ctx]) => {
        const payload = ctx as Record<string, string | undefined>;
        return (
          typeof payload.CollaborationTaskId === "string" &&
          payload.CollaborationRuntimeManaged === "true" &&
          payload.CollaborationHandoffCount === 0 &&
          payload.CollaborationMaxHops === 2 &&
          payload.CollaborationRecentTurns === undefined &&
          payload.CollaborationOwnLastVisibleTurn === undefined
        );
      }),
    ).toBe(true);
  });

  it("adds visible mention targets for coordinate main dispatch and specialist fan-out", async () => {
    botOpenIds.set("main", "ou_main");
    botOpenIds.set("flink-sre", "ou_flink");
    botOpenIds.set("starrocks-sre", "ou_starrocks");
    botNames.set("main", "首席大管家");
    botNames.set("flink-sre", "Flink-SRE");
    botNames.set("starrocks-sre", "Starrocks-SRE");
    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "main",
      sessionKey: "agent:main:feishu:group:oc-group",
      mainSessionKey: "agent:main:main",
      matchedBy: "explicit",
    });
    mockCreateFeishuReplyDispatcher.mockImplementation((params) => ({
      dispatcher: {
        markComplete: vi.fn(),
        waitForIdle: vi.fn(async () => {}),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      _params: params,
    }));

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          defaultAccount: "main",
          accounts: {
            main: {
              enabled: true,
              appId: "app_main",
              appSecret: "secret_main",
              requireMention: false,
              groupPolicy: "open",
            },
            "flink-sre": {
              enabled: true,
              appId: "app_flink",
              appSecret: "secret_flink",
              requireMention: true,
              groupPolicy: "open",
            },
            "starrocks-sre": {
              enabled: true,
              appId: "app_starrocks",
              appSecret: "secret_starrocks",
              requireMention: true,
              groupPolicy: "open",
            },
          },
        },
      },
      agents: {
        list: [{ id: "main" }, { id: "flink-sre" }, { id: "starrocks-sre" }],
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-user",
        },
      },
      message: {
        message_id: "msg-coordinate-visible",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({
          text: '<at user_id="ou_main">@_user_1</at> <at user_id="ou_flink">@_user_2</at> <at user_id="ou_starrocks">@_user_3</at> 帮我安排并汇总这次排查',
        }),
        mentions: [
          { key: "@_user_1", id: { open_id: "ou_main" }, name: "首席大管家", tenant_key: "" },
          { key: "@_user_2", id: { open_id: "ou_flink" }, name: "Flink-SRE", tenant_key: "" },
          { key: "@_user_3", id: { open_id: "ou_starrocks" }, name: "Starrocks-SRE", tenant_key: "" },
        ],
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      accountId: "main",
      botOpenId: "ou_main",
      botName: "首席大管家",
      runtime: createRuntimeEnv(),
    });

    const dispatcherParams = mockCreateFeishuReplyDispatcher.mock.calls.map((call) => call[0]);
    const mainParams = dispatcherParams.find((value) => value?.agentId === "main");
    const flinkParams = dispatcherParams.find((value) => value?.agentId === "flink-sre");
    const starrocksParams = dispatcherParams.find((value) => value?.agentId === "starrocks-sre");

    expect(mainParams.visibleMentionTargets).toEqual([
      expect.objectContaining({ openId: "ou_flink", name: "Flink-SRE" }),
      expect.objectContaining({ openId: "ou_starrocks", name: "Starrocks-SRE" }),
    ]);
    expect(flinkParams.visibleMentionTargets).toEqual([
      expect.objectContaining({ openId: "ou_main", name: "首席大管家" }),
    ]);
    expect(starrocksParams.visibleMentionTargets).toEqual([
      expect.objectContaining({ openId: "ou_main", name: "首席大管家" }),
    ]);
    const collaborationSessionKeys = mockFinalizeInboundContext.mock.calls
      .map((call: unknown[]) => call[0] as { SessionKey?: string; CollaborationTaskId?: string })
      .filter((ctx) => typeof ctx.CollaborationTaskId === "string");
    expect(collaborationSessionKeys.length).toBeGreaterThan(0);
    for (const ctx of collaborationSessionKeys) {
      expect(ctx.SessionKey).toContain(`:task:${ctx.CollaborationTaskId}`);
    }
  });

  it("fans out coordinator-only collective direct-reply requests to all internal participants", async () => {
    botOpenIds.set("main", "ou_main");
    botOpenIds.set("coder", "ou_coder");
    botOpenIds.set("starrocks-sre", "ou_starrocks");
    botNames.set("main", "首席大管家");
    botNames.set("coder", "SoulCoder");
    botNames.set("starrocks-sre", "Starrocks-SRE");
    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "main",
      sessionKey: "agent:main:feishu:group:oc-group",
      mainSessionKey: "agent:main:main",
      matchedBy: "explicit",
    });
    mockCreateFeishuReplyDispatcher.mockImplementation((params) => ({
      dispatcher: {
        markComplete: vi.fn(),
        waitForIdle: vi.fn(async () => {}),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      _params: params,
    }));

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          defaultAccount: "main",
          accounts: {
            main: {
              enabled: true,
              appId: "app_main",
              appSecret: "secret_main",
              requireMention: false,
              groupPolicy: "open",
              renderMode: "raw",
              streaming: false,
            },
            coder: {
              enabled: true,
              appId: "app_coder",
              appSecret: "secret_coder",
              requireMention: true,
              groupPolicy: "open",
              renderMode: "raw",
              streaming: false,
              name: "SoulCoder",
            },
            "starrocks-sre": {
              enabled: true,
              appId: "app_starrocks",
              appSecret: "secret_starrocks",
              requireMention: true,
              groupPolicy: "open",
              renderMode: "raw",
              streaming: false,
              name: "Starrocks-SRE",
            },
          },
        },
      },
      agents: {
        list: [{ id: "main", name: "首席大管家" }, { id: "coder", name: "SoulCoder" }, { id: "starrocks-sre", name: "Starrocks-SRE" }],
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-user",
        },
      },
      message: {
        message_id: "msg-coordinator-collective-intro",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({
          text: '<at user_id="ou_main">首席大管家</at> 让大家互相介绍下',
        }),
        mentions: [{ key: "@_user_1", id: { open_id: "ou_main" }, name: "首席大管家", tenant_key: "" }],
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      accountId: "main",
      botOpenId: "ou_main",
      botName: "首席大管家",
      runtime: createRuntimeEnv(),
    });

    const directReplyCalls = mockDispatchReplyFromConfig.mock.calls.map(
      (call) => call[0] as { ctx: Record<string, string> },
    );
    expect(directReplyCalls).toHaveLength(3);
    expect(directReplyCalls.map((call) => call.ctx.AccountId)).toEqual([
      "coder",
      "starrocks-sre",
      "main",
    ]);
    expect(directReplyCalls.map((call) => call.ctx.MessageSid)).toEqual([
      "msg-coordinator-collective-intro::direct-reply::coder",
      "msg-coordinator-collective-intro::direct-reply::starrocks-sre",
      "msg-coordinator-collective-intro",
    ]);
    expect(directReplyCalls.map((call) => call.ctx.GroupCoAddressScope)).toEqual([
      "all_internal",
      "all_internal",
      "all_internal",
    ]);
  });

  it("fans out coordinator-only collective discussion requests into peer collaboration", async () => {
    botOpenIds.set("main", "ou_main");
    botOpenIds.set("coder", "ou_coder");
    botOpenIds.set("starrocks-sre", "ou_starrocks");
    botNames.set("main", "首席大管家");
    botNames.set("coder", "SoulCoder");
    botNames.set("starrocks-sre", "Starrocks-SRE");
    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "main",
      sessionKey: "agent:main:feishu:group:oc-group",
      mainSessionKey: "agent:main:main",
      matchedBy: "explicit",
    });
    mockCreateFeishuReplyDispatcher.mockImplementation((params) => ({
      dispatcher: {
        markComplete: vi.fn(),
        waitForIdle: vi.fn(async () => {}),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      _params: params,
    }));

    let dispatchCount = 0;
    mockDispatchReplyFromConfig.mockImplementation(async ({ ctx }: { ctx: Record<string, string> }) => {
      dispatchCount += 1;
      if (dispatchCount === 1) {
        applyCollaborationActions([
          {
            action: "collab_assess",
            taskId: ctx.CollaborationTaskId,
            agentId: "main",
            ownershipClaim: "supporting",
            currentFinding: "先给一个协调视角判断",
            nextCheck: "等待其他参与者补充",
            needsWorker: false,
          },
        ]);
      } else if (dispatchCount === 2) {
        applyCollaborationActions([
          {
            action: "collab_assess",
            taskId: ctx.CollaborationTaskId,
            agentId: "coder",
            ownershipClaim: "owner_candidate",
            currentFinding: "从 SoulCoder 角度先补一层判断",
            nextCheck: "继续补充灵魂的工程含义",
            needsWorker: false,
          },
        ]);
      } else if (dispatchCount === 3) {
        applyCollaborationActions([
          {
            action: "collab_assess",
            taskId: ctx.CollaborationTaskId,
            agentId: "starrocks-sre",
            ownershipClaim: "supporting",
            currentFinding: "从存储和持久化角度补一层",
            nextCheck: "等待 owner 继续",
            needsWorker: false,
          },
        ]);
      }
      return { queuedFinal: false, counts: { final: 1 } };
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          defaultAccount: "main",
          accounts: {
            main: {
              enabled: true,
              appId: "app_main",
              appSecret: "secret_main",
              requireMention: false,
              groupPolicy: "open",
              renderMode: "raw",
              streaming: false,
            },
            coder: {
              enabled: true,
              appId: "app_coder",
              appSecret: "secret_coder",
              requireMention: true,
              groupPolicy: "open",
              renderMode: "raw",
              streaming: false,
              name: "SoulCoder",
            },
            "starrocks-sre": {
              enabled: true,
              appId: "app_starrocks",
              appSecret: "secret_starrocks",
              requireMention: true,
              groupPolicy: "open",
              renderMode: "raw",
              streaming: false,
              name: "Starrocks-SRE",
            },
          },
        },
      },
      agents: {
        list: [{ id: "main", name: "首席大管家" }, { id: "coder", name: "SoulCoder" }, { id: "starrocks-sre", name: "Starrocks-SRE" }],
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-user",
        },
      },
      message: {
        message_id: "msg-coordinator-collective-discussion",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({
          text: '<at user_id="ou_main">首席大管家</at> 让大家讨论下什么是灵魂',
        }),
        mentions: [{ key: "@_user_1", id: { open_id: "ou_main" }, name: "首席大管家", tenant_key: "" }],
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      accountId: "main",
      botOpenId: "ou_main",
      botName: "首席大管家",
      runtime: createRuntimeEnv(),
    });

    const collaborationCalls = mockDispatchReplyFromConfig.mock.calls.map(
      (call) => call[0] as { ctx: Record<string, string> },
    );
    expect(collaborationCalls[0]?.ctx).toEqual(
      expect.objectContaining({
        AccountId: "main",
        MessageSid: "msg-coordinator-collective-discussion",
        CollaborationMode: "peer_collab",
        GroupCoAddressScope: "all_internal",
      }),
    );
    const peerInitCalls = collaborationCalls.filter((call) =>
      call.ctx.MessageSid?.includes("::peer-init::"),
    );
    expect(peerInitCalls.map((call) => call.ctx.AccountId).sort()).toEqual([
      "coder",
      "starrocks-sre",
    ]);
    expect(peerInitCalls.map((call) => call.ctx.GroupCoAddressScope)).toEqual([
      "all_internal",
      "all_internal",
    ]);
    const ownerCalls = collaborationCalls.filter((call) => call.ctx.MessageSid?.includes("::owner::"));
    expect(ownerCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("fans out coordinator-only collective summary requests into coordinate", async () => {
    botOpenIds.set("main", "ou_main");
    botOpenIds.set("coder", "ou_coder");
    botOpenIds.set("starrocks-sre", "ou_starrocks");
    botNames.set("main", "首席大管家");
    botNames.set("coder", "SoulCoder");
    botNames.set("starrocks-sre", "Starrocks-SRE");
    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "main",
      sessionKey: "agent:main:feishu:group:oc-group",
      mainSessionKey: "agent:main:main",
      matchedBy: "explicit",
    });
    mockCreateFeishuReplyDispatcher.mockImplementation((params) => ({
      dispatcher: {
        markComplete: vi.fn(),
        waitForIdle: vi.fn(async () => {}),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      _params: params,
    }));
    mockDispatchReplyFromConfig.mockImplementation(async ({ ctx }: { ctx: Record<string, string> }) => {
      if (ctx.AccountId === "coder" || ctx.AccountId === "starrocks-sre") {
        applyCollaborationActions([
          {
            action: "collab_report_complete",
            taskId: ctx.CollaborationTaskId,
            agentId: ctx.AccountId,
          },
        ]);
      }
      return { queuedFinal: false, counts: { final: 1 } };
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          defaultAccount: "main",
          accounts: {
            main: {
              enabled: true,
              appId: "app_main",
              appSecret: "secret_main",
              requireMention: false,
              groupPolicy: "open",
              renderMode: "raw",
              streaming: false,
            },
            coder: {
              enabled: true,
              appId: "app_coder",
              appSecret: "secret_coder",
              requireMention: true,
              groupPolicy: "open",
              renderMode: "raw",
              streaming: false,
              name: "SoulCoder",
            },
            "starrocks-sre": {
              enabled: true,
              appId: "app_starrocks",
              appSecret: "secret_starrocks",
              requireMention: true,
              groupPolicy: "open",
              renderMode: "raw",
              streaming: false,
              name: "Starrocks-SRE",
            },
          },
        },
      },
      agents: {
        list: [{ id: "main", name: "首席大管家" }, { id: "coder", name: "SoulCoder" }, { id: "starrocks-sre", name: "Starrocks-SRE" }],
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-user",
        },
      },
      message: {
        message_id: "msg-coordinator-collective-summary",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({
          text: '<at user_id="ou_main">首席大管家</at> 让大家先看，最后给我一个结论',
        }),
        mentions: [{ key: "@_user_1", id: { open_id: "ou_main" }, name: "首席大管家", tenant_key: "" }],
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      accountId: "main",
      botOpenId: "ou_main",
      botName: "首席大管家",
      runtime: createRuntimeEnv(),
    });

    const coordinateCalls = mockDispatchReplyFromConfig.mock.calls.map(
      (call) => call[0] as { ctx: Record<string, string> },
    );
    expect(coordinateCalls[0]?.ctx).toEqual(
      expect.objectContaining({
        AccountId: "main",
        MessageSid: "msg-coordinator-collective-summary",
        CollaborationMode: "coordinate",
        GroupCoAddressScope: "all_internal",
      }),
    );
    const specialistCalls = coordinateCalls
      .filter((call) => call.ctx.MessageSid?.includes("::coordinate::"))
      .map((call) => call.ctx)
      .sort((a, b) => String(a.AccountId).localeCompare(String(b.AccountId)));
    expect(specialistCalls).toEqual([
      expect.objectContaining({
        AccountId: "coder",
        CollaborationMode: "coordinate",
        GroupCoAddressScope: "all_internal",
      }),
      expect.objectContaining({
        AccountId: "starrocks-sre",
        CollaborationMode: "coordinate",
        GroupCoAddressScope: "all_internal",
      }),
    ]);
    expect(coordinateCalls.at(-1)?.ctx).toEqual(
      expect.objectContaining({
        AccountId: "main",
        MessageSid: expect.stringContaining("::coordinate-summary::"),
        CollaborationMode: "coordinate",
        GroupCoAddressScope: "all_internal",
      }),
    );
  });

  it("keeps coordinator-only collective discussion follow-ups scoped to active thread participants", async () => {
    botOpenIds.set("main", "ou_main");
    botOpenIds.set("coder", "ou_coder");
    botOpenIds.set("flink-sre", "ou_flink");
    botOpenIds.set("starrocks-sre", "ou_starrocks");
    botNames.set("main", "首席大管家");
    botNames.set("coder", "SoulCoder");
    botNames.set("flink-sre", "Flink-SRE");
    botNames.set("starrocks-sre", "Starrocks-SRE");
    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "main",
      sessionKey: "agent:main:feishu:group:oc-group",
      mainSessionKey: "agent:main:main",
      matchedBy: "explicit",
    });
    mockCreateFeishuReplyDispatcher.mockImplementation((params) => ({
      dispatcher: {
        markComplete: vi.fn(),
        waitForIdle: vi.fn(async () => {}),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      _params: params,
    }));
    mockDispatchReplyFromConfig.mockResolvedValue({ queuedFinal: false, counts: { final: 1 } });

    const seedEvent: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-user",
        },
      },
      message: {
        message_id: "msg-thread-scope-seed",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om-thread-scope-root",
        thread_id: "om-thread-scope-root",
        message_type: "text",
        content: JSON.stringify({
          text: '<at user_id="ou_coder">SoulCoder</at> <at user_id="ou_flink">Flink-SRE</at> 你俩讨论一下这个问题',
        }),
        mentions: [
          { key: "@_user_1", name: "SoulCoder", id: { open_id: "ou_coder" } },
          { key: "@_user_2", name: "Flink-SRE", id: { open_id: "ou_flink" } },
        ],
      },
    };
    const seededState = resolveCollaborationStateForMessage({
      event: seedEvent,
      mode: "peer_collab",
      participants: ["coder", "flink-sre"],
      maxHops: 3,
      coordinatorAccountId: "main",
    });
    applyCollaborationActions([
      {
        action: "collab_assess",
        taskId: seededState.taskId,
        agentId: "coder",
        ownershipClaim: "owner_candidate",
        currentFinding: "从 coder 角度给第一层判断",
        nextCheck: "等待其他人补充",
        needsWorker: false,
      },
      {
        action: "collab_assess",
        taskId: seededState.taskId,
        agentId: "flink-sre",
        ownershipClaim: "supporting",
        currentFinding: "从 flink 角度补充一层",
        nextCheck: "等待 owner 继续",
        needsWorker: false,
      },
    ]);

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-user",
        },
      },
      message: {
        message_id: "msg-thread-scope-followup",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om-thread-scope-root",
        thread_id: "om-thread-scope-root",
        message_type: "text",
        content: JSON.stringify({
          text: '<at user_id="ou_main">首席大管家</at> 让大家继续讨论下这个点',
        }),
        mentions: [{ key: "@_user_1", name: "首席大管家", id: { open_id: "ou_main" } }],
      },
    };

    await handleFeishuMessage({
      cfg: {
        channels: {
          feishu: {
            defaultAccount: "main",
            accounts: {
              main: {
                enabled: true,
                appId: "app_main",
                appSecret: "secret_main",
                requireMention: false,
                groupPolicy: "open",
                renderMode: "raw",
                streaming: false,
              },
              coder: {
                enabled: true,
                appId: "app_coder",
                appSecret: "secret_coder",
                requireMention: true,
                groupPolicy: "open",
                renderMode: "raw",
                streaming: false,
                name: "SoulCoder",
              },
              "flink-sre": {
                enabled: true,
                appId: "app_flink",
                appSecret: "secret_flink",
                requireMention: true,
                groupPolicy: "open",
                renderMode: "raw",
                streaming: false,
                name: "Flink-SRE",
              },
              "starrocks-sre": {
                enabled: true,
                appId: "app_starrocks",
                appSecret: "secret_starrocks",
                requireMention: true,
                groupPolicy: "open",
                renderMode: "raw",
                streaming: false,
                name: "Starrocks-SRE",
              },
            },
          },
        },
        agents: {
          list: [
            { id: "main", name: "首席大管家" },
            { id: "coder", name: "SoulCoder" },
            { id: "flink-sre", name: "Flink-SRE" },
            { id: "starrocks-sre", name: "Starrocks-SRE" },
          ],
        },
      } as ClawdbotConfig,
      event,
      accountId: "main",
      botOpenId: "ou_main",
      botName: "首席大管家",
      runtime: createRuntimeEnv(),
    });

    const calls = mockDispatchReplyFromConfig.mock.calls.map(
      (call) => call[0] as { ctx: Record<string, string> },
    );
    expect(calls[0]?.ctx).toEqual(
      expect.objectContaining({
        AccountId: "main",
        GroupCoAddressScope: "active_thread",
        CollaborationMode: "peer_collab",
      }),
    );
    const dispatchedAccounts = [...new Set(calls.map((call) => call.ctx.AccountId))].sort();
    expect(dispatchedAccounts).toEqual(["coder", "flink-sre", "main"]);
    const peerInitCalls = calls.filter((call) => call.ctx.MessageSid?.includes("::peer-init::"));
    expect(peerInitCalls.map((call) => call.ctx.GroupCoAddressScope)).toEqual([
      "active_thread",
      "active_thread",
    ]);
    expect(dispatchedAccounts).not.toContain("starrocks-sre");
  });

  it("preserves display-only visible mentions for single-agent group replies with other mentioned entities", async () => {
    botOpenIds.set("starrocks-sre", "ou_starrocks_self");
    mockResolveAgentRoute.mockReturnValue({
      agentId: "starrocks-sre",
      channel: "feishu",
      accountId: "starrocks-sre",
      sessionKey: "agent:starrocks-sre:feishu:group:oc-group",
      mainSessionKey: "agent:main:main",
      matchedBy: "explicit",
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          accounts: {
            "starrocks-sre": {
              enabled: true,
              appId: "app_starrocks",
              appSecret: "secret_starrocks",
              requireMention: true,
              groupPolicy: "open",
            },
          },
        },
      },
      agents: {
        list: [{ id: "starrocks-sre" }],
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-user",
        },
      },
      message: {
        message_id: "msg-single-visible-mention",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({
          text: '<at user_id="ou_starrocks_self">@_user_1</at> <at user_id="ou_other_bot_view">@_user_2</at> 你俩辩论下，明天会更好吗？',
        }),
        mentions: [
          {
            key: "@_user_1",
            id: { open_id: "ou_starrocks_self" },
            name: "Starrocks-SRE",
            tenant_key: "",
          },
          {
            key: "@_user_2",
            id: { open_id: "ou_other_bot_view" },
            name: "SoulCoder",
            tenant_key: "",
          },
        ],
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      accountId: "starrocks-sre",
      botOpenId: "ou_starrocks_self",
      botName: "Starrocks-SRE",
      runtime: createRuntimeEnv(),
    });

    const dispatcherParams = mockCreateFeishuReplyDispatcher.mock.calls.at(-1)?.[0];
    expect(dispatcherParams.visibleMentionTargets).toEqual([
      expect.objectContaining({
        openId: "ou_other_bot_view",
        name: "SoulCoder",
      }),
    ]);
  });

  it("uses authorizer resolution instead of hardcoded CommandAuthorized=true", async () => {
    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          dmPolicy: "open",
          allowFrom: ["ou-admin"],
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-auth-bypass-regression",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "/status" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveCommandAuthorizedFromAuthorizers).toHaveBeenCalledWith({
      useAccessGroups: true,
      authorizers: [{ configured: true, allowed: false }],
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledTimes(1);
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        CommandAuthorized: false,
        SenderId: "ou-attacker",
        Surface: "feishu",
      }),
    );
  });

  it("reads pairing allow store for non-command DMs when dmPolicy is pairing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadAllowFromStore.mockResolvedValue(["ou-attacker"]);

    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-read-store-non-command",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello there" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockReadAllowFromStore).toHaveBeenCalledWith({
      channel: "feishu",
      accountId: "default",
    });
    expect(mockResolveCommandAuthorizedFromAuthorizers).not.toHaveBeenCalled();
    expect(mockFinalizeInboundContext).toHaveBeenCalledTimes(1);
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("skips sender-name lookup when resolveSenderNames is false", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
          allowFrom: ["*"],
          resolveSenderNames: false,
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-skip-sender-lookup",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuClient).not.toHaveBeenCalled();
  });

  it("propagates parent/root message ids into inbound context for reply reconstruction", async () => {
    mockGetMessageFeishu.mockResolvedValueOnce({
      messageId: "om_parent_001",
      chatId: "oc-group",
      content: "quoted content",
      contentType: "text",
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          enabled: true,
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-replier",
        },
      },
      message: {
        message_id: "om_reply_001",
        root_id: "om_root_001",
        parent_id: "om_parent_001",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "reply text" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ReplyToId: "om_parent_001",
        RootMessageId: "om_root_001",
        ReplyToBody: "quoted content",
      }),
    );
  });

  it("replies pairing challenge to DM chat_id instead of user:sender id", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "pairing",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          user_id: "u_mobile_only",
        },
      },
      message: {
        message_id: "msg-pairing-chat-reply",
        chat_id: "oc_dm_chat_1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "ABCDEFGH", created: true });

    await dispatchMessage({ cfg, event });

    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc_dm_chat_1",
      }),
    );
  });
  it("creates pairing request and drops unauthorized DMs in pairing mode", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "ABCDEFGH", created: true });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-unapproved",
        },
      },
      message: {
        message_id: "msg-pairing-flow",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockUpsertPairingRequest).toHaveBeenCalledWith({
      channel: "feishu",
      accountId: "default",
      id: "ou-unapproved",
      meta: { name: undefined },
    });
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc-dm",
        text: expect.stringContaining("Your Feishu user id: ou-unapproved"),
        accountId: "default",
      }),
    );
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc-dm",
        text: expect.stringContaining("Pairing code: ABCDEFGH"),
        accountId: "default",
      }),
    );
    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("computes group command authorization from group allowFrom", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-group-command-auth",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "/status" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveCommandAuthorizedFromAuthorizers).toHaveBeenCalledWith({
      useAccessGroups: true,
      authorizers: [{ configured: false, allowed: false }],
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ChatType: "group",
        CommandAuthorized: false,
        SenderId: "ou-attacker",
      }),
    );
  });

  it("normalizes group mention-prefixed slash commands before command-auth probing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-group-mention-command-probe",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1/model" }),
        mentions: [{ key: "@_user_1", id: { open_id: "ou-bot" }, name: "Bot", tenant_key: "" }],
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockShouldComputeCommandAuthorized).toHaveBeenCalledWith("/model", cfg);
  });

  it("falls back to top-level allowFrom for group command authorization", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(true);

    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          allowFrom: ["ou-admin"],
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-admin",
        },
      },
      message: {
        message_id: "msg-group-command-fallback",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "/status" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveCommandAuthorizedFromAuthorizers).toHaveBeenCalledWith({
      useAccessGroups: true,
      authorizers: [{ configured: true, allowed: true }],
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ChatType: "group",
        CommandAuthorized: true,
        SenderId: "ou-admin",
      }),
    );
  });

  it("allows group sender when global groupSenderAllowFrom includes sender", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          groupSenderAllowFrom: ["ou-allowed"],
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-allowed",
        },
      },
      message: {
        message_id: "msg-global-group-sender-allow",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ChatType: "group",
        SenderId: "ou-allowed",
      }),
    );
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("blocks group sender when global groupSenderAllowFrom excludes sender", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          groupSenderAllowFrom: ["ou-allowed"],
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-blocked",
        },
      },
      message: {
        message_id: "msg-global-group-sender-block",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("prefers per-group allowFrom over global groupSenderAllowFrom", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          groupSenderAllowFrom: ["ou-global"],
          groups: {
            "oc-group": {
              allowFrom: ["ou-group-only"],
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-global",
        },
      },
      message: {
        message_id: "msg-per-group-precedence",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("drops message when groupConfig.enabled is false", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-disabled-group": {
              enabled: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: { open_id: "ou-sender" },
      },
      message: {
        message_id: "msg-disabled-group",
        chat_id: "oc-disabled-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("uses video file_key (not thumbnail image_key) for inbound video download", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-video-inbound",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "video",
        content: JSON.stringify({
          file_key: "file_video_payload",
          image_key: "img_thumb_payload",
          file_name: "clip.mp4",
        }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-video-inbound",
        fileKey: "file_video_payload",
        type: "file",
      }),
    );
    expect(mockSaveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      expect.any(Number),
      "clip.mp4",
    );
  });

  it("uses media message_type file_key (not thumbnail image_key) for inbound mobile video download", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-media-inbound",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "media",
        content: JSON.stringify({
          file_key: "file_media_payload",
          image_key: "img_media_thumb",
          file_name: "mobile.mp4",
        }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-media-inbound",
        fileKey: "file_media_payload",
        type: "file",
      }),
    );
    expect(mockSaveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      expect.any(Number),
      "clip.mp4",
    );
  });

  it("downloads embedded media tags from post messages as files", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-post-media",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "post",
        content: JSON.stringify({
          title: "Rich text",
          content: [
            [
              {
                tag: "media",
                file_key: "file_post_media_payload",
                file_name: "embedded.mov",
              },
            ],
          ],
        }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-post-media",
        fileKey: "file_post_media_payload",
        type: "file",
      }),
    );
    expect(mockSaveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      expect.any(Number),
    );
  });

  it("includes message_id in BodyForAgent on its own line", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-msgid",
        },
      },
      message: {
        message_id: "msg-message-id-line",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: "[message_id: msg-message-id-line]\nou-msgid: hello",
      }),
    );
  });

  it("expands merge_forward content from API sub-messages", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    const mockGetMerged = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            message_id: "container",
            msg_type: "merge_forward",
            body: { content: JSON.stringify({ text: "Merged and Forwarded Message" }) },
          },
          {
            message_id: "sub-2",
            upper_message_id: "container",
            msg_type: "file",
            body: { content: JSON.stringify({ file_name: "report.pdf" }) },
            create_time: "2000",
          },
          {
            message_id: "sub-1",
            upper_message_id: "container",
            msg_type: "text",
            body: { content: JSON.stringify({ text: "alpha" }) },
            create_time: "1000",
          },
        ],
      },
    });
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
      im: {
        message: {
          get: mockGetMerged,
        },
      },
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-merge",
        },
      },
      message: {
        message_id: "msg-merge-forward",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "merge_forward",
        content: JSON.stringify({ text: "Merged and Forwarded Message" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockGetMerged).toHaveBeenCalledWith({
      path: { message_id: "msg-merge-forward" },
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining(
          "[Merged and Forwarded Messages]\n- alpha\n- [File: report.pdf]",
        ),
      }),
    );
  });

  it("falls back when merge_forward API returns no sub-messages", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
      im: {
        message: {
          get: vi.fn().mockResolvedValue({ code: 0, data: { items: [] } }),
        },
      },
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-merge-empty",
        },
      },
      message: {
        message_id: "msg-merge-empty",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "merge_forward",
        content: JSON.stringify({ text: "Merged and Forwarded Message" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining("[Merged and Forwarded Message - could not fetch]"),
      }),
    );
  });

  it("dispatches once and appends permission notice to the main agent body", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockRejectedValue({
            response: {
              data: {
                code: 99991672,
                msg: "permission denied https://open.feishu.cn/app/cli_test",
              },
            },
          }),
        },
      },
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "sec_test", // pragma: allowlist secret
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-perm",
        },
      },
      message: {
        message_id: "msg-perm-1",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello group" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining(
          "Permission grant URL: https://open.feishu.cn/app/cli_test",
        ),
      }),
    );
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining("ou-perm: hello group"),
      }),
    );
  });

  it("ignores stale non-existent contact scope permission errors", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockRejectedValue({
            response: {
              data: {
                code: 99991672,
                msg: "permission denied: contact:contact.base:readonly https://open.feishu.cn/app/cli_scope_bug",
              },
            },
          }),
        },
      },
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          appId: "cli_scope_bug",
          appSecret: "sec_scope_bug", // pragma: allowlist secret
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-perm-scope",
        },
      },
      message: {
        message_id: "msg-perm-scope-1",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello group" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.not.stringContaining("Permission grant URL"),
      }),
    );
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining("ou-perm-scope: hello group"),
      }),
    );
  });

  it("routes group sessions by sender when groupSessionScope=group_sender", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-scope-user" } },
      message: {
        message_id: "msg-scope-group-sender",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "group sender scope" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:sender:ou-scope-user" },
        parentPeer: null,
      }),
    );
  });

  it("routes topic sessions and parentPeer when groupSessionScope=group_topic_sender", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "msg-scope-topic-sender",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om_root_topic",
        message_type: "text",
        content: JSON.stringify({ text: "topic sender scope" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:om_root_topic:sender:ou-topic-user" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("keeps root_id as topic key when root_id and thread_id both exist", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "msg-scope-topic-thread-id",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om_root_topic",
        thread_id: "omt_topic_1",
        message_type: "text",
        content: JSON.stringify({ text: "topic sender scope" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:om_root_topic:sender:ou-topic-user" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("uses thread_id as topic key when root_id is missing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "msg-scope-topic-thread-only",
        chat_id: "oc-group",
        chat_type: "group",
        thread_id: "omt_topic_1",
        message_type: "text",
        content: JSON.stringify({ text: "topic sender scope" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:omt_topic_1:sender:ou-topic-user" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("maps legacy topicSessionMode=enabled to group_topic routing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          topicSessionMode: "enabled",
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-legacy" } },
      message: {
        message_id: "msg-legacy-topic-mode",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om_root_legacy",
        message_type: "text",
        content: JSON.stringify({ text: "legacy topic mode" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:om_root_legacy" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("maps legacy topicSessionMode=enabled to root_id when both root_id and thread_id exist", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          topicSessionMode: "enabled",
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-legacy-thread-id" } },
      message: {
        message_id: "msg-legacy-topic-thread-id",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om_root_legacy",
        thread_id: "omt_topic_legacy",
        message_type: "text",
        content: JSON.stringify({ text: "legacy topic mode" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:om_root_legacy" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("uses message_id as topic root when group_topic + replyInThread and no root_id", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic",
              replyInThread: "enabled",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-init" } },
      message: {
        message_id: "msg-new-topic-root",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "create topic" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:msg-new-topic-root" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("keeps topic session key stable after first turn creates a thread", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic",
              replyInThread: "enabled",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const firstTurn: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-init" } },
      message: {
        message_id: "msg-topic-first",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "create topic" }),
      },
    };
    const secondTurn: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-init" } },
      message: {
        message_id: "msg-topic-second",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "msg-topic-first",
        thread_id: "omt_topic_created",
        message_type: "text",
        content: JSON.stringify({ text: "follow up in same topic" }),
      },
    };

    await dispatchMessage({ cfg, event: firstTurn });
    await dispatchMessage({ cfg, event: secondTurn });

    expect(mockResolveAgentRoute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:msg-topic-first" },
      }),
    );
    expect(mockResolveAgentRoute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:msg-topic-first" },
      }),
    );
  });

  it("replies to the topic root when handling a message inside an existing topic", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              replyInThread: "enabled",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "om_child_message",
        root_id: "om_root_topic",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "reply inside topic" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_root_topic",
        rootId: "om_root_topic",
      }),
    );
  });

  it("replies to triggering message in normal group even when root_id is present (#32980)", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-normal-user" } },
      message: {
        message_id: "om_quote_reply",
        root_id: "om_original_msg",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello in normal group" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_quote_reply",
        rootId: "om_original_msg",
      }),
    );
  });

  it("replies to topic root in topic-mode group with root_id", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "om_topic_reply",
        root_id: "om_topic_root",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello in topic group" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_topic_root",
        rootId: "om_topic_root",
      }),
    );
  });

  it("replies to topic root in topic-sender group with root_id", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-sender-user" } },
      message: {
        message_id: "om_topic_sender_reply",
        root_id: "om_topic_sender_root",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello in topic sender group" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_topic_sender_root",
        rootId: "om_topic_sender_root",
      }),
    );
  });

  it("forces thread replies when inbound message contains thread_id", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group",
              replyInThread: "disabled",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-thread-reply" } },
      message: {
        message_id: "msg-thread-reply",
        chat_id: "oc-group",
        chat_type: "group",
        thread_id: "omt_topic_thread_reply",
        message_type: "text",
        content: JSON.stringify({ text: "thread content" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyInThread: true,
        threadReply: true,
      }),
    );
  });

  it("does not dispatch twice for the same image message_id (concurrent dedupe)", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-image-dedup",
        },
      },
      message: {
        message_id: "msg-image-dedup",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({
          image_key: "img_dedup_payload",
        }),
      },
    };

    await Promise.all([dispatchMessage({ cfg, event }), dispatchMessage({ cfg, event })]);
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });
});

describe("toMessageResourceType", () => {
  it("maps image to image", () => {
    expect(toMessageResourceType("image")).toBe("image");
  });

  it("maps audio to file", () => {
    expect(toMessageResourceType("audio")).toBe("file");
  });

  it("maps video/file/sticker to file", () => {
    expect(toMessageResourceType("video")).toBe("file");
    expect(toMessageResourceType("file")).toBe("file");
    expect(toMessageResourceType("sticker")).toBe("file");
  });
});

describe("resolveBroadcastAgents", () => {
  it("returns agent list when broadcast config has the peerId", () => {
    const cfg = { broadcast: { oc_group123: ["susan", "main"] } } as unknown as ClawdbotConfig;
    expect(resolveBroadcastAgents(cfg, "oc_group123")).toEqual(["susan", "main"]);
  });

  it("returns null when no broadcast config", () => {
    const cfg = {} as ClawdbotConfig;
    expect(resolveBroadcastAgents(cfg, "oc_group123")).toBeNull();
  });

  it("returns null when peerId not in broadcast", () => {
    const cfg = { broadcast: { oc_other: ["susan"] } } as unknown as ClawdbotConfig;
    expect(resolveBroadcastAgents(cfg, "oc_group123")).toBeNull();
  });

  it("returns null when agent list is empty", () => {
    const cfg = { broadcast: { oc_group123: [] } } as unknown as ClawdbotConfig;
    expect(resolveBroadcastAgents(cfg, "oc_group123")).toBeNull();
  });
});

describe("buildBroadcastSessionKey", () => {
  it("replaces agent ID prefix in session key", () => {
    expect(buildBroadcastSessionKey("agent:main:feishu:group:oc_group123", "main", "susan")).toBe(
      "agent:susan:feishu:group:oc_group123",
    );
  });

  it("handles compound peer IDs", () => {
    expect(
      buildBroadcastSessionKey(
        "agent:main:feishu:group:oc_group123:sender:ou_user1",
        "main",
        "susan",
      ),
    ).toBe("agent:susan:feishu:group:oc_group123:sender:ou_user1");
  });

  it("returns base key unchanged when prefix does not match", () => {
    expect(buildBroadcastSessionKey("custom:key:format", "main", "susan")).toBe(
      "custom:key:format",
    );
  });
});

describe("broadcast dispatch", () => {
  const mockFinalizeInboundContext = vi.fn((ctx: unknown) => ctx);
  const mockDispatchReplyFromConfig = vi
    .fn()
    .mockResolvedValue({ queuedFinal: false, counts: { final: 1 } });
  const mockWithReplyDispatcher = vi.fn(
    async ({
      dispatcher,
      run,
      onSettled,
    }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
      try {
        return await run();
      } finally {
        dispatcher.markComplete();
        try {
          await dispatcher.waitForIdle();
        } finally {
          await onSettled?.();
        }
      }
    },
  );
  const mockShouldComputeCommandAuthorized = vi.fn(() => false);
  const mockSaveMediaBuffer = vi.fn().mockResolvedValue({
    path: "/tmp/inbound-clip.mp4",
    contentType: "video/mp4",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "default",
      sessionKey: "agent:main:feishu:group:oc-broadcast-group",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    });
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
    });
    setFeishuRuntime({
      system: {
        enqueueSystemEvent: vi.fn(),
      },
      channel: {
        routing: {
          resolveAgentRoute: mockResolveAgentRoute,
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({ template: "channel+name+time" })),
          formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
          finalizeInboundContext: mockFinalizeInboundContext,
          dispatchReplyFromConfig: mockDispatchReplyFromConfig,
          withReplyDispatcher: mockWithReplyDispatcher,
        },
        commands: {
          shouldComputeCommandAuthorized: mockShouldComputeCommandAuthorized,
          resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
        },
        media: {
          saveMediaBuffer: mockSaveMediaBuffer,
        },
        pairing: {
          readAllowFromStore: vi.fn().mockResolvedValue([]),
          upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
          buildPairingReply: vi.fn(() => "Pairing response"),
        },
      },
      media: {
        detectMime: vi.fn(async () => "application/octet-stream"),
      },
    } as unknown as PluginRuntime);
  });

  it("dispatches to all broadcast agents when bot is mentioned", async () => {
    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["susan", "main"] },
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: true,
            },
          },
        },
      },
    } as unknown as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-broadcast-mentioned",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello @bot" }),
        mentions: [
          { key: "@_user_1", id: { open_id: "bot-open-id" }, name: "Bot", tenant_key: "" },
        ],
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });

    // Both agents should get dispatched
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(2);

    // Verify session keys for both agents
    const sessionKeys = mockFinalizeInboundContext.mock.calls.map(
      (call: unknown[]) => (call[0] as { SessionKey: string }).SessionKey,
    );
    expect(sessionKeys).toContain("agent:susan:feishu:group:oc-broadcast-group");
    expect(sessionKeys).toContain("agent:main:feishu:group:oc-broadcast-group");

    // Active agent (mentioned) gets the real Feishu reply dispatcher
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledTimes(1);
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main" }),
    );
  });

  it("skips broadcast dispatch when bot is NOT mentioned (requireMention=true)", async () => {
    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["susan", "main"] },
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: true,
            },
          },
        },
      },
    } as unknown as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-broadcast-not-mentioned",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello everyone" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    // No dispatch: requireMention=true and bot not mentioned → returns early.
    // The mentioned bot's handler (on another account or same account with
    // matching botOpenId) will handle broadcast dispatch for all agents.
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(mockCreateFeishuReplyDispatcher).not.toHaveBeenCalled();
  });

  it("preserves single-agent dispatch when no broadcast config", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-no-broadcast",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    // Single dispatch (no broadcast)
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledTimes(1);
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        SessionKey: "agent:main:feishu:group:oc-broadcast-group",
      }),
    );
  });

  it("cross-account broadcast dedup: second account skips dispatch", async () => {
    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["susan", "main"] },
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    } as unknown as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-multi-account-dedup",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    // First account handles broadcast normally
    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
      accountId: "account-A",
    });
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(2);

    mockDispatchReplyFromConfig.mockClear();
    mockFinalizeInboundContext.mockClear();

    // Second account: same message ID, different account.
    // Per-account dedup passes (different namespace), but cross-account
    // broadcast dedup blocks dispatch.
    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
      accountId: "account-B",
    });
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("skips unknown agents not in agents.list", async () => {
    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["susan", "unknown-agent"] },
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    } as unknown as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-broadcast-unknown-agent",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    // Only susan should get dispatched (unknown-agent skipped)
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const sessionKey = (mockFinalizeInboundContext.mock.calls[0]?.[0] as { SessionKey: string })
      .SessionKey;
    expect(sessionKey).toBe("agent:susan:feishu:group:oc-broadcast-group");
  });

  it("does not synthesize SenderName or Timestamp when sender lookup is unavailable", async () => {
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockRejectedValue(new Error("lookup failed")),
        },
      },
    });
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    } as unknown as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-no-sender-name",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "只回复OK" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    expect(mockFinalizeInboundContext).toHaveBeenCalled();
    const ctxArg = mockFinalizeInboundContext.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(ctxArg.SenderId).toBe("ou-sender");
    expect(ctxArg.SenderName).toBeUndefined();
    expect(ctxArg.Timestamp).toBeUndefined();
  });
});
