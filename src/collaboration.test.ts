import { describe, expect, it, beforeEach } from "vitest";
import {
  applyCollaborationActions,
  advancePeerAutoTurn,
  buildCollaborationRuntimeContext,
  claimCurrentOwnerDispatch,
  clearCollaborationStateForTesting,
  ensureCollaborationState,
  getCollaborationStateForTesting,
  getCollaborationStateStatsForTesting,
  parseCollaborationControlBlocks,
  recordCollaborationVisibleTurn,
  resolveNextPeerAutoSpeaker,
  resolveCollaborationStateForMessage,
  sweepCollaborationStatesForTesting,
} from "./collaboration.js";

describe("collaboration state", () => {
  beforeEach(() => {
    clearCollaborationStateForTesting();
  });

  it("creates a peer_collab task in initial_assessment with stable participants", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_1",
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre", "flink-sre"],
    });
    expect(state.taskId).toMatch(/^task_[0-9a-f]{12}$/);
    expect(state.phase).toBe("initial_assessment");
    expect(state.participants).toEqual(["flink-sre", "starrocks-sre"]);
    expect(state.currentOwner).toBeUndefined();
  });

  it("creates a coordinate task with main as owner", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_2",
      mode: "coordinate",
      participants: ["main", "flink-sre"],
    });
    expect(state.phase).toBe("active_collab");
    expect(state.currentOwner).toBe("main");
    expect(state.speakerToken).toBe("main");
  });

  it("keeps explicit peer_collab override on the unified runtime protocol", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_scripted",
      messageId: "msg_scripted",
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre"],
      explicitMode: "peer_collab",
    });
    expect(state.protocol).toBe("runtime");
    expect(state.phase).toBe("initial_assessment");
    expect(state.currentOwner).toBeUndefined();
  });

  it("creates a fresh task for a new user message in the same thread", () => {
    const first = resolveCollaborationStateForMessage({
      event: {
        message: {
          chat_id: "oc_group_thread",
          root_id: "om_root_same",
          thread_id: "om_thread_same",
          message_id: "om_user_msg_1",
        },
      } as any,
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre"],
      maxHops: 3,
    });
    const second = resolveCollaborationStateForMessage({
      event: {
        message: {
          chat_id: "oc_group_thread",
          root_id: "om_root_same",
          thread_id: "om_thread_same",
          message_id: "om_user_msg_2",
        },
      } as any,
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre"],
      maxHops: 3,
    });
    expect(second.taskId).not.toBe(first.taskId);
  });

  it("elects peer owner from real collab_assess claims instead of participant order", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_owner_claims",
      messageId: "msg_owner_claims",
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre"],
      maxHops: 3,
    });
    applyCollaborationActions([
      {
        action: "collab_assess",
        taskId: state.taskId,
        agentId: "flink-sre",
        ownershipClaim: "supporting",
        currentFinding: "先补一层实时任务视角",
        nextCheck: "等待存储侧判断",
      },
      {
        action: "collab_assess",
        taskId: state.taskId,
        agentId: "starrocks-sre",
        ownershipClaim: "owner_candidate",
        currentFinding: "更适合继续主讲",
        nextCheck: "补一层存储与查询侧判断",
      },
    ]);
    const finalState = getCollaborationStateForTesting(state.taskId);
    expect(finalState?.phase).toBe("active_collab");
    expect(finalState?.currentOwner).toBe("starrocks-sre");
    expect(finalState?.speakerToken).toBe("starrocks-sre");
  });

  it("allows peer collaboration to create a real handoff instead of ignoring it", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_peer_handoff",
      messageId: "msg_peer_handoff",
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
    applyCollaborationActions([
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_peer_real",
        fromAgentId: "flink-sre",
        targetAgentId: "starrocks-sre",
        timeWindow: "18:20-18:35",
        currentFinding: "从 Flink 侧先判断到这里",
        unresolvedQuestion: "请 StarRocks 侧补一层",
        evidencePaths: [],
      },
    ]);
    const finalState = getCollaborationStateForTesting(state.taskId);
    expect(finalState?.phase).toBe("awaiting_accept");
    expect(finalState?.activeHandoffState).toMatchObject({
      handoffId: "handoff_peer_real",
      fromAgentId: "flink-sre",
      targetAgentId: "starrocks-sre",
    });
  });

  it("strips control blocks from visible text and parses collab_assess actions", () => {
    const parsed = parseCollaborationControlBlocks(
      `我先看下实时链路。\n\n\`\`\`openclaw-collab\n{"action":"collab_assess","taskId":"task_x","agentId":"flink-sre","ownershipClaim":"owner_candidate","currentFinding":"lag上升","nextCheck":"看checkpoint","needsWorker":false}\n\`\`\``,
    );
    expect(parsed.visibleText).toBe("我先看下实时链路。");
    expect(parsed.actions).toEqual([
      {
        action: "collab_assess",
        taskId: "task_x",
        agentId: "flink-sre",
        ownershipClaim: "owner_candidate",
        currentFinding: "lag上升",
        nextCheck: "看checkpoint",
        needsWorker: false,
      },
    ]);
  });

  it("strips trailing bare collaboration json and parses the action", () => {
    const parsed = parseCollaborationControlBlocks(
      `从代码和架构角度，我会审视“灵魂”是否体现为持续的身份认同、价值坚守和自主决策能力。\n\n{"action":"collab_assess","taskId":"task_x","agentId":"coder","ownershipClaim":"owner_candidate","currentFinding":"从工程视角，灵魂更像身份一致性与自主判断能力","nextCheck":"等待另一个 agent 的视角","needsWorker":false}`,
    );
    expect(parsed.visibleText).toBe(
      "从代码和架构角度，我会审视“灵魂”是否体现为持续的身份认同、价值坚守和自主决策能力。",
    );
    expect(parsed.actions).toEqual([
      {
        action: "collab_assess",
        taskId: "task_x",
        agentId: "coder",
        ownershipClaim: "owner_candidate",
        currentFinding: "从工程视角，灵魂更像身份一致性与自主判断能力",
        nextCheck: "等待另一个 agent 的视角",
        needsWorker: false,
      },
    ]);
  });

  it("parses shorthand handoff control blocks for generic collaboration turns", () => {
    const parsed = parseCollaborationControlBlocks(
      `从工程实现看，灵魂还体现在系统的自我坚持。\n\n{"action":"agent_handoff","taskId":"task_x","agentId":"coder","handoffTo":"flink-sre","handoffReason":"请 flink-sre 从实时任务运维角度补充"}`,
    );
    expect(parsed.visibleText).toBe("从工程实现看，灵魂还体现在系统的自我坚持。");
    expect(parsed.actions).toEqual([
      expect.objectContaining({
        action: "agent_handoff",
        taskId: "task_x",
        fromAgentId: "coder",
        targetAgentId: "flink-sre",
        currentFinding: "请 flink-sre 从实时任务运维角度补充",
        unresolvedQuestion: "请 flink-sre 从实时任务运维角度补充",
        evidencePaths: [],
      }),
    ]);
  });

  it("strips an incomplete trailing collaboration fence from visible text", () => {
    const parsed = parseCollaborationControlBlocks(
      `我先看实时链路。\n\n\`\`\`openclaw-collab\n{"action":"collab_assess","taskId":"task_x","agentId":"flink-sre"`,
    );
    expect(parsed.visibleText).toBe("我先看实时链路。");
    expect(parsed.actions).toEqual([]);
  });

  it("runtime peer collaboration elects owner after all initial assessments", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_scripted_assess",
      messageId: "msg_scripted_assess",
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre"],
      maxHops: 2,
      explicitMode: "peer_collab",
    });
    applyCollaborationActions([
      {
        action: "collab_assess",
        taskId: state.taskId,
        agentId: "flink-sre",
        ownershipClaim: "owner_candidate",
      },
    ]);
    const advanced = applyCollaborationActions([
      {
        action: "collab_assess",
        taskId: state.taskId,
        agentId: "starrocks-sre",
        ownershipClaim: "supporting",
      },
    ]).at(-1);
    expect(advanced).toEqual(
      expect.objectContaining({
        protocol: "runtime",
        phase: "active_collab",
        currentOwner: "flink-sre",
        speakerToken: "flink-sre",
        autoTurnCount: 0,
      }),
    );
  });

  it("runtime peer collaboration auto-advances without incrementing handoff depth", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_scripted_turns",
      messageId: "msg_scripted_turns",
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre"],
      maxHops: 2,
      explicitMode: "peer_collab",
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
    const afterFirstTurn = advancePeerAutoTurn(state.taskId, "flink-sre");
    expect(afterFirstTurn).toEqual(
      expect.objectContaining({
        phase: "active_collab",
        currentOwner: "starrocks-sre",
        speakerToken: "starrocks-sre",
        autoTurnCount: 1,
        handoffCount: 0,
        lastSpeakerId: "flink-sre",
      }),
    );
    const afterSecondTurn = advancePeerAutoTurn(state.taskId, "starrocks-sre");
    expect(afterSecondTurn).toEqual(
      expect.objectContaining({
        phase: "active_collab",
        currentOwner: "flink-sre",
        speakerToken: "flink-sre",
        autoTurnCount: 2,
        handoffCount: 0,
        lastSpeakerId: "starrocks-sre",
      }),
    );
    const afterThirdTurn = advancePeerAutoTurn(state.taskId, "flink-sre");
    expect(afterThirdTurn).toEqual(
      expect.objectContaining({
        phase: "active_collab",
        currentOwner: "starrocks-sre",
        speakerToken: "starrocks-sre",
        autoTurnCount: 3,
        handoffCount: 0,
        lastSpeakerId: "flink-sre",
      }),
    );
  });

  it("applies handoff control actions for runtime peer collaboration", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_scripted_ignore_handoff",
      messageId: "msg_scripted_ignore_handoff",
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre"],
      maxHops: 2,
      explicitMode: "peer_collab",
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
    const before = getCollaborationStateForTesting(state.taskId);

    applyCollaborationActions([
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_should_be_ignored",
        fromAgentId: "flink-sre",
        targetAgentId: "starrocks-sre",
        timeWindow: "18:20-18:35",
        currentFinding: "sink 吞吐下降",
        unresolvedQuestion: "查询层是否是独立源头",
        evidencePaths: ["shared/tasks/task_x/evidence/02-compute.md"],
      },
    ]);

    const after = getCollaborationStateForTesting(state.taskId);
    expect(after).not.toEqual(before);
    expect(after?.activeHandoffState).toMatchObject({
      handoffId: "handoff_should_be_ignored",
      fromAgentId: "flink-sre",
      targetAgentId: "starrocks-sre",
    });
    expect(after?.phase).toBe("awaiting_accept");
    expect(after?.speakerToken).toBe("starrocks-sre");
  });

  it("claims each current owner turn only once", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_scripted_claim",
      messageId: "msg_scripted_claim",
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre"],
      maxHops: 1,
      explicitMode: "peer_collab",
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

    const firstClaim = claimCurrentOwnerDispatch(state.taskId);
    expect(firstClaim).toEqual(
      expect.objectContaining({
        currentOwner: "flink-sre",
        autoTurnCount: 0,
        currentTurnDispatchKey: "active_collab:flink-sre:flink-sre:0:0:",
      }),
    );
    expect(claimCurrentOwnerDispatch(state.taskId)).toBeUndefined();

    const nextState = advancePeerAutoTurn(state.taskId, "flink-sre");
    expect(nextState).toEqual(
      expect.objectContaining({
        currentOwner: "starrocks-sre",
        autoTurnCount: 1,
        currentTurnDispatchKey: undefined,
      }),
    );
    const secondClaim = claimCurrentOwnerDispatch(state.taskId);
    expect(secondClaim).toEqual(
      expect.objectContaining({
        currentOwner: "starrocks-sre",
        autoTurnCount: 1,
        currentTurnDispatchKey: "active_collab:starrocks-sre:starrocks-sre:0:1:",
      }),
    );
  });

  it("records recent visible turns and exposes them in runtime context", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_scripted_visible_turns",
      messageId: "msg_scripted_visible_turns",
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre"],
      maxHops: 2,
      explicitMode: "peer_collab",
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
    recordCollaborationVisibleTurn({
      taskId: state.taskId,
      agentId: "flink-sre",
      text: "从 Flink 视角先看，灵魂更像状态记忆。",
    });
    recordCollaborationVisibleTurn({
      taskId: state.taskId,
      agentId: "starrocks-sre",
      text: "从 StarRocks 视角补一层，灵魂也体现在持久化与恢复。",
    });

    const ctx = buildCollaborationRuntimeContext({
      state: getCollaborationStateForTesting(state.taskId)!,
      agentId: "flink-sre",
    });

    expect(ctx.recentVisibleTurns).toEqual([
      expect.objectContaining({
        agentId: "flink-sre",
        text: "从 Flink 视角先看，灵魂更像状态记忆。",
      }),
      expect.objectContaining({
        agentId: "starrocks-sre",
        text: "从 StarRocks 视角补一层，灵魂也体现在持久化与恢复。",
      }),
    ]);
  });

  it("builds runtime context from current collaboration state", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_4",
      mode: "coordinate",
      participants: ["main", "flink-sre"],
      maxHops: 4,
    });
    const ctx = buildCollaborationRuntimeContext({
      state,
      agentId: "main",
    });
    expect(ctx).toEqual({
      taskId: state.taskId,
      mode: "coordinate",
      protocol: "runtime",
      phase: "active_collab",
      participants: ["main", "flink-sre"],
      currentOwner: "main",
      speakerToken: "main",
      handoffCount: 0,
      autoTurnCount: 0,
      maxHops: 4,
      isCurrentOwner: true,
      activeHandoff: undefined,
      recentVisibleTurns: [],
      allowedActions: ["agent_handoff", "agent_handoff_complete"],
    });
  });

  it("prefers explicit handoff depth over auto-turn count for allowed actions", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_peer_handoff_depth",
      messageId: "msg_peer_handoff_depth",
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre"],
      maxHops: 1,
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
    advancePeerAutoTurn(state.taskId, "flink-sre");
    const ctx = buildCollaborationRuntimeContext({
      state: getCollaborationStateForTesting(state.taskId)!,
      agentId: "starrocks-sre",
    });
    expect(ctx.autoTurnCount).toBe(1);
    expect(ctx.handoffCount).toBe(0);
    expect(ctx.allowedActions).toContain("agent_handoff");
  });

  it("resolves next peer auto speaker from the current owner", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_next_speaker",
      messageId: "msg_next_speaker",
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre", "coder"],
      maxHops: 2,
    });
    expect(resolveNextPeerAutoSpeaker(state, "flink-sre")).toBe("starrocks-sre");
    expect(resolveNextPeerAutoSpeaker(state, "starrocks-sre")).toBe("coder");
  });

  it("increments handoff count after a successful accept", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_handoff_count",
      mode: "coordinate",
      participants: ["main", "starrocks-sre"],
      maxHops: 3,
    });
    applyCollaborationActions([
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_count_1",
        fromAgentId: "main",
        targetAgentId: "starrocks-sre",
        timeWindow: "18:20-18:35",
        currentFinding: "sink 吞吐下降",
        unresolvedQuestion: "查询层是否是独立源头",
        evidencePaths: ["shared/tasks/task_x/evidence/02-compute.md"],
      },
      {
        action: "agent_handoff_accept",
        taskId: state.taskId,
        handoffId: "handoff_count_1",
        agentId: "starrocks-sre",
      },
    ]);
    const finalState = getCollaborationStateForTesting(state.taskId);
    expect(finalState?.handoffCount).toBe(1);
    expect(finalState?.currentOwner).toBe("starrocks-sre");
  });

  it("disallows further handoff after maxHops is reached", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_max_hops",
      mode: "coordinate",
      participants: ["main", "starrocks-sre", "coder"],
      maxHops: 1,
    });
    applyCollaborationActions([
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_max_1",
        fromAgentId: "main",
        targetAgentId: "starrocks-sre",
        timeWindow: "18:20-18:35",
        currentFinding: "sink 吞吐下降",
        unresolvedQuestion: "查询层是否是独立源头",
        evidencePaths: ["shared/tasks/task_x/evidence/02-compute.md"],
      },
      {
        action: "agent_handoff_accept",
        taskId: state.taskId,
        handoffId: "handoff_max_1",
        agentId: "starrocks-sre",
      },
    ]);
    const stateAfterAccept = getCollaborationStateForTesting(state.taskId);
    const ctx = buildCollaborationRuntimeContext({
      state: stateAfterAccept!,
      agentId: "starrocks-sre",
    });
    expect(ctx.handoffCount).toBe(1);
    expect(ctx.maxHops).toBe(1);
    expect(ctx.allowedActions).toEqual(["agent_handoff_complete"]);
    applyCollaborationActions([
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_max_2",
        fromAgentId: "starrocks-sre",
        targetAgentId: "coder",
        timeWindow: "18:36-18:40",
        currentFinding: "需要补充日志和截图",
        unresolvedQuestion: "确认日志里是否有错误堆栈",
        evidencePaths: ["shared/tasks/task_x/evidence/03-serving.md"],
      },
    ]);
    const finalState = getCollaborationStateForTesting(state.taskId);
    expect(finalState?.activeHandoffState).toBeUndefined();
    expect(finalState?.currentOwner).toBe("starrocks-sre");
    expect(finalState?.handoffCount).toBe(1);
  });

  it("moves active owner into awaiting_accept when handoff is created", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_5",
      mode: "coordinate",
      participants: ["main", "starrocks-sre"],
    });
    applyCollaborationActions([
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_1",
        fromAgentId: "main",
        targetAgentId: "starrocks-sre",
        timeWindow: "18:20-18:35",
        currentFinding: "sink 吞吐下降",
        unresolvedQuestion: "查询层是否是独立源头",
        evidencePaths: ["shared/tasks/task_x/evidence/02-compute.md"],
      },
    ]);
    const finalState = getCollaborationStateForTesting(state.taskId);
    expect(finalState?.phase).toBe("awaiting_accept");
    expect(finalState?.currentOwner).toBe("main");
    expect(finalState?.activeHandoffState).toMatchObject({
      handoffId: "handoff_1",
      fromAgentId: "main",
      targetAgentId: "starrocks-sre",
      status: "awaiting_accept",
    });
  });

  it("accept switches owner and speaker token to target agent", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_6",
      mode: "coordinate",
      participants: ["main", "starrocks-sre"],
    });
    applyCollaborationActions([
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_2",
        fromAgentId: "main",
        targetAgentId: "starrocks-sre",
        timeWindow: "18:20-18:35",
        currentFinding: "sink 吞吐下降",
        unresolvedQuestion: "查询层是否是独立源头",
        evidencePaths: ["shared/tasks/task_x/evidence/02-compute.md"],
      },
      {
        action: "agent_handoff_accept",
        taskId: state.taskId,
        handoffId: "handoff_2",
        agentId: "starrocks-sre",
      },
    ]);
    const finalState = getCollaborationStateForTesting(state.taskId);
    expect(finalState?.phase).toBe("active_collab");
    expect(finalState?.currentOwner).toBe("starrocks-sre");
    expect(finalState?.speakerToken).toBe("starrocks-sre");
    expect(finalState?.activeHandoffState).toBeUndefined();
  });

  it("reject keeps the original owner and clears pending handoff", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_7",
      mode: "coordinate",
      participants: ["main", "starrocks-sre"],
    });
    applyCollaborationActions([
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_3",
        fromAgentId: "main",
        targetAgentId: "starrocks-sre",
        timeWindow: "18:20-18:35",
        currentFinding: "sink 吞吐下降",
        unresolvedQuestion: "查询层是否是独立源头",
        evidencePaths: ["shared/tasks/task_x/evidence/02-compute.md"],
      },
      {
        action: "agent_handoff_reject",
        taskId: state.taskId,
        handoffId: "handoff_3",
        agentId: "starrocks-sre",
      },
    ]);
    const finalState = getCollaborationStateForTesting(state.taskId);
    expect(finalState?.phase).toBe("active_collab");
    expect(finalState?.currentOwner).toBe("main");
    expect(finalState?.speakerToken).toBe("main");
    expect(finalState?.activeHandoffState).toBeUndefined();
  });

  it("need_info blocks collaboration without switching owner", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_8",
      mode: "coordinate",
      participants: ["main", "starrocks-sre"],
    });
    applyCollaborationActions([
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_4",
        fromAgentId: "main",
        targetAgentId: "starrocks-sre",
        timeWindow: "18:20-18:35",
        currentFinding: "sink 吞吐下降",
        unresolvedQuestion: "查询层是否是独立源头",
        evidencePaths: ["shared/tasks/task_x/evidence/02-compute.md"],
      },
      {
        action: "agent_handoff_need_info",
        taskId: state.taskId,
        handoffId: "handoff_4",
        agentId: "starrocks-sre",
      },
    ]);
    const finalState = getCollaborationStateForTesting(state.taskId);
    expect(finalState?.phase).toBe("blocked_need_info");
    expect(finalState?.currentOwner).toBe("main");
    expect(finalState?.speakerToken).toBe("main");
    expect(finalState?.activeHandoffState).toMatchObject({
      handoffId: "handoff_4",
      status: "blocked_need_info",
    });
  });

  it("complete marks the current owner stage as completed", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_9",
      mode: "coordinate",
      participants: ["main", "flink-sre"],
    });
    applyCollaborationActions([
      {
        action: "agent_handoff_complete",
        taskId: state.taskId,
        agentId: "main",
      },
    ]);
    const finalState = getCollaborationStateForTesting(state.taskId);
    expect(finalState?.phase).toBe("completed");
    expect(finalState?.speakerToken).toBeUndefined();
    expect(finalState?.activeHandoffState).toBeUndefined();
  });

  it("allows the current owner to supersede a blocked handoff with a new handoff", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_10",
      mode: "coordinate",
      participants: ["main", "starrocks-sre", "coder"],
    });
    applyCollaborationActions([
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_blocked_1",
        fromAgentId: "main",
        targetAgentId: "starrocks-sre",
        timeWindow: "18:20-18:35",
        currentFinding: "sink 吞吐下降",
        unresolvedQuestion: "查询层是否是独立源头",
        evidencePaths: ["shared/tasks/task_x/evidence/02-compute.md"],
      },
      {
        action: "agent_handoff_need_info",
        taskId: state.taskId,
        handoffId: "handoff_blocked_1",
        agentId: "starrocks-sre",
      },
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_blocked_2",
        fromAgentId: "main",
        targetAgentId: "coder",
        timeWindow: "18:20-18:35",
        currentFinding: "需要补充日志和截图",
        unresolvedQuestion: "先确认 HDFS 和作业日志是否有错误堆栈",
        evidencePaths: ["shared/tasks/task_x/evidence/02-compute.md"],
      },
    ]);
    const finalState = getCollaborationStateForTesting(state.taskId);
    expect(finalState?.phase).toBe("awaiting_accept");
    expect(finalState?.currentOwner).toBe("main");
    expect(finalState?.speakerToken).toBe("coder");
    expect(finalState?.activeHandoffState).toMatchObject({
      handoffId: "handoff_blocked_2",
      fromAgentId: "main",
      targetAgentId: "coder",
      status: "awaiting_accept",
    });
  });

  it("accepts a handoff response without taskId when handoffId uniquely matches an active handoff", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_missing_taskid",
      messageId: "msg_missing_taskid",
      mode: "coordinate",
      participants: ["main", "starrocks-sre"],
      maxHops: 3,
    });
    applyCollaborationActions([
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_missing_taskid",
        fromAgentId: "main",
        targetAgentId: "starrocks-sre",
        timeWindow: "",
        currentFinding: "请从存储/查询视角补一层",
        unresolvedQuestion: "请从存储/查询视角补一层",
        evidencePaths: [],
      },
      {
        action: "agent_handoff_accept",
        handoffId: "handoff_missing_taskid",
        agentId: "starrocks-sre",
      },
    ]);
    const finalState = getCollaborationStateForTesting(state.taskId);
    expect(finalState?.phase).toBe("active_collab");
    expect(finalState?.currentOwner).toBe("starrocks-sre");
    expect(finalState?.handoffCount).toBe(1);
    expect(finalState?.activeHandoffState).toBeUndefined();
  });

  it("treats handoff accept with completionStatus complete as terminal", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_accept_complete",
      messageId: "msg_accept_complete",
      mode: "coordinate",
      participants: ["main", "starrocks-sre"],
      maxHops: 3,
    });
    applyCollaborationActions([
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_accept_complete",
        fromAgentId: "main",
        targetAgentId: "starrocks-sre",
        timeWindow: "",
        currentFinding: "请给最终结论",
        unresolvedQuestion: "请给最终结论",
        evidencePaths: [],
      },
      {
        action: "agent_handoff_accept",
        handoffId: "handoff_accept_complete",
        agentId: "starrocks-sre",
        completionStatus: "complete",
        finalConclusion: "最终结论",
      },
    ]);
    const finalState = getCollaborationStateForTesting(state.taskId);
    expect(finalState?.phase).toBe("completed");
    expect(finalState?.currentOwner).toBe("starrocks-sre");
    expect(finalState?.speakerToken).toBeUndefined();
    expect(finalState?.handoffCount).toBe(1);
    expect(finalState?.activeHandoffState).toBeUndefined();
  });

  it("lets the source owner cancel or reassign while handoff is awaiting acceptance", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_10a",
      mode: "coordinate",
      participants: ["main", "starrocks-sre"],
    });
    applyCollaborationActions([
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_waiting_1",
        fromAgentId: "main",
        targetAgentId: "starrocks-sre",
        timeWindow: "18:20-18:35",
        currentFinding: "sink 吞吐下降",
        unresolvedQuestion: "查询层是否是独立源头",
        evidencePaths: ["shared/tasks/task_x/evidence/02-compute.md"],
      },
    ]);
    const waitingState = getCollaborationStateForTesting(state.taskId);
    const ctx = buildCollaborationRuntimeContext({
      state: waitingState!,
      agentId: "main",
    });
    expect(ctx.allowedActions).toEqual(["agent_handoff", "agent_handoff_cancel"]);
  });

  it("expire returns the task to the current owner and clears the pending handoff", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_11",
      mode: "coordinate",
      participants: ["main", "starrocks-sre"],
    });
    applyCollaborationActions([
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_expire_1",
        fromAgentId: "main",
        targetAgentId: "starrocks-sre",
        timeWindow: "18:20-18:35",
        currentFinding: "sink 吞吐下降",
        unresolvedQuestion: "查询层是否是独立源头",
        evidencePaths: ["shared/tasks/task_x/evidence/02-compute.md"],
      },
      {
        action: "agent_handoff_expire",
        taskId: state.taskId,
        handoffId: "handoff_expire_1",
        agentId: "main",
      } as never,
    ]);
    const finalState = getCollaborationStateForTesting(state.taskId);
    expect(finalState?.phase).toBe("active_collab");
    expect(finalState?.currentOwner).toBe("main");
    expect(finalState?.speakerToken).toBe("main");
    expect(finalState?.activeHandoffState).toBeUndefined();
  });

  it("ignores stale accept after a handoff has been superseded", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_12",
      mode: "coordinate",
      participants: ["main", "starrocks-sre", "coder"],
    });
    applyCollaborationActions([
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_old",
        fromAgentId: "main",
        targetAgentId: "starrocks-sre",
        timeWindow: "18:20-18:35",
        currentFinding: "先看查询层",
        unresolvedQuestion: "是否为独立源头",
        evidencePaths: ["shared/tasks/task_x/evidence/02-compute.md"],
      },
      {
        action: "agent_handoff_need_info",
        taskId: state.taskId,
        handoffId: "handoff_old",
        agentId: "starrocks-sre",
      },
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_new",
        fromAgentId: "main",
        targetAgentId: "coder",
        timeWindow: "18:20-18:35",
        currentFinding: "先补日志和截图",
        unresolvedQuestion: "作业和 HDFS 是否有错误堆栈",
        evidencePaths: ["shared/tasks/task_x/evidence/03-resource.md"],
      },
      {
        action: "agent_handoff_accept",
        taskId: state.taskId,
        handoffId: "handoff_old",
        agentId: "starrocks-sre",
      },
    ]);
    const finalState = getCollaborationStateForTesting(state.taskId);
    expect(finalState?.phase).toBe("awaiting_accept");
    expect(finalState?.currentOwner).toBe("main");
    expect(finalState?.speakerToken).toBe("coder");
    expect(finalState?.activeHandoffState).toMatchObject({
      handoffId: "handoff_new",
      targetAgentId: "coder",
      status: "awaiting_accept",
    });
  });

  it("lazily sweeps completed collaboration states", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_terminal",
      messageId: "msg_terminal",
      mode: "coordinate",
      participants: ["main", "flink-sre"],
    });
    applyCollaborationActions([
      {
        action: "agent_handoff_complete",
        taskId: state.taskId,
        agentId: "main",
      },
    ]);

    expect(getCollaborationStateForTesting(state.taskId)?.phase).toBe("completed");
    expect(getCollaborationStateStatsForTesting().byTaskId).toBe(1);

    sweepCollaborationStatesForTesting(Date.now() + 11 * 60 * 1000);

    expect(getCollaborationStateForTesting(state.taskId)).toBeUndefined();
    expect(getCollaborationStateStatsForTesting()).toEqual({ byKey: 0, byTaskId: 0 });
  });

  it("lazily sweeps stale non-terminal collaboration states", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_stale",
      messageId: "msg_stale",
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre"],
    });

    expect(getCollaborationStateForTesting(state.taskId)?.phase).toBe("initial_assessment");

    sweepCollaborationStatesForTesting(Date.now() + 25 * 60 * 60 * 1000);

    expect(getCollaborationStateForTesting(state.taskId)).toBeUndefined();
    expect(getCollaborationStateStatsForTesting()).toEqual({ byKey: 0, byTaskId: 0 });
  });
});
