import * as crypto from "crypto";
import type { FeishuMessageEvent } from "./bot.js";
import type { GroupCoAddressMode } from "./mention.js";

export type CollaborationMode = Extract<GroupCoAddressMode, "peer_collab" | "coordinate">;
export type CollaborationProtocol = "runtime";
export type CollaborationPhase =
  | "initial_assessment"
  | "active_collab"
  | "awaiting_accept"
  | "blocked_need_info"
  | "completed";
export type CollaborationOwnershipClaim = "owner_candidate" | "supporting" | "observer";
export type CollaborationAllowedAction =
  | "collab_assess"
  | "collab_report_complete"
  | "agent_handoff"
  | "agent_handoff_cancel"
  | "agent_handoff_accept"
  | "agent_handoff_reject"
  | "agent_handoff_need_info"
  | "agent_handoff_complete"
  | "agent_handoff_expire"
  | "agent_handoff_superseded";

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
  taskId?: string;
  handoffId: string;
  agentId: string;
  completionStatus?: "complete";
  finalConclusion?: string;
};

export type CollaborationHandoffResolutionAction = {
  action: "agent_handoff_cancel" | "agent_handoff_expire" | "agent_handoff_superseded";
  taskId: string;
  handoffId: string;
  agentId: string;
};

export type CollaborationCompleteAction = {
  action: "agent_handoff_complete";
  taskId: string;
  agentId: string;
};

export type CollaborationReportCompleteAction = {
  action: "collab_report_complete";
  taskId: string;
  agentId: string;
};

export type CollaborationControlAction =
  | CollaborationAssessAction
  | CollaborationReportCompleteAction
  | CollaborationHandoffAction
  | CollaborationHandoffResponseAction
  | CollaborationHandoffResolutionAction
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
  chatId: string;
  threadKey: string;
  originMessageId: string;
  mode: CollaborationMode;
  protocol?: CollaborationProtocol;
  phase: CollaborationPhase;
  participants: string[];
  maxHops: number;
  handoffCount: number;
  autoTurnCount: number;
  currentOwner?: string;
  speakerToken?: string;
  currentTurnDispatchKey?: string;
  lastSpeakerId?: string;
  peerAssessmentDispatchedAgents: string[];
  coordinateDispatchedAgents: string[];
  coordinateCompletedAgents: string[];
  coordinateSummaryPending: boolean;
  coordinateSummaryDispatchKey?: string;
  assessments: Record<string, CollaborationAssessment>;
  activeHandoffState?: CollaborationActiveHandoffState;
  recentVisibleTurns: CollaborationVisibleTurn[];
  updatedAtMs: number;
};

export type CollaborationVisibleTurn = {
  agentId: string;
  text: string;
  timestampMs: number;
};

export type CollaborationRuntimeContext = {
  taskId: string;
  mode: CollaborationMode;
  protocol?: CollaborationProtocol;
  phase: CollaborationPhase;
  participants: string[];
  maxHops: number;
  handoffCount: number;
  autoTurnCount: number;
  currentOwner?: string;
  speakerToken?: string;
  isCurrentOwner: boolean;
  activeHandoff?: CollaborationActiveHandoffState;
  recentVisibleTurns: CollaborationVisibleTurn[];
  coordinateCompletedAgents?: string[];
  coordinateSummaryPending?: boolean;
  allowedActions: CollaborationAllowedAction[];
};

const collaborationStateByKey = new Map<string, CollaborationState>();
const collaborationStateByTaskId = new Map<string, CollaborationState>();
const collaborationTaskIdByThreadKey = new Map<string, string>();
const COLLABORATION_TERMINAL_TTL_MS = 10 * 60 * 1000;
const COLLABORATION_STALE_TTL_MS = 24 * 60 * 60 * 1000;

const CONTROL_BLOCK_PATTERN = /```openclaw-collab\s*([\s\S]*?)```/gu;
const CONTROL_ACTION_NAME_PATTERN =
  /"action"\s*:\s*"(collab_assess|collab_report_complete|agent_handoff|agent_handoff_accept|agent_handoff_reject|agent_handoff_need_info|agent_handoff_cancel|agent_handoff_expire|agent_handoff_superseded|agent_handoff_complete)"/u;
const PEER_AUTO_STOP_PATTERNS = [
  /(^|[：:，,。\s])(结论|总结|综合来看|整体来看|所以|因此|最终|一句话结论|最终结论)/u,
  /(已经|可以)(收口|总结|得出结论)/u,
];

function hashText(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 12);
}

export function buildCollaborationStateKey(params: {
  chatId: string;
  rootId?: string;
  threadId?: string;
  messageId: string;
}): string {
  return `${params.chatId.trim()}:${params.messageId.trim()}`;
}

export function buildCollaborationThreadKey(params: {
  chatId: string;
  rootId?: string;
  threadId?: string;
  messageId: string;
}): string {
  const scopedThreadId = params.rootId?.trim() || params.threadId?.trim();
  if (scopedThreadId) {
    return `${params.chatId.trim()}:thread:${scopedThreadId}`;
  }
  return `${params.chatId.trim()}:message:${params.messageId.trim()}`;
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
    autoTurnCount: 0,
    currentTurnDispatchKey: undefined,
    updatedAtMs: Date.now(),
  };
  collaborationStateByKey.set(state.stateKey, nextState);
  collaborationStateByTaskId.set(state.taskId, nextState);
  return nextState;
}

function replaceState(state: CollaborationState): CollaborationState {
  const nextState = {
    ...state,
    updatedAtMs: Date.now(),
  };
  collaborationStateByKey.set(nextState.stateKey, nextState);
  collaborationStateByTaskId.set(nextState.taskId, nextState);
  collaborationTaskIdByThreadKey.set(nextState.threadKey, nextState.taskId);
  return nextState;
}

function computeVisibleTurnRetentionLimit(state: CollaborationState): number {
  return Math.min(12, Math.max(6, Math.max(1, state.participants.length) * Math.max(1, state.maxHops + 1)));
}

function normalizeParticipants(participants: string[]): string[] {
  return [...new Set(participants.map((value) => value.trim()).filter(Boolean))];
}

function haveSameParticipants(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

export function ensureCollaborationState(params: {
  chatId: string;
  rootId?: string;
  threadId?: string;
  messageId: string;
  mode: CollaborationMode;
  participants: string[];
  maxHops: number;
  explicitMode?: Exclude<GroupCoAddressMode, "none">;
}): CollaborationState {
  sweepExpiredCollaborationStates();
  const stateKey = buildCollaborationStateKey(params);
  const threadKey = buildCollaborationThreadKey(params);
  const normalizedParticipants = normalizeParticipants(params.participants);
  const existing = collaborationStateByKey.get(stateKey);
  if (existing) {
    const mergedParticipants = normalizeParticipants([...existing.participants, ...normalizedParticipants]);
    const nextState =
      mergedParticipants.length === existing.participants.length
        ? existing
        : { ...existing, participants: mergedParticipants, updatedAtMs: Date.now() };
    collaborationStateByKey.set(stateKey, nextState);
    collaborationStateByTaskId.set(nextState.taskId, nextState);
    return nextState;
  }
  const existingThreadTaskId = collaborationTaskIdByThreadKey.get(threadKey);
  if (existingThreadTaskId) {
    const existingThreadState = collaborationStateByTaskId.get(existingThreadTaskId);
    if (
      existingThreadState &&
      !isTerminalCollaborationPhase(existingThreadState.phase) &&
      existingThreadState.mode === params.mode &&
      haveSameParticipants(existingThreadState.participants, normalizedParticipants)
    ) {
      collaborationStateByKey.delete(existingThreadState.stateKey);
      const nextState = replaceState({
        ...existingThreadState,
        stateKey,
        chatId: params.chatId,
        threadKey,
        maxHops: Math.max(existingThreadState.maxHops, params.maxHops),
      });
      return nextState;
    }
  }
  const taskId = buildCollaborationTaskId(params);
  const protocol: CollaborationProtocol = "runtime";
  const nextState: CollaborationState = {
    stateKey,
    taskId,
    chatId: params.chatId,
    threadKey,
    originMessageId: params.messageId,
    mode: params.mode,
    protocol,
    phase: params.mode === "coordinate" ? "active_collab" : "initial_assessment",
    participants: normalizedParticipants,
    maxHops: params.maxHops,
    handoffCount: 0,
    autoTurnCount: 0,
    currentOwner: params.mode === "coordinate" ? "main" : undefined,
    speakerToken: params.mode === "coordinate" ? "main" : undefined,
    peerAssessmentDispatchedAgents: [],
    coordinateDispatchedAgents: [],
    coordinateCompletedAgents: [],
    coordinateSummaryPending: false,
    assessments: {},
    recentVisibleTurns: [],
    updatedAtMs: Date.now(),
  };
  collaborationStateByKey.set(stateKey, nextState);
  collaborationStateByTaskId.set(taskId, nextState);
  collaborationTaskIdByThreadKey.set(threadKey, taskId);
  return nextState;
}

export function recordCollaborationVisibleTurn(params: {
  taskId: string;
  agentId: string;
  text: string;
  timestampMs?: number;
}): CollaborationState | undefined {
  sweepExpiredCollaborationStates();
  const state = collaborationStateByTaskId.get(params.taskId);
  const text = params.text.trim();
  if (!state || !text) {
    return state;
  }
  const nextTurn = {
    agentId: params.agentId,
    text,
    timestampMs: params.timestampMs ?? Date.now(),
  };
  const previousTurns = state.recentVisibleTurns ?? [];
  const lastTurn = previousTurns[previousTurns.length - 1];
  if (lastTurn?.agentId === nextTurn.agentId && lastTurn.text === nextTurn.text) {
    return state;
  }
  const nextTurns = [...previousTurns, nextTurn].slice(-computeVisibleTurnRetentionLimit(state));
  return replaceState({
    ...state,
    recentVisibleTurns: nextTurns,
  });
}

function computePeerAutoTurnLimit(state: CollaborationState): number {
  return Math.max(1, state.participants.length - 1);
}

function shouldStopPeerAutoTurn(state: CollaborationState, speakerAgentId: string): boolean {
  const lastVisibleTurn = [...state.recentVisibleTurns]
    .reverse()
    .find((turn) => turn.agentId === speakerAgentId);
  return Boolean(lastVisibleTurn?.text && PEER_AUTO_STOP_PATTERNS.some((pattern) => pattern.test(lastVisibleTurn.text)));
}

export function resolveNextPeerAutoSpeaker(
  state: CollaborationState,
  speakerAgentId: string,
): string | undefined {
  if (state.mode !== "peer_collab" || state.participants.length <= 1) {
    return undefined;
  }
  if (!state.participants.includes(speakerAgentId)) {
    return undefined;
  }
  const spokenAgents = new Set(
    state.recentVisibleTurns
      .map((turn) => turn.agentId.trim())
      .filter(Boolean),
  );
  const unspokenParticipants = state.participants.filter(
    (participant) => participant !== speakerAgentId && !spokenAgents.has(participant),
  );
  if (unspokenParticipants.length > 0) {
    return unspokenParticipants[0];
  }
  const currentOwnerIndex = state.participants.indexOf(speakerAgentId);
  if (currentOwnerIndex < 0) {
    return undefined;
  }
  return state.participants[(currentOwnerIndex + 1 + state.participants.length) % state.participants.length];
}

export function advancePeerAutoTurn(
  taskId: string,
  agentId: string,
): CollaborationState | undefined {
  const state = collaborationStateByTaskId.get(taskId);
  if (
    !state ||
    state.mode !== "peer_collab" ||
    state.phase !== "active_collab" ||
    state.currentOwner !== agentId
  ) {
    return state;
  }
  const nextAutoTurnCount = state.autoTurnCount + 1;
  if (
    shouldStopPeerAutoTurn(state, agentId) ||
    nextAutoTurnCount > computePeerAutoTurnLimit(state) ||
    state.participants.length <= 1
  ) {
    return replaceState({
      ...state,
      phase: "completed",
      speakerToken: undefined,
      lastSpeakerId: agentId,
      autoTurnCount: nextAutoTurnCount,
      currentTurnDispatchKey: undefined,
    });
  }
  const nextOwner = resolveNextPeerAutoSpeaker(state, agentId);
  if (!nextOwner) {
    return replaceState({
      ...state,
      phase: "completed",
      speakerToken: undefined,
      lastSpeakerId: agentId,
      autoTurnCount: nextAutoTurnCount,
      currentTurnDispatchKey: undefined,
    });
  }
  return replaceState({
    ...state,
    currentOwner: nextOwner,
    speakerToken: nextOwner,
    lastSpeakerId: agentId,
    autoTurnCount: nextAutoTurnCount,
    currentTurnDispatchKey: undefined,
  });
}

function buildCurrentTurnDispatchKey(state: CollaborationState): string | undefined {
  if (
    state.phase !== "active_collab" ||
    !state.currentOwner ||
    !state.speakerToken
  ) {
    return undefined;
  }
  return `${state.phase}:${state.currentOwner}:${state.speakerToken}:${state.handoffCount}:${state.autoTurnCount}:${state.activeHandoffState?.handoffId ?? ""}`;
}

export function claimCurrentOwnerDispatch(taskId: string): CollaborationState | undefined {
  const state = collaborationStateByTaskId.get(taskId);
  if (!state) {
    return state;
  }
  const dispatchKey = buildCurrentTurnDispatchKey(state);
  if (!dispatchKey || state.currentTurnDispatchKey === dispatchKey) {
    return undefined;
  }
  return replaceState({
    ...state,
    currentTurnDispatchKey: dispatchKey,
  });
}

function removeCollaborationState(state: CollaborationState): void {
  collaborationStateByKey.delete(state.stateKey);
  collaborationStateByTaskId.delete(state.taskId);
  if (collaborationTaskIdByThreadKey.get(state.threadKey) === state.taskId) {
    collaborationTaskIdByThreadKey.delete(state.threadKey);
  }
}

function isTerminalCollaborationPhase(phase: CollaborationPhase): boolean {
  return phase === "completed";
}

function isExpiredCollaborationState(state: CollaborationState, now: number): boolean {
  const ttlMs = isTerminalCollaborationPhase(state.phase)
    ? COLLABORATION_TERMINAL_TTL_MS
    : COLLABORATION_STALE_TTL_MS;
  return now - state.updatedAtMs > ttlMs;
}

function sweepExpiredCollaborationStates(now = Date.now()): void {
  for (const state of collaborationStateByTaskId.values()) {
    if (isExpiredCollaborationState(state, now)) {
      removeCollaborationState(state);
    }
  }
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
  const targetAgentId =
    typeof action.targetAgentId === "string"
      ? action.targetAgentId
      : typeof action.handoffTo === "string"
        ? action.handoffTo
        : undefined;
  const fromAgentId =
    typeof action.fromAgentId === "string"
      ? action.fromAgentId
      : typeof action.agentId === "string"
        ? action.agentId
        : undefined;
  if (
    typeof action.taskId !== "string" ||
    !fromAgentId ||
    !targetAgentId
  ) {
    return null;
  }
  const evidencePaths = Array.isArray(action.evidencePaths)
    ? action.evidencePaths.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const handoffReason =
    typeof action.handoffReason === "string" ? action.handoffReason.trim() : undefined;
  return {
    action: "agent_handoff",
    taskId: action.taskId,
    handoffId:
      typeof action.handoffId === "string" && action.handoffId.trim().length > 0
        ? action.handoffId
        : `handoff_${hashText(JSON.stringify({ taskId: action.taskId, fromAgentId, targetAgentId, handoffReason }))}`,
    fromAgentId,
    targetAgentId,
    timeWindow: typeof action.timeWindow === "string" ? action.timeWindow : "",
    currentFinding:
      typeof action.currentFinding === "string"
        ? action.currentFinding
        : handoffReason ?? "",
    unresolvedQuestion:
      typeof action.unresolvedQuestion === "string"
        ? action.unresolvedQuestion
        : handoffReason ?? "",
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
  if (typeof action.handoffId !== "string" || typeof action.agentId !== "string") {
    return null;
  }
  return {
    action: action.action,
    taskId: typeof action.taskId === "string" ? action.taskId : undefined,
    handoffId: action.handoffId,
    agentId: action.agentId,
    completionStatus: action.completionStatus === "complete" ? "complete" : undefined,
    finalConclusion:
      typeof action.finalConclusion === "string" && action.finalConclusion.trim().length > 0
        ? action.finalConclusion.trim()
        : undefined,
  };
}

function toHandoffResolutionAction(value: unknown): CollaborationHandoffResolutionAction | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const action = value as Record<string, unknown>;
  if (
    action.action !== "agent_handoff_cancel" &&
    action.action !== "agent_handoff_expire" &&
    action.action !== "agent_handoff_superseded"
  ) {
    return null;
  }
  if (typeof action.handoffId !== "string" || typeof action.agentId !== "string") {
    return null;
  }
  return {
    action: action.action,
    taskId: typeof action.taskId === "string" ? action.taskId : undefined,
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

function toReportCompleteAction(value: unknown): CollaborationReportCompleteAction | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const action = value as Record<string, unknown>;
  if (action.action !== "collab_report_complete") {
    return null;
  }
  if (typeof action.taskId !== "string" || typeof action.agentId !== "string") {
    return null;
  }
  return {
    action: "collab_report_complete",
    taskId: action.taskId,
    agentId: action.agentId,
  };
}

export function parseCollaborationControlBlocks(text: string): {
  visibleText: string;
  actions: CollaborationControlAction[];
} {
  const actions: CollaborationControlAction[] = [];
  const tryParseKnownAction = (rawPayload: string): CollaborationControlAction | null => {
    try {
      const parsed = JSON.parse(rawPayload.trim()) as unknown;
      return (
        toAssessAction(parsed) ??
        toReportCompleteAction(parsed) ??
        toHandoffAction(parsed) ??
        toHandoffResponseAction(parsed) ??
        toHandoffResolutionAction(parsed) ??
        toCompleteAction(parsed)
      );
    } catch {
      return null;
    }
  };

  let visibleText = text
    .replace(CONTROL_BLOCK_PATTERN, (_, rawPayload: string) => {
      const action = tryParseKnownAction(rawPayload);
      if (action) {
        actions.push(action);
      }
      return "";
    });

  const incompleteFenceIndex = visibleText.indexOf("```openclaw-collab");
  if (incompleteFenceIndex >= 0) {
    visibleText = visibleText.slice(0, incompleteFenceIndex);
  }

  const trimmedRight = visibleText.trimEnd();
  const trailingJsonStart = Math.max(trimmedRight.lastIndexOf("\n{"), trimmedRight.startsWith("{") ? 0 : -1);
  if (trailingJsonStart >= 0) {
    const candidateStart =
      trailingJsonStart === 0 ? 0 : trailingJsonStart + 1;
    const candidate = trimmedRight.slice(candidateStart).trim();
    if (CONTROL_ACTION_NAME_PATTERN.test(candidate)) {
      const action = tryParseKnownAction(candidate);
      if (action) {
        actions.push(action);
      }
      visibleText = trimmedRight.slice(0, candidateStart);
    }
  }

  visibleText = visibleText.replace(/\n{3,}/g, "\n\n").trim();
  return {
    visibleText,
    actions,
  };
}

function resolveStateForHandoffAction(action: CollaborationControlAction): CollaborationState | undefined {
  if ("taskId" in action && typeof action.taskId === "string") {
    return collaborationStateByTaskId.get(action.taskId);
  }
  if (
    action.action === "agent_handoff_accept" ||
    action.action === "agent_handoff_reject" ||
    action.action === "agent_handoff_need_info"
  ) {
    return [...collaborationStateByTaskId.values()].find(
      (state) =>
        (state.phase === "awaiting_accept" || state.phase === "blocked_need_info") &&
        state.activeHandoffState?.handoffId === action.handoffId &&
        state.activeHandoffState.targetAgentId === action.agentId,
    );
  }
  return undefined;
}

export function applyCollaborationActions(actions: CollaborationControlAction[]): CollaborationState[] {
  sweepExpiredCollaborationStates();
  const touchedStates: CollaborationState[] = [];
  for (const action of actions) {
    const state = resolveStateForHandoffAction(action);
    if (!state) {
      continue;
    }
    if (
      (action.action === "collab_assess" || action.action === "collab_report_complete") &&
      !state.participants.includes(action.agentId)
    ) {
      continue;
    }
    if (action.action === "collab_report_complete") {
      if (
        state.mode !== "coordinate" ||
        state.phase !== "active_collab" ||
        action.agentId === "main"
      ) {
        continue;
      }
      const nextState = markCoordinateParticipantCompleted(state.taskId, action.agentId);
      if (nextState) {
        touchedStates.push(nextState);
      }
      continue;
    }
    if (action.action === "collab_assess") {
      if (state.mode !== "peer_collab" || state.phase !== "initial_assessment") {
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
      touchedStates.push(maybeAdvanceState(replaceState(nextState)));
      continue;
    }
    if (action.action === "agent_handoff") {
      if (
        state.handoffCount >= state.maxHops ||
        state.currentOwner !== action.fromAgentId ||
        !state.participants.includes(action.targetAgentId) ||
        (state.phase !== "active_collab" &&
          state.phase !== "blocked_need_info" &&
          !(
            state.phase === "awaiting_accept" &&
            state.activeHandoffState?.fromAgentId === action.fromAgentId
          ))
      ) {
        continue;
      }
      touchedStates.push(
        replaceState({
          ...state,
          phase: "awaiting_accept",
          speakerToken: action.targetAgentId,
          currentTurnDispatchKey: undefined,
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
    if (
      action.action === "agent_handoff_cancel" ||
      action.action === "agent_handoff_expire" ||
      action.action === "agent_handoff_superseded"
    ) {
      if (
        (state.phase !== "awaiting_accept" && state.phase !== "blocked_need_info") ||
        state.activeHandoffState?.handoffId !== action.handoffId ||
        state.currentOwner !== action.agentId ||
        state.activeHandoffState.fromAgentId !== action.agentId
      ) {
        continue;
      }
      touchedStates.push(
        replaceState({
          ...state,
          phase: "active_collab",
          speakerToken: state.currentOwner,
          currentTurnDispatchKey: undefined,
          activeHandoffState: undefined,
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
          phase: action.completionStatus === "complete" ? "completed" : "active_collab",
          handoffCount: state.handoffCount + 1,
          currentOwner: action.agentId,
          speakerToken: action.completionStatus === "complete" ? undefined : action.agentId,
          currentTurnDispatchKey: undefined,
          coordinateSummaryPending:
            action.completionStatus === "complete" ? false : state.coordinateSummaryPending,
          coordinateSummaryDispatchKey:
            action.completionStatus === "complete" ? undefined : state.coordinateSummaryDispatchKey,
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
          currentTurnDispatchKey: undefined,
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
          currentTurnDispatchKey: undefined,
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
          currentTurnDispatchKey: undefined,
          coordinateSummaryPending: false,
          coordinateSummaryDispatchKey: undefined,
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
  } else if (
    params.state.mode === "coordinate" &&
    params.state.phase === "active_collab" &&
    !isCurrentOwner &&
    params.agentId !== "main" &&
    params.state.participants.includes(params.agentId)
  ) {
    allowedActions.push("collab_report_complete");
  } else if (
    params.state.phase === "active_collab" &&
    isCurrentOwner &&
    !(params.state.mode === "coordinate" && params.state.coordinateSummaryPending)
  ) {
    if (params.state.handoffCount < params.state.maxHops) {
      allowedActions.push("agent_handoff");
    }
    allowedActions.push("agent_handoff_complete");
  } else if (
    params.state.phase === "awaiting_accept" &&
    activeHandoff?.targetAgentId === params.agentId
  ) {
    allowedActions.push("agent_handoff_accept", "agent_handoff_reject", "agent_handoff_need_info");
  } else if (
    params.state.phase === "awaiting_accept" &&
    isCurrentOwner &&
    activeHandoff?.fromAgentId === params.agentId
  ) {
    allowedActions.push("agent_handoff", "agent_handoff_cancel");
  } else if (params.state.phase === "blocked_need_info" && isCurrentOwner) {
    allowedActions.push("agent_handoff", "agent_handoff_cancel", "agent_handoff_complete");
  }
  return {
    taskId: params.state.taskId,
    mode: params.state.mode,
    protocol: params.state.protocol,
    phase: params.state.phase,
    participants: params.state.participants,
    maxHops: params.state.maxHops,
    handoffCount: params.state.handoffCount,
    autoTurnCount: params.state.autoTurnCount,
    currentOwner: params.state.currentOwner,
    speakerToken: params.state.speakerToken,
    isCurrentOwner,
    activeHandoff,
    recentVisibleTurns: params.state.recentVisibleTurns,
    coordinateCompletedAgents:
      params.state.mode === "coordinate" ? params.state.coordinateCompletedAgents : undefined,
    coordinateSummaryPending:
      params.state.mode === "coordinate" ? params.state.coordinateSummaryPending : undefined,
    allowedActions,
  };
}

export function markCoordinateParticipantCompleted(
  taskId: string,
  agentId: string,
): CollaborationState | undefined {
  sweepExpiredCollaborationStates();
  const state = collaborationStateByTaskId.get(taskId);
  if (
    !state ||
    state.mode !== "coordinate" ||
    agentId === "main" ||
    !state.participants.includes(agentId)
  ) {
    return state;
  }
  const nextCompletedAgents = normalizeParticipants([...state.coordinateCompletedAgents, agentId]);
  const specialistParticipants = state.participants.filter((participant) => participant !== "main");
  const coordinateSummaryPending = specialistParticipants.every((participant) =>
    nextCompletedAgents.includes(participant),
  );
  return replaceState({
    ...state,
    coordinateCompletedAgents: nextCompletedAgents,
    coordinateSummaryPending,
  });
}

export function claimCoordinateSummaryDispatch(taskId: string): CollaborationState | undefined {
  sweepExpiredCollaborationStates();
  const state = collaborationStateByTaskId.get(taskId);
  if (
    !state ||
    state.mode !== "coordinate" ||
    state.phase !== "active_collab" ||
    !state.coordinateSummaryPending ||
    state.coordinateSummaryDispatchKey
  ) {
    return undefined;
  }
  return replaceState({
    ...state,
    coordinateSummaryDispatchKey: `coordinate-summary:${state.taskId}`,
    currentOwner: "main",
    speakerToken: "main",
    currentTurnDispatchKey: undefined,
  });
}

export function completeCoordinateSummary(taskId: string): CollaborationState | undefined {
  sweepExpiredCollaborationStates();
  const state = collaborationStateByTaskId.get(taskId);
  if (
    !state ||
    state.mode !== "coordinate" ||
    state.phase !== "active_collab" ||
    !state.coordinateSummaryPending
  ) {
    return state;
  }
  return replaceState({
    ...state,
    phase: "completed",
    speakerToken: undefined,
    currentTurnDispatchKey: undefined,
    coordinateSummaryPending: false,
    coordinateSummaryDispatchKey: undefined,
  });
}

export function claimPendingCoordinateParticipants(taskId: string): {
  state?: CollaborationState;
  targets: string[];
} {
  sweepExpiredCollaborationStates();
  const state = collaborationStateByTaskId.get(taskId);
  if (
    !state ||
    state.mode !== "coordinate" ||
    state.phase !== "active_collab" ||
    state.currentOwner !== "main" ||
    state.activeHandoffState
  ) {
    return {
      state,
      targets: [],
    };
  }
  const targets = state.participants.filter(
    (agentId) =>
      agentId !== state.currentOwner && !state.coordinateDispatchedAgents.includes(agentId),
  );
  if (targets.length === 0) {
    return {
      state,
      targets,
    };
  }
  const nextState = replaceState({
    ...state,
    coordinateDispatchedAgents: [...state.coordinateDispatchedAgents, ...targets],
  });
  return {
    state: nextState,
    targets,
  };
}

export function claimPendingPeerAssessmentParticipants(params: {
  taskId: string;
  dispatchedAgentId?: string;
}): {
  state?: CollaborationState;
  targets: string[];
} {
  sweepExpiredCollaborationStates();
  const state = collaborationStateByTaskId.get(params.taskId);
  if (
    !state ||
    state.mode !== "peer_collab" ||
    state.phase !== "initial_assessment"
  ) {
    return {
      state,
      targets: [],
    };
  }
  const dispatched = new Set(state.peerAssessmentDispatchedAgents);
  const normalizedDispatchedAgentId = params.dispatchedAgentId?.trim();
  if (normalizedDispatchedAgentId && state.participants.includes(normalizedDispatchedAgentId)) {
    dispatched.add(normalizedDispatchedAgentId);
  }
  const targets = state.participants.filter((agentId) => !dispatched.has(agentId));
  if (
    targets.length === 0 &&
    state.peerAssessmentDispatchedAgents.length === dispatched.size
  ) {
    return {
      state,
      targets,
    };
  }
  const nextState = replaceState({
    ...state,
    peerAssessmentDispatchedAgents: [...dispatched, ...targets],
  });
  return {
    state: nextState,
    targets,
  };
}

export function clearCollaborationStateForTesting(): void {
  collaborationStateByKey.clear();
  collaborationStateByTaskId.clear();
  collaborationTaskIdByThreadKey.clear();
}

export function getCollaborationState(taskId: string): CollaborationState | undefined {
  sweepExpiredCollaborationStates();
  return collaborationStateByTaskId.get(taskId);
}

export function getActiveCollaborationStateForThread(params: {
  chatId: string;
  rootId?: string;
  threadId?: string;
}): CollaborationState | undefined {
  sweepExpiredCollaborationStates();
  const scopedThreadId = params.rootId?.trim() || params.threadId?.trim();
  if (!scopedThreadId) {
    return undefined;
  }
  const threadKey = `${params.chatId.trim()}:thread:${scopedThreadId}`;
  const taskId = collaborationTaskIdByThreadKey.get(threadKey);
  if (!taskId) {
    return undefined;
  }
  const state = collaborationStateByTaskId.get(taskId);
  if (!state || isTerminalCollaborationPhase(state.phase)) {
    return undefined;
  }
  return state;
}

export function getCollaborationStateForTesting(taskId: string): CollaborationState | undefined {
  return getCollaborationState(taskId);
}

export function sweepCollaborationStatesForTesting(now: number): void {
  sweepExpiredCollaborationStates(now);
}

export function getCollaborationStateStatsForTesting(): { byKey: number; byTaskId: number } {
  return {
    byKey: collaborationStateByKey.size,
    byTaskId: collaborationStateByTaskId.size,
  };
}

export function resolveCollaborationStateForMessage(params: {
  event: FeishuMessageEvent;
  mode: CollaborationMode;
  participants: string[];
  maxHops: number;
  explicitMode?: Exclude<GroupCoAddressMode, "none">;
}): CollaborationState {
  return ensureCollaborationState({
    chatId: params.event.message.chat_id,
    rootId: params.event.message.root_id,
    threadId: params.event.message.thread_id,
    messageId: params.event.message.message_id,
    mode: params.mode,
    participants: params.participants,
    maxHops: params.maxHops,
    explicitMode: params.explicitMode,
  });
}
