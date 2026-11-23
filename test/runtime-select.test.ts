import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, RuntimeChoiceError, readRuntimeChoice } from "../src/runtime/select.ts";

const scratch = (): string => mkdtempSync(join(tmpdir(), "dori-select-"));

const config = (text: string): string => {
  const path = join(scratch(), "config.json");
  writeFileSync(path, text);
  return path;
};
const NO_CONFIG = "/nonexistent/dori/config.json";

const pathWith = (...bins: string[]): string => {
  const dirs = bins.map((bin) => {
    const dir = join(scratch(), "bin");
    mkdirSync(dir);
    const file = join(dir, bin);
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
    return dir;
  });
  return [join(scratch(), "empty"), ...dirs].join(":");
};

describe("readRuntimeChoice precedence", () => {
  test.each([
    [
      "DORI_RUNTIME beats config and every detection",
      { DORI_RUNTIME: "hc", PATH: pathWith() },
      '{"runtime":"hc"}',
      "env",
    ],
    [
      "config beats the caller's terminal",
      { HC_TERMINAL_ID: "t3", PATH: pathWith("hc") },
      '{"runtime":"hc","other":1}',
      "config",
    ],
    ["HC_TERMINAL_ID beats PATH", { HC_TERMINAL_ID: "t3", PATH: pathWith("hc") }, "{}", "detect:HC_TERMINAL_ID"],
    ["only hc on PATH", { PATH: pathWith("hc") }, '{"other":true}', "detect:path"],
    ["an old herdr binary beside hc changes nothing", { PATH: pathWith("herdr", "hc") }, undefined, "detect:path"],
    [
      "empty variables count as unset",
      { DORI_RUNTIME: "", HC_TERMINAL_ID: "", PATH: pathWith("hc") },
      undefined,
      "detect:path",
    ],
  ] as const)("%s", (_, env, configText, source) => {
    const configPath = configText === undefined ? NO_CONFIG : config(configText);
    expect(readRuntimeChoice({ env, configPath })).toEqual({ kind: "hc", source });
  });
});

describe("readRuntimeChoice refusals", () => {
  test("no hc and nothing set: RuntimeChoiceError whose message is the fix", () => {
    let caught: unknown;
    try {
      readRuntimeChoice({ env: { PATH: pathWith() }, configPath: config("{}") });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuntimeChoiceError);
    expect((caught as Error).message).toBe("hc is not on PATH: install hc (herdr-core)");
    expect(() => readRuntimeChoice({ env: {}, configPath: NO_CONFIG })).toThrow(RuntimeChoiceError);
  });

  test("the old herdr selects nothing: not its binary on PATH, not its pane variable", () => {
    const env = { PATH: pathWith("herdr"), HERDR_PANE_ID: "w1:p3", HERDR_WORKSPACE_ID: "w1" };
    expect(() => readRuntimeChoice({ env, configPath: NO_CONFIG })).toThrow(RuntimeChoiceError);
  });

  test("a non-executable file named hc is not an install", () => {
    const dir = scratch();
    writeFileSync(join(dir, "hc"), "");
    chmodSync(join(dir, "hc"), 0o644);
    expect(() => readRuntimeChoice({ env: { PATH: dir }, configPath: NO_CONFIG })).toThrow(RuntimeChoiceError);
  });

  test.each(["tmux", "herdr"])('config value "%s": ConfigError naming the file and the value', (value) => {
    const configPath = config(JSON.stringify({ runtime: value }));
    expect(() => readRuntimeChoice({ env: { DORI_RUNTIME: "" }, configPath })).toThrow(ConfigError);
    expect(() => readRuntimeChoice({ env: {}, configPath })).toThrow(new RegExp(`${configPath}.*"${value}"`));
  });

  test("a non-string runtime value is a ConfigError too", () => {
    expect(() => readRuntimeChoice({ env: {}, configPath: config('{"runtime":7}') })).toThrow(ConfigError);
  });

  test("unreadable config JSON: ConfigError naming the file", () => {
    const configPath = config("{ runtime: hc");
    expect(() => readRuntimeChoice({ env: { PATH: pathWith("hc") }, configPath })).toThrow(ConfigError);
    expect(() => readRuntimeChoice({ env: {}, configPath })).toThrow(configPath);
  });

  test("a config file that is not an object is a ConfigError", () => {
    expect(() => readRuntimeChoice({ env: {}, configPath: config("[]") })).toThrow(ConfigError);
  });

  test.each(["tmux", "herdr"])('DORI_RUNTIME="%s" is a ConfigError naming the variable and the value', (value) => {
    const env = { DORI_RUNTIME: value, PATH: pathWith("hc") };
    expect(() => readRuntimeChoice({ env, configPath: NO_CONFIG })).toThrow(ConfigError);
    expect(() => readRuntimeChoice({ env, configPath: NO_CONFIG })).toThrow(new RegExp(`DORI_RUNTIME.*"${value}"`));
  });

  test("DORI_RUNTIME wins without reading a broken config", () => {
    expect(readRuntimeChoice({ env: { DORI_RUNTIME: "hc" }, configPath: config("not json") })).toEqual({
      kind: "hc",
      source: "env",
    });
  });
});

describe("readRuntimeChoice PATH detection is injectable", () => {
  test("exists is asked for hc in each PATH directory, in order, and for nothing else", () => {
    const asked: string[] = [];
    const exists = (path: string): boolean => {
      asked.push(path);
      return path === "/b/hc";
    };
    expect(readRuntimeChoice({ env: { PATH: "/a:/b" }, configPath: NO_CONFIG, exists })).toEqual({
      kind: "hc",
      source: "detect:path",
    });
    expect(asked).toEqual(["/a/hc", "/b/hc"]);
  });

  test("an empty PATH entry is skipped, never read as the working directory", () => {
    const asked: string[] = [];
    const exists = (path: string): boolean => {
      asked.push(path);
      return false;
    };
    expect(() => readRuntimeChoice({ env: { PATH: ":/a:" }, configPath: NO_CONFIG, exists })).toThrow(
      RuntimeChoiceError,
    );
    expect(asked.every((p) => p.startsWith("/a/"))).toBe(true);
  });
});
