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

export type GroupCoAddressMode = "none" | "direct_reply" | "coordinate";

const GROUP_COORDINATION_PATTERNS = [
  /安排/u,
  /派单/u,
  /分工/u,
  /协调/u,
  /汇总/u,
  /拉通/u,
  /并行/u,
  /负责/u,
  /协作/u,
  /处理/u,
  /排查/u,
  /跟进/u,
  /让.+(看|查|处理|排查|汇报|回复)/u,
];

function extractEventText(event: FeishuMessageEvent): string {
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

export function isGroupCoordinationRequest(event: FeishuMessageEvent): boolean {
  if (event.message.chat_type !== "group") {
    return false;
  }
  const text = extractEventText(event);
  return GROUP_COORDINATION_PATTERNS.some((pattern) => pattern.test(text));
}

export function classifyGroupCoAddressMode(params: {
  event: FeishuMessageEvent;
  mentionedBotCount: number;
  mainMentioned: boolean;
}): GroupCoAddressMode {
  const { event, mentionedBotCount, mainMentioned } = params;
  if (event.message.chat_type !== "group" || mentionedBotCount < 2) {
    return "none";
  }
  if (!mainMentioned) {
    return "direct_reply";
  }
  return isGroupCoordinationRequest(event) ? "coordinate" : "direct_reply";
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
