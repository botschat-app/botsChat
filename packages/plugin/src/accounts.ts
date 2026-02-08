import type {
  BotsChatAccountConfig,
  BotsChatChannelConfig,
  ResolvedBotsChatAccount,
} from "./types.js";

const DEFAULT_ACCOUNT_ID = "default";

/** Extract the botschat section from the full config. */
function section(cfg: unknown): BotsChatAccountConfig & { accounts?: Record<string, BotsChatAccountConfig> } {
  const c = cfg as BotsChatChannelConfig;
  return c?.channels?.botschat ?? {};
}

/** List all configured account IDs. */
export function listBotsChatAccountIds(cfg: unknown): string[] {
  const s = section(cfg);
  const ids: string[] = [];
  // Top-level counts as "default" if it has cloudUrl
  if (s.cloudUrl) {
    ids.push(DEFAULT_ACCOUNT_ID);
  }
  // Named accounts
  if (s.accounts) {
    for (const id of Object.keys(s.accounts)) {
      if (id !== DEFAULT_ACCOUNT_ID || !s.cloudUrl) {
        ids.push(id);
      }
    }
  }
  return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}

/** Resolve default account ID. */
export function resolveDefaultBotsChatAccountId(cfg: unknown): string {
  const ids = listBotsChatAccountIds(cfg);
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/** Resolve a single account by ID. */
export function resolveBotsChatAccount(
  cfg: unknown,
  accountId?: string | null,
): ResolvedBotsChatAccount {
  const s = section(cfg);
  const id = accountId ?? resolveDefaultBotsChatAccountId(cfg);
  let acct: BotsChatAccountConfig;

  if (id === DEFAULT_ACCOUNT_ID || !s.accounts?.[id]) {
    // Use top-level config
    acct = {
      enabled: s.enabled,
      name: s.name,
      cloudUrl: s.cloudUrl,
      pairingToken: s.pairingToken,
    };
  } else {
    acct = s.accounts[id];
  }

  const cloudUrl = acct.cloudUrl ?? "";
  const pairingToken = acct.pairingToken ?? "";

  return {
    accountId: id,
    name: acct.name,
    enabled: acct.enabled !== false,
    configured: !!cloudUrl && !!pairingToken,
    cloudUrl,
    pairingToken,
    config: acct,
  };
}

/** Delete an account from config, returning the updated config. */
export function deleteBotsChatAccount(
  cfg: unknown,
  accountId: string,
): unknown {
  const c = cfg as BotsChatChannelConfig;
  const botschat = { ...c?.channels?.botschat };

  if (accountId === DEFAULT_ACCOUNT_ID) {
    delete botschat.cloudUrl;
    delete botschat.pairingToken;
    delete botschat.name;
    botschat.enabled = false;
  } else if (botschat.accounts) {
    const accounts = { ...botschat.accounts };
    delete accounts[accountId];
    botschat.accounts = accounts;
  }

  return {
    ...(c as Record<string, unknown>),
    channels: {
      ...(c as BotsChatChannelConfig).channels,
      botschat,
    },
  };
}

/** Enable or disable an account, returning updated config. */
export function setBotsChatAccountEnabled(
  cfg: unknown,
  accountId: string,
  enabled: boolean,
): unknown {
  const c = cfg as BotsChatChannelConfig;
  const botschat = { ...c?.channels?.botschat };

  if (accountId === DEFAULT_ACCOUNT_ID) {
    botschat.enabled = enabled;
  } else if (botschat.accounts) {
    botschat.accounts = {
      ...botschat.accounts,
      [accountId]: { ...botschat.accounts[accountId], enabled },
    };
  }

  return {
    ...(c as Record<string, unknown>),
    channels: {
      ...(c as BotsChatChannelConfig).channels,
      botschat,
    },
  };
}
