import { expect, spyOn, test } from "bun:test";
import { agentCommandArgv } from "../src/agent-command.ts";
import { shq } from "../src/delivery.ts";
import { Refusal } from "../src/refusal.ts";

// The public command configuration accepts shell quoting, but its contents stay literal.
test.each([
  { raw: "omo", argv: ["omo"] },
  { raw: " \tbin/reviewer-omo --account lane\n", argv: ["bin/reviewer-omo", "--account", "lane"] },
  { raw: "'/tools/reviewer omo' --label \"lane one\"", argv: ["/tools/reviewer omo", "--label", "lane one"] },
  { raw: "omo pre' two '\"three\"post", argv: ["omo", "pre two threepost"] },
  { raw: "omo '' \"\"", argv: ["omo", "", ""] },
  { raw: "bin/reviewer\\ omo a\\ b", argv: ["bin/reviewer omo", "a b"] },
  { raw: 'omo "a\\"b\\\\c\\$d\\`e\\q"', argv: ["omo", 'a"b\\c$d`e\\q'] },
  { raw: "omo 'a\\b\nc'", argv: ["omo", "a\\b\nc"] },
  { raw: '\\\nomo a\\\nb "c\\\nd"', argv: ["omo", "ab", "cd"] },
  { raw: `omo $HOME \${USER} *.ts ; \`id\``, argv: ["omo", "$HOME", `\${USER}`, "*.ts", ";", "`id`"] },
  {
    raw: ["reviewer", "owner's choice", "$HOME;$(exit 99)"].map(shq).join(" "),
    argv: ["reviewer", "owner's choice", "$HOME;$(exit 99)"],
  },
])("parses literal executable and arguments from $raw", ({ raw, argv }) => {
  expect(agentCommandArgv(raw)).toEqual(argv);
});

test.each(["", " \t\n", "'' --arg", '""', "omo 'unfinished", 'omo "unfinished', "omo trailing\\"])(
  "refuses malformed command configuration %j",
  (raw) => {
    expect(() => agentCommandArgv(raw)).toThrow(Refusal);
  },
);

test.each([
  { name: "another message", failure: new Error("executable lookup denied") },
  { name: "another error type", failure: new TypeError("bin path is too long") },
  { name: "a non-Error value", failure: { message: "bin path is too long" } },
])("preserves unrelated executable lookup failures: $name", ({ failure }) => {
  const lookup = spyOn(Bun, "which").mockImplementation(() => {
    throw failure;
  });
  let result: unknown;
  try {
    result = agentCommandArgv("omo --flag");
  } catch (error) {
    result = error;
  } finally {
    lookup.mockRestore();
  }
  expect(result).toBe(failure);
});
