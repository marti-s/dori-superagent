import { beforeAll, describe, expect, test } from "bun:test";

import { type Finding, lintFixtures } from "./rule-findings.ts";

type Case = readonly [name: string, source: string];

const sleepCode = "dori-testing(no-fixed-sleep)";

const sleeps: readonly Case[] = [
  [
    "setTimeout promise with a block body",
    "test('x', async () => { await new Promise((resolve) => { setTimeout(resolve, 250); }); });",
  ],
  [
    "setTimeout promise with an expression body",
    "test('x', async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });",
  ],
  [
    "globalThis.setTimeout",
    "test('x', async () => { await new Promise<void>((done) => globalThis.setTimeout(() => done(), 31_000)); });",
  ],
  [
    "timers/promises import aliased to sleep",
    'import { setTimeout as sleep } from "node:timers/promises"; test("x", async () => { await sleep(500); });',
  ],
  [
    "bare timers/promises import",
    'import { setTimeout } from "timers/promises"; afterEach(async () => { await setTimeout(20); });',
  ],
  ["scheduler.wait in a hook", "beforeEach(async () => { await scheduler.wait(10); });"],
  ["Bun.sleep", "test('x', async () => { await Bun.sleep(100); });"],
  ["test.each modifier", "test.each([1])('x %s', async () => { await scheduler.wait(1); });"],
  ["test.concurrent modifier", "test.concurrent('x', async () => { await scheduler.wait(1); });"],
  [
    "it.skipIf modifier with a function expression",
    "it.skipIf(ci)('x', async function () { await scheduler.wait(1); });",
  ],
];

const signals: readonly Case[] = [
  ["awaiting the operation itself", "test('x', async () => { await operation(); });"],
  ["a withResolvers promise", "test('x', async () => { const r = Promise.withResolvers(); await r.promise; });"],
  [
    "a sleep after fake timers",
    "test('x', async () => { vi.useFakeTimers(); await new Promise((resolve) => { setTimeout(resolve, 250); }); });",
  ],
  ["a sleep outside any test body", "serve(async () => { await scheduler.wait(10); return new Response(); });"],
  [
    "a sleep inside a helper the test awaits",
    "async function backoff(attempt) { await scheduler.wait(2 ** attempt); } test('x', async () => { await backoff(1); });",
  ],
  [
    "a timeout raced against real work",
    "test('x', async () => { await Promise.race([work, new Promise((resolve) => { setTimeout(() => resolve('pending'), 0); })]); });",
  ],
  [
    "a promise with a second scheduled statement",
    "test('x', async () => { await new Promise((resolve) => { setTimeout(resolve, 10); queueMicrotask(resolve); }); });",
  ],
  [
    "a cancelled timer without an await",
    "test('x', async () => { const timer = setTimeout(cancel, 10); await work(); clearTimeout(timer); });",
  ],
];

// One oxlint run for every fixture in this file; each test reads its own case's findings.
let results: Finding[][] = [];
const codesAt = (index: number): string[] => (results[index] ?? []).map((finding) => finding.code);

describe("no-fixed-sleep through the ratchet lint configuration", () => {
  beforeAll(() => {
    results = lintFixtures([...sleeps, ...signals].map(([, source]) => source));
  });
  sleeps.forEach(([name], index) => {
    test(`reports ${name}`, () => {
      expect(codesAt(index)).toEqual([sleepCode]);
    });
  });
  signals.forEach(([name], index) => {
    test(`allows ${name}`, () => {
      expect(codesAt(sleeps.length + index)).toEqual([]);
    });
  });
});
