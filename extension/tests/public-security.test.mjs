import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const serverRoot = path.join(repoRoot, "server", "api", "v1", "vanta");
const library = fs.readFileSync(path.join(serverRoot, "lib.php"), "utf8");
const cursorAccess = fs.readFileSync(path.join(serverRoot, "cursor-access.php"), "utf8");
const configExample = fs.readFileSync(path.join(repoRoot, "server", "config.example.php"), "utf8");

test("공개 서버와 클라이언트는 동일한 결정적 청크 문법을 사용한다", () => {
  assert.match(library, /function vanta_bounded_chunk_key/);
  assert.match(library, /strlen\(\$name\) > 128/);
  assert.match(library, /vanta_bounded_chunk_key\('field', \$name\)/);
  assert.match(library, /vanta_item_identity\(\$decoded\)/);
  assert.match(library, /Invalid VANTA item chunk key/);
});

test("참여자별 실패가 방 전체 Live Cursor를 끄지 않는다", () => {
  assert.doesNotMatch(cursorAccess, /vanta_disable_live_cursor_room/);
  assert.match(cursorAccess, /vanta_take_cursor_live_access_limits/);
  assert.match(cursorAccess, /vanta_usage_reserve/);
});

test("공개 예제에는 실제 키나 개인 키가 없다", () => {
  assert.doesNotMatch(configExample, /AIza[0-9A-Za-z_-]{30,}/);
  assert.doesNotMatch(configExample, /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/);
  assert.match(configExample, /CHANGE_TO_FIREBASE_WEB_API_KEY/);
  assert.match(configExample, /https:\/\/example\.com/);
});
