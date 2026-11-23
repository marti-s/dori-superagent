import { expect, test } from "bun:test";
import { join } from "node:path";

import { type Http, type HttpRequest, type HttpResponse, MessengerError } from "../src/messenger/http.ts";
import { Slack } from "../src/messenger/slack.ts";
import { pollSlackInbound } from "../src/messenger/slack-inbound.ts";
import { ThreadLedger } from "../src/messenger/thread-ledger.ts";
import { fakeClock, withState } from "./fakes.ts";

// #180: a bot token must still hear replies in its own threads, and the Web API's read methods take a form body.
const SELF = "U_DORI";
const state = withState();
const FORM_ONLY = new Set(["conversations.replies", "files.getUploadURLExternal"]);

type Reply = { ts: string; user: string; text: string };

function fakeSlack(refuse: Record<string, string>) {
  const replies: Record<string, Reply[]> = {};
  const types: Record<string, string> = {};
  let next = 1000;
  const http: Http = async (req: HttpRequest): Promise<HttpResponse> => {
    const method = req.url.split("/").pop() ?? "";
    const type = String(req.headers?.["Content-Type"] ?? "");
    types[method] = type;
    const form = type.startsWith("application/x-www-form-urlencoded");
    const raw = String(req.body ?? "");
    const p: Record<string, unknown> = form ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw || "{}");
    const reply = (value: object) => ({ status: 200, headers: {}, body: JSON.stringify(value) });
    if (FORM_ONLY.has(method) && !form) return reply({ ok: false, error: "invalid_arguments" });
    if (refuse[method] !== undefined) return reply({ ok: false, error: refuse[method] });
    if (method === "chat.postMessage") {
      const ts = `${next++}.000100`;
      replies[`${p["channel"]}:${ts}`] = [];
      return reply({ ok: true, channel: p["channel"], ts });
    }
    if (method === "conversations.replies") {
      const all = replies[`${p["channel"]}:${p["ts"]}`] ?? [];
      return reply({ ok: true, messages: all.filter((m) => Number(m.ts) > Number(p["oldest"] ?? 0)) });
    }
    return reply({ ok: true });
  };
  return { http, replies, types };
}

async function threadWithReply(name: string, refuse: Record<string, string>) {
  const fake = fakeSlack(refuse);
  const ledger = new ThreadLedger(join(state.dir, `${name}.json`));
  const slack = new Slack(fake.http, fakeClock(0), { token: "xoxb-t" }, "https://slack.test/api", ledger);
  const root = String((await slack.call("chat.postMessage", { channel: "C1", text: "Starting the deploy" }))["ts"]);
  fake.replies[`C1:${root}`]?.push({ ts: "2000.000100", user: "U_OWNER", text: "go ahead" });
  return { fake, ledger, slack, root };
}

const BOT: Record<string, string> = {
  "subscriptions.thread.getView": "not_allowed_token_type",
  "client.counts": "not_allowed_token_type",
};

test("a bot token refused the threads view and the counts still gets the reply in its own thread", async () => {
  const { slack, ledger, root } = await threadWithReply("bot", BOT);
  const warned: string[] = [];
  const got = await pollSlackInbound(slack, ledger, { selfUserId: SELF, warn: (m) => warned.push(m) });
  expect(got).toEqual([
    { source: "own-thread", channel: "C1", ts: "2000.000100", threadTs: root, user: "U_OWNER", text: "go ahead" },
  ]);
  expect(warned).toHaveLength(2);
  expect(warned[0]).toStartWith("slack subscriptions.thread.getView: not_allowed_token_type");
  expect(warned[1]).toStartWith("slack client.counts: not_allowed_token_type");
  expect(await pollSlackInbound(slack, ledger, { selfUserId: SELF })).toEqual([]);
});

test("any other refusal of the threads view fails the poll and leaves the reply unseen", async () => {
  const { slack, ledger, root } = await threadWithReply("revoked", { "subscriptions.thread.getView": "invalid_auth" });
  const warned: string[] = [];
  const failure = await pollSlackInbound(slack, ledger, { selfUserId: SELF, warn: (m) => warned.push(m) }).catch(
    (e: unknown) => e,
  );
  expect(failure).toBeInstanceOf(MessengerError);
  expect((failure as MessengerError).code).toBe("invalid_auth");
  expect(warned).toEqual([]);
  expect(await ledger.list()).toEqual([{ channel: "C1", rootTs: root, seenTs: root }]);
});

test("the form-only read methods go out as a form body; posting stays JSON", async () => {
  const { fake, slack, ledger } = await threadWithReply("encoding", BOT);
  await pollSlackInbound(slack, ledger, { selfUserId: SELF });
  await slack.call("files.getUploadURLExternal", { filename: "a.png", length: 3 });
  expect(fake.types["conversations.replies"]).toStartWith("application/x-www-form-urlencoded");
  expect(fake.types["files.getUploadURLExternal"]).toStartWith("application/x-www-form-urlencoded");
  expect(fake.types["chat.postMessage"]).toStartWith("application/json");
});
