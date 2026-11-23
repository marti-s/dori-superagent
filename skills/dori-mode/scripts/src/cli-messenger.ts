/** dori send, presence, inbound and transcribe: the messengers. */
import { type Command, die, envSlackToken, every, slackAuth } from "./cli-context.ts";
import { Discord, discordPresence } from "./messenger/discord.ts";
import { fetchHttp, MessengerError, UnsafeMessageError } from "./messenger/http.ts";
import { Slack } from "./messenger/slack.ts";
import { pollSlackInbound } from "./messenger/slack-inbound.ts";
import { slackPresence } from "./messenger/slack-presence.ts";
import { Telegram } from "./messenger/telegram.ts";
import { envInt, fileTgInboundStore, telegramInboundLoop } from "./messenger/telegram-inbound.ts";
import { formatTelegramInbound } from "./messenger/telegram-line.ts";
import { ThreadLedger } from "./messenger/thread-ledger.ts";
import { realTimers } from "./messenger/typing.ts";
import { transcribe, TranscriptionError } from "./messenger/voice.ts";
import { realClock, run } from "./run.ts";

/** Messenger errors are one line, never a stack. */
export const messengerErrors = [MessengerError, UnsafeMessageError, TranscriptionError] as const;

const NO_SLACK_TOKEN = "DORI_SLACK_TOKEN is not set (nor DORI_SLACK_TOKEN_FILE)";

const send: Command = async ({ key, need, opt, values, config }) => {
  const platform = key ?? die("send needs slack, telegram or discord");
  const to = need("to");
  const text = need("text");
  const token = (name: string) => process.env[name] ?? die(`${name} is not set`);
  // An empty --thread or --edit ("$UNSET") would post a new top-level message instead of replying or editing.
  const present = (flag: string): string | undefined =>
    values[flag] === undefined ? undefined : opt(flag) || die(`--${flag} is empty: leave it out to post a new message`);
  if (platform === "slack") {
    const ts = present("edit");
    const threadTs = present("thread");
    const slack = new Slack(
      fetchHttp,
      realClock,
      slackAuth(envSlackToken() ?? die(NO_SLACK_TOKEN)),
      undefined,
      new ThreadLedger(`${config.stateDir}/slack-threads.json`),
    );
    if (ts !== undefined) await slack.edit(to, ts, text);
    else console.log(`SENT ${(await slack.post(to, text, threadTs)).ts}`);
  } else if (platform === "telegram") {
    // Number("telegram:-1001/42") is NaN, and the Telegram target drops a falsy threadId, so a bad --thread
    // would post to the group's General topic. A flag given empty (--thread "$UNSET") is refused too: no topic
    // means leaving the flag out.
    const id = (flag: string, what: string): number | undefined => {
      if (values[flag] === undefined) return undefined;
      const value = opt(flag) ?? "";
      return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
        ? Number(value)
        : die(`--${flag} must be a Telegram ${what} id, a whole number above 0`);
    };
    const threadId = id("thread", "topic");
    const target = { chatId: to, ...(threadId !== undefined ? { threadId } : {}) };
    const messageId = id("edit", "message");
    const tg = new Telegram(fetchHttp, realClock, token("DORI_TELEGRAM_TOKEN"));
    if (messageId !== undefined) await tg.edit(target, messageId, text);
    else console.log(`SENT ${await tg.send(target, text)}`);
  } else if (platform === "discord") {
    const messageId = present("edit");
    const thread = present("thread");
    const dc = new Discord(fetchHttp, realClock, token("DORI_DISCORD_TOKEN"));
    if (messageId !== undefined) await dc.edit(to, messageId, text);
    else console.log(`SENT ${await dc.send(thread ?? to, text)}`);
  } else die(`unknown platform ${platform}`);
};

const presence: Command = async ({ key }) => {
  if (key === "slack") {
    const auth = {
      token: envSlackToken() ?? die(NO_SLACK_TOKEN),
      cookie:
        process.env["DORI_SLACK_COOKIE"] ??
        die("DORI_SLACK_COOKIE is not set (user-token presence needs the d cookie)"),
    };
    const p = slackPresence(
      new Slack(fetchHttp, realClock, auth),
      (url, headers) => {
        const options: Bun.WebSocketOptions = { headers: { ...headers } };
        const ws = new WebSocket(url, options);
        return { isOpen: () => ws.readyState === WebSocket.OPEN, send: (f) => ws.send(f), close: () => ws.close() };
      },
      auth,
    );
    console.log("PRESENCE_READY slack");
    await every(1, async () => console.log(`PRESENCE slack ${await p.hold()}`));
  } else if (key === "discord") {
    const token = process.env["DORI_DISCORD_TOKEN"] ?? die("DORI_DISCORD_TOKEN is not set");
    discordPresence(
      () => {
        const ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
        let handler: (d: string) => void = () => {};
        ws.addEventListener("message", (e) => handler(String(e.data)));
        return {
          send: (d) => ws.send(d),
          close: () => ws.close(),
          onMessage: (cb) => {
            handler = cb;
          },
        };
      },
      token,
      realTimers,
    );
    console.log("PRESENCE_READY discord");
    await new Promise(() => {});
  } else die("presence needs slack or discord");
};

const telegramInbound = async (stateDir: string, minutes: number): Promise<void> => {
  const tg = new Telegram(
    fetchHttp,
    realClock,
    process.env["DORI_TELEGRAM_TOKEN"] ?? die("DORI_TELEGRAM_TOKEN is not set"),
  );
  const store = fileTgInboundStore(`${stateDir}/telegram-offset`);
  const num = (name: string): number => {
    try {
      return envInt(name, process.env[name]);
    } catch (e) {
      return die(e instanceof Error ? e.message : String(e));
    }
  };
  const ownerId = num("DORI_TELEGRAM_OWNER_ID");
  const groupChatId = process.env["DORI_TELEGRAM_GROUP_ID"] === undefined ? undefined : num("DORI_TELEGRAM_GROUP_ID");
  const topicId = process.env["DORI_TELEGRAM_TOPIC_ID"] === undefined ? undefined : num("DORI_TELEGRAM_TOPIC_ID");
  console.log(`INBOUND_READY telegram owner=${ownerId} group=${groupChatId ?? "-"} topic=${topicId ?? "-"}`);
  await telegramInboundLoop(
    tg,
    store,
    {
      ownerId,
      ...(groupChatId !== undefined ? { groupChatId } : {}),
      ...(topicId !== undefined ? { topicId } : {}),
    },
    minutes,
    (i) => console.log(formatTelegramInbound(i)),
    (m) => console.log(`WARN ${m}`.slice(0, 300)),
  );
};

const inbound: Command = async ({ key, loopMinutes, config }) => {
  const minutes = loopMinutes();
  if (key === "telegram") return await telegramInbound(config.stateDir, minutes);
  if (key !== "slack") die("inbound supports slack or telegram");
  const auth = slackAuth(envSlackToken() ?? die(NO_SLACK_TOKEN));
  const ledger = new ThreadLedger(`${config.stateDir}/slack-threads.json`);
  const slack = new Slack(fetchHttp, realClock, auth, undefined, ledger);
  const me = String((await slack.call("auth.test", {}))["user_id"] ?? die("auth.test returned no user_id"));
  console.log("INBOUND_READY slack");
  const told = new Set<string>();
  const warn = (message: string) => {
    if (!told.has(message)) console.log(`WARN ${message}`.slice(0, 300));
    told.add(message);
  };
  await every(minutes, async () => {
    for (const i of await pollSlackInbound(slack, ledger, { selfUserId: me, warn }))
      console.log(
        `INBOUND ${i.source} ${i.channel} ${i.threadTs ?? "-"} ${i.ts || "-"} ${i.user ?? "-"} ${JSON.stringify((i.text ?? "").slice(0, 200))}`,
      );
  });
};

export const messengerCommands: Readonly<Record<string, Command>> = {
  send,
  presence,
  inbound,
  transcribe: async ({ key, config }) => {
    console.log(await transcribe(run, config.hooks.transcribe, key ?? die("transcribe needs an audio file path")));
  },
};
