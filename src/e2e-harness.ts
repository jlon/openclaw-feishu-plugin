import { listFeishuAccountIds, resolveFeishuAccount } from "./accounts.js";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import type { FeishuMessageEvent } from "./bot.js";

export type SyntheticMention = {
  accountId: string;
  openId: string;
  name: string;
};

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

export function buildSyntheticGroupMessageEvent(params: {
  messageId: string;
  groupId: string;
  senderOpenId: string;
  text: string;
  mentions?: SyntheticMention[];
}): FeishuMessageEvent {
  const mentions = params.mentions ?? [];
  const prefix = mentions
    .map((mention, index) => `<at user_id="${mention.openId}">@_user_${index + 1}</at>`)
    .join(" ");
  const contentText = [prefix, params.text].filter(Boolean).join(" ").trim();
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
      content: JSON.stringify({ text: contentText }),
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
