import { describe, expect, it, beforeEach } from "vitest";
import {
  applyCollaborationActions,
  buildCollaborationRuntimeContext,
  clearCollaborationStateForTesting,
  ensureCollaborationState,
  getCollaborationStateForTesting,
  parseCollaborationControlBlocks,
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

  it("strips an incomplete trailing collaboration fence from visible text", () => {
    const parsed = parseCollaborationControlBlocks(
      `我先看实时链路。\n\n\`\`\`openclaw-collab\n{"action":"collab_assess","taskId":"task_x","agentId":"flink-sre"`,
    );
    expect(parsed.visibleText).toBe("我先看实时链路。");
    expect(parsed.actions).toEqual([]);
  });

  it("elects owner after all peer_collab assessments arrive", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_3",
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre"],
    });
    applyCollaborationActions([
      {
        action: "collab_assess",
        taskId: state.taskId,
        agentId: "flink-sre",
        ownershipClaim: "owner_candidate",
        currentFinding: "Flink checkpoint正常",
        nextCheck: "看sink",
      },
    ]);
    expect(getCollaborationStateForTesting(state.taskId)?.phase).toBe("initial_assessment");
    applyCollaborationActions([
      {
        action: "collab_assess",
        taskId: state.taskId,
        agentId: "starrocks-sre",
        ownershipClaim: "supporting",
        currentFinding: "查询层像下游表现",
        nextCheck: "看慢查询",
      },
    ]);
    const finalState = getCollaborationStateForTesting(state.taskId);
    expect(finalState?.phase).toBe("active_collab");
    expect(finalState?.currentOwner).toBe("flink-sre");
    expect(finalState?.speakerToken).toBe("flink-sre");
  });

  it("builds runtime context from current collaboration state", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_4",
      mode: "coordinate",
      participants: ["main", "flink-sre"],
    });
    const ctx = buildCollaborationRuntimeContext({
      state,
      agentId: "main",
    });
    expect(ctx).toEqual({
      taskId: state.taskId,
      mode: "coordinate",
      phase: "active_collab",
      participants: ["main", "flink-sre"],
      currentOwner: "main",
      speakerToken: "main",
      isCurrentOwner: true,
      activeHandoff: undefined,
      allowedActions: ["agent_handoff", "agent_handoff_complete"],
    });
  });

  it("moves active owner into awaiting_accept when handoff is created", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_5",
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
    applyCollaborationActions([
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_1",
        fromAgentId: "flink-sre",
        targetAgentId: "starrocks-sre",
        timeWindow: "18:20-18:35",
        currentFinding: "sink 吞吐下降",
        unresolvedQuestion: "查询层是否是独立源头",
        evidencePaths: ["shared/tasks/task_x/evidence/02-compute.md"],
      },
    ]);
    const finalState = getCollaborationStateForTesting(state.taskId);
    expect(finalState?.phase).toBe("awaiting_accept");
    expect(finalState?.currentOwner).toBe("flink-sre");
    expect(finalState?.activeHandoffState).toMatchObject({
      handoffId: "handoff_1",
      fromAgentId: "flink-sre",
      targetAgentId: "starrocks-sre",
      status: "awaiting_accept",
    });
  });

  it("accept switches owner and speaker token to target agent", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_6",
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
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_2",
        fromAgentId: "flink-sre",
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
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_3",
        fromAgentId: "flink-sre",
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
    expect(finalState?.currentOwner).toBe("flink-sre");
    expect(finalState?.speakerToken).toBe("flink-sre");
    expect(finalState?.activeHandoffState).toBeUndefined();
  });

  it("need_info blocks collaboration without switching owner", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_8",
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
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_4",
        fromAgentId: "flink-sre",
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
    expect(finalState?.currentOwner).toBe("flink-sre");
    expect(finalState?.speakerToken).toBe("flink-sre");
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
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre", "coder"],
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
      {
        action: "collab_assess",
        taskId: state.taskId,
        agentId: "coder",
        ownershipClaim: "observer",
      },
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_blocked_1",
        fromAgentId: "flink-sre",
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
        fromAgentId: "flink-sre",
        targetAgentId: "coder",
        timeWindow: "18:20-18:35",
        currentFinding: "需要补充日志和截图",
        unresolvedQuestion: "先确认 HDFS 和作业日志是否有错误堆栈",
        evidencePaths: ["shared/tasks/task_x/evidence/02-compute.md"],
      },
    ]);
    const finalState = getCollaborationStateForTesting(state.taskId);
    expect(finalState?.phase).toBe("awaiting_accept");
    expect(finalState?.currentOwner).toBe("flink-sre");
    expect(finalState?.speakerToken).toBe("coder");
    expect(finalState?.activeHandoffState).toMatchObject({
      handoffId: "handoff_blocked_2",
      fromAgentId: "flink-sre",
      targetAgentId: "coder",
      status: "awaiting_accept",
    });
  });

  it("lets the source owner cancel or reassign while handoff is awaiting acceptance", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_10a",
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
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_waiting_1",
        fromAgentId: "flink-sre",
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
      agentId: "flink-sre",
    });
    expect(ctx.allowedActions).toEqual(["agent_handoff", "agent_handoff_cancel"]);
  });

  it("expire returns the task to the current owner and clears the pending handoff", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_11",
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
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_expire_1",
        fromAgentId: "flink-sre",
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
        agentId: "flink-sre",
      } as never,
    ]);
    const finalState = getCollaborationStateForTesting(state.taskId);
    expect(finalState?.phase).toBe("active_collab");
    expect(finalState?.currentOwner).toBe("flink-sre");
    expect(finalState?.speakerToken).toBe("flink-sre");
    expect(finalState?.activeHandoffState).toBeUndefined();
  });

  it("ignores stale accept after a handoff has been superseded", () => {
    const state = ensureCollaborationState({
      chatId: "oc_group_1",
      messageId: "msg_12",
      mode: "peer_collab",
      participants: ["flink-sre", "starrocks-sre", "coder"],
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
      {
        action: "collab_assess",
        taskId: state.taskId,
        agentId: "coder",
        ownershipClaim: "observer",
      },
      {
        action: "agent_handoff",
        taskId: state.taskId,
        handoffId: "handoff_old",
        fromAgentId: "flink-sre",
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
        fromAgentId: "flink-sre",
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
    expect(finalState?.currentOwner).toBe("flink-sre");
    expect(finalState?.speakerToken).toBe("coder");
    expect(finalState?.activeHandoffState).toMatchObject({
      handoffId: "handoff_new",
      targetAgentId: "coder",
      status: "awaiting_accept",
    });
  });
});
