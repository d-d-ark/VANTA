import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.join(here, "..");
const serverRoot = path.join(
  path.resolve(extensionRoot, ".."),
  "server",
  "api",
  "v1",
  "vanta",
);

const background = fs.readFileSync(path.join(extensionRoot, "src", "background.js"), "utf8");
const content = fs.readFileSync(path.join(extensionRoot, "src", "content.js"), "utf8");
const streamEndpoint = fs.readFileSync(path.join(serverRoot, "stream.php"), "utf8");
const serverLibrary = fs.readFileSync(path.join(serverRoot, "lib.php"), "utf8");

test("gateway streams respect Retry-After and reconnect with bounded backoff", () => {
  assert.match(background, /function streamRetryAfterMs\(response\)/);
  assert.match(background, /headers\?\.get\?\.\("Retry-After"\)/);
  assert.match(background, /let reconnectBackoffMs = 1000/);
  assert.match(background, /Math\.min\(30000, Math\.max\(1000, reconnectBackoffMs \* 2\)\)/);
  assert.match(background, /healthyConnection \? 1000 : reconnectBackoffMs/);
  assert.match(background, /type: "STREAM_RECONNECTING"[\s\S]*retryAfterMs/);
});

test("stream and full-project recovery retries are bounded", () => {
  assert.match(content, /const FULL_RECOVERY_MIN_INTERVAL_MS = 5000/);
  assert.match(content, /streamReconnectBackoffMs: 1000/);
  assert.match(content, /Math\.min\(30000, Math\.max\(1000, delay \* 2\)\)/);
  assert.match(content, /FULL_RECOVERY_MIN_INTERVAL_MS - \(Date\.now\(\) - state\.lastFullRecoveryAt\)/);
  const drain = content.indexOf("async function drainProjectChanges");
  const attempt = content.indexOf("state.lastFullRecoveryAt = Date.now();", drain);
  const download = content.indexOf('sendRuntimeMessage({ type: "VANTA_GET_SESSION"', attempt);
  assert.ok(drain >= 0 && attempt > drain && download > attempt,
    "failed full recovery attempts must also start the cooldown");
  const initialDownload = content.indexOf('sendRuntimeMessage({ type: "VANTA_GET_SESSION"');
  const initialCooldownReset = content.indexOf("state.lastFullRecoveryAt = 0;", initialDownload);
  assert.ok(initialDownload >= 0 && initialCooldownReset > initialDownload,
    "the initial snapshot must not delay recovery of the first missed realtime delta");
});

test("latest project revisions are forwarded without a replaceable timer", () => {
  assert.doesNotMatch(background, /latestEmitTimer/);
  assert.match(background,
    /channel === "latest"[\s\S]*latest = updateStreamTree\(latest, eventName, payload\);[\s\S]*emitLatest\(\);/);
  assert.doesNotMatch(background,
    /channel === "latest"[\s\S]*clearTimeout\([^)]*latest[^)]*\)[\s\S]*setTimeout\(emitLatest/);
});

test("server waits for the old participant stream before counting a reconnect", () => {
  const lock = streamEndpoint.indexOf("vanta_acquire_stream_lock");
  const limit = streamEndpoint.indexOf("vanta_take_stream_limits");
  assert.ok(lock >= 0 && limit > lock, "the stream-open limiter runs after the participant lock");
  assert.match(serverLibrary, /int \$waitSeconds = 5/);
  assert.match(serverLibrary, /SELECT GET_LOCK\(\?, \?\)/);
  assert.match(streamEndpoint, /ignore_user_abort\(false\)/);
  assert.match(streamEndpoint, /Retry-After: 2/);
});

test("1.1.10 and later compatible clients share release 54 during store rollout", () => {
  assert.match(background, /const RELEASE_VERSION = 54/);
  assert.match(serverLibrary, /const VANTA_CURRENT_CLIENT_VERSION = '1\.1\.25'/);
  assert.match(serverLibrary, /const VANTA_CURRENT_RELEASE = 54/);
  assert.match(serverLibrary, /version_compare\(\$provided, \$minimum, '<'\)/);
});

test("quota reset credits refresh immediately after an async quota response", () => {
  assert.match(content, /function updateQuotaResetDisplay\(root = getRoot\(\)\)/);
  assert.match(content, /state\.quota\?\.resetCredits \?\? state\.quota\?\.reset_credits \?\? 0/);
  assert.match(content, /function updateQuotaDisplay\(root = getRoot\(\)\)[\s\S]*updateQuotaResetDisplay\(root\)/);
});
