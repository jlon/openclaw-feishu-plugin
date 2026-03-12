import * as crypto from "crypto";
import type { FeishuMessageEvent } from "./bot.js";
import type { GroupCoAddressMode } from "./mention.js";

export type CollaborationMode = Extract<GroupCoAddressMode, "peer_collab" | "coordinate">;
export type CollaborationPhase =
  | "initial_assessment"
  | "active_collab"
  | "awaiting_accept"
  | "blocked_need_info"
  | "completed";
export type CollaborationOwnershipClaim = "owner_candidate" | "supporting" | "observer";
export type CollaborationAllowedAction =
  | "collab_assess"
  | "agent_handoff"
  | "agent_handoff_accept"
  | "agent_handoff_reject"
  | "agent_handoff_need_info"
  | "agent_handoff_complete";

export type CollaborationAssessAction = {
  action: "collab_assess";
  taskId: string;
  agentId: string;
  ownershipClaim: CollaborationOwnershipClaim;
  currentFinding?: string;
  nextCheck?: string;
  needsWorker?: boolean;
};

export type CollaborationHandoffAction = {
  action: "agent_handoff";
  taskId: string;
  handoffId: string;
  fromAgentId: string;
  targetAgentId: string;
  timeWindow: string;
  currentFinding: string;
  unresolvedQuestion: string;
  evidencePaths: string[];
};

export type CollaborationHandoffResponseAction = {
  action: "agent_handoff_accept" | "agent_handoff_reject" | "agent_handoff_need_info";
  taskId: string;
  handoffId: string;
  agentId: string;
};

export type CollaborationCompleteAction = {
  action: "agent_handoff_complete";
  taskId: string;
  agentId: string;
};

export type CollaborationControlAction =
  | CollaborationAssessAction
  | CollaborationHandoffAction
  | CollaborationHandoffResponseAction
  | CollaborationCompleteAction;

export type CollaborationAssessment = Omit<CollaborationAssessAction, "action" | "taskId">;

export type CollaborationActiveHandoffState = {
  handoffId: string;
  fromAgentId: string;
  targetAgentId: string;
  status: "awaiting_accept" | "blocked_need_info";
  timeWindow: string;
  currentFinding: string;
  unresolvedQuestion: string;
  evidencePaths: string[];
};

export type CollaborationState = {
  stateKey: string;
  taskId: string;
  mode: CollaborationMode;
  phase: CollaborationPhase;
  participants: string[];
  currentOwner?: string;
  speakerToken?: string;
  assessments: Record<string, CollaborationAssessment>;
  activeHandoffState?: CollaborationActiveHandoffState;
};

export type CollaborationRuntimeContext = {
  taskId: string;
  mode: CollaborationMode;
  phase: CollaborationPhase;
  participants: string[];
  currentOwner?: string;
  speakerToken?: string;
  isCurrentOwner: boolean;
  activeHandoff?: CollaborationActiveHandoffState;
  allowedActions: CollaborationAllowedAction[];
};

const collaborationStateByKey = new Map<string, CollaborationState>();
const collaborationStateByTaskId = new Map<string, CollaborationState>();

const CONTROL_BLOCK_PATTERN = /```openclaw-collab\s*([\s\S]*?)```/gu;

function hashText(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 12);
}

export function buildCollaborationStateKey(params: {
  chatId: string;
  rootId?: string;
  threadId?: string;
  messageId: string;
}): string {
  const anchor = params.rootId?.trim() || params.threadId?.trim() || params.messageId.trim();
  return `${params.chatId.trim()}:${anchor}`;
}

export function buildCollaborationTaskId(params: {
  chatId: string;
  rootId?: string;
  threadId?: string;
  messageId: string;
}): string {
  return `task_${hashText(buildCollaborationStateKey(params))}`;
}

function pickOwner(state: CollaborationState): string | undefined {
  const ownerCandidate = state.participants.find(
    (agentId) => state.assessments[agentId]?.ownershipClaim === "owner_candidate",
  );
  if (ownerCandidate) {
    return ownerCandidate;
  }
  return state.participants.find((agentId) => state.assessments[agentId]?.ownershipClaim === "supporting");
}

function maybeAdvanceState(state: CollaborationState): CollaborationState {
  if (state.mode !== "peer_collab" || state.phase !== "initial_assessment") {
    return state;
  }
  const allAssessed = state.participants.every((agentId) => Boolean(state.assessments[agentId]));
  if (!allAssessed) {
    return state;
  }
  const nextOwner = pickOwner(state);
  if (!nextOwner) {
    return state;
  }
  const nextState = {
    ...state,
    phase: "active_collab" as const,
    currentOwner: nextOwner,
    speakerToken: nextOwner,
  };
  collaborationStateByKey.set(state.stateKey, nextState);
  collaborationStateByTaskId.set(state.taskId, nextState);
  return nextState;
}

function replaceState(state: CollaborationState): CollaborationState {
  collaborationStateByKey.set(state.stateKey, state);
  collaborationStateByTaskId.set(state.taskId, state);
  return state;
}

function normalizeParticipants(participants: string[]): string[] {
  return [...new Set(participants.map((value) => value.trim()).filter(Boolean))];
}

export function ensureCollaborationState(params: {
  chatId: string;
  rootId?: string;
  threadId?: string;
  messageId: string;
  mode: CollaborationMode;
  participants: string[];
}): CollaborationState {
  const stateKey = buildCollaborationStateKey(params);
  const normalizedParticipants = normalizeParticipants(params.participants);
  const existing = collaborationStateByKey.get(stateKey);
  if (existing) {
    const mergedParticipants = normalizeParticipants([...existing.participants, ...normalizedParticipants]);
    const nextState =
      mergedParticipants.length === existing.participants.length
        ? existing
        : { ...existing, participants: mergedParticipants };
    collaborationStateByKey.set(stateKey, nextState);
    collaborationStateByTaskId.set(nextState.taskId, nextState);
    return nextState;
  }
  const taskId = buildCollaborationTaskId(params);
  const nextState: CollaborationState = {
    stateKey,
    taskId,
    mode: params.mode,
    phase: params.mode === "coordinate" ? "active_collab" : "initial_assessment",
    participants: normalizedParticipants,
    currentOwner: params.mode === "coordinate" ? "main" : undefined,
    speakerToken: params.mode === "coordinate" ? "main" : undefined,
    assessments: {},
  };
  collaborationStateByKey.set(stateKey, nextState);
  collaborationStateByTaskId.set(taskId, nextState);
  return nextState;
}

function toAssessAction(value: unknown): CollaborationAssessAction | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const action = value as Record<string, unknown>;
  if (action.action !== "collab_assess") {
    return null;
  }
  if (
    typeof action.taskId !== "string" ||
    typeof action.agentId !== "string" ||
    (action.ownershipClaim !== "owner_candidate" &&
      action.ownershipClaim !== "supporting" &&
      action.ownershipClaim !== "observer")
  ) {
    return null;
  }
  return {
    action: "collab_assess",
    taskId: action.taskId,
    agentId: action.agentId,
    ownershipClaim: action.ownershipClaim,
    currentFinding: typeof action.currentFinding === "string" ? action.currentFinding : undefined,
    nextCheck: typeof action.nextCheck === "string" ? action.nextCheck : undefined,
    needsWorker: typeof action.needsWorker === "boolean" ? action.needsWorker : undefined,
  };
}

function toHandoffAction(value: unknown): CollaborationHandoffAction | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const action = value as Record<string, unknown>;
  if (action.action !== "agent_handoff") {
    return null;
  }
  if (
    typeof action.taskId !== "string" ||
    typeof action.handoffId !== "string" ||
    typeof action.fromAgentId !== "string" ||
    typeof action.targetAgentId !== "string" ||
    typeof action.timeWindow !== "string" ||
    typeof action.currentFinding !== "string" ||
    typeof action.unresolvedQuestion !== "string" ||
    !Array.isArray(action.evidencePaths)
  ) {
    return null;
  }
  const evidencePaths = action.evidencePaths.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (evidencePaths.length === 0) {
    return null;
  }
  return {
    action: "agent_handoff",
    taskId: action.taskId,
    handoffId: action.handoffId,
    fromAgentId: action.fromAgentId,
    targetAgentId: action.targetAgentId,
    timeWindow: action.timeWindow,
    currentFinding: action.currentFinding,
    unresolvedQuestion: action.unresolvedQuestion,
    evidencePaths,
  };
}

function toHandoffResponseAction(value: unknown): CollaborationHandoffResponseAction | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const action = value as Record<string, unknown>;
  if (
    action.action !== "agent_handoff_accept" &&
    action.action !== "agent_handoff_reject" &&
    action.action !== "agent_handoff_need_info"
  ) {
    return null;
  }
  if (
    typeof action.taskId !== "string" ||
    typeof action.handoffId !== "string" ||
    typeof action.agentId !== "string"
  ) {
    return null;
  }
  return {
    action: action.action,
    taskId: action.taskId,
    handoffId: action.handoffId,
    agentId: action.agentId,
  };
}

function toCompleteAction(value: unknown): CollaborationCompleteAction | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const action = value as Record<string, unknown>;
  if (action.action !== "agent_handoff_complete") {
    return null;
  }
  if (typeof action.taskId !== "string" || typeof action.agentId !== "string") {
    return null;
  }
  return {
    action: "agent_handoff_complete",
    taskId: action.taskId,
    agentId: action.agentId,
  };
}

export function parseCollaborationControlBlocks(text: string): {
  visibleText: string;
  actions: CollaborationControlAction[];
} {
  const actions: CollaborationControlAction[] = [];
  const visibleText = text
    .replace(CONTROL_BLOCK_PATTERN, (_, rawPayload: string) => {
      try {
        const parsed = JSON.parse(rawPayload.trim()) as unknown;
        const action =
          toAssessAction(parsed) ??
          toHandoffAction(parsed) ??
          toHandoffResponseAction(parsed) ??
          toCompleteAction(parsed);
        if (action) {
          actions.push(action);
        }
      } catch {}
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    visibleText,
    actions,
  };
}

export function applyCollaborationActions(actions: CollaborationControlAction[]): CollaborationState[] {
  const touchedStates: CollaborationState[] = [];
  for (const action of actions) {
    const state = collaborationStateByTaskId.get(action.taskId);
    if (!state) {
      continue;
    }
    if (action.action === "collab_assess" && !state.participants.includes(action.agentId)) {
      continue;
    }
    if (action.action === "collab_assess") {
      const nextState: CollaborationState = {
        ...state,
        assessments: {
          ...state.assessments,
          [action.agentId]: {
            agentId: action.agentId,
            ownershipClaim: action.ownershipClaim,
            currentFinding: action.currentFinding,
            nextCheck: action.nextCheck,
            needsWorker: action.needsWorker,
          },
        },
      };
      touchedStates.push(maybeAdvanceState(replaceState(nextState)));
      continue;
    }
    if (action.action === "agent_handoff") {
      if (
        state.currentOwner !== action.fromAgentId ||
        !state.participants.includes(action.targetAgentId) ||
        state.phase !== "active_collab"
      ) {
        continue;
      }
      touchedStates.push(
        replaceState({
          ...state,
          phase: "awaiting_accept",
          speakerToken: action.targetAgentId,
          activeHandoffState: {
            handoffId: action.handoffId,
            fromAgentId: action.fromAgentId,
            targetAgentId: action.targetAgentId,
            status: "awaiting_accept",
            timeWindow: action.timeWindow,
            currentFinding: action.currentFinding,
            unresolvedQuestion: action.unresolvedQuestion,
            evidencePaths: action.evidencePaths,
          },
        }),
      );
      continue;
    }
    if (action.action === "agent_handoff_accept") {
      if (
        state.phase !== "awaiting_accept" ||
        state.activeHandoffState?.handoffId !== action.handoffId ||
        state.activeHandoffState.targetAgentId !== action.agentId
      ) {
        continue;
      }
      touchedStates.push(
        replaceState({
          ...state,
          phase: "active_collab",
          currentOwner: action.agentId,
          speakerToken: action.agentId,
          activeHandoffState: undefined,
        }),
      );
      continue;
    }
    if (action.action === "agent_handoff_reject") {
      if (
        state.phase !== "awaiting_accept" ||
        state.activeHandoffState?.handoffId !== action.handoffId ||
        state.activeHandoffState.targetAgentId !== action.agentId
      ) {
        continue;
      }
      touchedStates.push(
        replaceState({
          ...state,
          phase: "active_collab",
          currentOwner: state.activeHandoffState.fromAgentId,
          speakerToken: state.activeHandoffState.fromAgentId,
          activeHandoffState: undefined,
        }),
      );
      continue;
    }
    if (action.action === "agent_handoff_need_info") {
      if (
        state.phase !== "awaiting_accept" ||
        state.activeHandoffState?.handoffId !== action.handoffId ||
        state.activeHandoffState.targetAgentId !== action.agentId
      ) {
        continue;
      }
      touchedStates.push(
        replaceState({
          ...state,
          phase: "blocked_need_info",
          currentOwner: state.activeHandoffState.fromAgentId,
          speakerToken: state.activeHandoffState.fromAgentId,
          activeHandoffState: {
            ...state.activeHandoffState,
            status: "blocked_need_info",
          },
        }),
      );
      continue;
    }
    if (action.action === "agent_handoff_complete") {
      if (!state.currentOwner || state.currentOwner !== action.agentId) {
        continue;
      }
      touchedStates.push(
        replaceState({
          ...state,
          phase: "completed",
          speakerToken: undefined,
          activeHandoffState: undefined,
        }),
      );
    }
  }
  return touchedStates;
}

export function buildCollaborationRuntimeContext(params: {
  state: CollaborationState;
  agentId: string;
}): CollaborationRuntimeContext {
  const isCurrentOwner = params.state.currentOwner === params.agentId;
  const activeHandoff = params.state.activeHandoffState;
  const allowedActions: CollaborationAllowedAction[] = [];
  if (params.state.mode === "peer_collab" && params.state.phase === "initial_assessment") {
    allowedActions.push("collab_assess");
  } else if (params.state.phase === "active_collab" && isCurrentOwner) {
    allowedActions.push("agent_handoff", "agent_handoff_complete");
  } else if (
    params.state.phase === "awaiting_accept" &&
    activeHandoff?.targetAgentId === params.agentId
  ) {
    allowedActions.push("agent_handoff_accept", "agent_handoff_reject", "agent_handoff_need_info");
  } else if (params.state.phase === "blocked_need_info" && isCurrentOwner) {
    allowedActions.push("agent_handoff", "agent_handoff_complete");
  }
  return {
    taskId: params.state.taskId,
    mode: params.state.mode,
    phase: params.state.phase,
    participants: params.state.participants,
    currentOwner: params.state.currentOwner,
    speakerToken: params.state.speakerToken,
    isCurrentOwner,
    activeHandoff,
    allowedActions,
  };
}

export function clearCollaborationStateForTesting(): void {
  collaborationStateByKey.clear();
  collaborationStateByTaskId.clear();
}

export function getCollaborationState(taskId: string): CollaborationState | undefined {
  return collaborationStateByTaskId.get(taskId);
}

export function getCollaborationStateForTesting(taskId: string): CollaborationState | undefined {
  return getCollaborationState(taskId);
}

export function resolveCollaborationStateForMessage(params: {
  event: FeishuMessageEvent;
  mode: CollaborationMode;
  participants: string[];
}): CollaborationState {
  return ensureCollaborationState({
    chatId: params.event.message.chat_id,
    rootId: params.event.message.root_id,
    threadId: params.event.message.thread_id,
    messageId: params.event.message.message_id,
    mode: params.mode,
    participants: params.participants,
  });
}
