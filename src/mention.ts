import type { FeishuMessageEvent } from "./bot.js";

/**
 * Escape regex metacharacters so user-controlled mention fields are treated literally.
 */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Mention target user info
 */
export type MentionTarget = {
  openId: string;
  name: string;
  key: string; // Placeholder in original message, e.g. @_user_1
};

export type GroupCoAddressMode = "none" | "direct_reply" | "peer_collab" | "coordinate";
export type GroupCoAddressIntent = {
  mode: GroupCoAddressMode;
  participants: string[];
  rawParticipants: string[];
  mainMentioned: boolean;
  rawEntryAccountId?: string;
};

const EXPLICIT_GROUP_MODE_PATTERN = /(?:^|\s)#(直答|协作|编排)(?=\s|$)/u;
const EXPLICIT_GROUP_MODE_WITH_PARTICIPANTS_PATTERN =
  /(?:^|\s)#(直答|协作|编排)\s*[\(\[（【]([^)）\]】]+)[\)）\]】]/u;

const GROUP_COORDINATION_PATTERNS = [
  /安排/u,
  /派单/u,
  /分工/u,
  /协调/u,
  /汇总/u,
  /拉通/u,
  /并行/u,
  /负责/u,
  /跟进/u,
  /总结/u,
  /统筹/u,
  /让.+(安排|协调|汇总|总结|统筹|跟进)/u,
  /最后.{0,8}(给我|给出|产出).{0,8}(结论|总结|汇总|答复)/u,
  /最后.{0,8}(总结|汇总).{0,8}(给我|出来|一下)/u,
  /统一(回复|口径|结论|总结)/u,
];

const GROUP_DIRECT_REPLY_PATTERNS = [
  /只(回复|用|说).{0,4}一个字/u,
  /只(回复|用|说).{0,4}一句话/u,
  /各用一句话/u,
  /各说一句/u,
  /各自说一句/u,
  /各自回复一句/u,
  /分别说一句/u,
  /分别回复一句/u,
  /各自介绍自己/u,
  /自我介绍/u,
  /介绍下自己/u,
  /打个招呼/u,
  /互相打个招呼/u,
  /一个字描述/u,
  /一句话介绍/u,
];

const GROUP_CONTINUATION_PATTERNS = [
  /继续/u,
  /再.+(讨论|往下|补充|聊|辩论)/u,
  /互相补充/u,
  /补充/u,
  /讨论/u,
  /辩论/u,
  /赞同/u,
  /反驳/u,
  /多次发表意见/u,
  /形成一句(话)?结论/u,
  /最后形成/u,
  /下钻/u,
];

function normalizeParticipants(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeExplicitParticipantToken(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

export function extractEventText(event: FeishuMessageEvent): string {
  const raw = event.message.content ?? "";
  try {
    const parsed = JSON.parse(raw) as { text?: unknown; body?: unknown };
    if (typeof parsed.text === "string" && parsed.text.trim()) {
      return parsed.text;
    }
    if (typeof parsed.body === "string" && parsed.body.trim()) {
      return parsed.body;
    }
    return JSON.stringify(parsed);
  } catch {
    return raw;
  }
}

export function extractExplicitGroupCoAddressMode(
  text: string,
): Exclude<GroupCoAddressMode, "none"> | undefined {
  const match =
    text.match(EXPLICIT_GROUP_MODE_WITH_PARTICIPANTS_PATTERN) ??
    text.match(EXPLICIT_GROUP_MODE_PATTERN);
  if (!match) {
    return undefined;
  }
  if (match[1] === "直答") {
    return "direct_reply";
  }
  if (match[1] === "协作") {
    return "peer_collab";
  }
  if (match[1] === "编排") {
    return "coordinate";
  }
  return undefined;
}

export function resolveExplicitGroupCoAddressParticipants(params: {
  text: string;
  knownAccountIds: readonly string[];
  botNameMap?: ReadonlyMap<string, string>;
}): string[] {
  const { text, knownAccountIds, botNameMap } = params;
  const match = text.match(EXPLICIT_GROUP_MODE_WITH_PARTICIPANTS_PATTERN);
  if (!match?.[2]) {
    return [];
  }
  const normalizedKnownAccounts = new Map(
    knownAccountIds
      .map((accountId) => [normalizeExplicitParticipantToken(accountId), accountId] as const)
      .filter(([normalized]) => normalized.length > 0),
  );
  const normalizedKnownNames = new Map(
    knownAccountIds
      .map(
        (accountId) =>
          [normalizeExplicitParticipantToken(botNameMap?.get(accountId)), accountId] as const,
      )
      .filter(([normalized]) => normalized.length > 0),
  );
  return [
    ...new Set(
      match[2]
        .split(/[，,、/|]/u)
        .map((token) => normalizeExplicitParticipantToken(token))
        .map(
          (normalized) =>
            normalizedKnownAccounts.get(normalized) ?? normalizedKnownNames.get(normalized),
        )
        .filter((accountId): accountId is string => Boolean(accountId)),
    ),
  ];
}

export function stripExplicitGroupCoAddressMode(text: string): {
  text: string;
  explicitMode?: Exclude<GroupCoAddressMode, "none">;
} {
  const explicitMode = extractExplicitGroupCoAddressMode(text);
  if (!explicitMode) {
    return { text };
  }
  return {
    text: text
      .replace(EXPLICIT_GROUP_MODE_WITH_PARTICIPANTS_PATTERN, " ")
      .replace(EXPLICIT_GROUP_MODE_PATTERN, " ")
      .replace(/\s+/gu, " ")
      .trim(),
    explicitMode,
  };
}

export function isGroupCoordinationRequest(event: FeishuMessageEvent): boolean {
  if (event.message.chat_type !== "group") {
    return false;
  }
  const text = extractEventText(event);
  return GROUP_COORDINATION_PATTERNS.some((pattern) => pattern.test(text));
}

export function isGroupDirectReplyRequest(event: FeishuMessageEvent): boolean {
  if (event.message.chat_type !== "group") {
    return false;
  }
  const text = extractEventText(event);
  return GROUP_DIRECT_REPLY_PATTERNS.some((pattern) => pattern.test(text));
}

export function isGroupContinuationRequest(event: FeishuMessageEvent): boolean {
  if (event.message.chat_type !== "group") {
    return false;
  }
  const text = extractEventText(event);
  return GROUP_CONTINUATION_PATTERNS.some((pattern) => pattern.test(text));
}

export function classifyGroupCoAddressMode(params: {
  event: FeishuMessageEvent;
  mentionedBotCount: number;
  mainMentioned: boolean;
}): GroupCoAddressMode {
  const { event, mentionedBotCount, mainMentioned } = params;
  if (event.message.chat_type !== "group") {
    return "none";
  }
  const explicitMode = extractExplicitGroupCoAddressMode(extractEventText(event));
  if (explicitMode) {
    return explicitMode;
  }
  if (mentionedBotCount < 2) {
    return "none";
  }
  if (isGroupCoordinationRequest(event)) {
    return "coordinate";
  }
  if (isGroupDirectReplyRequest(event) && !isGroupContinuationRequest(event)) {
    return "direct_reply";
  }
  return "peer_collab";
}

export function resolveGroupCoAddressIntent(params: {
  event: FeishuMessageEvent;
  mentionedBotAccountIds: readonly string[];
  knownAccountIds: readonly string[];
  botNameMap?: ReadonlyMap<string, string>;
  mainAccountId?: string;
  activeThreadMode?: Extract<GroupCoAddressMode, "peer_collab" | "coordinate">;
  activeThreadParticipants?: readonly string[];
}): GroupCoAddressIntent {
  const {
    event,
    mentionedBotAccountIds,
    knownAccountIds,
    botNameMap,
    mainAccountId = "main",
    activeThreadMode,
    activeThreadParticipants,
  } = params;
  const explicitParticipants = resolveExplicitGroupCoAddressParticipants({
    text: extractEventText(event),
    knownAccountIds,
    botNameMap,
  });
  let rawParticipants = normalizeParticipants(
    explicitParticipants.length > 0 ? explicitParticipants : [...mentionedBotAccountIds],
  );
  const explicitMode = extractExplicitGroupCoAddressMode(extractEventText(event));
  let mode = classifyGroupCoAddressMode({
    event,
    mentionedBotCount: rawParticipants.length,
    mainMentioned: rawParticipants.includes(mainAccountId) || explicitMode === "coordinate",
  });
  if (
    mode === "none" &&
    !explicitMode &&
    rawParticipants.length === 0 &&
    activeThreadMode &&
    activeThreadParticipants &&
    activeThreadParticipants.length > 0 &&
    isGroupContinuationRequest(event)
  ) {
    mode = activeThreadMode;
    rawParticipants = normalizeParticipants([mainAccountId, ...activeThreadParticipants]);
  }
  const mainMentioned = rawParticipants.includes(mainAccountId) || mode === "coordinate";
  let participants =
    mode === "peer_collab"
      ? rawParticipants.filter((participant) => participant !== mainAccountId)
      : rawParticipants;
  if (mode === "peer_collab" && participants.length < 2) {
    mode = "direct_reply";
    participants = rawParticipants;
  }
  return {
    mode,
    participants,
    rawParticipants,
    mainMentioned,
    rawEntryAccountId: mode === "none" ? undefined : mainAccountId,
  };
}

function extractMentionTargetsFromContent(
  event: FeishuMessageEvent,
  botOpenId?: string,
): MentionTarget[] {
  const raw = event.message.content ?? "";
  let text = raw;
  try {
    const parsed = JSON.parse(raw) as { text?: unknown; body?: unknown };
    if (typeof parsed.text === "string" && parsed.text.trim()) {
      text = parsed.text;
    } else if (typeof parsed.body === "string" && parsed.body.trim()) {
      text = parsed.body;
    }
  } catch {}
  const pattern = /<at\s+user_id="([^"]+)">([^<]+)<\/at>/gu;
  const results: MentionTarget[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null = null;

  while ((match = pattern.exec(text)) !== null) {
    const openId = match[1]?.trim();
    const name = match[2]?.trim();
    if (!openId || !name) {
      continue;
    }
    if (botOpenId && openId === botOpenId) {
      continue;
    }
    if (seen.has(openId)) {
      continue;
    }
    seen.add(openId);
    results.push({
      openId,
      name,
      key: `@content_${results.length + 1}`,
    });
  }

  return results;
}

/**
 * Extract mention targets from message event (excluding the bot itself)
 */
export function extractMentionTargets(
  event: FeishuMessageEvent,
  botOpenId?: string,
): MentionTarget[] {
  const fromContent = extractMentionTargetsFromContent(event, botOpenId);
  if (fromContent.length > 0) {
    return fromContent;
  }

  const mentions = event.message.mentions ?? [];

  return mentions
    .filter((m) => {
      // Exclude the bot itself
      if (botOpenId && m.id.open_id === botOpenId) {
        return false;
      }
      // Must have open_id
      return !!m.id.open_id;
    })
    .map((m) => ({
      openId: m.id.open_id!,
      name: m.name,
      key: m.key,
    }));
}

/**
 * Check if message is a mention forward request
 * Rules:
 * - DM/private: message mentions any user (no need to mention bot)
 *
 * Group mention-forward is intentionally disabled. In collaborative group chats,
 * "bot A + bot B" usually means both bots should answer as themselves, not that
 * one bot should auto-forward/auto-mention the other. Enabling mention-forward
 * in groups conflicts with multi-agent collaboration and causes role crossover.
 */
export function isMentionForwardRequest(event: FeishuMessageEvent, botOpenId?: string): boolean {
  const mentions = event.message.mentions ?? [];
  if (mentions.length === 0) {
    return false;
  }

  const isDirectMessage = event.message.chat_type !== "group";
  const hasOtherMention = mentions.some((m) => m.id.open_id !== botOpenId);

  if (isDirectMessage) {
    // DM/private: trigger if any non-bot user is mentioned
    return hasOtherMention;
  }
  return false;
}

/**
 * Extract message body from text (remove @ placeholders)
 */
export function extractMessageBody(text: string, allMentionKeys: string[]): string {
  let result = text;

  // Remove all @ placeholders
  for (const key of allMentionKeys) {
    result = result.replace(new RegExp(escapeRegExp(key), "g"), "");
  }

  return result.replace(/\s+/g, " ").trim();
}

/**
 * Format @mention for text message
 */
export function formatMentionForText(target: MentionTarget): string {
  return `<at user_id="${target.openId}">${target.name}</at>`;
}

/**
 * Format @everyone for text message
 */
export function formatMentionAllForText(): string {
  return `<at user_id="all">Everyone</at>`;
}

/**
 * Format @mention for card message (lark_md)
 */
export function formatMentionForCard(target: MentionTarget): string {
  return `<at id=${target.openId}></at>`;
}

/**
 * Format @everyone for card message
 */
export function formatMentionAllForCard(): string {
  return `<at id=all></at>`;
}

/**
 * Build complete message with @mentions (text format)
 */
export function buildMentionedMessage(targets: MentionTarget[], message: string): string {
  if (targets.length === 0) {
    return message;
  }

  const mentionParts = targets.map((t) => formatMentionForText(t));
  return `${mentionParts.join(" ")} ${message}`;
}

/**
 * Build card content with @mentions (Markdown format)
 */
export function buildMentionedCardContent(targets: MentionTarget[], message: string): string {
  if (targets.length === 0) {
    return message;
  }

  const mentionParts = targets.map((t) => formatMentionForCard(t));
  return `${mentionParts.join(" ")} ${message}`;
}
