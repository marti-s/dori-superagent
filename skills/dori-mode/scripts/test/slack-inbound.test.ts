import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import type { Http, HttpRequest, HttpResponse } from "../src/messenger/http.ts";
import { Slack } from "../src/messenger/slack.ts";
import { pollSlackInbound } from "../src/messenger/slack-inbound.ts";
import { ThreadLedger } from "../src/messenger/thread-ledger.ts";
import { fakeClock, withState } from "./fakes.ts";

const SELF = "U_DORI";
const state = withState();
afterEach(() => {});

type Workspace = {
  replies: Record<string, { ts: string; user?: string; text: string; bot_id?: string }[]>;
  view: unknown[];
  counts: Record<string, unknown>;
  nextTs: number;
  /** The Slack error a method answers instead of its result. */
  refuse?: Record<string, string>;
};

// Like the live API (#180): these read only a form body and answer invalid_arguments to JSON.
const FORM_ONLY = new Set(["conversations.replies", "files.getUploadURLExternal"]);

const slackFake = (w: Workspace) => {
  const calls: string[] = [];
  const types: Record<string, string> = {};
  const http: Http = async (req: HttpRequest): Promise<HttpResponse> => {
    const method = req.url.split("/").pop() ?? "";
    calls.push(method);
    const type = String(req.headers?.["Content-Type"] ?? "");
    types[method] = type;
    const form = type.startsWith("application/x-www-form-urlencoded");
    const raw = String(req.body ?? "");
    const p: Record<string, unknown> = form ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw || "{}");
    const answer = (error: string): HttpResponse => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ ok: false, error }),
    });
    if (FORM_ONLY.has(method) && !form) return answer("invalid_arguments");
    const refusal = w.refuse?.[method];
    if (refusal !== undefined) return answer(refusal);
    const body = (b: unknown): HttpResponse => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ ok: true, ...(b as object) }),
    });
    if (method === "chat.postMessage") {
      const ts = `${w.nextTs++}.000100`;
      const root = typeof p["thread_ts"] === "string" ? p["thread_ts"] : ts;
      const thread = `${p["channel"]}:${root}`;
      const replies = w.replies[thread] ?? [];
      w.replies[thread] = replies;
      replies.push({ ts, user: SELF, text: String(p["text"]) });
      return body({ channel: p["channel"], ts });
    }
    if (method === "conversations.replies") {
      const all = w.replies[`${p["channel"]}:${p["ts"]}`] ?? [];
      return body({ messages: all.filter((m) => Number(m.ts) > Number(p["oldest"] ?? 0)) });
    }
    if (method === "subscriptions.thread.getView") return body({ threads: w.view });
    if (method === "client.counts") return body(w.counts);
    return body({});
  };
  return { http, calls, types };
};

const setup = (name: string) => {
  const w: Workspace = { replies: {}, view: [], counts: { channels: [], ims: [], mpims: [] }, nextTs: 1000 };
  const { http, calls, types } = slackFake(w);
  const ledger = new ThreadLedger(join(state.dir, `${name}.json`));
  const slack = new Slack(http, fakeClock(0), { token: "t" }, "https://slack.test/api", ledger);
  return { w, slack, ledger, calls, types };
};

test("a guest's untagged reply in a thread the Dori started through a raw API call is still picked up", async () => {
  const { w, slack, ledger } = setup("raw-root");
  const root = (await slack.call("chat.postMessage", { channel: "C1", text: "Kicking off the release checklist" })) as {
    ts: string;
  };
  w.replies[`C1:${root.ts}`]?.push({ ts: "2000.000100", user: "U_GUEST", text: "the staging deploy is red" });
  const got = await pollSlackInbound(slack, ledger, { selfUserId: SELF });
  expect(got).toEqual([
    {
      source: "own-thread",
      channel: "C1",
      ts: "2000.000100",
      threadTs: root.ts,
      user: "U_GUEST",
      text: "the staging deploy is red",
    },
  ]);
  expect(await pollSlackInbound(slack, ledger, { selfUserId: SELF })).toEqual([]);
});

test("a reply the Dori posts into someone else's thread also makes that thread watched, and its own messages are never inbound", async () => {
  const { w, slack, ledger } = setup("reply");
  w.replies["C2:500.000100"] = [{ ts: "500.000100", user: "U_OWNER", text: "can you check this?" }];
  await slack.post("C2", "on it", "500.000100");
  w.replies["C2:500.000100"]?.push(
    { ts: "3000.000100", user: "U_OWNER", text: "thanks, also the logs" },
    { ts: "3001.000100", bot_id: "B1", user: "U_BOT", text: "automated" },
  );
  const got = await pollSlackInbound(slack, ledger, { selfUserId: SELF });
  expect(got.map((g) => [g.source, g.ts, g.user])).toEqual([["own-thread", "3000.000100", "U_OWNER"]]);
});

test("unread replies from the threads view and DMs with unreads are surfaced, each message once", async () => {
  const { w, slack, ledger } = setup("view");
  w.view = [
    {
      root_msg: { channel: "C3", ts: "10.1", user: "U_OWNER" },
      unread_replies: [
        { ts: "11.1", thread_ts: "10.1", user: "U_TEAM", text: "ping" },
        { ts: "12.1", thread_ts: "10.1", user: SELF, text: "mine" },
      ],
    },
  ];
  w.counts = {
    channels: [
      { id: "C9", has_unreads: true, mention_count: 0 },
      { id: "C8", has_unreads: true, mention_count: 2 },
    ],
    ims: [{ id: "D1", has_unreads: true, mention_count: 1 }],
    mpims: [],
  };
  const got = await pollSlackInbound(slack, ledger, { selfUserId: SELF });
  expect(got.map((g) => `${g.source}:${g.channel}:${g.ts}`)).toEqual([
    "threads-view:C3:11.1",
    "unread:D1:",
    "unread:C8:",
  ]);
});

test("the thread ledger survives a restart: a new process still watches threads posted before it", async () => {
  const a = setup("restart");
  const root = (await a.slack.post("C4", "starting the migration")).ts;
  const fresh = new ThreadLedger(join(state.dir, "restart.json"));
  expect((await fresh.list()).map((t) => `${t.channel}:${t.rootTs}`)).toEqual([`C4:${root}`]);
});
