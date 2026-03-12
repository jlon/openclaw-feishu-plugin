import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk/feishu";
import {
  buildAgentMediaPayload,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  createScopedPairingAccess,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
  issuePairingChallenge,
  normalizeAgentId,
  recordPendingHistoryEntryIfEnabled,
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { tryRecordMessage, tryRecordMessagePersistent } from "./dedup.js";
import { maybeCreateDynamicAgent } from "./dynamic-agent.js";
import { normalizeFeishuExternalKey } from "./external-keys.js";
import { downloadMessageResourceFeishu } from "./media.js";
import {
  classifyGroupCoAddressMode,
  extractMentionTargets,
  isMentionForwardRequest,
} from "./mention.js";
import {
  resolveFeishuGroupConfig,
  resolveFeishuReplyPolicy,
  resolveFeishuAllowlistMatch,
  isFeishuGroupAllowed,
} from "./policy.js";
import { parsePostContent } from "./post.js";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import { getFeishuRuntime } from "./runtime.js";
import { getMessageFeishu, sendMessageFeishu } from "./send.js";
import {
  buildCollaborationRuntimeContext,
  claimPendingCoordinateParticipants,
  getCollaborationState,
  resolveCollaborationStateForMessage,
  type CollaborationRuntimeContext,
} from "./collaboration.js";
import { botNames, botOpenIds } from "./monitor.state.js";
import type { FeishuMessageContext, FeishuMediaInfo, ResolvedFeishuAccount } from "./types.js";
import type { DynamicAgentCreationConfig } from "./types.js";

// --- Permission error extraction ---
// Extract permission grant URL from Feishu API error response.
type PermissionError = {
  code: number;
  message: string;
  grantUrl?: string;
};

const IGNORED_PERMISSION_SCOPE_TOKENS = ["contact:contact.base:readonly"];

// Feishu API sometimes returns incorrect scope names in permission error
// responses (e.g. "contact:contact.base:readonly" instead of the valid
// "contact:user.base:readonly"). This map corrects known mismatches.
const FEISHU_SCOPE_CORRECTIONS: Record<string, string> = {
  "contact:contact.base:readonly": "contact:user.base:readonly",
};

function correctFeishuScopeInUrl(url: string): string {
  let corrected = url;
  for (const [wrong, right] of Object.entries(FEISHU_SCOPE_CORRECTIONS)) {
    corrected = corrected.replaceAll(encodeURIComponent(wrong), encodeURIComponent(right));
    corrected = corrected.replaceAll(wrong, right);
  }
  return corrected;
}

function shouldSuppressPermissionErrorNotice(permissionError: PermissionError): boolean {
  const message = permissionError.message.toLowerCase();
  return IGNORED_PERMISSION_SCOPE_TOKENS.some((token) => message.includes(token));
}

function extractPermissionError(err: unknown): PermissionError | null {
  if (!err || typeof err !== "object") return null;

  // Axios error structure: err.response.data contains the Feishu error
  const axiosErr = err as { response?: { data?: unknown } };
  const data = axiosErr.response?.data;
  if (!data || typeof data !== "object") return null;

  const feishuErr = data as {
    code?: number;
    msg?: string;
    error?: { permission_violations?: Array<{ uri?: string }> };
  };

  // Feishu permission error code: 99991672
  if (feishuErr.code !== 99991672) return null;

  // Extract the grant URL from the error message (contains the direct link)
  const msg = feishuErr.msg ?? "";
  const urlMatch = msg.match(/https:\/\/[^\s,]+\/app\/[^\s,]+/);
  const grantUrl = urlMatch?.[0] ? correctFeishuScopeInUrl(urlMatch[0]) : undefined;

  return {
    code: feishuErr.code,
    message: msg,
    grantUrl,
  };
}

// --- Sender name resolution (so the agent can distinguish who is speaking in group chats) ---
// Cache display names by sender id (open_id/user_id) to avoid an API call on every message.
const SENDER_NAME_TTL_MS = 10 * 60 * 1000;
const senderNameCache = new Map<string, { name: string; expireAt: number }>();

// Cache permission errors to avoid spamming the user with repeated notifications.
// Key: appId or "default", Value: timestamp of last notification
const permissionErrorNotifiedAt = new Map<string, number>();
const PERMISSION_ERROR_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_COLLABORATION_MAX_HOPS = 3;

function sweepSenderNameCache(now = Date.now()): void {
  for (const [key, value] of senderNameCache.entries()) {
    if (value.expireAt <= now) {
      senderNameCache.delete(key);
    }
  }
}

function sweepPermissionErrorCache(now = Date.now()): void {
  for (const [key, value] of permissionErrorNotifiedAt.entries()) {
    if (now - value > PERMISSION_ERROR_COOLDOWN_MS) {
      permissionErrorNotifiedAt.delete(key);
    }
  }
}

type SenderNameResult = {
  name?: string;
  permissionError?: PermissionError;
};

function resolveSenderLookupIdType(senderId: string): "open_id" | "user_id" | "union_id" {
  const trimmed = senderId.trim();
  if (trimmed.startsWith("ou_")) {
    return "open_id";
  }
  if (trimmed.startsWith("on_")) {
    return "union_id";
  }
  return "user_id";
}

async function resolveFeishuSenderName(params: {
  account: ResolvedFeishuAccount;
  senderId: string;
  log: (...args: any[]) => void;
}): Promise<SenderNameResult> {
  const { account, senderId, log } = params;
  if (!account.configured) return {};

  const normalizedSenderId = senderId.trim();
  if (!normalizedSenderId) return {};

  sweepSenderNameCache();
  const cached = senderNameCache.get(normalizedSenderId);
  const now = Date.now();
  if (cached && cached.expireAt > now) return { name: cached.name };

  try {
    const client = createFeishuClient(account);
    const userIdType = resolveSenderLookupIdType(normalizedSenderId);

    // contact/v3/users/:user_id?user_id_type=<open_id|user_id|union_id>
    const res: any = await client.contact.user.get({
      path: { user_id: normalizedSenderId },
      params: { user_id_type: userIdType },
    });

    const name: string | undefined =
      res?.data?.user?.name ||
      res?.data?.user?.display_name ||
      res?.data?.user?.nickname ||
      res?.data?.user?.en_name;

    if (name && typeof name === "string") {
      senderNameCache.set(normalizedSenderId, { name, expireAt: now + SENDER_NAME_TTL_MS });
      return { name };
    }

    return {};
  } catch (err) {
    // Check if this is a permission error
    const permErr = extractPermissionError(err);
    if (permErr) {
      if (shouldSuppressPermissionErrorNotice(permErr)) {
        log(`feishu: ignoring stale permission scope error: ${permErr.message}`);
        return {};
      }
      log(`feishu: permission error resolving sender name: code=${permErr.code}`);
      return { permissionError: permErr };
    }

    // Best-effort. Don't fail message handling if name lookup fails.
    log(`feishu: failed to resolve sender name for ${normalizedSenderId}: ${String(err)}`);
    return {};
  }
}

export type FeishuMessageEvent = {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    chat_id: string;
    chat_type: "p2p" | "group" | "private";
    message_type: string;
    content: string;
    create_time?: string;
    mentions?: Array<{
      key: string;
      id: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
      name: string;
      tenant_key?: string;
    }>;
  };
};

export type FeishuBotAddedEvent = {
  chat_id: string;
  operator_id: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  external: boolean;
  operator_tenant_key?: string;
};

type GroupSessionScope = "group" | "group_sender" | "group_topic" | "group_topic_sender";

type ResolvedFeishuGroupSession = {
  peerId: string;
  parentPeer: { kind: "group"; id: string } | null;
  groupSessionScope: GroupSessionScope;
  replyInThread: boolean;
  threadReply: boolean;
};

function shouldSkipReplyToForSyntheticInbound(messageId: string | undefined): boolean {
  return (
    process.env.OPENCLAW_FEISHU_SYNTHETIC_NO_REPLY_TO === "1" &&
    typeof messageId === "string" &&
    messageId.startsWith("synthetic_")
  );
}

function shouldUseSyntheticMinimalBody(messageId: string | undefined): boolean {
  return (
    process.env.OPENCLAW_FEISHU_SYNTHETIC_MINIMAL_BODY === "1" &&
    typeof messageId === "string" &&
    messageId.startsWith("synthetic_")
  );
}

function resolveFeishuGroupSession(params: {
  chatId: string;
  senderOpenId: string;
  messageId: string;
  rootId?: string;
  threadId?: string;
  groupConfig?: {
    groupSessionScope?: GroupSessionScope;
    topicSessionMode?: "enabled" | "disabled";
    replyInThread?: "enabled" | "disabled";
  };
  feishuCfg?: {
    groupSessionScope?: GroupSessionScope;
    topicSessionMode?: "enabled" | "disabled";
    replyInThread?: "enabled" | "disabled";
  };
}): ResolvedFeishuGroupSession {
  const { chatId, senderOpenId, messageId, rootId, threadId, groupConfig, feishuCfg } = params;

  const normalizedThreadId = threadId?.trim();
  const normalizedRootId = rootId?.trim();
  const threadReply = Boolean(normalizedThreadId || normalizedRootId);
  const replyInThread =
    (groupConfig?.replyInThread ?? feishuCfg?.replyInThread ?? "disabled") === "enabled" ||
    threadReply;

  const legacyTopicSessionMode =
    groupConfig?.topicSessionMode ?? feishuCfg?.topicSessionMode ?? "disabled";
  const groupSessionScope: GroupSessionScope =
    groupConfig?.groupSessionScope ??
    feishuCfg?.groupSessionScope ??
    (legacyTopicSessionMode === "enabled" ? "group_topic" : "group");

  // Keep topic session keys stable across the "first turn creates thread" flow:
  // first turn may only have message_id, while the next turn carries root_id/thread_id.
  // Prefer root_id first so both turns stay on the same peer key.
  const topicScope =
    groupSessionScope === "group_topic" || groupSessionScope === "group_topic_sender"
      ? (normalizedRootId ?? normalizedThreadId ?? (replyInThread ? messageId : null))
      : null;

  let peerId = chatId;
  switch (groupSessionScope) {
    case "group_sender":
      peerId = `${chatId}:sender:${senderOpenId}`;
      break;
    case "group_topic":
      peerId = topicScope ? `${chatId}:topic:${topicScope}` : chatId;
      break;
    case "group_topic_sender":
      peerId = topicScope
        ? `${chatId}:topic:${topicScope}:sender:${senderOpenId}`
        : `${chatId}:sender:${senderOpenId}`;
      break;
    case "group":
    default:
      peerId = chatId;
      break;
  }

  const parentPeer =
    topicScope &&
    (groupSessionScope === "group_topic" || groupSessionScope === "group_topic_sender")
      ? {
          kind: "group" as const,
          id: chatId,
        }
      : null;

  return {
    peerId,
    parentPeer,
    groupSessionScope,
    replyInThread,
    threadReply,
  };
}

function parseMessageContent(content: string, messageType: string): string {
  if (messageType === "post") {
    // Extract text content from rich text post
    const { textContent } = parsePostContent(content);
    return textContent;
  }

  try {
    const parsed = JSON.parse(content);
    if (messageType === "text") {
      return parsed.text || "";
    }
    if (messageType === "share_chat") {
      // Preserve available summary text for merged/forwarded chat messages.
      if (parsed && typeof parsed === "object") {
        const share = parsed as {
          body?: unknown;
          summary?: unknown;
          share_chat_id?: unknown;
        };
        if (typeof share.body === "string" && share.body.trim().length > 0) {
          return share.body.trim();
        }
        if (typeof share.summary === "string" && share.summary.trim().length > 0) {
          return share.summary.trim();
        }
        if (typeof share.share_chat_id === "string" && share.share_chat_id.trim().length > 0) {
          return `[Forwarded message: ${share.share_chat_id.trim()}]`;
        }
      }
      return "[Forwarded message]";
    }
    if (messageType === "merge_forward") {
      // Return placeholder; actual content fetched asynchronously in handleFeishuMessage
      return "[Merged and Forwarded Message - loading...]";
    }
    return content;
  } catch {
    return content;
  }
}

/**
 * Parse merge_forward message content and fetch sub-messages.
 * Returns formatted text content of all sub-messages.
 */
function parseMergeForwardContent(params: {
  content: string;
  log?: (...args: any[]) => void;
}): string {
  const { content, log } = params;
  const maxMessages = 50;

  // For merge_forward, the API returns all sub-messages in items array
  // with upper_message_id pointing to the merge_forward message.
  // The 'content' parameter here is actually the full API response items array as JSON.
  log?.(`feishu: parsing merge_forward sub-messages from API response`);

  let items: Array<{
    message_id?: string;
    msg_type?: string;
    body?: { content?: string };
    sender?: { id?: string };
    upper_message_id?: string;
    create_time?: string;
  }>;

  try {
    items = JSON.parse(content);
  } catch {
    log?.(`feishu: merge_forward items parse failed`);
    return "[Merged and Forwarded Message - parse error]";
  }

  if (!Array.isArray(items) || items.length === 0) {
    return "[Merged and Forwarded Message - no sub-messages]";
  }

  // Filter to only sub-messages (those with upper_message_id, skip the merge_forward container itself)
  const subMessages = items.filter((item) => item.upper_message_id);

  if (subMessages.length === 0) {
    return "[Merged and Forwarded Message - no sub-messages found]";
  }

  log?.(`feishu: merge_forward contains ${subMessages.length} sub-messages`);

  // Sort by create_time
  subMessages.sort((a, b) => {
    const timeA = parseInt(a.create_time || "0", 10);
    const timeB = parseInt(b.create_time || "0", 10);
    return timeA - timeB;
  });

  // Format output
  const lines: string[] = ["[Merged and Forwarded Messages]"];
  const limitedMessages = subMessages.slice(0, maxMessages);

  for (const item of limitedMessages) {
    const msgContent = item.body?.content || "";
    const msgType = item.msg_type || "text";
    const formatted = formatSubMessageContent(msgContent, msgType);
    lines.push(`- ${formatted}`);
  }

  if (subMessages.length > maxMessages) {
    lines.push(`... and ${subMessages.length - maxMessages} more messages`);
  }

  return lines.join("\n");
}

/**
 * Format sub-message content based on message type.
 */
function formatSubMessageContent(content: string, contentType: string): string {
  try {
    const parsed = JSON.parse(content);
    switch (contentType) {
      case "text":
        return parsed.text || content;
      case "post": {
        const { textContent } = parsePostContent(content);
        return textContent;
      }
      case "image":
        return "[Image]";
      case "file":
        return `[File: ${parsed.file_name || "unknown"}]`;
      case "audio":
        return "[Audio]";
      case "video":
        return "[Video]";
      case "sticker":
        return "[Sticker]";
      case "merge_forward":
        return "[Nested Merged Forward]";
      default:
        return `[${contentType}]`;
    }
  } catch {
    return content;
  }
}

export function extractMentionedOpenIds(event: FeishuMessageEvent): string[] {
  const mentionedOpenIds = new Set(
    (event.message.mentions ?? [])
      .map((mention) => mention.id.open_id?.trim())
      .filter((openId): openId is string => Boolean(openId)),
  );
  if (event.message.message_type === "post") {
    for (const openId of parsePostContent(event.message.content).mentionedOpenIds) {
      const normalized = openId.trim();
      if (normalized) {
        mentionedOpenIds.add(normalized);
      }
    }
  }
  return [...mentionedOpenIds];
}

export function normalizeBotIdentifier(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function extractPlainTextContent(event: FeishuMessageEvent): string {
  const rawContent = event.message.content ?? "";
  if (!rawContent) {
    return "";
  }
  try {
    if (event.message.message_type === "text") {
      const parsed = JSON.parse(rawContent) as { text?: string };
      return parsed.text ?? rawContent;
    }
    if (event.message.message_type === "post") {
      return parsePostContent(rawContent).textContent;
    }
  } catch {
    return rawContent;
  }
  return rawContent;
}

export function extractMentionedBotTokensFromText(event: FeishuMessageEvent): string[] {
  const text = extractPlainTextContent(event);
  if (!text) {
    return [];
  }
  const tokens = new Set<string>();
  for (const match of text.matchAll(/(^|\s)@([^\s@]+)/gmu)) {
    const candidate = normalizeBotIdentifier(match[2]);
    if (candidate) {
      tokens.add(candidate);
    }
  }
  return [...tokens];
}

export function extractMentionedBotAccountIds(params: {
  event: FeishuMessageEvent;
  botOpenIdMap: ReadonlyMap<string, string>;
  botNameMap?: ReadonlyMap<string, string>;
}): string[] {
  const { event, botOpenIdMap, botNameMap = botNames } = params;
  const mentionedOpenIds = extractMentionedOpenIds(event);
  const mentionedNames = new Set(
    [
      ...(event.message.mentions ?? []).map((mention) => normalizeBotIdentifier(mention.name)),
      ...extractMentionedBotTokensFromText(event),
    ].filter((name) => Boolean(name)),
  );
  const mentionedAccountIds = new Set<string>();
  for (const [accountId, openId] of botOpenIdMap.entries()) {
    if (openId?.trim() && mentionedOpenIds.includes(openId.trim())) {
      mentionedAccountIds.add(accountId);
      continue;
    }
    const normalizedAccountId = normalizeBotIdentifier(accountId);
    const normalizedBotName = normalizeBotIdentifier(botNameMap.get(accountId));
    if (
      (normalizedAccountId && mentionedNames.has(normalizedAccountId)) ||
      (normalizedBotName && mentionedNames.has(normalizedBotName))
    ) {
      mentionedAccountIds.add(accountId);
    }
  }
  return [...mentionedAccountIds];
}

function checkBotMentioned(event: FeishuMessageEvent, botOpenId?: string, botName?: string): boolean {
  if (!botOpenId) return false;
  const rawContent = event.message.content ?? "";
  if (rawContent.includes("@_all")) return true;
  if (extractMentionedOpenIds(event).some((openId) => openId === botOpenId)) {
    return true;
  }
  const mentionedTextTokens = extractMentionedBotTokensFromText(event);
  const normalizedBotName = normalizeBotIdentifier(botName);
  const normalizedAccountId =
    normalizeBotIdentifier(
      [...botNames.entries()].find(([, name]) => normalizeBotIdentifier(name) === normalizedBotName)?.[0],
    ) || "";
  return Boolean(
    (normalizedBotName && mentionedTextTokens.includes(normalizedBotName)) ||
    (normalizedAccountId && mentionedTextTokens.includes(normalizedAccountId))
  );
}

function normalizeMentions(
  text: string,
  mentions?: FeishuMessageEvent["message"]["mentions"],
  botStripId?: string,
): string {
  if (!mentions || mentions.length === 0) return text;

  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapeName = (value: string) => value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let result = text;

  for (const mention of mentions) {
    const mentionId = mention.id.open_id;
    const replacement =
      botStripId && mentionId === botStripId
        ? ""
        : mentionId
          ? `<at user_id="${mentionId}">${escapeName(mention.name)}</at>`
          : `@${mention.name}`;

    result = result.replace(new RegExp(escaped(mention.key), "g"), () => replacement).trim();
  }

  return result;
}

function normalizeFeishuCommandProbeBody(text: string): string {
  if (!text) {
    return "";
  }
  return text
    .replace(/<at\b[^>]*>[^<]*<\/at>/giu, " ")
    .replace(/(^|\s)@[^/\s]+(?=\s|$|\/)/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse media keys from message content based on message type.
 */
function parseMediaKeys(
  content: string,
  messageType: string,
): {
  imageKey?: string;
  fileKey?: string;
  fileName?: string;
} {
  try {
    const parsed = JSON.parse(content);
    const imageKey = normalizeFeishuExternalKey(parsed.image_key);
    const fileKey = normalizeFeishuExternalKey(parsed.file_key);
    switch (messageType) {
      case "image":
        return { imageKey };
      case "file":
        return { fileKey, fileName: parsed.file_name };
      case "audio":
        return { fileKey };
      case "video":
      case "media":
        // Video/media has both file_key (video) and image_key (thumbnail)
        return { fileKey, imageKey };
      case "sticker":
        return { fileKey };
      default:
        return {};
    }
  } catch {
    return {};
  }
}

/**
 * Map Feishu message type to messageResource.get resource type.
 * Feishu messageResource API supports only: image | file.
 */
export function toMessageResourceType(messageType: string): "image" | "file" {
  return messageType === "image" ? "image" : "file";
}

/**
 * Infer placeholder text based on message type.
 */
function inferPlaceholder(messageType: string): string {
  switch (messageType) {
    case "image":
      return "<media:image>";
    case "file":
      return "<media:document>";
    case "audio":
      return "<media:audio>";
    case "video":
    case "media":
      return "<media:video>";
    case "sticker":
      return "<media:sticker>";
    default:
      return "<media:document>";
  }
}

/**
 * Resolve media from a Feishu message, downloading and saving to disk.
 * Similar to Discord's resolveMediaList().
 */
async function resolveFeishuMediaList(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  messageType: string;
  content: string;
  maxBytes: number;
  log?: (msg: string) => void;
  accountId?: string;
}): Promise<FeishuMediaInfo[]> {
  const { cfg, messageId, messageType, content, maxBytes, log, accountId } = params;

  // Only process media message types (including post for embedded images)
  const mediaTypes = ["image", "file", "audio", "video", "media", "sticker", "post"];
  if (!mediaTypes.includes(messageType)) {
    return [];
  }

  const out: FeishuMediaInfo[] = [];
  const core = getFeishuRuntime();

  // Handle post (rich text) messages with embedded images/media.
  if (messageType === "post") {
    const { imageKeys, mediaKeys: postMediaKeys } = parsePostContent(content);
    if (imageKeys.length === 0 && postMediaKeys.length === 0) {
      return [];
    }

    if (imageKeys.length > 0) {
      log?.(`feishu: post message contains ${imageKeys.length} embedded image(s)`);
    }
    if (postMediaKeys.length > 0) {
      log?.(`feishu: post message contains ${postMediaKeys.length} embedded media file(s)`);
    }

    for (const imageKey of imageKeys) {
      try {
        // Embedded images in post use messageResource API with image_key as file_key
        const result = await downloadMessageResourceFeishu({
          cfg,
          messageId,
          fileKey: imageKey,
          type: "image",
          accountId,
        });

        let contentType = result.contentType;
        if (!contentType) {
          contentType = await core.media.detectMime({ buffer: result.buffer });
        }

        const saved = await core.channel.media.saveMediaBuffer(
          result.buffer,
          contentType,
          "inbound",
          maxBytes,
        );

        out.push({
          path: saved.path,
          contentType: saved.contentType,
          placeholder: "<media:image>",
        });

        log?.(`feishu: downloaded embedded image ${imageKey}, saved to ${saved.path}`);
      } catch (err) {
        log?.(`feishu: failed to download embedded image ${imageKey}: ${String(err)}`);
      }
    }

    for (const media of postMediaKeys) {
      try {
        const result = await downloadMessageResourceFeishu({
          cfg,
          messageId,
          fileKey: media.fileKey,
          type: "file",
          accountId,
        });

        let contentType = result.contentType;
        if (!contentType) {
          contentType = await core.media.detectMime({ buffer: result.buffer });
        }

        const saved = await core.channel.media.saveMediaBuffer(
          result.buffer,
          contentType,
          "inbound",
          maxBytes,
        );

        out.push({
          path: saved.path,
          contentType: saved.contentType,
          placeholder: "<media:video>",
        });

        log?.(`feishu: downloaded embedded media ${media.fileKey}, saved to ${saved.path}`);
      } catch (err) {
        log?.(`feishu: failed to download embedded media ${media.fileKey}: ${String(err)}`);
      }
    }

    return out;
  }

  // Handle other media types
  const mediaKeys = parseMediaKeys(content, messageType);
  if (!mediaKeys.imageKey && !mediaKeys.fileKey) {
    return [];
  }

  try {
    let buffer: Buffer;
    let contentType: string | undefined;
    let fileName: string | undefined;

    // For message media, always use messageResource API
    // The image.get API is only for images uploaded via im/v1/images, not for message attachments
    const fileKey = mediaKeys.fileKey || mediaKeys.imageKey;
    if (!fileKey) {
      return [];
    }

    const resourceType = toMessageResourceType(messageType);
    const result = await downloadMessageResourceFeishu({
      cfg,
      messageId,
      fileKey,
      type: resourceType,
      accountId,
    });
    buffer = result.buffer;
    contentType = result.contentType;
    fileName = result.fileName || mediaKeys.fileName;

    // Detect mime type if not provided
    if (!contentType) {
      contentType = await core.media.detectMime({ buffer });
    }

    // Save to disk using core's saveMediaBuffer
    const saved = await core.channel.media.saveMediaBuffer(
      buffer,
      contentType,
      "inbound",
      maxBytes,
      fileName,
    );

    out.push({
      path: saved.path,
      contentType: saved.contentType,
      placeholder: inferPlaceholder(messageType),
    });

    log?.(`feishu: downloaded ${messageType} media, saved to ${saved.path}`);
  } catch (err) {
    log?.(`feishu: failed to download ${messageType} media: ${String(err)}`);
  }

  return out;
}

// --- Broadcast support ---
// Resolve broadcast agent list for a given peer (group) ID.
// Returns null if no broadcast config exists or the peer is not in the broadcast list.
export function resolveBroadcastAgents(cfg: ClawdbotConfig, peerId: string): string[] | null {
  const broadcast = (cfg as Record<string, unknown>).broadcast;
  if (!broadcast || typeof broadcast !== "object") return null;
  const agents = (broadcast as Record<string, unknown>)[peerId];
  if (!Array.isArray(agents) || agents.length === 0) return null;
  return agents as string[];
}

// Build a session key for a broadcast target agent by replacing the agent ID prefix.
// Session keys follow the format: agent:<agentId>:<channel>:<peerKind>:<peerId>
export function buildBroadcastSessionKey(
  baseSessionKey: string,
  originalAgentId: string,
  targetAgentId: string,
): string {
  const prefix = `agent:${originalAgentId}:`;
  if (baseSessionKey.startsWith(prefix)) {
    return `agent:${targetAgentId}:${baseSessionKey.slice(prefix.length)}`;
  }
  return baseSessionKey;
}

/**
 * Build media payload for inbound context.
 * Similar to Discord's buildDiscordMediaPayload().
 */
export function parseFeishuMessageEvent(
  event: FeishuMessageEvent,
  botOpenId?: string,
  botName?: string,
): FeishuMessageContext {
  const rawContent = parseMessageContent(event.message.content, event.message.message_type);
  const mentionedBot = checkBotMentioned(event, botOpenId, botName);
  const hasAnyMention = (event.message.mentions?.length ?? 0) > 0;
  // Strip the bot's own mention so slash commands like @Bot /help retain
  // the leading /. This applies in both p2p *and* group contexts — the
  // mentionedBot flag already captures whether the bot was addressed, so
  // keeping the mention tag in content only breaks command detection (#35994).
  // Non-bot mentions (e.g. mention-forward targets) are still normalized to <at> tags.
  const content = normalizeMentions(rawContent, event.message.mentions, botOpenId);
  const senderOpenId = event.sender.sender_id.open_id?.trim();
  const senderUserId = event.sender.sender_id.user_id?.trim();
  const senderFallbackId = senderOpenId || senderUserId || "";

  const ctx: FeishuMessageContext = {
    chatId: event.message.chat_id,
    messageId: event.message.message_id,
    senderId: senderUserId || senderOpenId || "",
    // Keep the historical field name, but fall back to user_id when open_id is unavailable
    // (common in some mobile app deliveries).
    senderOpenId: senderFallbackId,
    chatType: event.message.chat_type,
    mentionedBot,
    hasAnyMention,
    rootId: event.message.root_id || undefined,
    parentId: event.message.parent_id || undefined,
    threadId: event.message.thread_id || undefined,
    content,
    contentType: event.message.message_type,
  };

  // Detect mention forward request: message mentions bot + at least one other user
  if (isMentionForwardRequest(event, botOpenId)) {
    const mentionTargets = extractMentionTargets(event, botOpenId);
    if (mentionTargets.length > 0) {
      ctx.mentionTargets = mentionTargets;
    }
  }

  return ctx;
}

export function buildFeishuAgentBody(params: {
  ctx: Pick<
    FeishuMessageContext,
    | "content"
    | "senderName"
    | "senderOpenId"
    | "mentionTargets"
    | "messageId"
    | "hasAnyMention"
    | "collaboration"
  >;
  quotedContent?: string;
  permissionErrorForAgent?: PermissionError;
  botOpenId?: string;
  autoMentionTargets?: boolean;
  agentId?: string;
}): string {
  const { ctx, quotedContent, permissionErrorForAgent, botOpenId, agentId } = params;
  const autoMentionTargets = params.autoMentionTargets ?? true;
  const useSyntheticMinimalBody = shouldUseSyntheticMinimalBody(ctx.messageId);
  let messageBody = ctx.content;
  if (quotedContent) {
    messageBody = `[Replying to: "${quotedContent}"]\n\n${ctx.content}`;
  }

  // DMs already have per-sender sessions, but this label still improves attribution.
  const speaker = ctx.senderName ?? ctx.senderOpenId;
  messageBody = `${speaker}: ${messageBody}`;
  if (useSyntheticMinimalBody) {
    messageBody = `[message_id: ${ctx.messageId}]\n${messageBody}`;
  }

  if (ctx.hasAnyMention) {
    const botIdHint = botOpenId?.trim();
    messageBody +=
      `\n\n[System: The content may include mention tags in the form <at user_id="...">name</at>. ` +
      `Treat these as real mentions of Feishu entities (users or bots).]`;
    if (botIdHint) {
      messageBody += `\n[System: If user_id is "${botIdHint}", that mention refers to you.]`;
    }
  }

  if (ctx.mentionTargets && ctx.mentionTargets.length > 0) {
    const targetNames = ctx.mentionTargets.map((t) => t.name).join(", ");
    if (autoMentionTargets) {
      messageBody += `\n\n[System: Your reply will automatically @mention: ${targetNames}. Do not write @xxx yourself.]`;
    } else {
      messageBody +=
        `\n\n[System: The current turn mention target(s) ${targetNames} are part of the request context. ` +
        `Do not automatically @mention them in your reply.]`;
    }
    messageBody +=
      `\n[System: The current turn mention target(s) ${targetNames} are authoritative. ` +
      `Do not continue prior rounds with different agents or users unless they are explicitly mentioned again in this turn.]`;
  }

  if (ctx.groupCoAddressMode === "direct_reply") {
    messageBody +=
      `\n\n[System: This group message is co-addressed to multiple people or bots. ` +
      `Reply only for yourself. Assume the other mentioned participants will receive this same turn on their own. ` +
      `Do not delegate, do not call sessions_send, sessions_spawn, subagents, or message, ` +
      `and do not answer on behalf of anyone else.]` +
      `\n[System: Visible reply should be exactly one short sentence.]` +
      `\n[System: Do not cue another participant, do not say '把话头交给', '轮到谁', '收到', '两位都已回答', '协作完成', or similar follow-up lines.]` +
      `\n[System: After your one visible sentence, stop. Do not send follow-up confirmation or completion chatter.]`;
  } else if (ctx.groupCoAddressMode === "peer_collab") {
    messageBody +=
      `\n\n[System: This group message is a peer collaboration request among multiple bots. ` +
      `Reply only from your own role, give your own judgment or next action, keep it concise, ` +
      `do not answer on behalf of other bots, do not expose tool calls or internal routing in visible text, ` +
      `and do not call sessions_send, sessions_spawn, subagents, or message to move the baton.]`;
  } else if (ctx.groupCoAddressMode === "coordinate") {
    messageBody +=
      `\n\n[System: This group message is a coordination request. You are the coordinator for this turn. ` +
      `Delegate only when needed, and do not speak on behalf of other bots without their result.]`;
  }

  if (ctx.collaboration) {
    const collaboration = ctx.collaboration;
    messageBody +=
      `\n\n[System: Collaboration task ${collaboration.taskId}. ` +
      `Mode=${collaboration.mode}. Phase=${collaboration.phase}. Participants=${collaboration.participants.join(", ")}. ` +
      `HandoffDepth=${collaboration.handoffCount}/${collaboration.maxHops}.]`;
    if (collaboration.allowedActions.length > 0) {
      messageBody += `\n[System: AllowedActions=${collaboration.allowedActions.join(",")}.]`;
    }
    if (collaboration.phase === "initial_assessment" && collaboration.mode === "peer_collab" && agentId) {
      messageBody +=
        `\n[System: This is the initial assessment stage.]` +
        `\n[System: Visible reply should be exactly one short sentence about what you will inspect from your own side.]` +
        `\n[System: Do not ask the user follow-up questions during initial assessment.]` +
        `\n[System: Do not call sessions_send, sessions_spawn, subagents, or message during initial assessment.]` +
        `\n[System: After the visible reply, append exactly one hidden control block in this format:` +
        `\n\`\`\`openclaw-collab` +
        `\n{"action":"collab_assess","taskId":"${collaboration.taskId}","agentId":"${agentId}","ownershipClaim":"owner_candidate","currentFinding":"...","nextCheck":"...","needsWorker":false}` +
        `\n\`\`\`` +
        `\n[System: The hidden control block will be stripped before sending to Feishu.]`;
    } else if (collaboration.phase === "active_collab") {
      if (collaboration.isCurrentOwner) {
        const canHandoff = collaboration.allowedActions.includes("agent_handoff");
        if (collaboration.mode === "coordinate" && agentId === "main") {
          messageBody +=
            `\n[System: You are coordinating this task. Your visible reply should acknowledge the request, assign the relevant participants in parallel, and set the expected output.]` +
            `\n[System: In this first coordinator turn, do not append an agent_handoff control block. The mentioned specialists will be dispatched automatically.]` +
            `\n[System: Do not speak on behalf of specialists. Keep the visible reply to one or two short sentences.]`;
        } else {
          messageBody +=
            `\n[System: You are the current owner of this collaboration. Drive the next step and keep others in-role.]` +
            `\n[System: Do not call sessions_send, sessions_spawn, subagents, or message to make another participant speak. Use hidden control blocks only.]`;
          if (canHandoff) {
            messageBody +=
              `\n[System: Visible reply should first add one deeper point from your own role in one or two short sentences.]` +
              `\n[System: If you hand off, explicitly cue the next participant in plain words in the visible reply before the hidden control block.]` +
              `\n[System: After the visible baton cue, stop. Do not add extra '收到' or '等待对方' style follow-up lines.]` +
              `\n[System: If you need to pass the lead, append exactly one hidden control block in this format:` +
              `\n\`\`\`openclaw-collab` +
              `\n{"action":"agent_handoff","taskId":"${collaboration.taskId}","agentId":"${agentId}","handoffTo":"target-agent-id","handoffReason":"一句话说明为什么交给对方"}` +
              `\n\`\`\`` +
              `\n[System: If your current stage is complete, append exactly one hidden control block with action agent_handoff_complete.]`;
          } else {
            messageBody +=
              `\n[System: The handoff limit has been reached for this task.]` +
              `\n[System: Use the findings already gathered in this task to produce the best current conclusion you can from your role.]` +
              `\n[System: Do not defer the conclusion back to the user or ask another participant to finish it for you.]` +
              `\n[System: Finish from your own role and append exactly one hidden control block with action agent_handoff_complete.]`;
          }
        }
      } else if (collaboration.currentOwner) {
        if (collaboration.mode === "coordinate") {
          messageBody +=
            `\n[System: Current owner is ${collaboration.currentOwner}. You are participating as a specialist in a coordinated task.]` +
            `\n[System: Visible reply should be exactly one short sentence from your own role: your first check, finding, or next step.]` +
            `\n[System: Do not @ other participants, do not summarize for the coordinator, do not append completion chatter, and do not emit hidden control blocks unless AllowedActions explicitly says so.]`;
        } else {
          messageBody +=
            `\n[System: Current owner is ${collaboration.currentOwner}. Do not act as the main speaker unless the user re-addresses you.]`;
        }
      }
    } else if (collaboration.phase === "awaiting_accept" && collaboration.activeHandoff) {
      const activeHandoff = collaboration.activeHandoff;
      if (activeHandoff.targetAgentId === agentId) {
        messageBody += `\n[System: ${activeHandoff.fromAgentId} is handing this task to you.]`;
        if (activeHandoff.timeWindow) {
          messageBody += `\n[System: Known time window: ${activeHandoff.timeWindow}.]`;
        }
        if (activeHandoff.currentFinding) {
          messageBody += `\n[System: Current finding: ${activeHandoff.currentFinding}.]`;
        }
        if (activeHandoff.unresolvedQuestion) {
          messageBody += `\n[System: Unresolved question: ${activeHandoff.unresolvedQuestion}.]`;
        }
        if (activeHandoff.evidencePaths.length > 0) {
          messageBody += `\n[System: Evidence paths: ${activeHandoff.evidencePaths.join(", ")}.]`;
        }
        messageBody +=
          `\n[System: Visible reply should explicitly acknowledge the baton and continue from your own role in one or two short sentences before the hidden control block.]` +
          `\n[System: After the visible acknowledgement and your contribution, stop. Do not append extra completion chatter.]` +
          `\n[System: Do not call sessions_send, sessions_spawn, subagents, or message here. Accept, reject, or ask for missing information using the hidden control block only.]` +
          `\n[System: Reply briefly, then append exactly one hidden control block with action agent_handoff_accept, agent_handoff_reject, or agent_handoff_need_info using handoffId ${activeHandoff.handoffId}.]`;
      } else if (collaboration.isCurrentOwner) {
        messageBody +=
          `\n[System: Handoff ${activeHandoff.handoffId} is pending acceptance by ${activeHandoff.targetAgentId}.]` +
          `\n[System: You still own this task. Wait, cancel the handoff, or issue a replacement agent_handoff only if the target is wrong or no longer appropriate.]` +
          `\n[System: Do not call sessions_send, sessions_spawn, subagents, or message while this handoff is pending.]`;
      } else if (collaboration.currentOwner) {
        messageBody +=
          `\n[System: Handoff ${activeHandoff.handoffId} is pending acceptance by ${activeHandoff.targetAgentId}. Do not create another handoff until it resolves.]`;
      }
    } else if (collaboration.phase === "blocked_need_info" && collaboration.activeHandoff) {
      messageBody +=
        `\n[System: The current handoff is blocked waiting for more information from ${collaboration.activeHandoff.targetAgentId}.]`;
      if (collaboration.isCurrentOwner) {
        messageBody +=
          `\n[System: You still own this task. Provide the missing context, then either continue yourself or issue a new hidden agent_handoff control block.]` +
          `\n[System: Do not call sessions_send, sessions_spawn, subagents, or message while the handoff is blocked.]`;
      }
    } else if (collaboration.phase === "completed") {
      messageBody += `\n[System: This collaboration stage is completed. Do not reopen it unless the user adds new facts.]`;
    }
  }

  // Keep message_id on its own line so shared message-id hint stripping can parse it reliably.
  messageBody = `[message_id: ${ctx.messageId}]\n${messageBody}`;

  if (permissionErrorForAgent) {
    const grantUrl = permissionErrorForAgent.grantUrl ?? "";
    messageBody += `\n\n[System: The bot encountered a Feishu API permission error. Please inform the user about this issue and provide the permission grant URL for the admin to authorize. Permission grant URL: ${grantUrl}]`;
  }

  return messageBody;
}

export async function handleFeishuMessage(params: {
  cfg: ClawdbotConfig;
  event: FeishuMessageEvent;
  botOpenId?: string;
  botName?: string;
  runtime?: RuntimeEnv;
  chatHistories?: Map<string, HistoryEntry[]>;
  accountId?: string;
}): Promise<void> {
  const { cfg, event, botOpenId, botName, runtime, chatHistories, accountId } = params;

  // Resolve account with merged config
  const account = resolveFeishuAccount({ cfg, accountId });
  const feishuCfg = account.config;

  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  // Dedup: synchronous memory guard prevents concurrent duplicate dispatch
  // before the async persistent check completes.
  const messageId = event.message.message_id;
  const memoryDedupeKey = `${account.accountId}:${messageId}`;
  if (!tryRecordMessage(memoryDedupeKey)) {
    log(`feishu: skipping duplicate message ${messageId} (memory dedup)`);
    return;
  }
  // Persistent dedup survives restarts and reconnects.
  if (!(await tryRecordMessagePersistent(messageId, account.accountId, log))) {
    log(`feishu: skipping duplicate message ${messageId}`);
    return;
  }

  let ctx = parseFeishuMessageEvent(event, botOpenId, botName);
  const isGroup = ctx.chatType === "group";
  const isDirect = !isGroup;
  const senderUserId = event.sender.sender_id.user_id?.trim() || undefined;
  let collaborationState:
    | ReturnType<typeof resolveCollaborationStateForMessage>
    | undefined;
  if (isGroup) {
    const mentionedBotAccountIds = extractMentionedBotAccountIds({
      event,
      botOpenIdMap: botOpenIds,
      botNameMap: botNames,
    });
    const mainMentioned = mentionedBotAccountIds.includes("main");
    const groupCoAddressMode = classifyGroupCoAddressMode({
      event,
      mentionedBotCount: mentionedBotAccountIds.length,
      mainMentioned,
    });
    if (groupCoAddressMode !== "none") {
      ctx = { ...ctx, groupCoAddressMode };
      if (groupCoAddressMode === "peer_collab" || groupCoAddressMode === "coordinate") {
        const collaborationMaxHops =
          feishuCfg?.accounts?.[account.accountId]?.collaboration?.maxHops ??
          feishuCfg?.collaboration?.maxHops ??
          DEFAULT_COLLABORATION_MAX_HOPS;
        collaborationState = resolveCollaborationStateForMessage({
          event,
          mode: groupCoAddressMode,
          participants: mentionedBotAccountIds,
          maxHops: collaborationMaxHops,
        });
      }
    }
  }

  // Handle merge_forward messages: fetch full message via API then expand sub-messages
  if (event.message.message_type === "merge_forward") {
    log(
      `feishu[${account.accountId}]: processing merge_forward message, fetching full content via API`,
    );
    try {
      // Websocket event doesn't include sub-messages, need to fetch via API
      // The API returns all sub-messages in the items array
      const client = createFeishuClient(account);
      const response = (await client.im.message.get({
        path: { message_id: event.message.message_id },
      })) as { code?: number; data?: { items?: unknown[] } };

      if (response.code === 0 && response.data?.items && response.data.items.length > 0) {
        log(
          `feishu[${account.accountId}]: merge_forward API returned ${response.data.items.length} items`,
        );
        const expandedContent = parseMergeForwardContent({
          content: JSON.stringify(response.data.items),
          log,
        });
        ctx = { ...ctx, content: expandedContent };
      } else {
        log(`feishu[${account.accountId}]: merge_forward API returned no items`);
        ctx = { ...ctx, content: "[Merged and Forwarded Message - could not fetch]" };
      }
    } catch (err) {
      log(`feishu[${account.accountId}]: merge_forward fetch failed: ${String(err)}`);
      ctx = { ...ctx, content: "[Merged and Forwarded Message - fetch error]" };
    }
  }

  // Resolve sender display name (best-effort) so the agent can attribute messages correctly.
  // Optimization: skip if disabled to save API quota (Feishu free tier limit).
  let permissionErrorForAgent: PermissionError | undefined;
  if (feishuCfg?.resolveSenderNames ?? true) {
    const senderResult = await resolveFeishuSenderName({
      account,
      senderId: ctx.senderOpenId,
      log,
    });
    if (senderResult.name) ctx = { ...ctx, senderName: senderResult.name };

    // Track permission error to inform agent later (with cooldown to avoid repetition)
    if (senderResult.permissionError) {
      const appKey = account.appId ?? "default";
      const now = Date.now();
      sweepPermissionErrorCache(now);
      const lastNotified = permissionErrorNotifiedAt.get(appKey) ?? 0;

      if (now - lastNotified > PERMISSION_ERROR_COOLDOWN_MS) {
        permissionErrorNotifiedAt.set(appKey, now);
        permissionErrorForAgent = senderResult.permissionError;
      }
    }
  }

  log(
    `feishu[${account.accountId}]: received message from ${ctx.senderOpenId} in ${ctx.chatId} (${ctx.chatType})`,
  );

  // Log mention targets if detected
  if (ctx.mentionTargets && ctx.mentionTargets.length > 0) {
    const names = ctx.mentionTargets.map((t) => t.name).join(", ");
    log(`feishu[${account.accountId}]: detected @ forward request, targets: [${names}]`);
  }

  const historyLimit = Math.max(
    0,
    feishuCfg?.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupConfig = isGroup
    ? resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: ctx.chatId })
    : undefined;
  const groupSession = isGroup
    ? resolveFeishuGroupSession({
        chatId: ctx.chatId,
        senderOpenId: ctx.senderOpenId,
        messageId: ctx.messageId,
        rootId: ctx.rootId,
        threadId: ctx.threadId,
        groupConfig,
        feishuCfg,
      })
    : null;
  const groupHistoryKey = isGroup ? (groupSession?.peerId ?? ctx.chatId) : undefined;
  const dmPolicy = feishuCfg?.dmPolicy ?? "pairing";
  const configAllowFrom = feishuCfg?.allowFrom ?? [];
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const rawBroadcastAgents = isGroup ? resolveBroadcastAgents(cfg, ctx.chatId) : null;
  const broadcastAgents = rawBroadcastAgents
    ? [...new Set(rawBroadcastAgents.map((id) => normalizeAgentId(id)))]
    : null;

  let requireMention = false; // DMs never require mention; groups may override below
  if (isGroup) {
    if (groupConfig?.enabled === false) {
      log(`feishu[${account.accountId}]: group ${ctx.chatId} is disabled`);
      return;
    }
    const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
    const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.feishu !== undefined,
      groupPolicy: feishuCfg?.groupPolicy,
      defaultGroupPolicy,
    });
    warnMissingProviderGroupPolicyFallbackOnce({
      providerMissingFallbackApplied,
      providerKey: "feishu",
      accountId: account.accountId,
      log,
    });
    const groupAllowFrom = feishuCfg?.groupAllowFrom ?? [];
    // DEBUG: log(`feishu[${account.accountId}]: groupPolicy=${groupPolicy}`);

    // Check if this GROUP is allowed (groupAllowFrom contains group IDs like oc_xxx, not user IDs)
    const groupAllowed = isFeishuGroupAllowed({
      groupPolicy,
      allowFrom: groupAllowFrom,
      senderId: ctx.chatId, // Check group ID, not sender ID
      senderName: undefined,
    });

    if (!groupAllowed) {
      log(
        `feishu[${account.accountId}]: group ${ctx.chatId} not in groupAllowFrom (groupPolicy=${groupPolicy})`,
      );
      return;
    }

    // Sender-level allowlist: per-group allowFrom takes precedence, then global groupSenderAllowFrom
    const perGroupSenderAllowFrom = groupConfig?.allowFrom ?? [];
    const globalSenderAllowFrom = feishuCfg?.groupSenderAllowFrom ?? [];
    const effectiveSenderAllowFrom =
      perGroupSenderAllowFrom.length > 0 ? perGroupSenderAllowFrom : globalSenderAllowFrom;
    if (effectiveSenderAllowFrom.length > 0) {
      const senderAllowed = isFeishuGroupAllowed({
        groupPolicy: "allowlist",
        allowFrom: effectiveSenderAllowFrom,
        senderId: ctx.senderOpenId,
        senderIds: [senderUserId],
        senderName: ctx.senderName,
      });
      if (!senderAllowed) {
        log(`feishu: sender ${ctx.senderOpenId} not in group ${ctx.chatId} sender allowlist`);
        return;
      }
    }

    ({ requireMention } = resolveFeishuReplyPolicy({
      isDirectMessage: false,
      globalConfig: feishuCfg,
      groupConfig,
    }));

    if (requireMention && !ctx.mentionedBot) {
      log(`feishu[${account.accountId}]: message in group ${ctx.chatId} did not mention bot`);
      // Record to pending history for non-broadcast groups only. For broadcast groups,
      // the mentioned handler's broadcast dispatch writes the turn directly into all
      // agent sessions — buffering here would cause duplicate replay when this account
      // later becomes active via buildPendingHistoryContextFromMap.
      if (!broadcastAgents && chatHistories && groupHistoryKey) {
        recordPendingHistoryEntryIfEnabled({
          historyMap: chatHistories,
          historyKey: groupHistoryKey,
          limit: historyLimit,
          entry: {
            sender: ctx.senderOpenId,
            body: `${ctx.senderName ?? ctx.senderOpenId}: ${ctx.content}`,
            timestamp: Date.now(),
            messageId: ctx.messageId,
          },
        });
      }
      return;
    }
  } else {
  }

  try {
    const core = getFeishuRuntime();
    const pairing = createScopedPairingAccess({
      core,
      channel: "feishu",
      accountId: account.accountId,
    });
    const commandProbeBody = isGroup ? normalizeFeishuCommandProbeBody(ctx.content) : ctx.content;
    const shouldComputeCommandAuthorized = core.channel.commands.shouldComputeCommandAuthorized(
      commandProbeBody,
      cfg,
    );
    const storeAllowFrom =
      !isGroup &&
      dmPolicy !== "allowlist" &&
      (dmPolicy !== "open" || shouldComputeCommandAuthorized)
        ? await pairing.readAllowFromStore().catch(() => [])
        : [];
    const effectiveDmAllowFrom = [...configAllowFrom, ...storeAllowFrom];
    const dmAllowed = resolveFeishuAllowlistMatch({
      allowFrom: effectiveDmAllowFrom,
      senderId: ctx.senderOpenId,
      senderIds: [senderUserId],
      senderName: ctx.senderName,
    }).allowed;

    if (isDirect && dmPolicy !== "open" && !dmAllowed) {
      if (dmPolicy === "pairing") {
        await issuePairingChallenge({
          channel: "feishu",
          senderId: ctx.senderOpenId,
          senderIdLine: `Your Feishu user id: ${ctx.senderOpenId}`,
          meta: { name: ctx.senderName },
          upsertPairingRequest: pairing.upsertPairingRequest,
          onCreated: () => {
            log(`feishu[${account.accountId}]: pairing request sender=${ctx.senderOpenId}`);
          },
          sendPairingReply: async (text) => {
            await sendMessageFeishu({
              cfg,
              to: `chat:${ctx.chatId}`,
              text,
              accountId: account.accountId,
            });
          },
          onReplyError: (err) => {
            log(
              `feishu[${account.accountId}]: pairing reply failed for ${ctx.senderOpenId}: ${String(err)}`,
            );
          },
        });
      } else {
        log(
          `feishu[${account.accountId}]: blocked unauthorized sender ${ctx.senderOpenId} (dmPolicy=${dmPolicy})`,
        );
      }
      return;
    }

    const commandAllowFrom = isGroup
      ? (groupConfig?.allowFrom ?? configAllowFrom)
      : effectiveDmAllowFrom;
    const senderAllowedForCommands = resolveFeishuAllowlistMatch({
      allowFrom: commandAllowFrom,
      senderId: ctx.senderOpenId,
      senderIds: [senderUserId],
      senderName: ctx.senderName,
    }).allowed;
    const commandAuthorized = shouldComputeCommandAuthorized
      ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
          useAccessGroups,
          authorizers: [
            { configured: commandAllowFrom.length > 0, allowed: senderAllowedForCommands },
          ],
        })
      : undefined;

    // In group chats, the session is scoped to the group, but the *speaker* is the sender.
    // Using a group-scoped From causes the agent to treat different users as the same person.
    const feishuFrom = `feishu:${ctx.senderOpenId}`;
    const feishuTo = isGroup ? `chat:${ctx.chatId}` : `user:${ctx.senderOpenId}`;
    const peerId = isGroup ? (groupSession?.peerId ?? ctx.chatId) : ctx.senderOpenId;
    const parentPeer = isGroup ? (groupSession?.parentPeer ?? null) : null;
    const replyInThread = isGroup ? (groupSession?.replyInThread ?? false) : false;

    if (isGroup && groupSession) {
      log(
        `feishu[${account.accountId}]: group session scope=${groupSession.groupSessionScope}, peer=${peerId}`,
      );
    }

    let route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "feishu",
      accountId: account.accountId,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: peerId,
      },
      parentPeer,
    });

    // Dynamic agent creation for DM users
    // When enabled, creates a unique agent instance with its own workspace for each DM user.
    let effectiveCfg = cfg;
    if (!isGroup && route.matchedBy === "default") {
      const dynamicCfg = feishuCfg?.dynamicAgentCreation as DynamicAgentCreationConfig | undefined;
      if (dynamicCfg?.enabled) {
        const runtime = getFeishuRuntime();
        const result = await maybeCreateDynamicAgent({
          cfg,
          runtime,
          senderOpenId: ctx.senderOpenId,
          dynamicCfg,
          log: (msg) => log(msg),
        });
        if (result.created) {
          effectiveCfg = result.updatedCfg;
          // Re-resolve route with updated config
          route = core.channel.routing.resolveAgentRoute({
            cfg: result.updatedCfg,
            channel: "feishu",
            accountId: account.accountId,
            peer: { kind: "direct", id: ctx.senderOpenId },
          });
          log(
            `feishu[${account.accountId}]: dynamic agent created, new route: ${route.sessionKey}`,
          );
        }
      }
    }

    const preview = ctx.content.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = isGroup
      ? `Feishu[${account.accountId}] message in group ${ctx.chatId}`
      : `Feishu[${account.accountId}] DM from ${ctx.senderOpenId}`;

    // Do not enqueue inbound user previews as system events.
    // System events are prepended to future prompts and can be misread as
    // authoritative transcript turns.
    log(`feishu[${account.accountId}]: ${inboundLabel}: ${preview}`);

    // Resolve media from message
    const mediaMaxBytes = (feishuCfg?.mediaMaxMb ?? 30) * 1024 * 1024; // 30MB default
    const mediaList = await resolveFeishuMediaList({
      cfg,
      messageId: ctx.messageId,
      messageType: event.message.message_type,
      content: event.message.content,
      maxBytes: mediaMaxBytes,
      log,
      accountId: account.accountId,
    });
    const mediaPayload = buildAgentMediaPayload(mediaList);

    // Fetch quoted/replied message content if parentId exists
    let quotedContent: string | undefined;
    if (ctx.parentId) {
      try {
        const quotedMsg = await getMessageFeishu({
          cfg,
          messageId: ctx.parentId,
          accountId: account.accountId,
        });
        if (quotedMsg) {
          quotedContent = quotedMsg.content;
          log(
            `feishu[${account.accountId}]: fetched quoted message: ${quotedContent?.slice(0, 100)}`,
          );
        }
      } catch (err) {
        log(`feishu[${account.accountId}]: failed to fetch quoted message: ${String(err)}`);
      }
    }

    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const historyKey = groupHistoryKey;

    const inboundHistory =
      isGroup && historyKey && historyLimit > 0 && chatHistories
        ? (chatHistories.get(historyKey) ?? []).map((entry) => ({
            sender: entry.sender,
            body: entry.body,
            timestamp: entry.timestamp,
          }))
        : undefined;

    // --- Shared context builder for dispatch ---
    const buildCtxPayloadForAgent = (
      agentSessionKey: string,
      agentAccountId: string,
      wasMentioned: boolean,
      agentIdForBody: string,
      options?: {
        collaborationStateOverride?: typeof collaborationState;
        autoMentionTargetsOverride?: boolean;
        mentionTargetsOverride?: FeishuMessageContext["mentionTargets"];
        messageIdOverride?: string;
      },
    ) => {
      const normalizedAgentId = normalizeAgentId(agentIdForBody);
      const effectiveCollaborationState = options?.collaborationStateOverride ?? collaborationState;
      const collaboration: CollaborationRuntimeContext | undefined = effectiveCollaborationState
        ? buildCollaborationRuntimeContext({
            state: effectiveCollaborationState,
            agentId: normalizedAgentId,
          })
        : undefined;
      const baseCtx =
        options?.mentionTargetsOverride === undefined
          ? { ...ctx, messageId: options?.messageIdOverride ?? ctx.messageId }
          : {
              ...ctx,
              messageId: options?.messageIdOverride ?? ctx.messageId,
              mentionTargets: options.mentionTargetsOverride,
            };
      const ctxForAgent = collaboration ? { ...baseCtx, collaboration } : baseCtx;
      const messageBody = buildFeishuAgentBody({
        ctx: ctxForAgent,
        quotedContent,
        permissionErrorForAgent,
        botOpenId,
        autoMentionTargets:
          options?.autoMentionTargetsOverride ?? normalizedAgentId !== "main",
        agentId: normalizedAgentId,
      });
      const envelopeFrom = isGroup ? `${ctx.chatId}:${ctx.senderOpenId}` : ctx.senderOpenId;
      if (permissionErrorForAgent) {
        log(`feishu[${account.accountId}]: appending permission error notice to message body`);
      }
      const body = core.channel.reply.formatAgentEnvelope({
        channel: "Feishu",
        from: envelopeFrom,
        timestamp: new Date(),
        envelope: envelopeOptions,
        body: messageBody,
      });
      const combinedBody =
        isGroup && historyKey && chatHistories
          ? buildPendingHistoryContextFromMap({
              historyMap: chatHistories,
              historyKey,
              limit: historyLimit,
              currentMessage: body,
              formatEntry: (entry) =>
                core.channel.reply.formatAgentEnvelope({
                  channel: "Feishu",
                  from: `${ctx.chatId}:${entry.sender}`,
                  timestamp: entry.timestamp,
                  body: entry.body,
                  envelope: envelopeOptions,
                }),
            })
          : body;
      return core.channel.reply.finalizeInboundContext({
        Body: combinedBody,
        BodyForAgent: messageBody,
        InboundHistory: inboundHistory,
        ReplyToId: ctx.parentId,
        RootMessageId: ctx.rootId,
        RawBody: ctx.content,
        CommandBody: ctx.content,
        From: feishuFrom,
        To: feishuTo,
        SessionKey: agentSessionKey,
        AccountId: agentAccountId,
        ChatType: isGroup ? "group" : "direct",
        GroupSubject: isGroup ? ctx.chatId : undefined,
        SenderName:
          ctx.senderName && ctx.senderName.trim() !== ctx.senderOpenId ? ctx.senderName : undefined,
        SenderId: ctx.senderOpenId,
        Provider: "feishu" as const,
        Surface: "feishu" as const,
        MessageSid: baseCtx.messageId,
        ReplyToBody: quotedContent ?? undefined,
        WasMentioned: wasMentioned,
        CommandAuthorized: commandAuthorized,
        OriginatingChannel: "feishu" as const,
        OriginatingTo: feishuTo,
        GroupSystemPrompt: isGroup ? groupConfig?.systemPrompt?.trim() || undefined : undefined,
        CollaborationTaskId: collaboration?.taskId,
        CollaborationMode: collaboration?.mode,
        CollaborationPhase: collaboration?.phase,
        CollaborationParticipants:
          collaboration && collaboration.participants.length > 0
            ? collaboration.participants.join(",")
            : undefined,
        CollaborationMaxHops: collaboration?.maxHops,
        CollaborationHandoffCount: collaboration?.handoffCount,
        CollaborationCurrentOwner: collaboration?.currentOwner,
        CollaborationSpeakerToken: collaboration?.speakerToken,
        CollaborationIsCurrentOwner: collaboration?.isCurrentOwner,
        CollaborationAllowedActions:
          collaboration && collaboration.allowedActions.length > 0
            ? collaboration.allowedActions.join(",")
            : undefined,
        CollaborationActiveHandoffId: collaboration?.activeHandoff?.handoffId,
        CollaborationActiveHandoffFrom: collaboration?.activeHandoff?.fromAgentId,
        CollaborationActiveHandoffTarget: collaboration?.activeHandoff?.targetAgentId,
        CollaborationActiveHandoffStatus: collaboration?.activeHandoff?.status,
        ...mediaPayload,
      });
    };

    const resolveHandoffTargetAccountId = (targetAgentId: string): string => {
      const normalizedTarget = normalizeAgentId(targetAgentId);
      if (normalizedTarget === normalizeAgentId(route.agentId)) {
        return route.accountId;
      }
      const accountConfig = feishuCfg?.accounts as Record<string, unknown> | undefined;
      if (accountConfig && typeof accountConfig === "object") {
        for (const key of Object.keys(accountConfig)) {
          if (normalizeAgentId(key) === normalizedTarget) {
            return key;
          }
        }
      }
      return targetAgentId;
    };

    const maybeDispatchPendingHandoff = async (params: {
      sourceAgentId: string;
      previousHandoffId?: string;
    }) => {
      if (!isGroup || !collaborationState) {
        return;
      }
      const latestState = getCollaborationState(collaborationState.taskId);
      const activeHandoff = latestState?.activeHandoffState;
      if (
        !latestState ||
        latestState.phase !== "awaiting_accept" ||
        !activeHandoff ||
        activeHandoff.handoffId === params.previousHandoffId ||
        normalizeAgentId(activeHandoff.fromAgentId) !== normalizeAgentId(params.sourceAgentId)
      ) {
        return;
      }
      const targetAgentId = activeHandoff.targetAgentId;
      const targetAccountId = resolveHandoffTargetAccountId(targetAgentId);
      const targetSessionKey = core.channel.routing.buildAgentSessionKey({
        agentId: targetAgentId,
        channel: "feishu",
        peer: {
          kind: isGroup ? "group" : "direct",
          id: peerId,
        },
      });
      const targetCtxPayload = buildCtxPayloadForAgent(
        targetSessionKey,
        targetAccountId,
        true,
        targetAgentId,
        {
          collaborationStateOverride: latestState,
          autoMentionTargetsOverride: false,
          mentionTargetsOverride: undefined,
          messageIdOverride: `${ctx.messageId}::handoff::${activeHandoff.handoffId}::${targetAgentId}`,
        },
      );
      const { dispatcher, replyOptions, markDispatchIdle } = createFeishuReplyDispatcher({
        cfg,
        agentId: targetAgentId,
        runtime: runtime as RuntimeEnv,
        chatId: ctx.chatId,
        replyToMessageId: replyTargetMessageId,
        skipReplyToInMessages: !isGroup,
        replyInThread,
        rootId: ctx.rootId,
        threadReply,
        mentionTargets: undefined,
        accountId: targetAccountId,
        messageCreateTimeMs,
      });
      log(
        `feishu[${account.accountId}]: collaboration handoff dispatch ${params.sourceAgentId} -> ${targetAgentId} (session=${targetSessionKey})`,
      );
      const previousPhase = latestState.phase;
      const previousOwner = latestState.currentOwner;
      const previousSpeakerToken = latestState.speakerToken;
      await runCollaborationDispatchWithRetry({
        log: (message) => log(`feishu[${account.accountId}]: ${message}`),
        run: () =>
          core.channel.reply.withReplyDispatcher({
            dispatcher,
            onSettled: () => {
              markDispatchIdle();
            },
            run: () =>
              core.channel.reply.dispatchReplyFromConfig({
                ctx: targetCtxPayload,
                cfg,
                dispatcher,
                replyOptions,
              }),
          }),
      });
      await maybeDispatchCurrentOwnerFollowup({
        previousPhase,
        previousOwner,
        previousSpeakerToken,
      });
    };

    const maybeDispatchCurrentOwnerFollowup = async (params: {
      previousPhase?: string;
      previousOwner?: string;
      previousSpeakerToken?: string;
    }) => {
      if (!isGroup || !collaborationState) {
        return;
      }
      const latestState = getCollaborationState(collaborationState.taskId);
      if (
        !latestState ||
        latestState.mode !== "peer_collab" ||
        (latestState.phase !== "active_collab" && latestState.phase !== "blocked_need_info") ||
        !latestState.currentOwner ||
        (params.previousPhase === latestState.phase &&
          params.previousOwner === latestState.currentOwner &&
          params.previousSpeakerToken === latestState.speakerToken)
      ) {
        return;
      }
      const ownerAgentId = latestState.currentOwner;
      const ownerAccountId = resolveHandoffTargetAccountId(ownerAgentId);
      const ownerSessionKey = core.channel.routing.buildAgentSessionKey({
        agentId: ownerAgentId,
        channel: "feishu",
        peer: {
          kind: isGroup ? "group" : "direct",
          id: peerId,
        },
      });
      const ownerCtxPayload = buildCtxPayloadForAgent(
        ownerSessionKey,
        ownerAccountId,
        true,
        ownerAgentId,
        {
          collaborationStateOverride: latestState,
          autoMentionTargetsOverride: false,
          mentionTargetsOverride: undefined,
          messageIdOverride: `${ctx.messageId}::owner::${latestState.taskId}::${latestState.phase}::${latestState.handoffCount}::${ownerAgentId}`,
        },
      );
      const { dispatcher, replyOptions, markDispatchIdle } = createFeishuReplyDispatcher({
        cfg,
        agentId: ownerAgentId,
        runtime: runtime as RuntimeEnv,
        chatId: ctx.chatId,
        replyToMessageId: replyTargetMessageId,
        skipReplyToInMessages: !isGroup,
        replyInThread,
        rootId: ctx.rootId,
        threadReply,
        mentionTargets: undefined,
        accountId: ownerAccountId,
        messageCreateTimeMs,
      });
      log(
        `feishu[${account.accountId}]: collaboration owner kickoff dispatch -> ${ownerAgentId} (session=${ownerSessionKey})`,
      );
      const previousHandoffId = latestState.activeHandoffState?.handoffId;
      const previousPhase = latestState.phase;
      const previousOwner = latestState.currentOwner;
      const previousSpeakerToken = latestState.speakerToken;
      await runCollaborationDispatchWithRetry({
        log: (message) => log(`feishu[${account.accountId}]: ${message}`),
        run: () =>
          core.channel.reply.withReplyDispatcher({
            dispatcher,
            onSettled: () => {
              markDispatchIdle();
            },
            run: () =>
              core.channel.reply.dispatchReplyFromConfig({
                ctx: ownerCtxPayload,
                cfg,
                dispatcher,
                replyOptions,
              }),
          }),
      });
      await maybeDispatchCurrentOwnerFollowup({
        previousPhase,
        previousOwner,
        previousSpeakerToken,
      });
      await maybeDispatchPendingHandoff({
        sourceAgentId: ownerAgentId,
        previousHandoffId,
      });
    };

    const maybeDispatchCoordinateParticipants = async () => {
      if (!isGroup || !collaborationState) {
        return;
      }
      const claim = claimPendingCoordinateParticipants(collaborationState.taskId);
      if (!claim.state || claim.targets.length === 0) {
        return;
      }
      const dispatchTarget = async (targetAgentId: string) => {
        const targetAccountId = resolveHandoffTargetAccountId(targetAgentId);
        const targetSessionKey = core.channel.routing.buildAgentSessionKey({
          agentId: targetAgentId,
          channel: "feishu",
          peer: {
            kind: isGroup ? "group" : "direct",
            id: peerId,
          },
        });
        const targetCtxPayload = buildCtxPayloadForAgent(
          targetSessionKey,
          targetAccountId,
          true,
          targetAgentId,
          {
            collaborationStateOverride: claim.state,
            autoMentionTargetsOverride: false,
            mentionTargetsOverride: undefined,
            messageIdOverride: `${ctx.messageId}::coordinate::${claim.state.taskId}::${targetAgentId}`,
          },
        );
        const { dispatcher, replyOptions, markDispatchIdle } = createFeishuReplyDispatcher({
          cfg,
          agentId: targetAgentId,
          runtime: runtime as RuntimeEnv,
          chatId: ctx.chatId,
          replyToMessageId: replyTargetMessageId,
          skipReplyToInMessages: !isGroup,
          replyInThread,
          rootId: ctx.rootId,
          threadReply,
          mentionTargets: undefined,
          accountId: targetAccountId,
          messageCreateTimeMs,
        });
        log(
          `feishu[${account.accountId}]: coordinate participant dispatch -> ${targetAgentId} (session=${targetSessionKey})`,
        );
        await runCollaborationDispatchWithRetry({
          log: (message) => log(`feishu[${account.accountId}]: ${message}`),
          run: () =>
            core.channel.reply.withReplyDispatcher({
              dispatcher,
              onSettled: () => {
                markDispatchIdle();
              },
              run: () =>
                core.channel.reply.dispatchReplyFromConfig({
                  ctx: targetCtxPayload,
                  cfg,
                  dispatcher,
                  replyOptions,
                }),
            }),
        });
      };
      const results = await Promise.allSettled(claim.targets.map(dispatchTarget));
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "rejected") {
          log(
            `feishu[${account.accountId}]: coordinate participant dispatch failed for ${claim.targets[i]}: ${String((results[i] as PromiseRejectedResult).reason)}`,
          );
        }
      }
    };

    // Parse message create_time (Feishu uses millisecond epoch string).
    const messageCreateTimeMs = event.message.create_time
      ? parseInt(event.message.create_time, 10)
      : undefined;
    // Determine reply target based on group session mode:
    // - Topic-mode groups (group_topic / group_topic_sender): reply to the topic
    //   root so the bot stays in the same thread.
    // - Groups with explicit replyInThread config: reply to the root so the bot
    //   stays in the thread the user expects.
    // - Normal groups (auto-detected threadReply from root_id): reply to the
    //   triggering message itself. Using rootId here would silently push the
    //   reply into a topic thread invisible in the main chat view (#32980).
    const isTopicSession =
      isGroup &&
      (groupSession?.groupSessionScope === "group_topic" ||
        groupSession?.groupSessionScope === "group_topic_sender");
    const configReplyInThread =
      isGroup &&
      (groupConfig?.replyInThread ?? feishuCfg?.replyInThread ?? "disabled") === "enabled";
    const replyTargetMessageId = shouldSkipReplyToForSyntheticInbound(ctx.messageId)
      ? undefined
      : isTopicSession || configReplyInThread
        ? (ctx.rootId ?? ctx.messageId)
        : ctx.messageId;
    const threadReply = isGroup ? (groupSession?.threadReply ?? false) : false;

    if (broadcastAgents) {
      // Cross-account dedup: in multi-account setups, Feishu delivers the same
      // event to every bot account in the group. Only one account should handle
      // broadcast dispatch to avoid duplicate agent sessions and race conditions.
      // Uses a shared "broadcast" namespace (not per-account) so the first handler
      // to reach this point claims the message; subsequent accounts skip.
      if (!(await tryRecordMessagePersistent(ctx.messageId, "broadcast", log))) {
        log(
          `feishu[${account.accountId}]: broadcast already claimed by another account for message ${ctx.messageId}; skipping`,
        );
        return;
      }

      // --- Broadcast dispatch: send message to all configured agents ---
      const strategy =
        ((cfg as Record<string, unknown>).broadcast as Record<string, unknown> | undefined)
          ?.strategy || "parallel";
      const activeAgentId =
        ctx.mentionedBot || !requireMention ? normalizeAgentId(route.agentId) : null;
      const agentIds = (cfg.agents?.list ?? []).map((a: { id: string }) => normalizeAgentId(a.id));
      const hasKnownAgents = agentIds.length > 0;

      log(
        `feishu[${account.accountId}]: broadcasting to ${broadcastAgents.length} agents (strategy=${strategy}, active=${activeAgentId ?? "none"})`,
      );

      const dispatchForAgent = async (agentId: string) => {
        if (hasKnownAgents && !agentIds.includes(normalizeAgentId(agentId))) {
          log(
            `feishu[${account.accountId}]: broadcast agent ${agentId} not found in agents.list; skipping`,
          );
          return;
        }

        const agentSessionKey = buildBroadcastSessionKey(route.sessionKey, route.agentId, agentId);
        const agentCtx = buildCtxPayloadForAgent(
          agentSessionKey,
          route.accountId,
          ctx.mentionedBot && agentId === activeAgentId,
          agentId,
        );

        if (agentId === activeAgentId) {
          // Active agent: real Feishu dispatcher (responds on Feishu)
          const { dispatcher, replyOptions, markDispatchIdle } = createFeishuReplyDispatcher({
            cfg,
            agentId,
            runtime: runtime as RuntimeEnv,
            chatId: ctx.chatId,
            replyToMessageId: replyTargetMessageId,
            skipReplyToInMessages: !isGroup,
            replyInThread,
            rootId: ctx.rootId,
            threadReply,
            mentionTargets: normalizeAgentId(agentId) === "main" ? undefined : ctx.mentionTargets,
            accountId: account.accountId,
            messageCreateTimeMs,
          });

          log(
            `feishu[${account.accountId}]: broadcast active dispatch agent=${agentId} (session=${agentSessionKey})`,
          );
          await core.channel.reply.withReplyDispatcher({
            dispatcher,
            onSettled: () => markDispatchIdle(),
            run: () =>
              core.channel.reply.dispatchReplyFromConfig({
                ctx: agentCtx,
                cfg,
                dispatcher,
                replyOptions,
              }),
          });
        } else {
          // Observer agent: no-op dispatcher (session entry + inference, no Feishu reply).
          // Strip CommandAuthorized so slash commands (e.g. /reset) don't silently
          // mutate observer sessions — only the active agent should execute commands.
          delete (agentCtx as Record<string, unknown>).CommandAuthorized;
          const noopDispatcher = {
            sendToolResult: () => false,
            sendBlockReply: () => false,
            sendFinalReply: () => false,
            waitForIdle: async () => {},
            getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
            markComplete: () => {},
          };

          log(
            `feishu[${account.accountId}]: broadcast observer dispatch agent=${agentId} (session=${agentSessionKey})`,
          );
          await core.channel.reply.withReplyDispatcher({
            dispatcher: noopDispatcher,
            run: () =>
              core.channel.reply.dispatchReplyFromConfig({
                ctx: agentCtx,
                cfg,
                dispatcher: noopDispatcher,
              }),
          });
        }
      };

      if (strategy === "sequential") {
        for (const agentId of broadcastAgents) {
          try {
            await dispatchForAgent(agentId);
          } catch (err) {
            log(
              `feishu[${account.accountId}]: broadcast dispatch failed for agent=${agentId}: ${String(err)}`,
            );
          }
        }
      } else {
        const results = await Promise.allSettled(broadcastAgents.map(dispatchForAgent));
        for (let i = 0; i < results.length; i++) {
          if (results[i].status === "rejected") {
            log(
              `feishu[${account.accountId}]: broadcast dispatch failed for agent=${broadcastAgents[i]}: ${String((results[i] as PromiseRejectedResult).reason)}`,
            );
          }
        }
      }

      if (isGroup && historyKey && chatHistories) {
        clearHistoryEntriesIfEnabled({
          historyMap: chatHistories,
          historyKey,
          limit: historyLimit,
        });
      }

      log(
        `feishu[${account.accountId}]: broadcast dispatch complete for ${broadcastAgents.length} agents`,
      );
    } else {
      // --- Single-agent dispatch (existing behavior) ---
      const ctxPayload = buildCtxPayloadForAgent(
        route.sessionKey,
        route.accountId,
        ctx.mentionedBot,
        route.agentId,
      );

      const { dispatcher, replyOptions, markDispatchIdle } = createFeishuReplyDispatcher({
        cfg,
        agentId: route.agentId,
        runtime: runtime as RuntimeEnv,
        chatId: ctx.chatId,
        replyToMessageId: replyTargetMessageId,
        skipReplyToInMessages: !isGroup,
        replyInThread,
        rootId: ctx.rootId,
        threadReply,
        mentionTargets: normalizeAgentId(route.agentId) === "main" ? undefined : ctx.mentionTargets,
        accountId: account.accountId,
        messageCreateTimeMs,
      });

      const previousHandoffId = collaborationState?.activeHandoffState?.handoffId;
      const previousCollaborationPhase = collaborationState?.phase;
      const previousCollaborationOwner = collaborationState?.currentOwner;
      const previousCollaborationSpeakerToken = collaborationState?.speakerToken;
      log(`feishu[${account.accountId}]: dispatching to agent (session=${route.sessionKey})`);
      const { queuedFinal, counts } = await core.channel.reply.withReplyDispatcher({
        dispatcher,
        onSettled: () => {
          markDispatchIdle();
        },
        run: () =>
          core.channel.reply.dispatchReplyFromConfig({
            ctx: ctxPayload,
            cfg,
            dispatcher,
            replyOptions,
          }),
      });

      if (isGroup && historyKey && chatHistories) {
        clearHistoryEntriesIfEnabled({
          historyMap: chatHistories,
          historyKey,
          limit: historyLimit,
        });
      }

      log(
        `feishu[${account.accountId}]: dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final})`,
      );
      await maybeDispatchCoordinateParticipants();
      await maybeDispatchCurrentOwnerFollowup({
        previousPhase: previousCollaborationPhase,
        previousOwner: previousCollaborationOwner,
        previousSpeakerToken: previousCollaborationSpeakerToken,
      });
      await maybeDispatchPendingHandoff({
        sourceAgentId: route.agentId,
        previousHandoffId,
      });
    }
  } catch (err) {
    error(`feishu[${account.accountId}]: failed to dispatch message: ${String(err)}`);
  }
}

export function clearBotCachesForTesting(): void {
  senderNameCache.clear();
  permissionErrorNotifiedAt.clear();
}

export const isSessionFileLockError = (error: unknown): boolean =>
  (error instanceof Error ? error.message : String(error)).includes("session file locked");

export async function runCollaborationDispatchWithRetry<T>(params: {
  run: () => Promise<T>;
  log?: (message: string) => void;
  retryDelaysMs?: readonly number[];
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<T> {
  const retryDelaysMs = params.retryDelaysMs ?? [150, 300, 600];
  const sleep = params.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await params.run();
    } catch (error) {
      lastError = error;
      if (!isSessionFileLockError(error) || attempt === retryDelaysMs.length) {
        throw error;
      }
      const delayMs = retryDelaysMs[attempt] ?? retryDelaysMs[retryDelaysMs.length - 1] ?? 0;
      params.log?.(`collaboration dispatch retry after session lock: attempt=${attempt + 1} delayMs=${delayMs}`);
      await sleep(delayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function primeBotCachesForTesting(params: {
  senderEntries?: Array<{ key: string; name: string; expireAt: number }>;
  permissionEntries?: Array<{ key: string; value: number }>;
}): void {
  for (const entry of params.senderEntries ?? []) {
    senderNameCache.set(entry.key, {
      name: entry.name,
      expireAt: entry.expireAt,
    });
  }
  for (const entry of params.permissionEntries ?? []) {
    permissionErrorNotifiedAt.set(entry.key, entry.value);
  }
}

export function sweepBotCachesForTesting(now: number): void {
  sweepSenderNameCache(now);
  sweepPermissionErrorCache(now);
}

export function getBotCacheStatsForTesting(): {
  senderNameCache: number;
  permissionErrorNotifiedAt: number;
} {
  return {
    senderNameCache: senderNameCache.size,
    permissionErrorNotifiedAt: permissionErrorNotifiedAt.size,
  };
}
