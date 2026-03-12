import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { FeishuChatSchema, type FeishuChatParams } from "./chat-schema.js";
import { botNames, botOpenIds } from "./monitor.state.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";
import type { ResolvedFeishuAccount } from "./types.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

async function getChatInfo(client: Lark.Client, chatId: string) {
  const res = await client.im.chat.get({ path: { chat_id: chatId } });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const chat = res.data;
  return {
    chat_id: chatId,
    name: chat?.name,
    description: chat?.description,
    owner_id: chat?.owner_id,
    tenant_key: chat?.tenant_key,
    user_count: chat?.user_count,
    chat_mode: chat?.chat_mode,
    chat_type: chat?.chat_type,
    join_message_visibility: chat?.join_message_visibility,
    leave_message_visibility: chat?.leave_message_visibility,
    membership_approval: chat?.membership_approval,
    moderation_permission: chat?.moderation_permission,
    avatar: chat?.avatar,
  };
}

async function getChatMembers(
  client: Lark.Client,
  chatId: string,
  pageSize?: number,
  pageToken?: string,
  memberIdType?: "open_id" | "user_id" | "union_id",
) {
  const page_size = pageSize ? Math.max(1, Math.min(100, pageSize)) : 50;
  const res = await client.im.chatMembers.get({
    path: { chat_id: chatId },
    params: {
      page_size,
      page_token: pageToken,
      member_id_type: memberIdType ?? "open_id",
    },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    chat_id: chatId,
    has_more: res.data?.has_more,
    page_token: res.data?.page_token,
    members:
      res.data?.items?.map((item) => ({
        member_id: item.member_id,
        name: item.name,
        tenant_key: item.tenant_key,
        member_id_type: item.member_id_type,
      })) ?? [],
  };
}

function normalizeChatId(value: string) {
  return value.trim().toLowerCase();
}

function canAccountParticipateInGroup(account: ResolvedFeishuAccount, chatId: string) {
  const groupPolicy = account.config.groupPolicy ?? "allowlist";
  if (groupPolicy === "disabled") {
    return false;
  }
  if (groupPolicy === "open" || groupPolicy === "allowall") {
    return true;
  }
  const groupAllowFrom = (account.config.groupAllowFrom ?? []).map((entry) =>
    normalizeChatId(String(entry)),
  );
  return groupAllowFrom.includes(normalizeChatId(chatId));
}

async function getChatParticipants(
  client: Lark.Client,
  chatId: string,
  accounts: ResolvedFeishuAccount[],
) {
  const [info, members] = await Promise.all([getChatInfo(client, chatId), getChatMembers(client, chatId)]);
  const internalBots = accounts
    .filter((account) => canAccountParticipateInGroup(account, chatId))
    .map((account) => ({
      account_id: account.accountId,
      display_name: botNames.get(account.accountId) ?? account.name ?? account.accountId,
      bot_open_id: botOpenIds.get(account.accountId) ?? null,
    }))
    .toSorted((a, b) => a.account_id.localeCompare(b.account_id));

  return {
    chat_id: chatId,
    chat_name: info.name,
    chat_type: info.chat_type,
    visible_member_count: members.members.length,
    visible_members: members.members,
    internal_bot_count: internalBots.length,
    internal_bots: internalBots,
    external_bot_count_known: false,
    note: "visible_members comes from Feishu member APIs; internal_bots reflects OpenClaw Feishu accounts eligible for this chat.",
  };
}

export function registerFeishuChatTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_chat: No config available, skipping chat tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_chat: No Feishu accounts configured, skipping chat tools");
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.chat) {
    api.logger.debug?.("feishu_chat: chat tool disabled in config");
    return;
  }

  api.registerTool(
    (ctx) => {
      const accountId = ctx.agentAccountId;
      return {
        name: "feishu_chat",
        label: "Feishu Chat",
        description: "Feishu chat operations. Actions: members, info",
        parameters: FeishuChatSchema,
        async execute(_toolCallId, params) {
          const p = params as FeishuChatParams;
          try {
            const client = createFeishuToolClient({
              api,
              executeParams: p,
              defaultAccountId: accountId,
            });
            switch (p.action) {
              case "members":
                return json(
                  await getChatMembers(
                    client,
                    p.chat_id,
                    p.page_size,
                    p.page_token,
                    p.member_id_type,
                  ),
                );
              case "info":
                return json(await getChatInfo(client, p.chat_id));
              case "participants":
                return json(await getChatParticipants(client, p.chat_id, accounts));
              default:
                return json({ error: `Unknown action: ${String(p.action)}` });
            }
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      };
    },
    { name: "feishu_chat" },
  );

  api.logger.info?.("feishu_chat: Registered feishu_chat tool");
}
