import { beforeAll, describe, expect, test } from "bun:test";

import { type Finding, lintFixtures } from "./rule-findings.ts";

const moduleMockCode = "dori-testing(no-module-mock)";

const replaced: readonly (readonly [name: string, source: string, count: number])[] = [
  ["a direct bun mock.module", 'import { mock } from "bun:test"; mock.module("./a", () => ({}));', 1],
  ["an aliased bun mock", 'import { mock as mockFn } from "bun:test"; mockFn.module("./a", () => ({}));', 1],
  ["a bun:test namespace import", 'import * as bunTest from "bun:test"; bunTest.mock.module("./a", () => ({}));', 1],
  ["a bun mock destructured from require", 'const { mock } = require("bun:test"); mock.module("./a", () => ({}));', 1],
  [
    "a bun mock destructured from import()",
    'const { mock } = await import("bun:test"); mock.module("./a", () => ({}));',
    1,
  ],
  ["a required bun:test namespace", 'const bunTest = require("bun:test"); bunTest.mock.module("./a", () => ({}));', 1],
  ["a const alias of bun mock", 'import { mock } from "bun:test"; const m = mock; m.module("./a", () => ({}));', 1],
  [
    "a cast alias of bun mock",
    'import { mock } from "bun:test"; const mockModule = mock as typeof mock & {}; mockModule.module("./a", () => ({}));',
    1,
  ],
  ["a mock.module above its import", 'mock.module("./a", () => ({})); import { mock } from "bun:test";', 1],
  [
    "a bun mock from an inline createRequire",
    'const { mock } = createRequire(import.meta.url)("bun:test"); mock.module("./a", () => ({}));',
    1,
  ],
  ["a mock read off require", 'require("bun:test").mock.module("./a", () => ({}));', 1],
  [
    "a namespace from an inline createRequire",
    'createRequire(import.meta.url)("bun:test").mock.module("./a", () => ({}));',
    1,
  ],
  ["bun's vi.mock alias", 'import { vi } from "bun:test"; vi.mock("./a", () => ({}));', 1],
  [
    "bun's vi.mock alias with spy: true (the exception is vitest-only)",
    'import { vi } from "bun:test"; vi.mock("./a", { spy: true });',
    1,
  ],
  ["vitest vi.mock and vi.doMock", 'import { vi } from "vitest"; vi.mock("./a"); vi.doMock("./b");', 2],
  ["a global vi.mock", 'vi.mock("./a", () => ({}));', 1],
  [
    "jest.mock, jest.doMock and unstable_mockModule",
    'import { jest } from "@jest/globals"; jest.mock("./a"); jest.doMock("./b"); jest.unstable_mockModule("./c", () => ({}));',
    3,
  ],
];

const allowed: readonly (readonly [name: string, source: string])[] = [
  [
    "bun mock functions, spies and restore",
    'import { mock, spyOn } from "bun:test"; mock(() => 1); spyOn(api, "get"); mock.restore();',
  ],
  ["bun vi.fn and vi.spyOn", 'import { vi } from "bun:test"; vi.fn(); vi.spyOn(api, "get");'],
  ["vitest vi.fn and vi.spyOn", 'import { vi } from "vitest"; vi.fn(); vi.spyOn(api, "get");'],
  ["an observing vitest vi.mock with spy: true", 'import { vi } from "vitest"; vi.mock("./a", { spy: true });'],
  ["a local object named mock", 'const mock = { module: () => 1 }; mock.module("./a");'],
  ["an unrelated .module call", 'registry.module("./a", () => ({}));'],
  ["a vi imported from a non-test module", 'import { vi } from "./fake-vi"; vi.mock("./a");'],
  ["a type-only bun:test import", 'import type { mock } from "bun:test"; declare const m: typeof mock;'],
];

// One oxlint run for every fixture in this file; each test reads its own case's findings.
let results: Finding[][] = [];

describe("no-module-mock through the ratchet lint configuration", () => {
  beforeAll(() => {
    results = lintFixtures([...replaced, ...allowed].map(([, source]) => source));
  });
  test("tells the agent to inject the dependency or use a real fake at a boundary", () => {
    expect(results[0]?.[0]?.message).toMatch(/Inject the dependency instead/);
  });
  replaced.forEach(([name, , count], index) => {
    test(`reports ${name}`, () => {
      const codes = (results[index] ?? []).map((finding) => finding.code);
      expect(codes).toEqual(Array.from({ length: count }, () => moduleMockCode));
    });
  });
  allowed.forEach(([name], index) => {
    test(`allows ${name}`, () => {
      expect(results[replaced.length + index] ?? []).toEqual([]);
    });
  });
});
