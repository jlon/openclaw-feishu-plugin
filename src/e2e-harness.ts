import { listFeishuAccountIds, resolveFeishuAccount } from "./accounts.js";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import type { FeishuMessageEvent } from "./bot.js";
import { shouldSkipDispatchForMentionPolicy } from "./monitor.account.js";

export type SyntheticMention = {
  accountId: string;
  openId: string;
  name: string;
};

const escapeRegExp = (input: string): string => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const uniqueMentionAliases = (mention: SyntheticMention): string[] =>
  [...new Set([mention.name, mention.accountId].map((value) => value.trim()).filter(Boolean))];

export function resolveSyntheticDeliveryAccountIds(
  cfg: ClawdbotConfig,
  groupId: string,
): string[] {
  return listFeishuAccountIds(cfg).filter((accountId) => {
    const account = resolveFeishuAccount({ cfg, accountId });
    if (!account.enabled || !account.configured) {
      return false;
    }
    const allow = account.config.groupAllowFrom ?? [];
    return allow.length === 0 || allow.includes(groupId);
  });
}

export function filterSyntheticDispatchAccountIds(params: {
  event: FeishuMessageEvent;
  candidateAccountIds: string[];
  botOpenIdMap: ReadonlyMap<string, string>;
  botNameMap?: ReadonlyMap<string, string>;
}): string[] {
  const { event, candidateAccountIds, botOpenIdMap, botNameMap } = params;
  return candidateAccountIds.filter(
    (accountId) =>
      !shouldSkipDispatchForMentionPolicy({
        accountId,
        event,
        botOpenIdMap,
        botNameMap,
      }),
  );
}

export function buildSyntheticGroupMessageEvent(params: {
  messageId: string;
  groupId: string;
  senderOpenId: string;
  text: string;
  mentions?: SyntheticMention[];
}): FeishuMessageEvent {
  const mentions = params.mentions ?? [];
  let inlineMentionMatched = false;
  const contentText = mentions.reduce((text, mention, index) => {
    const placeholder = `@_user_${index + 1}`;
    return uniqueMentionAliases(mention).reduce((current, alias) => {
      const pattern = new RegExp(`(^|[\\s(（\\[【])@${escapeRegExp(alias)}(?=$|[\\s)）\\]】,，.。!?！？:：;；])`, "giu");
      return current.replace(pattern, (_match, prefix) => {
        inlineMentionMatched = true;
        return `${prefix}${placeholder}`;
      });
    }, text);
  }, params.text);
  const prefix = inlineMentionMatched
    ? ""
    : mentions
        .map((_mention, index) => `@_user_${index + 1}`)
        .join(" ");
  const finalText = [prefix, contentText].filter(Boolean).join(" ").trim();
  return {
    sender: {
      sender_id: {
        open_id: params.senderOpenId,
      },
    },
    message: {
      message_id: params.messageId,
      chat_id: params.groupId,
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: finalText }),
      mentions: mentions.map((mention, index) => ({
        key: `@_user_${index + 1}`,
        id: { open_id: mention.openId },
        name: mention.name,
        tenant_key: "",
      })),
      create_time: `${Date.now()}`,
    },
  };
}
