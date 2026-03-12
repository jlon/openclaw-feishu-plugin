import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { buildSyntheticGroupMessageEvent, resolveSyntheticDeliveryAccountIds } from "../src/e2e-harness.js";
import { handleFeishuMessage } from "../src/bot.js";
import { botNames, botOpenIds } from "../src/monitor.state.js";
import { probeFeishu } from "../src/probe.js";
import { setFeishuRuntime } from "../src/runtime.js";
import { resolveFeishuAccount } from "../src/accounts.js";
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk/feishu";

type Args = {
  configPath: string;
  groupId: string;
  senderOpenId: string;
  senderName?: string;
  text: string;
  mentions: string[];
  deliverAccounts: string[];
  dryRun: boolean;
};

const parseArgs = (argv: string[]): Args => {
  const nextValue = (i: number, flag: string) => {
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${flag}`);
    }
    return value;
  };
  const parsed: Args = {
    configPath: process.env.OPENCLAW_CONFIG_PATH || join(homedir(), ".openclaw", "openclaw.json"),
    groupId: "",
    senderOpenId: process.env.FEISHU_E2E_SENDER_OPEN_ID || "",
    senderName: process.env.FEISHU_E2E_SENDER_NAME,
    text: "",
    mentions: [],
    deliverAccounts: [],
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") parsed.configPath = nextValue(i++, arg);
    else if (arg === "--group") parsed.groupId = nextValue(i++, arg);
    else if (arg === "--sender-open-id") parsed.senderOpenId = nextValue(i++, arg);
    else if (arg === "--sender-name") parsed.senderName = nextValue(i++, arg);
    else if (arg === "--text") parsed.text = nextValue(i++, arg);
    else if (arg === "--mentions") parsed.mentions = nextValue(i++, arg).split(",").map((v) => v.trim()).filter(Boolean);
    else if (arg === "--deliver-accounts") parsed.deliverAccounts = nextValue(i++, arg).split(",").map((v) => v.trim()).filter(Boolean);
    else if (arg === "--dry-run") parsed.dryRun = true;
    else throw new Error(`unknown arg: ${arg}`);
  }
  if (!parsed.groupId) throw new Error("--group is required");
  if (!parsed.senderOpenId) throw new Error("--sender-open-id is required");
  if (!parsed.text) throw new Error("--text is required");
  return parsed;
};

const loadConfig = async (configPath: string): Promise<ClawdbotConfig> =>
  JSON.parse(await readFile(configPath, "utf8")) as ClawdbotConfig;

const prepareSyntheticHarnessConfig = (cfg: ClawdbotConfig): ClawdbotConfig => {
  const cloned = structuredClone(cfg);
  const feishu = cloned.channels?.feishu as Record<string, unknown> | undefined;
  if (!feishu) {
    return cloned;
  }
  feishu.resolveSenderNames = false;
  const accounts = feishu.accounts as Record<string, Record<string, unknown>> | undefined;
  if (accounts && typeof accounts === "object") {
    for (const account of Object.values(accounts)) {
      account.resolveSenderNames = false;
    }
  }
  return cloned;
};

const loadCreatePluginRuntime = async () => {
  const require = createRequire(import.meta.url);
  const openclawEntry = require.resolve("openclaw");
  const distDir = dirname(openclawEntry);
  const files = await readdir(distDir);
  const compact = files.find((file) => /^compact-.*\.js$/.test(file));
  if (!compact) {
    throw new Error(`cannot find compact dist bundle under ${distDir}`);
  }
  const mod = await import(pathToFileURL(join(distDir, compact)).href);
  if (typeof mod.l !== "function") {
    throw new Error("createPluginRuntime export not found");
  }
  return mod.l as () => unknown;
};

const buildRuntimeEnv = (): RuntimeEnv =>
  ({
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: (code: number): never => {
      throw new Error(`runtime exit ${code}`);
    },
  }) as RuntimeEnv;

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const cfg = prepareSyntheticHarnessConfig(await loadConfig(args.configPath));
  const createPluginRuntime = await loadCreatePluginRuntime();
  process.env.OPENCLAW_FEISHU_SYNTHETIC_NO_REPLY_TO = "1";
  setFeishuRuntime(createPluginRuntime() as never);
  const runtime = buildRuntimeEnv();
  const deliverAccounts =
    args.deliverAccounts.length > 0
      ? args.deliverAccounts
      : resolveSyntheticDeliveryAccountIds(cfg, args.groupId);
  if (deliverAccounts.length === 0) {
    throw new Error(`no enabled feishu accounts found for group ${args.groupId}`);
  }
  const identities = new Map<
    string,
    {
      openId?: string;
      name: string;
    }
  >();
  for (const accountId of new Set([...deliverAccounts, ...args.mentions])) {
    const account = resolveFeishuAccount({ cfg, accountId });
    if (!account.configured) {
      throw new Error(`account ${accountId} is not configured`);
    }
    const probe = await probeFeishu(account);
    if (!probe.ok || !probe.botOpenId) {
      throw new Error(`probe failed for ${accountId}: ${probe.error ?? "missing botOpenId"}`);
    }
    const name = probe.botName?.trim() || account.config.name?.trim() || accountId;
    identities.set(accountId, { openId: probe.botOpenId, name });
    botOpenIds.set(accountId, probe.botOpenId);
    botNames.set(accountId, name);
  }
  const mentions = args.mentions.map((accountId) => {
    const identity = identities.get(accountId);
    if (!identity?.openId) {
      throw new Error(`missing mention identity for ${accountId}`);
    }
    return {
      accountId,
      openId: identity.openId,
      name: identity.name,
    };
  });
  const messageId = `synthetic_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const event = buildSyntheticGroupMessageEvent({
    messageId,
    groupId: args.groupId,
    senderOpenId: args.senderOpenId,
    text: args.text,
    mentions,
  });
  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          messageId,
          deliverAccounts,
          mentions,
          event,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    JSON.stringify(
      {
        messageId,
        groupId: args.groupId,
        senderOpenId: args.senderOpenId,
        deliverAccounts,
        mentions: mentions.map(({ accountId, name, openId }) => ({ accountId, name, openId })),
      },
      null,
      2,
    ),
  );
  for (const accountId of deliverAccounts) {
    const identity = identities.get(accountId);
    console.log(`[e2e] dispatch ${messageId} -> ${accountId}`);
    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: identity?.openId,
      botName: identity?.name,
      runtime,
      accountId,
    });
  }
  console.log(`[e2e] completed ${messageId}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
