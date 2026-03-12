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
    });
  });
});
