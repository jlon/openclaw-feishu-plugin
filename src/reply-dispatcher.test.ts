import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const getFeishuRuntimeMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendMarkdownCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveReceiveIdTypeMock = vi.hoisted(() => vi.fn());
const createReplyDispatcherWithTypingMock = vi.hoisted(() => vi.fn());
const addTypingIndicatorMock = vi.hoisted(() => vi.fn(async () => ({ messageId: "om_msg" })));
const removeTypingIndicatorMock = vi.hoisted(() => vi.fn(async () => {}));
const streamingInstances = vi.hoisted(() => [] as any[]);

vi.mock("./accounts.js", () => ({ resolveFeishuAccount: resolveFeishuAccountMock }));
vi.mock("./runtime.js", () => ({ getFeishuRuntime: getFeishuRuntimeMock }));
vi.mock("./send.js", () => ({
  sendMessageFeishu: sendMessageFeishuMock,
  sendMarkdownCardFeishu: sendMarkdownCardFeishuMock,
}));
vi.mock("./media.js", () => ({ sendMediaFeishu: sendMediaFeishuMock }));
vi.mock("./client.js", () => ({ createFeishuClient: createFeishuClientMock }));
vi.mock("./targets.js", () => ({ resolveReceiveIdType: resolveReceiveIdTypeMock }));
vi.mock("./typing.js", () => ({
  addTypingIndicator: addTypingIndicatorMock,
  removeTypingIndicator: removeTypingIndicatorMock,
}));
vi.mock("./streaming-card.js", () => ({
  mergeStreamingText: (previousText: string | undefined, nextText: string | undefined) => {
    const previous = typeof previousText === "string" ? previousText : "";
    const next = typeof nextText === "string" ? nextText : "";
    if (!next) {
      return previous;
    }
    if (!previous || next === previous) {
      return next;
    }
    if (next.startsWith(previous)) {
      return next;
    }
    if (previous.startsWith(next)) {
      return previous;
    }
    return `${previous}${next}`;
  },
  FeishuStreamingSession: class {
    active = false;
    start = vi.fn(async () => {
      this.active = true;
    });
    update = vi.fn(async () => {});
    close = vi.fn(async () => {
      this.active = false;
    });
    isActive = vi.fn(() => this.active);

    constructor() {
      streamingInstances.push(this);
    }
  },
}));

import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import {
  applyCollaborationActions,
  clearCollaborationStateForTesting,
  ensureCollaborationState,
  getCollaborationStateForTesting,
} from "./collaboration.js";

describe("createFeishuReplyDispatcher streaming behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamingInstances.length = 0;
    clearCollaborationStateForTesting();
    sendMediaFeishuMock.mockResolvedValue(undefined);

    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: true,
      },
    });

    resolveReceiveIdTypeMock.mockReturnValue("chat_id");
    createFeishuClientMock.mockReturnValue({});

    createReplyDispatcherWithTypingMock.mockImplementation((opts) => ({
      dispatcher: {},
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      _opts: opts,
    }));

    getFeishuRuntimeMock.mockReturnValue({
      channel: {
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          resolveChunkMode: vi.fn(() => "line"),
          resolveMarkdownTableMode: vi.fn(() => "preserve"),
          convertMarkdownTables: vi.fn((text) => text),
          chunkTextWithMode: vi.fn((text) => [text]),
        },
        reply: {
          createReplyDispatcherWithTyping: createReplyDispatcherWithTypingMock,
          resolveHumanDelayConfig: vi.fn(() => undefined),
        },
      },
    });
  });

  function setupNonStreamingAutoDispatcher() {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: false,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    return createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
  }

  it("skips typing indicator when account typingIndicator is disabled", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: true,
        typingIndicator: false,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("skips typing indicator for stale replayed messages", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
      messageCreateTimeMs: Date.now() - 3 * 60_000,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("treats second-based timestamps as stale for typing suppression", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
      messageCreateTimeMs: Math.floor((Date.now() - 3 * 60_000) / 1000),
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("keeps typing indicator for fresh messages", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
      messageCreateTimeMs: Date.now() - 30_000,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).toHaveBeenCalledTimes(1);
    expect(addTypingIndicatorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "om_parent",
      }),
    );
  });

  it("keeps auto mode plain text on non-streaming send path", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "plain text" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("suppresses internal block payload delivery", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "internal reasoning chunk" }, { kind: "block" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
  });

  it("strips collaboration control blocks from visible replies and updates state on final", async () => {
    const state = ensureCollaborationState({
      chatId: "oc_chat",
      messageId: "msg_1",
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre"],
    });
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "flink-sre",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver(
      {
        text:
          "我先看实时链路。\n\n```openclaw-collab\n" +
          JSON.stringify({
            action: "collab_assess",
            taskId: state.taskId,
            agentId: "flink-sre",
            ownershipClaim: "owner_candidate",
            currentFinding: "lag上升",
            nextCheck: "看checkpoint",
            needsWorker: false,
          }) +
          "\n```",
      },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "我先看实时链路。",
      }),
    );
    expect(getCollaborationStateForTesting(state.taskId)?.assessments["flink-sre"]).toEqual(
      expect.objectContaining({
        ownershipClaim: "owner_candidate",
        currentFinding: "lag上升",
      }),
    );
  });

  it("records sanitized visible collaboration turns on final delivery", async () => {
    const state = ensureCollaborationState({
      chatId: "oc_chat",
      messageId: "msg_visible_turn",
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre"],
      maxHops: 2,
      explicitMode: "peer_collab",
    });
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "flink-sre",
      runtime: {} as never,
      chatId: "oc_chat",
      collaborationTaskId: state.taskId,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver(
      {
        text:
          "从 Flink 视角先看，灵魂更像状态记忆。\n\n```openclaw-collab\n" +
          JSON.stringify({
            action: "collab_assess",
            taskId: state.taskId,
            agentId: "flink-sre",
            ownershipClaim: "owner_candidate",
          }) +
          "\n```",
      },
      { kind: "final" },
    );

    expect(getCollaborationStateForTesting(state.taskId)?.recentVisibleTurns).toEqual([
      expect.objectContaining({
        agentId: "flink-sre",
        text: "从 Flink 视角先看，灵魂更像状态记忆。",
      }),
    ]);
  });

  it("strips trailing bare collaboration json from visible replies on final", async () => {
    const state = ensureCollaborationState({
      chatId: "oc_chat",
      messageId: "msg_bare_json",
      mode: "peer_collab",
      participants: ["coder", "starrocks-sre"],
    });
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "coder",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver(
      {
        text:
          "从代码和架构角度，我会审视“灵魂”是否体现为持续的身份认同、价值坚守和自主决策能力。\n\n" +
          JSON.stringify({
            action: "collab_assess",
            taskId: state.taskId,
            agentId: "coder",
            ownershipClaim: "owner_candidate",
            currentFinding: "从工程师视角，灵魂可理解为系统的身份认同、价值坚守和自主判断能力",
            nextCheck: "等待 Starrocks-SRE",
            needsWorker: false,
          }),
      },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "从代码和架构角度，我会审视“灵魂”是否体现为持续的身份认同、价值坚守和自主决策能力。",
      }),
    );
    expect(getCollaborationStateForTesting(state.taskId)?.assessments["coder"]).toEqual(
      expect.objectContaining({
        ownershipClaim: "owner_candidate",
      }),
    );
  });

  it("strips incomplete trailing collaboration fences from visible replies on final", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "flink-sre",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver(
      {
        text: "我先看实时链路。\n\n```openclaw-collab\n{\"action\":\"collab_assess\",\"taskId\":\"task_x\"",
      },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "我先看实时链路。",
      }),
    );
  });

  it("strips handoff control blocks from visible replies and updates collaboration owner flow", async () => {
    const state = ensureCollaborationState({
      chatId: "oc_chat",
      messageId: "msg_2",
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre"],
    });
    applyCollaborationActions([
      {
        action: "collab_assess",
        taskId: state.taskId,
        agentId: "flink-sre",
        ownershipClaim: "owner_candidate",
      },
      {
        action: "collab_assess",
        taskId: state.taskId,
        agentId: "starrocks-sre",
        ownershipClaim: "supporting",
      },
    ]);
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "flink-sre",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver(
      {
        text:
          "我先把查询层交给 Starrocks-SRE。\n\n```openclaw-collab\n" +
          JSON.stringify({
            action: "agent_handoff",
            taskId: state.taskId,
            handoffId: "handoff_1",
            fromAgentId: "flink-sre",
            targetAgentId: "starrocks-sre",
            timeWindow: "18:20-18:35",
            currentFinding: "sink 吞吐下降",
            unresolvedQuestion: "查询层是否是独立源头",
            evidencePaths: ["shared/tasks/task_x/evidence/02-compute.md"],
          }) +
          "\n```",
      },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "我先把查询层交给 Starrocks-SRE。",
      }),
    );
    expect(getCollaborationStateForTesting(state.taskId)).toEqual(
      expect.objectContaining({
        phase: "awaiting_accept",
        activeHandoffState: expect.objectContaining({
          handoffId: "handoff_1",
          targetAgentId: "starrocks-sre",
        }),
      }),
    );
  });

  it("auto-mentions handoff target in visible replies when no explicit mention targets are provided", async () => {
    const state = ensureCollaborationState({
      chatId: "oc_chat",
      messageId: "msg_handoff_visible_target",
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre"],
      maxHops: 3,
    });
    applyCollaborationActions([
      {
        action: "collab_assess",
        taskId: state.taskId,
        agentId: "flink-sre",
        ownershipClaim: "owner_candidate",
      },
      {
        action: "collab_assess",
        taskId: state.taskId,
        agentId: "starrocks-sre",
        ownershipClaim: "supporting",
      },
    ]);

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "flink-sre",
      runtime: {} as never,
      chatId: "oc_chat",
      collaborationAgentResolver: (agentId) =>
        agentId === "starrocks-sre"
          ? { openId: "ou_starrocks", name: "Starrocks-SRE", key: "@visible_starrocks-sre" }
          : undefined,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls.at(-1)?.[0];
    await options.deliver(
      {
        text:
          "我先补一层计算侧判断。\n\n```openclaw-collab\n" +
          JSON.stringify({
            action: "agent_handoff",
            taskId: state.taskId,
            handoffId: "handoff_visible_target",
            fromAgentId: "flink-sre",
            targetAgentId: "starrocks-sre",
            timeWindow: "18:20-18:35",
            currentFinding: "sink 吞吐下降",
            unresolvedQuestion: "查询层是否是独立源头",
            evidencePaths: ["shared/tasks/task_x/evidence/02-compute.md"],
          }) +
          "\n```",
      },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "我先补一层计算侧判断。",
        mentions: [
          expect.objectContaining({
            openId: "ou_starrocks",
            name: "Starrocks-SRE",
          }),
        ],
      }),
    );
  });

  it("sets disableBlockStreaming in replyOptions to prevent silent reply drops", async () => {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    expect(result.replyOptions).toHaveProperty("disableBlockStreaming", true);
  });

  it("uses streaming session for auto mode markdown payloads", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
      rootId: "om_root_topic",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].start).toHaveBeenCalledWith("oc_chat", "chat_id", {
      replyToMessageId: undefined,
      replyInThread: undefined,
      rootId: "om_root_topic",
    });
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("closes streaming with block text when final reply is missing", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```md\npartial answer\n```" }, { kind: "block" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith("```md\npartial answer\n```");
  });

  it("coalesces multiple streaming finals into the latest visible reply on idle", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```md\n完整回复第一段\n```" }, { kind: "final" });
    await options.deliver({ text: "```md\n完整回复第一段 + 第二段\n```" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith(
      "```md\n完整回复第一段 + 第二段\n```",
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("keeps a single streaming card when duplicate finals repeat before idle", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```md\n同一条回复\n```" }, { kind: "final" });
    await options.deliver({ text: "```md\n同一条回复\n```" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith("```md\n同一条回复\n```");
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("does not surface tool-use preambles as separate streaming replies", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "main",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "我先获取群成员列表。" }, { kind: "final" });
    await options.deliver({ text: "我遇到了权限问题，改用表格收集。" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith("我遇到了权限问题，改用表格收集。");
  });
  it("suppresses duplicate final text while still sending media", async () => {
    const options = setupNonStreamingAutoDispatcher();
    await options.deliver({ text: "plain final" }, { kind: "final" });
    await options.deliver(
      { text: "plain final", mediaUrl: "https://example.com/a.png" },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: "plain final",
      }),
    );
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/a.png",
      }),
    );
  });

  it("keeps distinct non-streaming final payloads", async () => {
    const options = setupNonStreamingAutoDispatcher();
    await options.deliver({ text: "notice header" }, { kind: "final" });
    await options.deliver({ text: "actual answer body" }, { kind: "final" });

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(sendMessageFeishuMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: "notice header" }),
    );
    expect(sendMessageFeishuMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "actual answer body" }),
    );
  });

  it("strips leaked internal tool syntax from visible text replies", async () => {
    const options = setupNonStreamingAutoDispatcher();
    await options.deliver(
      {
        text:
          "SoulCoder 好，我是小飞龙-SRE。\n\nsessions_send(sessionKey=\"agent:SoulCoder:feishu:group:oc_xxx\", message=\"hi\")",
      },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "SoulCoder 好，我是小飞龙-SRE。",
      }),
    );
  });

  it("strips model-generated leading mention tags when auto mentions are enabled", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      mentionTargets: [{ openId: "ou_target", name: "云上Bot", key: "@_user_1" }],
    });
    const options = createReplyDispatcherWithTypingMock.mock.calls.at(-1)?.[0];
    await options.deliver(
      {
        text: "<at id=ou_flink></at> 云上Bot，你好！我是小飞龙。",
      },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "云上Bot，你好！我是小飞龙。",
      }),
    );
  });

  it("strips model-generated leading mention tags on streaming close", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
      mentionTargets: [{ openId: "ou_target", name: "云上Bot", key: "@_user_1" }],
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls.at(-1)?.[0];
    await options.onReplyStart?.();
    await result.replyOptions.onPartialReply?.({
      text: "<at id=ou_flink></at> 云上Bot，你好！我是小飞龙。",
    });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith(
      "<at id=ou_target></at> 云上Bot，你好！我是小飞龙。",
    );
  });

  it("renders visible mention targets independently from control-plane mention targets", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
      visibleMentionTargets: [{ openId: "ou_main", name: "首席大管家", key: "@visible_main" }],
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls.at(-1)?.[0];
    await options.onReplyStart?.();
    await result.replyOptions.onPartialReply?.({
      text: "@首席大管家 我先补一层服务侧观察。",
    });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith(
      "<at id=ou_main></at> 我先补一层服务侧观察。",
    );
  });

  it("strips model-generated leading mention tags on streaming updates", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
      mentionTargets: [{ openId: "ou_target", name: "云上Bot", key: "@_user_1" }],
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls.at(-1)?.[0];
    await options.onReplyStart?.();
    result.replyOptions.onPartialReply?.({
      text: "<at id=ou_flink></at> 云上Bot，你好！我是小飞龙。",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].update).toHaveBeenCalledWith(
      "<at id=ou_target></at> 云上Bot，你好！我是小飞龙。",
    );
  });

  it("treats block updates as delta chunks", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();
    await result.replyOptions.onPartialReply?.({ text: "hello" });
    await options.deliver({ text: "lo world" }, { kind: "block" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith("hellolo world");
  });

  it("sends media-only payloads as attachments", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ mediaUrl: "https://example.com/a.png" }, { kind: "final" });

    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "oc_chat",
        mediaUrl: "https://example.com/a.png",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("falls back to legacy mediaUrl when mediaUrls is an empty array", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver(
      { text: "caption", mediaUrl: "https://example.com/a.png", mediaUrls: [] },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/a.png",
      }),
    );
  });

  it("sends attachments after streaming final markdown replies", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver(
      { text: "```ts\nconst x = 1\n```", mediaUrls: ["https://example.com/a.png"] },
      { kind: "final" },
    );
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/a.png",
      }),
    );
  });

  it("passes replyInThread to sendMessageFeishu for plain text", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_msg",
      replyInThread: true,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "plain text" }, { kind: "final" });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });

  it("passes replyInThread to sendMarkdownCardFeishu for card text", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: false,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_msg",
      replyInThread: true,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "card text" }, { kind: "final" });

    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });

  it("passes replyToMessageId and replyInThread to streaming.start()", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
      replyToMessageId: "om_msg",
      replyInThread: true,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledWith("oc_chat", "chat_id", {
      replyToMessageId: "om_msg",
      replyInThread: true,
    });
  });

  it("disables streaming for thread replies and keeps reply metadata", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
      replyToMessageId: "om_msg",
      replyInThread: false,
      threadReply: true,
      rootId: "om_root_topic",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });

  it("passes replyInThread to media attachments", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_msg",
      replyInThread: true,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ mediaUrl: "https://example.com/a.png" }, { kind: "final" });

    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });
});
