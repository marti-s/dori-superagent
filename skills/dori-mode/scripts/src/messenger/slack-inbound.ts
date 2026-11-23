import { MessengerError } from "./http.ts";
import type { Slack } from "./slack.ts";
import { type ThreadLedger, tsAfter } from "./thread-ledger.ts";

export type Inbound = {
  readonly source: "threads-view" | "own-thread" | "unread";
  readonly channel: string;
  readonly ts: string;
  readonly threadTs?: string | undefined;
  readonly user?: string | undefined;
  readonly text?: string | undefined;
};

type Msg = {
  readonly ts?: string;
  readonly thread_ts?: string;
  readonly user?: string;
  readonly text?: string;
  readonly bot_id?: string;
  readonly channel?: string;
};
type ThreadView = { readonly root_msg?: Msg & { readonly channel?: string }; readonly unread_replies?: readonly Msg[] };
type Counted = { readonly id: string; readonly has_unreads?: boolean; readonly mention_count?: number };

export type InboundOptions = {
  readonly selfUserId: string;
  readonly threadsViewLimit?: number;
  /** Told when a call is skipped because this token cannot make it; the caller decides how often to repeat it. */
  readonly warn?: (message: string) => void;
};

/**
 * A user-token-only method (the threads view, the unread counts) answers a bot token `not_allowed_token_type` (#180).
 * That one refusal reads as an empty answer, so the ledger walk a bot token can do still runs; any other failure is
 * rethrown, because an inbox that goes quiet on a revoked token or a dead network hides exactly what must be seen.
 */
async function userTokenOnly(
  slack: Slack,
  method: string,
  params: Record<string, unknown>,
  skipped: string,
  warn: InboundOptions["warn"],
): Promise<Record<string, unknown>> {
  try {
    return await slack.call(method, params);
  } catch (e) {
    if (!(e instanceof MessengerError) || e.code !== "not_allowed_token_type") throw e;
    warn?.(
      `slack ${method}: not_allowed_token_type (a bot token); skipping ${skipped}, replies in own threads still arrive`,
    );
    return {};
  }
}

export const pollSlackInbound = async (
  slack: Slack,
  ledger: ThreadLedger,
  opts: InboundOptions,
): Promise<Inbound[]> => {
  const out: Inbound[] = [];
  const seen = new Set<string>();
  const add = (i: Inbound) => {
    const k = `${i.channel}:${i.ts}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(i);
  };
  const fromOthers = (m: Msg) => m.user !== undefined && m.user !== opts.selfUserId && !m.bot_id;

  const limit = opts.threadsViewLimit ?? 20;
  const view = (await userTokenOnly(
    slack,
    "subscriptions.thread.getView",
    { limit },
    "the threads view",
    opts.warn,
  )) as {
    threads?: readonly ThreadView[];
  };
  for (const t of view.threads ?? []) {
    const channel = t.root_msg?.channel;
    if (!channel) continue;
    for (const m of t.unread_replies ?? []) {
      if (!m.ts || !fromOthers(m)) continue;
      add({ source: "threads-view", channel, ts: m.ts, threadTs: m.thread_ts, user: m.user, text: m.text });
      if (m.thread_ts) await ledger.markSeen(channel, m.thread_ts, m.ts);
    }
  }

  for (const t of await ledger.list()) {
    const r = (await slack.call("conversations.replies", {
      channel: t.channel,
      ts: t.rootTs,
      oldest: t.seenTs,
      inclusive: false,
      limit: 50,
    })) as { messages?: readonly Msg[] };
    let newest = t.seenTs;
    for (const m of r.messages ?? []) {
      if (!m.ts || !tsAfter(m.ts, t.seenTs)) continue;
      if (tsAfter(m.ts, newest)) newest = m.ts;
      if (fromOthers(m))
        add({ source: "own-thread", channel: t.channel, ts: m.ts, threadTs: t.rootTs, user: m.user, text: m.text });
    }
    if (newest !== t.seenTs) await ledger.markSeen(t.channel, t.rootTs, newest);
  }

  const counts = (await userTokenOnly(slack, "client.counts", {}, "the unread counts", opts.warn)) as {
    channels?: readonly Counted[];
    ims?: readonly Counted[];
    mpims?: readonly Counted[];
  };
  for (const c of [
    ...(counts.ims ?? []),
    ...(counts.mpims ?? []),
    ...(counts.channels ?? []).filter((c) => (c.mention_count ?? 0) > 0),
  ]) {
    if (c.has_unreads || (c.mention_count ?? 0) > 0)
      add({ source: "unread", channel: c.id, ts: "", text: `${c.mention_count ?? 0} mention(s), unread` });
  }
  return out;
};
