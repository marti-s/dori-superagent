import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
const recorder = join(import.meta.dir, "record-fetch.ts");

test("send slack and send discord refuse an empty --thread or --edit before they post anything", async () => {
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    const log = join(state.dir, "fetch.jsonl");
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
    for (const platform of ["slack", "discord"]) {
      for (const flags of [["--thread", ""], ["--thread", " "], ["--edit", ""], ["--edit"]]) {
        const r = await run(
          [
            "env",
            `DORI_CONFIG=${config}`,
            `DORI_STATE_DIR=${state.dir}`,
            "DORI_SLACK_TOKEN=xoxb-not-a-real-token",
            "DORI_DISCORD_TOKEN=not-a-real-token",
            `DORI_TEST_FETCH_LOG=${log}`,
            process.execPath,
            "--preload",
            recorder,
            cli,
            "send",
            platform,
            "--to",
            "C1",
            "--text",
            "hello",
            ...flags,
          ],
          { timeoutMs: 20_000 },
        );
        expect({ platform, flags, code: r.code, err: r.err, requests: existsSync(log) }).toEqual({
          platform,
          flags,
          code: 1,
          err: `${flags[0]} is empty: leave it out to post a new message`,
          requests: false,
        });
      }
    }
  } finally {
    state.done();
  }
}, 120_000);
