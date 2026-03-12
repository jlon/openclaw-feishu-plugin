import * as crypto from "crypto";
import type { FeishuMessageEvent } from "./bot.js";
import type { GroupCoAddressMode } from "./mention.js";

export type CollaborationMode = Extract<GroupCoAddressMode, "peer_collab" | "coordinate">;
export type CollaborationPhase = "initial_assessment" | "active_collab";
export type CollaborationOwnershipClaim = "owner_candidate" | "supporting" | "observer";

export type CollaborationAssessAction = {
  action: "collab_assess";
  taskId: string;
  agentId: string;
  ownershipClaim: CollaborationOwnershipClaim;
  currentFinding?: string;
  nextCheck?: string;
  needsWorker?: boolean;
};

export type CollaborationControlAction = CollaborationAssessAction;

export type CollaborationAssessment = Omit<CollaborationAssessAction, "action" | "taskId">;

export type CollaborationState = {
  stateKey: string;
  taskId: string;
  mode: CollaborationMode;
  phase: CollaborationPhase;
  participants: string[];
  currentOwner?: string;
  speakerToken?: string;
  assessments: Record<string, CollaborationAssessment>;
};

export type CollaborationRuntimeContext = {
  taskId: string;
  mode: CollaborationMode;
  phase: CollaborationPhase;
  participants: string[];
  currentOwner?: string;
  speakerToken?: string;
  isCurrentOwner: boolean;
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

export function parseCollaborationControlBlocks(text: string): {
  visibleText: string;
  actions: CollaborationControlAction[];
} {
  const actions: CollaborationControlAction[] = [];
  const visibleText = text
    .replace(CONTROL_BLOCK_PATTERN, (_, rawPayload: string) => {
      try {
        const parsed = JSON.parse(rawPayload.trim()) as unknown;
        const action = toAssessAction(parsed);
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
    if (!state.participants.includes(action.agentId)) {
      continue;
    }
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
    collaborationStateByKey.set(nextState.stateKey, nextState);
    collaborationStateByTaskId.set(nextState.taskId, nextState);
    touchedStates.push(maybeAdvanceState(nextState));
  }
  return touchedStates;
}

export function buildCollaborationRuntimeContext(params: {
  state: CollaborationState;
  agentId: string;
}): CollaborationRuntimeContext {
  return {
    taskId: params.state.taskId,
    mode: params.state.mode,
    phase: params.state.phase,
    participants: params.state.participants,
    currentOwner: params.state.currentOwner,
    speakerToken: params.state.speakerToken,
    isCurrentOwner: params.state.currentOwner === params.agentId,
  };
}

export function clearCollaborationStateForTesting(): void {
  collaborationStateByKey.clear();
  collaborationStateByTaskId.clear();
}

export function getCollaborationStateForTesting(taskId: string): CollaborationState | undefined {
  return collaborationStateByTaskId.get(taskId);
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
