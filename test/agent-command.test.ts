import { expect, test } from "bun:test";
import { Refusal } from "../src/refusal.ts";
import { parseAgentCommand, shq } from "../src/terminal.ts";

// The public command configuration accepts shell quoting, but its contents stay literal.
test.each([
  { raw: "omo", executable: "omo", args: [] },
  { raw: " \tbin/reviewer-omo --account lane\n", executable: "bin/reviewer-omo", args: ["--account", "lane"] },
  { raw: "'/tools/reviewer omo' --label \"lane one\"", executable: "/tools/reviewer omo", args: ["--label", "lane one"] },
  { raw: "omo pre' two '\"three\"post", executable: "omo", args: ["pre two threepost"] },
  { raw: "omo '' \"\"", executable: "omo", args: ["", ""] },
  { raw: "bin/reviewer\\ omo a\\ b", executable: "bin/reviewer omo", args: ["a b"] },
  { raw: "omo \"a\\\"b\\\\c\\$d\\`e\\q\"", executable: "omo", args: ['a"b\\c$d`e\\q'] },
  { raw: "omo 'a\\b\nc'", executable: "omo", args: ["a\\b\nc"] },
  { raw: "\\\nomo a\\\nb \"c\\\nd\"", executable: "omo", args: ["ab", "cd"] },
  { raw: "omo $HOME ${USER} *.ts ; `id`", executable: "omo", args: ["$HOME", "${USER}", "*.ts", ";", "`id`"] },
  { raw: ["reviewer", "owner's choice", "$HOME;$(exit 99)"].map(shq).join(" "), executable: "reviewer", args: ["owner's choice", "$HOME;$(exit 99)"] },
])("parses literal executable and arguments from $raw", ({ raw, executable, args }) => {
  expect(parseAgentCommand(raw)).toEqual({ executable, args });
});

test.each(["", " \t\n", "'' --arg", '""', "omo 'unfinished", 'omo "unfinished', "omo trailing\\"])(
  "refuses malformed command configuration %j",
  (raw) => {
    expect(() => parseAgentCommand(raw)).toThrow(Refusal);
  },
);
