import { expect, test } from "bun:test";
import { startupFailure } from "../src/startup-screen.ts";

// Which text on a new lane's screen is a failed start (#202). The hc join itself is tested through launch.
const warning = `Warning: Failed to load extension "/x/ext/index.js": Cannot find module '/x/ext/node_modules/gone/index.mjs'`;

test("omo's extension warning and its Bun tail are not a failure, whatever the path looks like", () => {
  for (const path of [
    "/Users/John Doe/.omo/agent/extensions/quota-meter/index.js",
    "/Users/anna.tsai/.omo/agent/extensions/quota-meter/index.js",
    "/opt/node.js/.omo/agent/extensions/quota-meter/index.js",
    "C:\\Users\\anna.tsai\\.omo\\agent\\extensions\\quota-meter\\index.js",
  ])
    expect(startupFailure(`${warning} imported from ${path}\n❯ `)).toBeNull();
});

// The fixture corpus. A new failure phrase or a new false alarm goes here first, then into the table.
// REAL: output as tools and providers print it, each with its source, and the phrase it must report.
const REAL: readonly (readonly [string, string, string])[] = [
  ["node/bun", "Error: Cannot find module '/repo/dist/cli.js'", "Cannot find module"],
  [
    "anthropic api, as a dori review receipt logged it",
    '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    "rate_limit_error",
  ],
  [
    "openai api",
    "Error: 429 You exceeded your current quota, please check your plan and billing details.",
    "exceeded your current quota",
  ],
  [
    "openai api",
    "Error: 429 Rate limit reached for gpt-4o in organization org-x on tokens per min (TPM): Limit 30000, Used 29600, Requested 800.",
    "Rate limit reached",
  ],
  ["openai/anthropic sdk", "RateLimitError: 429 status code (no body)", "RateLimitError: 429"],
  ["openai/anthropic sdk, no class name", "Error: 429 status code (no body)", "429 status code (no body)"],
  ["gemini api", "[429 Too Many Requests] Resource has been exhausted (e.g. check quota).", "429 Too Many Requests"],
  [
    "gemini python sdk",
    "google.api_core.exceptions.ResourceExhausted: 429 Resource has been exhausted (e.g. check quota).",
    "Resource has been exhausted",
  ],
  [
    "grpc status (gemini, vertex)",
    "8 RESOURCE_EXHAUSTED: Resource exhausted. Please try again later.",
    "RESOURCE_EXHAUSTED: Resource exhausted",
  ],
  ["gemini api", "Quota exceeded for quota metric 'Generate Content API requests per minute'", "Quota exceeded"],
  ["claude code", "Claude AI usage limit reached|1700000000", "usage limit reached"],
  ["claude.ai", "You've reached your usage limit.", "reached your usage limit"],
  [
    "codex cli",
    "\u25a0 You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again later.",
    "hit your usage limit",
  ],
  [
    "openai error body",
    '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}',
    "exceeded your current quota",
  ],
];
// RULE: lines shaped to test one rule: omo's own failure lines that dori matched before #202, and glued forms.
const RULE: readonly (readonly [string, string])[] = [
  ["All fallback models failed: anthropic, openai", "All fallback models failed"],
  ["No API key found for provider anthropic", "No API key"],
  ["error: model_not_available", "model_not_available"],
  ["Session crashed (exit 1)", "Session crashed"],
  ["Error: unknown provider: foo", "unknown provider"],
  ["Error: rate limited by provider", "rate limited"],
  ["Error: all quotas exhausted", "quotas exhausted"],
  ["error: QUOTA_EXCEEDED", "QUOTA_EXCEEDED"],
  ["code=quotaExceeded", "quotaExceeded"],
  ["status: RESOURCE_EXHAUSTED", "RESOURCE_EXHAUSTED"],
  ["Error: QUOTA_EXCEEDED", "QUOTA_EXCEEDED"],
  ["ERROR: insufficient_quota", "insufficient_quota"],
  ["Status: RESOURCE_EXHAUSTED", "RESOURCE_EXHAUSTED"],
  ["{'type': 'error', 'error': {'type': 'rate_limit_error', 'message': 'x'}}", "rate_limit_error"],
  ["usage limit reached.", "usage limit reached"],
  ["Loading providers okNo API key found", "No API key"],
  ["Loading providers okRate limit exceeded", "Rate limit exceeded"],
  ["Loading providers okRate Limit Exceeded", "Rate Limit Exceeded"],
  ["Loading providers okRATE LIMIT EXCEEDED", "RATE LIMIT EXCEEDED"],
  ["Loading providers OKRate limit exceeded", "Rate limit exceeded"],
  ["Loading providers okQuota exceeded for model", "Quota exceeded"],
  ["Loading providers okQuota Exceeded", "Quota Exceeded"],
  ["Loading providers okUsage limit reached", "Usage limit reached"],
  ["Loading providers ok429 Too Many Requests", "429 Too Many Requests"],
  // Glued after a pane-wide line that ends in punctuation or a path: still printed text, still a failure.
  ["Loading providers.....Quota exceeded for quota metric 'x'", "Quota exceeded"],
  ["------------------------Rate limit reached for gpt-4o", "Rate limit reached"],
  ["/very/long/path/Rate limit exceeded", "Rate limit exceeded"],
  ["provider says rate-limit exceeded", "rate-limit exceeded"],
  ["Error: Too Many Requests", "Error: Too Many Requests"],
];
// HEALTHY: code, names, paths and prose a working lane's screen can show; none is a failure.
const HEALTHY: readonly string[] = [
  "const rateLimit = ratelimiter(noApiKey, usageLimit); // SessionCrashed",
  "load is moderate\nlimits apply",
  "load is moderate limits apply",
  "const quotaUsed = 3;",
  "my_quota_check",
  "const e = isQuotaExceeded(r);",
  "handler: onRateLimitExceeded",
  "class RateLimiter {}",
  "if (err instanceof RateLimitError) retry()",
  "import { RateLimitError } from '@anthropic-ai/sdk'",
  "res.status(429).send('Too Many Requests')",
  "case 'rate_limit_error':",
  "if (status === 'RESOURCE_EXHAUSTED') backoff()",
  "RATE_LIMIT_EXCEEDED = 1",
  "const code = 'insufficient_quota';",
  "throw { type: 'rate_limit_error', message: 'x' }",
  "errorType: RESOURCE_EXHAUSTED",
  "if (code == 'quota_exceeded') retry()",
  'throw { type: "rate_limit_error", message: "x" }',
  "foo_Rate limit exceeded",
  "the userQuota field is set",
  "maxQuota of 10",
  "loaded the quota-meter extension",
  "bun run cli --quota=5",
  "set a rate limit of 10 per second",
  "check the usage limit in settings",
  "the rate limiter is configured",
  "a rate-limited queue",
  "bun add rate-limiter-flexible",
  "You are the fix-rate-limit-error lane; report as the footer says",
  "Read and execute the lane brief at /x/briefs/rate-limiter.md in full. You are the rate-limiter lane.",
  "Read /x/briefs/quota-exceeded-alerts.md and the usage-limit-reached-banner lane",
  "the moderate limit reached its cap",
  "set the flag rate-limit-reached to false",
  "notes in /x/briefs/quota exhausted handling.md",
  "\u276f \n Pursuing goal (1m)",
];

// DECIDED: trade-offs ruled on after six review rounds of this matcher (LEAD, 2026-11-12). Each row says what it reports
// and why. Changing one is a decision, not a regex fix.
const DECIDED: readonly (readonly [string, string | null, string])[] = [
  [
    "notes in /x/briefs/Quota exceeded handling.md",
    "Quota exceeded",
    "a provider phrase glued after a path is caught (/very/long/path/Rate limit exceeded), so a capitalised one inside a path segment alarms too; lane keys and brief names are kebab-case and lower-case",
  ],
  [
    'expect(err.message).toBe("Error: Too Many Requests")',
    "Error: Too Many Requests",
    "the printed line is caught wherever it shows; code that quotes it alarms too, and only the 20 s screen and an idle lane with no goal are checked",
  ],
  [
    "dispatch({ status: RESOURCE_EXHAUSTED })",
    "RESOURCE_EXHAUSTED",
    "an unquoted key with an unquoted value is how logs print a status field, so the same shape in source alarms too",
  ],
];

test("every real tool and provider line reports its phrase", () => {
  for (const [source, text, found] of REAL) expect([source, startupFailure(text)]).toEqual([source, found]);
});

test("every rule case reports its phrase", () => {
  for (const [text, found] of RULE) expect([text, startupFailure(text)]).toEqual([text, found]);
});

test("no code, name, path or prose in the corpus is a failure", () => {
  for (const text of HEALTHY) expect([text, startupFailure(text)]).toEqual([text, null]);
});

test("every decided trade-off reports what was decided", () => {
  for (const [text, found, why] of DECIDED) expect([text, why, startupFailure(text)]).toEqual([text, why, found]);
});
