import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.join(here, "..");
const publicRepoRoot = path.resolve(extensionRoot, "..");
const workspaceRoot = path.resolve(extensionRoot, "..", "..", "..");
const serverRoot = path.join(
  publicRepoRoot,
  "server",
  "api",
  "v1",
  "vanta",
);

const privateAdminPath = path.join(workspaceRoot, "01-LLNKKR", "Development", "Private-Server", "vanta777", "index.php");
const privateReporterPath = path.join(workspaceRoot, "05-VANTA", "tools", "firebase-usage-reporter", "reporter.py");
const privateWorkspaceAvailable = fs.existsSync(privateAdminPath) && fs.existsSync(privateReporterPath);

if (!privateWorkspaceAvailable) {
  await import("./public-security.test.mjs");
} else {

const background = fs.readFileSync(path.join(extensionRoot, "src", "background.js"), "utf8");
const rules = JSON.parse(
  fs.readFileSync(path.join(extensionRoot, "..", "firebase", "database.rules.json"), "utf8"),
);
const cursorRules = JSON.parse(
  fs.readFileSync(path.join(extensionRoot, "..", "firebase", "cursor.database.rules.json"), "utf8"),
);
const sessionsEndpoint = fs.readFileSync(path.join(serverRoot, "sessions.php"), "utf8");
const syncEndpoint = fs.readFileSync(path.join(serverRoot, "sync.php"), "utf8");
const chatEndpoint = fs.readFileSync(path.join(serverRoot, "chat.php"), "utf8");
const cursorEndpointPath = path.join(serverRoot, "cursor.php");
const cursorAccessEndpoint = fs.readFileSync(path.join(serverRoot, "cursor-access.php"), "utf8");
const presenceEndpoint = fs.readFileSync(path.join(serverRoot, "presence.php"), "utf8");
const quotaEndpoint = fs.readFileSync(path.join(serverRoot, "quota.php"), "utf8");
const settingsEndpoint = fs.readFileSync(path.join(serverRoot, "settings.php"), "utf8");
const gatewayEndpoint = fs.readFileSync(path.join(serverRoot, "gateway.php"), "utf8");
const streamEndpoint = fs.readFileSync(path.join(serverRoot, "stream.php"), "utf8");
const firebaseUsageEndpoint = fs.readFileSync(path.join(serverRoot, "firebase-usage.php"), "utf8");
const serverLibrary = fs.readFileSync(path.join(serverRoot, "lib.php"), "utf8");
const firebaseReporter = fs.readFileSync(
  privateReporterPath,
  "utf8",
);
const vantaAdmin = fs.readFileSync(
  privateAdminPath,
  "utf8",
);

const sessionRules = rules.rules.vanta.v1.sessions.$session;

test("VANTA 누적 토큰 사용 기록은 기간 제한 없이 보존한다", () => {
  assert.doesNotMatch(
    vantaAdmin,
    /DELETE\s+FROM\s+llnk_vanta_ip_usage_daily/i,
    "관리자 페이지가 오래된 일별 토큰 기록을 삭제하면 안 됩니다.",
  );
  assert.match(
    serverLibrary,
    /lifetime_used_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0/,
  );
  assert.match(serverLibrary, /lifetime_used_bytes = lifetime_used_bytes \+ VALUES\(lifetime_used_bytes\)/);
  assert.match(vantaAdmin, /COALESCE\(limits\.lifetime_used_bytes, 0\) AS lifetime_used_bytes/);
  assert.match(vantaAdmin, /\$action === 'reset_all_quotas'/);
  assert.match(vantaAdmin, /vanta_usage_admin_reset_period\(\$pdo, null, true\)/);
  assert.match(vantaAdmin, /name="action" value="reset_all_quotas"/);
  assert.match(serverLibrary, /UPDATE llnk_vanta_ip_usage_daily SET used_bytes = 0/);
  assert.match(serverLibrary, /UPDATE llnk_vanta_ip_limits SET reset_credits = 0/);
  assert.doesNotMatch(serverLibrary, /SET reset_used_count = 0|SET reset_used_bytes = 0|SET lifetime_used_bytes = 0/);
});

test("vanta777은 협업 코드 삭제와 명시적인 사용자 검색을 제공한다", () => {
  assert.match(vantaAdmin, /\$action === 'delete_partner_code'/);
  assert.match(vantaAdmin, /SELECT code FROM llnk_vanta_partner_codes WHERE code = \? FOR UPDATE/);
  assert.match(vantaAdmin, /DELETE FROM llnk_vanta_partner_redemptions WHERE code = \?/);
  assert.match(vantaAdmin, /DELETE FROM llnk_vanta_partner_codes WHERE code = \?/);
  assert.match(vantaAdmin, /hidden\('action','delete_partner_code'\)/);
  assert.match(vantaAdmin, /id="userSearchButton"/);
  assert.match(vantaAdmin, /userSearchButton\.addEventListener\('click',applyUserSearch\)/);
  assert.match(vantaAdmin, /event\.key==='Enter'/);
  assert.match(vantaAdmin, /value="lifetime_desc">누적 토큰 많은 순/);
  assert.match(vantaAdmin, /case 'lifetime_desc': return number\(b\.totalUsedTokens\)-number\(a\.totalUsedTokens\)/);
});

test("vanta777 사용자 목록은 선택 기간 활동이 없어도 누적 사용자를 유지한다", () => {
  assert.match(
    vantaAdmin,
    /SELECT ip_address FROM llnk_vanta_ip_usage_daily[\s\S]*UNION SELECT ip_address FROM llnk_vanta_ip_limits[\s\S]*UNION SELECT ip_address FROM llnk_vanta_ip_names/,
  );
  assert.match(vantaAdmin, /AS period ON period\.ip_address = known\.ip_address/);
  assert.match(
    vantaAdmin,
    /COALESCE\(period\.last_seen_at, lifetime\.last_seen_at, names_last\.last_seen_at\)/,
  );
});

test("전송된 채팅은 서버에 영구 보관되고 vanta777에서 검색한다", () => {
  assert.match(serverLibrary, /CREATE TABLE IF NOT EXISTS llnk_vanta_chat_archive/);
  assert.match(serverLibrary, /UNIQUE KEY uq_llnk_vanta_chat_message \(message_id\)/);
  assert.match(serverLibrary, /function vanta_archive_chat_message/);
  assert.match(chatEndpoint, /vanta_archive_chat_message\(\$pdo, \$roomId, \$message\)/);
  assert.match(vantaAdmin, /function vanta_admin_chat_archive/);
  assert.match(vantaAdmin, /\['dashboard', 'users', 'chats'\]/);
  assert.match(vantaAdmin, /\/vanta777\/\?view=chats/);
  assert.match(vantaAdmin, /닉네임, 메시지, 방 ID, 참여자 ID 검색/);
  assert.doesNotMatch(serverLibrary, /llnk_vanta_chat_archive[\s\S]{0,900}ip_address/);
});

test("모든 Firebase 규칙 표현식의 괄호가 균형을 이룬다", () => {
  function check(node, rulePath = "rules") {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      const nextPath = `${rulePath}.${key}`;
      if (/^\.(read|write|validate)$/.test(key) && typeof value === "string") {
        let depth = 0;
        for (const character of value) {
          if (character === "(") depth += 1;
          if (character === ")") depth -= 1;
          assert.ok(depth >= 0, `${nextPath} closes a parenthesis too early`);
        }
        assert.equal(depth, 0, `${nextPath} has unbalanced parentheses`);
      } else {
        check(value, nextPath);
      }
    }
  }
  check(rules);
});

test("작품 데이터는 LLNKKR 게이트웨이만 사용하고 Cursor 인증도 서버가 발급한다", () => {
  assert.doesNotMatch(background, /identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com/);
  assert.match(background, /api\/v1\/vanta\/sessions\.php/);
  assert.match(background, /api\/v1\/vanta\/sync\.php/);
  assert.match(background, /api\/v1\/vanta\/gateway\.php/);
  assert.match(background, /api\/v1\/vanta\/stream\.php/);
  assert.match(background, /requestRoomAuthorization\("create"/);
  assert.match(background, /requestProjectSync\("initialize"/);
  assert.match(background, /requestProjectSync\("update"/);
  assert.match(background, /VANTA_CURSOR_ACCESS_API/);
  assert.match(background, /"Authorization": `Bearer \$\{auth\.syncToken\}`/);
});

test("protocol 3 클라이언트는 Firebase snapshot에 직접 쓸 수 없다", () => {
  const snapshotWrite = sessionRules.snapshot[".write"];

  assert.equal(snapshotWrite, "auth != null && auth.token.vanta_server === true");
  assert.doesNotMatch(snapshotWrite, /protocolVersion/);

  assert.match(sessionRules.snapshot[".validate"], /newData\.child\('syncVersion'\)\.val\(\) === 2/);
  assert.match(sessionRules.snapshot[".validate"], /newData\.child\('chunkVersion'\)\.val\(\) === 1/);
  assert.match(sessionRules.snapshot[".validate"], /\{"_vantaChunked":true\}/);
});

test("구버전 프로토콜은 닫히고 release 54 권한만 참가자 ID에 묶인다", () => {
  const participantWrite = sessionRules.participants.$slot[".write"];

  assert.equal(sessionRules[".read"], "auth != null && auth.token.vanta_server === true");
  assert.equal(sessionRules.participants[".write"], "auth != null && auth.token.vanta_server === true");
  assert.doesNotMatch(sessionRules.snapshot[".write"], /protocolVersion/);
  assert.doesNotMatch(participantWrite, /protocolVersion'\)\.val\(\) === 2/);
  assert.match(participantWrite, /newData\.child\('protocolVersion'\)\.val\(\) === 3/);
  assert.match(participantWrite, /auth\.token\.vanta_protocol === 3/);
  assert.match(participantWrite, /auth\.token\.vanta_release === 54/);
  assert.match(participantWrite, /newData\.child\('releaseVersion'\)\.val\(\) === 54/);
  assert.match(
    participantWrite,
    /auth\.token\.vanta_participant === newData\.child\('participantId'\)\.val\(\)/,
  );
  assert.equal(cursorRules.rules.vanta.chat[".read"], false);
  assert.equal(cursorRules.rules.vanta.chat[".write"], false);
});

test("protocol 3의 작품 읽기는 활성 참가자 슬롯이 있어야 한다", () => {
  const snapshotRead = sessionRules.snapshot[".read"];

  for (const readRule of [snapshotRead]) {
    assert.match(readRule, /auth\.token\.vanta_release === 54/);
    assert.match(readRule, /participants/);
    assert.match(readRule, /auth\.uid/);
    assert.match(readRule, /expiresAt'\)\.val\(\) > now/);
    for (let slot = 0; slot < 5; slot += 1) {
      assert.match(readRule, new RegExp(`child\\('${slot}'\\)`));
    }
  }
  assert.match(sessionRules.meta[".read"], /auth\.token\.vanta_release === 54/);
  assert.match(sessionRules.participants[".read"], /auth\.token\.vanta_release === 54/);
  assert.match(sessionRules.meta[".validate"], /releaseVersion/);
  assert.match(sessionRules.meta[".validate"], /val\(\) === 54/);
  assert.match(sessionRules.participants.$slot[".validate"], /releaseVersion/);
});

test("Firebase v2 snapshot은 허용 필드와 청크·패치 크기를 제한한다", () => {
  const snapshotValidation = sessionRules.snapshot[".validate"];
  const chunkValidation = sessionRules.snapshot.chunks.$chunk[".validate"];
  const latestValidation = sessionRules.snapshot.latest[".validate"];

  assert.match(snapshotValidation, /_vantaInitializing/);
  assert.doesNotMatch(snapshotValidation, /8388608/);
  assert.match(chunkValidation, /manifest\|\(item\|field\)_/);
  assert.match(chunkValidation, /1048576/);
  assert.match(latestValidation, /2097152/);
  assert.equal(sessionRules.snapshot.$other[".validate"], false);
  assert.equal(sessionRules.snapshot.latest.$other[".validate"], false);
  assert.equal(sessionRules.participants.$slot.$other[".validate"], false);
});

test("LLNKKR 채팅은 활성 참가자·100자·Cursor 20슬롯·세 구간 도배 제한을 강제한다", () => {
  assert.match(background, /api\/v1\/vanta\/chat\.php/);
  assert.match(chatEndpoint, /vanta_sync_token_verify\(\$syncToken\)/);
  assert.match(chatEndpoint, /vanta_has_active_participant\(/);
  assert.match(serverLibrary, /const VANTA_CHAT_MAX_CHARACTERS = 100/);
  assert.match(serverLibrary, /function vanta_chat_text/);
  assert.match(serverLibrary, /function vanta_next_chat_sequence/);
  assert.match(serverLibrary, /function vanta_cursor_chat_firebase_url/);
  assert.match(chatEndpoint, /\(\(\$sequence - 1\) % 20\)/);
  assert.match(chatEndpoint, /vanta_cursor_chat_firebase_request\(/);
  assert.match(chatEndpoint, /'messages\/' \. \$slot/);
  assert.doesNotMatch(chatEndpoint, /X-Firebase-ETag: true/);
  assert.match(serverLibrary, /vanta_chat_second/);
  assert.match(serverLibrary, /vanta_chat_minute/);
  assert.match(serverLibrary, /vanta_chat_ten_minute/);
  assert.match(serverLibrary, /'limit' => 1/);
  assert.match(serverLibrary, /'limit' => 20/);
  assert.match(serverLibrary, /'limit' => 100/);
});

test("LLNKKR sync token은 HMAC 서명·만료·요청 신원 검증을 거친다", () => {
  assert.match(serverLibrary, /const VANTA_CURRENT_CLIENT_VERSION = '1\.1\.25'/);
  assert.match(serverLibrary, /const VANTA_CURRENT_RELEASE = 54/);
  assert.match(serverLibrary, /const VANTA_SYNC_TOKEN_VERSION = 2/);
  assert.match(serverLibrary, /function vanta_sync_token_create\(/);
  assert.match(serverLibrary, /function vanta_sync_token_verify\(/);
  assert.match(serverLibrary, /hash_hmac\(\s*'sha256'/);
  assert.match(serverLibrary, /hash_equals\(\$expectedSignature, \$providedSignature\)/);
  assert.match(serverLibrary, /\$expiresAt <= \$now/);
  assert.match(serverLibrary, /'vanta_participant' => \$participantId/);
  assert.match(serverLibrary, /'vanta_protocol' => \$protocolVersion/);
  assert.match(serverLibrary, /'vanta_release' => VANTA_CURRENT_RELEASE/);
  assert.match(serverLibrary, /'rv' => VANTA_CURRENT_RELEASE/);

  assert.match(syncEndpoint, /HTTP_AUTHORIZATION/);
  assert.match(syncEndpoint, /\^Bearer\[ \]\+/);
  assert.match(syncEndpoint, /vanta_sync_token_verify\(\$syncToken\)/);
  assert.match(syncEndpoint, /hash_equals\(\$identity\['room_id'\], \$roomId\)/);
  assert.match(syncEndpoint, /hash_equals\(\$identity\['participant_id'\], \$participantId\)/);
  assert.match(syncEndpoint, /hash_equals\(\$identity\['installation_id'\], \$installationId\)/);
  assert.match(syncEndpoint, /\$identity\['release_version'\].*VANTA_CURRENT_RELEASE/s);
  assert.match(chatEndpoint, /\$identity\['release_version'\].*VANTA_CURRENT_RELEASE/s);
});

test("모든 LLNKKR VANTA API는 관리자 최저 버전과 긴급 정지를 적용한다", () => {
  assert.match(serverLibrary, /function vanta_require_current_client\(\)/);
  assert.match(serverLibrary, /HTTP_X_VANTA_VERSION/);
  assert.match(serverLibrary, /X-VANTA-Minimum-Version/);
  assert.match(serverLibrary, /minimum_client_version/);
  assert.match(serverLibrary, /emergency_stop/);
  assert.match(serverLibrary, /llnk_fail\([^;]*426\)/s);
  for (const endpoint of [sessionsEndpoint, syncEndpoint, chatEndpoint, cursorAccessEndpoint, presenceEndpoint, quotaEndpoint, settingsEndpoint, gatewayEndpoint, streamEndpoint]) {
    assert.match(endpoint, /vanta_require_current_client\(\);/);
  }
  assert.match(background, /const RELEASE_VERSION = 54/);
  assert.match(background, /const CLIENT_VERSION = chrome\.runtime\.getManifest/);
  assert.match(background, /releaseMatches/);
  assert.doesNotMatch(background, /updateLegacySession/);
  assert.doesNotMatch(streamEndpoint, /'revision'\s*=>\s*'snapshot\/revision'/);
  assert.match(streamEndpoint, /\$syncVersion !== 2/);
  assert.match(sessionsEndpoint, /\$syncVersion !== 2/);
});

test("토큰 초기화는 IP 보유 횟수를 원자적으로 한 회 차감한다", () => {
  assert.match(serverLibrary, /reset_credits INT UNSIGNED NOT NULL DEFAULT 0/);
  assert.match(serverLibrary, /reset_used_count BIGINT UNSIGNED NOT NULL DEFAULT 0/);
  assert.match(serverLibrary, /reset_used_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0/);
  assert.match(serverLibrary, /function vanta_usage_reset_with_credit\(/);
  assert.match(serverLibrary, /SET reset_credits = reset_credits - 1,[\s\S]*reset_used_count = reset_used_count \+ 1,[\s\S]*reset_used_bytes = reset_used_bytes \+ \?[\s\S]*reset_credits > 0/);
  assert.match(serverLibrary, /SET used_bytes = 0, last_event_kind = \?/);
  assert.match(quotaEndpoint, /\$action === 'reset'/);
  assert.match(quotaEndpoint, /vanta_take_quota_reset_limits/);
  assert.match(quotaEndpoint, /보유한 토큰 초기화가 없습니다/);
  assert.match(vantaAdmin, /if \(\$action === 'adjust_resets'\)/);
  assert.match(vantaAdmin, /name="resets" type="number" min="0" max="100"/);
  assert.match(vantaAdmin, /grant_resets = VALUES\(grant_resets\)/);
  assert.match(vantaAdmin, /'resetUsedCount' =>/);
  assert.match(vantaAdmin, /'totalUsedTokens' =>/);
  assert.match(vantaAdmin, /초기화 사용/);
  assert.match(serverLibrary, /granted_resets/);
});

test("gateway와 실시간 스트림은 방장 UID를 유지해 프로필 표시가 깜빡이지 않는다", () => {
  assert.match(gatewayEndpoint, /'ownerUid' => \(string\)\(\$meta\['ownerUid'\] \?\? ''\)/);
  assert.match(background, /streamParticipantList\(participants, acquired\.ownerUid\)/);
  assert.match(background, /streamParticipantList\(participants, heartbeat\.ownerUid\)/);
  assert.match(background, /if \(String\(roomMeta\.ownerUid \|\| ""\)\) ownerUid = String\(roomMeta\.ownerUid\)/);
});

test("방 최대 인원은 2~5명이며 방을 만든 설치에서만 바꾼다", () => {
  const participantWrite = sessionRules.participants.$slot[".write"];
  const metaValidation = sessionRules.meta[".validate"];
  assert.match(metaValidation, /maxParticipants'\)\.val\(\) >= 2/);
  assert.match(metaValidation, /maxParticipants'\)\.val\(\) <= 5/);
  assert.match(participantWrite, /maxParticipants/);
  assert.match(settingsEndpoint, /vanta_sync_token_verify\(\$syncToken\)/);
  assert.match(settingsEndpoint, /hash_equals\(\$ownerUid, \(string\)\$identity\['uid'\]\)/);
  assert.match(settingsEndpoint, /\$requested < 2 \|\| \$requested > 5/);
  assert.match(settingsEndpoint, /\$requested < max\(\$activeCount, \$minimumForActiveSlots\)/);
  for (let slot = 2; slot < 5; slot += 1) {
    const proposedSlotGuard =
      `(!newData.parent().child('participants').child('${slot}').child('expiresAt').isNumber() || `
      + `newData.parent().child('participants').child('${slot}').child('expiresAt').val() <= now || `
      + `newData.child('maxParticipants').val() >= ${slot + 1})`;
    assert.ok(metaValidation.includes(proposedSlotGuard));
  }
  assert.doesNotMatch(metaValidation, /data\.parent\(\)\.child\('participants'\)/);
  assert.match(serverLibrary, /'room-uid\|' \. \$roomId \. '\|' \. \$installationId/);
  assert.match(background, /VANTA_GET_ROOM_SETTINGS/);
  assert.match(background, /VANTA_UPDATE_ROOM_SETTINGS/);
});

test("participant UID and participant ID are pairwise unique in the proposed final slot state", () => {
  const participantSetValidation = sessionRules.participants[".validate"];
  const participantSlotValidation = sessionRules.participants.$slot[".validate"];
  const expectedPairValidations = [];

  for (let left = 0; left < 5; left += 1) {
    for (let right = left + 1; right < 5; right += 1) {
      expectedPairValidations.push(
        `(!newData.child('${left}').exists() || !newData.child('${right}').exists() || (`
        + `newData.child('${left}').child('uid').val() !== newData.child('${right}').child('uid').val() && `
        + `newData.child('${left}').child('participantId').val() !== newData.child('${right}').child('participantId').val()))`,
      );
    }
  }
  assert.equal(participantSetValidation, expectedPairValidations.join(" && "));
  assert.doesNotMatch(participantSlotValidation, /data\.parent\(\).*participantId/);
});

test("Live 커서는 방 전체 설정·필수 권한·짧은 인증·전용 Cursor Firebase 규칙으로만 직접 연결한다", () => {
  assert.match(sessionsEndpoint, /'liveCursor' => true/);
  assert.match(settingsEndpoint, /'liveCursor'/);
  assert.match(settingsEndpoint, /방을 만든 사람만 방 설정을 변경/);
  assert.match(settingsEndpoint, /remaining_tokens[\s\S]*< 1/);
  assert.match(settingsEndpoint, /\$patch\['liveCursor'\]/);
  assert.doesNotMatch(presenceEndpoint, /liveCursors|LIVE_CURSORS/);
  assert.equal(Object.hasOwn(sessionRules, "liveCursors"), false);
  assert.match(sessionRules.meta[".validate"], /liveCursor/);
  assert.equal(sessionRules.meta.liveCursor[".validate"], true);
  assert.equal(Object.hasOwn(sessionRules.meta, "liveCursorUntil"), false);
  const cursorRoomRules = cursorRules.rules.vanta.cursors.$room;
  const cursorParticipantRules = cursorRoomRules.$participant;
  assert.match(cursorRoomRules[".read"], /vanta_cursor_room/);
  assert.match(cursorRoomRules[".read"], /vanta_cursor_release == 54/);
  assert.match(cursorRoomRules[".read"], /vanta_cursor_expires_at > now/);
  assert.match(cursorParticipantRules[".write"], /vanta_cursor_participant == \$participant/);
  assert.doesNotMatch(cursorParticipantRules[".write"], /newData/);
  assert.match(cursorParticipantRules.connectionId[".validate"], /16,64/);
  assert.match(cursorParticipantRules.at[".validate"], /now - 60000/);
  assert.match(cursorParticipantRules.area[".validate"], /enginebar/);
  assert.match(cursorParticipantRules.fallbackX[".validate"], /newData\.val\(\) >= 0/);
  assert.match(cursorParticipantRules.fallbackY[".validate"], /newData\.val\(\) <= 1/);
  assert.match(cursorParticipantRules.dragging[".validate"], /newData\.isBoolean/);
  assert.match(cursorParticipantRules.dragBlockKey[".validate"], /\[a-f0-9\]\{8\}/);
  assert.match(cursorParticipantRules.dragOffsetX[".validate"], /newData\.val\(\) >= 0/);
  assert.match(cursorParticipantRules.dragOffsetY[".validate"], /newData\.val\(\) <= 1/);
  for (const field of ["sceneKey", "objectKey", "blockKey"]) {
    assert.match(cursorParticipantRules[field][".validate"], /newData\.val\(\) == ''/);
    assert.doesNotMatch(cursorParticipantRules[field][".validate"], /\^\(\|/);
  }
  assert.equal(cursorParticipantRules.$other[".validate"], false);
  assert.doesNotMatch(background, /CURSOR_FIREBASE_PERMISSION|chrome\.permissions\.(request|contains)/);
  assert.match(background, /function startLiveCursorSession\(config\)/);
  assert.match(background, /function writeLiveCursor\(session, cursor\)/);
  assert.doesNotMatch(background, /chrome\.offscreen|VANTA_OFFSCREEN/);
  assert.match(background, /VANTA_CURSOR_ACCESS_API/);
  assert.equal(fs.existsSync(cursorEndpointPath), false);
  assert.match(cursorAccessEndpoint, /vanta_assert_sync_identity/);
  assert.match(cursorAccessEndpoint, /vanta_has_active_participant/);
  assert.match(cursorAccessEndpoint, /vanta_cursor_direct_enabled/);
  assert.match(cursorAccessEndpoint, /meta\/liveCursor/);
  assert.doesNotMatch(cursorAccessEndpoint, /vanta_disable_live_cursor_room/, "participant-specific failures must not disable Live Cursor for the room");
  assert.match(cursorAccessEndpoint, /VANTA_CURSOR_DIRECT_ACCESS_BYTES/);
  assert.match(serverLibrary, /const VANTA_CURSOR_DIRECT_ACCESS_SECONDS = 780/);
  assert.match(serverLibrary, /const VANTA_CURSOR_DIRECT_ACCESS_BYTES = 262144/);
  assert.match(serverLibrary, /const VANTA_PRESENCE_ACCOUNT_BYTES = 8192/);
  assert.match(serverLibrary, /CREATE TABLE IF NOT EXISTS llnk_vanta_cursor_leases/);
  assert.match(cursorAccessEndpoint, /FOR UPDATE/);
  assert.match(cursorAccessEndpoint, /\$reusePaidLease/);
  assert.match(cursorAccessEndpoint, /vanta_cursor_direct_access\(\$identity, \$expiresAt\)/);
  assert.match(serverLibrary, /vanta_cursor_live_access_install_minute[\s\S]*75/);
  assert.match(serverLibrary, /vanta_cursor_live_access_ip_minute[\s\S]*375/);
  assert.match(serverLibrary, /\['create', 'join', 'sync', 'chat', 'heartbeat', 'cursor'\]/);
});

test("새 방은 서버에서 Sync·Cursor shard를 고르고 기존 방은 등록된 shard를 유지한다", () => {
  assert.match(serverLibrary, /function vanta_new_room_shards/);
  assert.match(serverLibrary, /function vanta_choose_sync_shard/);
  assert.match(serverLibrary, /download_bytes[\s\S]*assignment_count[\s\S]*VANTA_FIREBASE_SHARD_ROOM_BALANCE_BYTES/);
  assert.match(serverLibrary, /cursor_active_shard/);
  assert.match(serverLibrary, /function vanta_use_room_shards/);
  assert.match(sessionsEndpoint, /vanta_new_room_shards\(\$pdo\)/);
  assert.match(sessionsEndpoint, /vanta_register_room\(\$pdo, \$roomId, \$roomShards\['sync'\], \$roomShards\['cursor'\]\)/);
  assert.match(vantaAdmin, /set_firebase_policy/);
  assert.doesNotMatch(vantaAdmin, /name="sync_shard"/);
  assert.match(vantaAdmin, /cursor_live_enabled/);
});

test("LLNKKR 포인터는 활성 참여자 한 행만 갱신하고 짧게 만료한다", () => {
  assert.equal(fs.existsSync(cursorEndpointPath), false);
  assert.doesNotMatch(background, /api\/v1\/vanta\/cursor\.php/);
  assert.doesNotMatch(streamEndpoint, /'cursor'\s*=>|channel === 'cursor'|cursorMode/);
  assert.match(background, /VANTA_CURSOR_ACCESS_API/);
  assert.match(background, /writeLiveCursor\(access, cursor\)/);
  assert.match(background, /&print=silent/);
  assert.match(cursorAccessEndpoint, /vanta_usage_reserve/);
});

test("IP별 미인증 닉네임 이력을 중복 없이 기록해 vanta777에 표시한다", () => {
  assert.match(serverLibrary, /CREATE TABLE IF NOT EXISTS llnk_vanta_ip_names/);
  assert.match(serverLibrary, /PRIMARY KEY \(ip_address, display_name\)/);
  assert.match(serverLibrary, /use_count = use_count \+ 1/);
  assert.match(vantaAdmin, /FROM llnk_vanta_ip_names GROUP BY ip_address/);
  assert.match(vantaAdmin, /미인증 ·/);
});

test("IP별 토큰은 선택한 일·주·월 기간으로 원자적으로 차감하고 조회한다", () => {
  assert.match(serverLibrary, /const VANTA_TOKEN_BYTES = 1048576/);
  assert.match(serverLibrary, /const VANTA_DEFAULT_QUOTA_TOKENS = 100/);
  assert.match(serverLibrary, /function vanta_usage_period\(/);
  assert.match(serverLibrary, /\['day', 'week', 'month'\]/);
  assert.match(serverLibrary, /'week'/);
  assert.match(serverLibrary, /function vanta_usage_reserve\(/);
  assert.match(serverLibrary, /usage_date BETWEEN \? AND \?[\s\S]*FOR UPDATE/);
  assert.match(serverLibrary, /used_bytes = used_bytes \+ \?/);
  assert.match(serverLibrary, /\{\$byteColumn\} = \{\$byteColumn\} \+ \?/);
  assert.match(serverLibrary, /create_bytes BIGINT UNSIGNED/);
  assert.match(serverLibrary, /cursor_bytes BIGINT UNSIGNED/);
  assert.match(serverLibrary, /daily\.create_bytes, daily\.join_bytes, daily\.sync_bytes/);
  assert.match(serverLibrary, /LEFT JOIN llnk_vanta_cursor_leases AS leases ON 1 = 0/);
  assert.match(syncEndpoint, /\$activeParticipantCount,[\s\S]*4096/);
  assert.match(chatEndpoint, /vanta_active_participant_count\(\$participants\)[\s\S]*4096/);
  assert.match(vantaAdmin, /usageHeartbeatBytes/);
  assert.match(vantaAdmin, /usageCursorBytes/);
  assert.match(vantaAdmin, /usageLegacyBytes/);
  assert.match(serverLibrary, /'remaining_percent'/);
  assert.match(serverLibrary, /function vanta_estimated_download_bytes\(/);
  assert.match(gatewayEndpoint, /vanta_usage_room_chunk_bytes/);
  assert.match(gatewayEndpoint, /vanta_usage_reserve/);
  assert.doesNotMatch(sessionsEndpoint, /vanta_usage_room_chunk_bytes/);
  assert.match(syncEndpoint, /\$estimatedDownloadBytes = vanta_estimated_download_bytes\([\s\S]*strlen\(\$encodedPatch\)[\s\S]*\$activeParticipantCount/);
  assert.match(chatEndpoint, /vanta_usage_reserve\(/);
  assert.match(background, /api\/v1\/vanta\/presence\.php/);
  assert.match(background, /const PRESENCE_REPORT_MS = 30000/);
  assert.match(presenceEndpoint, /vanta_sync_token_verify\(\$syncToken\)/);
  assert.match(presenceEndpoint, /vanta_presence_touch\(/);
  assert.match(quotaEndpoint, /vanta_usage_status\(\$pdo, \$ip\)/);
  assert.match(quotaEndpoint, /vanta_take_quota_limits/);
});

test("vanta777은 관리자 세션과 CSRF로 토큰 지급·압수·정지를 관리한다", () => {
  assert.match(vantaAdmin, /llnk_admin_is_authenticated\(\)/);
  assert.match(vantaAdmin, /llnk_admin_check_csrf/);
  assert.match(vantaAdmin, /set_default/);
  assert.match(vantaAdmin, /set_period/);
  assert.match(vantaAdmin, /quota_period/);
  assert.match(vantaAdmin, /set_limit/);
  assert.match(vantaAdmin, /bonus_tokens/);
  assert.match(vantaAdmin, /toggle_pause/);
  assert.match(vantaAdmin, /set_minimum_version/);
  assert.match(vantaAdmin, /toggle_emergency_stop/);
  assert.match(vantaAdmin, /reset_period/);
  assert.match(vantaAdmin, /setInterval\(refresh,5000\)/);
});

test("sync.php는 활성 참가자와 요청량·청크 개수·크기를 검증한다", () => {
  assert.match(syncEndpoint, /VANTA_SYNC_INITIALIZE_MAX_BYTES \+ 1/);
  assert.match(syncEndpoint, /strlen\(\$raw\) > VANTA_SYNC_UPDATE_MAX_BYTES/);
  assert.match(syncEndpoint, /vanta_take_sync_limits\(\$pdo, \$ip, \$installationId\)/);
  assert.match(syncEndpoint, /vanta_read_participants\(\$roomId, \$serverIdToken\)/);
  assert.match(syncEndpoint, /vanta_has_active_participant\(/);

  assert.match(serverLibrary, /const VANTA_SYNC_MAX_CHUNKS = 256/);
  assert.match(serverLibrary, /const VANTA_SYNC_MAX_CHANGED_CHUNKS = 32/);
  assert.match(serverLibrary, /const VANTA_SYNC_MAX_CHUNK_BYTES = 262144/);
  assert.match(serverLibrary, /const VANTA_SYNC_MAX_MANIFEST_BYTES = 131072/);
  assert.match(serverLibrary, /const VANTA_SYNC_MAX_TOTAL_CHUNK_BYTES = 2097152/);
  assert.match(serverLibrary, /const VANTA_SYNC_MAX_UPDATE_CHUNK_BYTES = 262144/);
  assert.match(serverLibrary, /const VANTA_SYNC_MAX_FANOUT_BYTES = 1048576/);
  assert.match(serverLibrary, /count\(\$rawChanges\) \+ count\(\$rawRemoved\) > VANTA_SYNC_MAX_CHANGED_CHUNKS/);
  assert.match(serverLibrary, /\$totalBytes > VANTA_SYNC_MAX_UPDATE_CHUNK_BYTES/);
  assert.match(syncEndpoint, /\$estimatedDownloadBytes > VANTA_SYNC_MAX_FANOUT_BYTES/);
  assert.match(vantaAdmin, /VANTA_SYNC_MAX_TOTAL_CHUNK_BYTES/);
  assert.match(vantaAdmin, /VANTA_SYNC_MAX_CHUNK_BYTES/);
  assert.match(vantaAdmin, /VANTA_SYNC_MAX_UPDATE_CHUNK_BYTES/);
  assert.match(vantaAdmin, /VANTA_SYNC_MAX_CHANGED_CHUNKS/);
  assert.match(vantaAdmin, /VANTA_SYNC_MAX_FANOUT_BYTES/);
  assert.match(serverLibrary, /function vanta_take_sync_limits\(/);
  assert.match(serverLibrary, /vanta_sync_install_minute/);
  assert.match(serverLibrary, /vanta_sync_ip_minute/);
});

test("sync.php의 변경 적용은 한 번의 Firebase PATCH로 revision과 청크를 함께 갱신한다", () => {
  assert.match(syncEndpoint, /'revision' => \['\.sv' => \['increment' => 1\]\]/);
  assert.match(syncEndpoint, /'latest\/revision' => \['\.sv' => \['increment' => 1\]\]/);
  assert.match(syncEndpoint, /\$patch\['chunks\/' \. \$key\] = \$chunk/);
  assert.match(syncEndpoint, /\$patch\['chunks\/' \. \$key\] = null/);
  assert.match(
    syncEndpoint,
    /vanta_firebase_session_path_request\(\s*'PATCH',\s*\$roomId,\s*'snapshot',\s*\$serverIdToken,\s*\$patch/s,
  );
});

test("sessions.php는 전체 방을 GET하지 않고 원자적으로 새 방을 만든다", () => {
  assert.doesNotMatch(sessionsEndpoint, /vanta_firebase_session_request\(\s*['"]GET['"]/s);
  assert.match(sessionsEndpoint, /vanta_read_scalar\(\$roomId, 'snapshot\/revision'/);
  assert.match(sessionsEndpoint, /vanta_read_participants\(\$roomId, \$serverIdToken\)/);
  assert.match(
    sessionsEndpoint,
    /vanta_firebase_session_request\(\s*'PUT',\s*\$roomId,\s*\$serverIdToken,\s*\$remote,\s*\['If-Match: null_etag'\]/s,
  );
  assert.match(sessionsEndpoint, /\$created\['status'\] === 412/);
});

test("LLNKKR는 방 생성 제한·서버 Custom Token·빈 방 정리를 유지한다", () => {
  assert.match(sessionsEndpoint, /vanta_take_create_limits/);
  assert.match(sessionsEndpoint, /vanta_server_id_token/);
  assert.match(serverLibrary, /vanta_create_install_daily/);
  assert.match(serverLibrary, /vanta_create_ip_daily/);
  assert.match(serverLibrary, /vanta_create_ip_burst/);
  assert.match(serverLibrary, /vanta_cleanup_empty_rooms/);
  assert.match(serverLibrary, /vanta_firebase_configured_shards\('sync'\)/);
  assert.match(serverLibrary, /cleanup_sync_shard_cursor/);
  assert.match(serverLibrary, /\(\$lastCleanupIndex \+ 1\) % count\(\$configuredSyncShards\)/);
  assert.match(serverLibrary, /\$cleanupSyncShard === \$originalSyncShard[\s\S]*vanta_server_id_token\(\)/);
  assert.match(serverLibrary, /SELECT room_id, cursor_shard FROM llnk_vanta_rooms/);
  assert.match(serverLibrary, /vanta_set_request_shards\([\s\S]*\$cleanupSyncShard[\s\S]*cursor_shard/);
  assert.match(sessionsEndpoint, /vanta_delete_room_if_empty/);
  assert.match(serverLibrary, /\$releaseVersion !== VANTA_CURRENT_RELEASE/);
  assert.match(serverLibrary, /\$participantsBeforeDelete = vanta_read_participants/);
  assert.match(serverLibrary, /openssl_sign/);
});

test("노트북 수집기는 서명된 실제 Firebase 사용량만 저장하고 프로젝트별로 표시한다", () => {
  assert.match(firebaseUsageEndpoint, /VANTA_FIREBASE_USAGE_REPORT_MAX_BYTES \+ 1/);
  assert.match(firebaseUsageEndpoint, /HTTP_X_VANTA_USAGE_TIMESTAMP/);
  assert.match(firebaseUsageEndpoint, /HTTP_X_VANTA_USAGE_SIGNATURE/);
  assert.match(firebaseUsageEndpoint, /hash_hmac\('sha256', \$timestampText \. "\\n" \. \$raw/);
  assert.match(firebaseUsageEndpoint, /hash_equals\(\$expected, \$signature\)/);
  assert.match(firebaseUsageEndpoint, /vanta_record_firebase_usage/);
  assert.match(serverLibrary, /CREATE TABLE IF NOT EXISTS llnk_vanta_firebase_usage/);
  assert.match(serverLibrary, /CREATE TABLE IF NOT EXISTS llnk_vanta_firebase_usage_history/);
  assert.match(serverLibrary, /INSERT IGNORE INTO llnk_vanta_firebase_usage_history/);
  assert.match(serverLibrary, /sample_count/);
  assert.match(vantaAdmin, /firebaseProjects/);
  assert.match(vantaAdmin, /Firebase 프로젝트 사용량/);
  assert.match(vantaAdmin, /30분 간격/);
});

test("Firebase 콘솔의 일시적인 빈 화면은 기존 사용량을 0으로 덮어쓰지 않는다", () => {
  assert.match(serverLibrary, /downloadBytes'\] === 0 && \$numeric\['storageBytes'\] === 0/);
  assert.match(serverLibrary, /Suspicious zero Firebase usage report/);
  assert.match(firebaseReporter, /Realtime Database 사용량이 비어 있어 이번 측정을 건너뜁니다/);
  assert.doesNotMatch(firebaseReporter, /if section == "":\s*download_bytes = 0/);
});

test("session and settings control requests are bounded before parsing", () => {
  for (const endpoint of [sessionsEndpoint, settingsEndpoint]) {
    const limit = endpoint.indexOf("VANTA_CONTROL_MAX_REQUEST_BYTES");
    const read = endpoint.indexOf("file_get_contents('php://input', false, null, 0, VANTA_CONTROL_MAX_REQUEST_BYTES + 1)");
    const parse = endpoint.indexOf("json_decode($raw, true)");
    assert.ok(limit >= 0, "control-plane request has a size guard");
    assert.ok(read > limit, "request body read is bounded");
    assert.ok(parse > read, "only the bounded body is decoded");
    assert.doesNotMatch(endpoint, /\$input\s*=\s*llnk_json_input\(\)/);
  }
  assert.match(serverLibrary, /const VANTA_CONTROL_MAX_REQUEST_BYTES = 4096;/);
});
}
