<?php
declare(strict_types=1);

function expect_true(bool $condition, string $message): void
{
    if (!$condition) {
        fwrite(STDERR, "FAIL: {$message}\n");
        exit(1);
    }
}

$key = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
expect_true($key !== false, 'RSA test key is available');
$privateKey = '';
expect_true(openssl_pkey_export($key, $privateKey), 'RSA test key can be exported');

define('LLNK_VANTA_IP_SECRET', str_repeat('test-secret-', 4));
define('LLNK_VANTA_FIREBASE_CLIENT_EMAIL', 'vanta-test@example.iam.gserviceaccount.com');
define('LLNK_VANTA_FIREBASE_PRIVATE_KEY_BASE64', base64_encode($privateKey));
define('LLNK_VANTA_CREATE_INSTALL_DAILY_LIMIT', 100);
define('LLNK_VANTA_CREATE_IP_DAILY_LIMIT', 500);
define('LLNK_VANTA_CREATE_IP_FIVE_MINUTE_LIMIT', 30);

require_once dirname(__DIR__) . '/api/v1/vanta/lib.php';

expect_true(vanta_room_id(str_repeat('a', 32)) !== '', 'valid room id is accepted');
expect_true(vanta_room_id('../firebase') === '', 'path-like room id is rejected');
expect_true(vanta_installation_id(str_repeat('b', 36)) !== '', 'valid installation id is accepted');
expect_true(vanta_participant_id('participant_123') !== '', 'valid participant id is accepted');
expect_true(vanta_participant_id('<script>') === '', 'markup participant id is rejected');
expect_true(vanta_chat_text(str_repeat('가', 100)) !== '', 'chat accepts one hundred unicode characters');
expect_true(vanta_chat_text(str_repeat('가', 101)) === '', 'chat rejects more than one hundred unicode characters');
expect_true(vanta_chat_text("one\ntwo\nthree") !== '', 'chat accepts up to three lines');
expect_true(vanta_chat_text("one\ntwo\nthree\nfour") === '', 'chat rejects more than three lines');
expect_true(vanta_chat_display_name("  다크  ") === '다크', 'chat display names are normalized');
expect_true(vanta_partner_code(' Partner_2026 ') === 'partner_2026', 'partner codes are canonicalized');
expect_true(vanta_partner_code('ab') === '', 'partner codes shorter than three characters are rejected');
expect_true(vanta_partner_code('../partner') === '', 'path-like partner codes are rejected');

$specs = vanta_create_limit_specs();
expect_true(count($specs) === 3, 'three creation limits are configured');
expect_true($specs[0]['limit'] === 30, 'five-minute IP limit is thirty');
expect_true($specs[1]['limit'] === 100, 'daily installation limit is one hundred');
expect_true($specs[2]['limit'] === 500, 'daily IP limit is five hundred');
expect_true(vanta_active_participant_count(null, 1000) === 0, 'missing room is empty');
expect_true(vanta_active_participant_count(['participants' => [
    ['expiresAt' => 999],
    ['expiresAt' => 1001],
]], 1000) === 1, 'only unexpired participants keep a room active');
expect_true(vanta_active_participant_count([
    ['expiresAt' => 999],
    ['expiresAt' => 1001],
], 1000) === 1, 'a participants-only Firebase response is supported');

$jwt = vanta_create_custom_token('vanta_test_user', [
    'vanta_room' => str_repeat('c', 32),
    'vanta_expires_at' => 9999999999999,
]);
$parts = explode('.', $jwt);
expect_true(count($parts) === 3, 'custom token is a signed JWT');
expect_true($parts[2] !== '', 'custom token has a signature');

$roomId = str_repeat('d', 32);
$installationId = str_repeat('e', 32);
$participantId = 'participant_456';
$access = vanta_room_access($roomId, 'member', 3, $participantId, $installationId);
expect_true(is_string($access['sync_token']) && $access['sync_token'] !== '', 'protocol 3 receives a sync token');
$customParts = explode('.', $access['custom_token']);
$customPayload = json_decode(vanta_base64url_decode($customParts[1]), true);
$customClaims = $customPayload['claims'] ?? [];
expect_true(($customClaims['vanta_protocol'] ?? null) === 3, 'custom token binds protocol 3');
expect_true(($customClaims['vanta_participant'] ?? null) === $participantId, 'custom token binds participant id');
expect_true(($customClaims['vanta_release'] ?? null) === VANTA_CURRENT_RELEASE, 'custom token binds current release');
$syncIdentity = vanta_sync_token_verify($access['sync_token']);
expect_true($syncIdentity['room_id'] === $roomId, 'sync token binds room id');
expect_true($syncIdentity['uid'] === $access['uid'], 'sync token binds Firebase uid');
expect_true($syncIdentity['participant_id'] === $participantId, 'sync token binds participant id');
expect_true($syncIdentity['installation_id'] === $installationId, 'sync token binds installation id');
expect_true($syncIdentity['release_version'] === VANTA_CURRENT_RELEASE, 'sync token binds current release');

[$syncPayload, $syncSignature] = explode('.', $access['sync_token'], 2);
$tampered = $syncPayload . '.' . ($syncSignature[0] === 'A' ? 'B' : 'A') . substr($syncSignature, 1);
$tamperRejected = false;
try {
    vanta_sync_token_verify($tampered);
} catch (VantaSyncAuthException $error) {
    $tamperRejected = true;
}
expect_true($tamperRejected, 'tampered sync token is rejected');

$legacyRejected = false;
try {
    vanta_room_access($roomId, 'member', 2, $participantId, $installationId);
} catch (InvalidArgumentException $error) {
    $legacyRejected = true;
}
expect_true($legacyRejected, 'legacy protocol 2 room access is rejected');

$objectsKey = vanta_bounded_chunk_key('field', 'objects');
$scenesKey = vanta_bounded_chunk_key('field', 'scenes');
$chunks = vanta_validate_initialize_chunks([
    'manifest' => json_encode(['version' => 1, 'fields' => [
        ['name' => 'objects', 'kind' => 'value', 'key' => $objectsKey],
    ]], JSON_UNESCAPED_SLASHES),
    $objectsKey => '[]',
]);
expect_true(count($chunks) === 2, 'valid initialize chunks are accepted');
$delta = vanta_validate_update_delta([
    'changes' => [$objectsKey => '[{"id":"a"}]'],
    'removed' => [$scenesKey],
]);
expect_true(count($delta['changes']) === 1 && count($delta['removed']) === 1, 'valid chunk delta is accepted');

$manifestRemovalRejected = false;
try {
    vanta_validate_update_delta(['changes' => [], 'removed' => ['manifest']]);
} catch (InvalidArgumentException $error) {
    $manifestRemovalRejected = true;
}
expect_true($manifestRemovalRejected, 'manifest cannot be removed without replacement');

$serverRoot = dirname(__DIR__);
$sessionsSource = file_get_contents($serverRoot . '/api/v1/vanta/sessions.php');
$syncSource = file_get_contents($serverRoot . '/api/v1/vanta/sync.php');
$gatewaySource = file_get_contents($serverRoot . '/api/v1/vanta/gateway.php');
$streamSource = file_get_contents($serverRoot . '/api/v1/vanta/stream.php');
$presenceSource = file_get_contents($serverRoot . '/api/v1/vanta/presence.php');
$chatSource = file_get_contents($serverRoot . '/api/v1/vanta/chat.php');
expect_true(is_string($sessionsSource) && strpos($sessionsSource, 'If-Match: null_etag') !== false, 'room create avoids a root preflight GET');
expect_true(is_string($sessionsSource) && strpos($sessionsSource, "vanta_firebase_session_request('GET'") === false, 'sessions endpoint has no Firebase root GET');
expect_true(strpos((string)$sessionsSource, "'customToken' =>") === false, 'sessions endpoint never exposes the Firebase custom token');
expect_true(is_string($syncSource) && strpos($syncSource, 'VANTA_SYNC_UPDATE_MAX_BYTES') !== false, 'sync endpoint enforces update body limit');
expect_true(strpos((string)$sessionsSource, 'vanta_require_current_client();') !== false, 'sessions endpoint requires current client version');
expect_true(is_string($syncSource) && strpos($syncSource, "'latest/revision' => ['.sv' => ['increment' => 1]]") !== false, 'sync update increments revision atomically');
expect_true(is_string($gatewaySource) && strpos($gatewaySource, 'vanta_take_gateway_limits(') !== false, 'gateway actions have dedicated rate limits');
expect_true(substr_count((string)$gatewaySource, 'vanta_presence_touch(') >= 1, 'gateway acquire and heartbeat establish metered presence');
expect_true(strpos((string)$gatewaySource, 'vanta_require_active_presence(') !== false, 'gateway reads require an active metered presence');
expect_true(strpos((string)$gatewaySource, 'vanta_usage_room_chunk_bytes(') !== false && strpos((string)$gatewaySource, 'vanta_usage_reserve(') !== false, 'full project reads reserve quota before Firebase download');
expect_true(is_string($streamSource) && strpos($streamSource, 'vanta_take_stream_limits(') !== false, 'stream opens have dedicated rate limits');
expect_true(strpos((string)$streamSource, 'vanta_require_active_presence(') !== false, 'streams require an active metered presence');
expect_true(strpos((string)$streamSource, 'vanta_acquire_stream_lock(') !== false && strpos((string)$streamSource, 'vanta_release_stream_lock(') !== false, 'one participant cannot open parallel Firebase streams');
expect_true(is_string($presenceSource) && strpos($presenceSource, 'vanta_take_presence_limits(') !== false, 'direct presence calls have dedicated rate limits');
expect_true(is_string($chatSource) && strpos($chatSource, 'vanta_archive_chat_message($pdo, $roomId, $message)') !== false, 'delivered chats are archived by the server');
expect_true(strpos((string)$chatSource, '[LLNKKR VANTA chat archive]') !== false, 'archive failures are logged without taking chat delivery offline');
expect_true(function_exists('vanta_create_chat_archive_schema') && function_exists('vanta_archive_chat_message'), 'chat archive schema and writer are available');

$partnerSource = file_get_contents($serverRoot . '/api/v1/vanta/partner.php');
$invantaSource = file_get_contents($serverRoot . '/invanta.php');
$rewriteSource = file_get_contents($serverRoot . '/.htaccess');
$adminSource = file_get_contents(dirname($serverRoot) . '/Private-Server/vanta777/index.php');
expect_true(is_string($partnerSource) && strpos($partnerSource, "file_get_contents('php://input', false, null, 0, 513)") !== false, 'partner redemption bounds the request body before decoding');
expect_true(is_string($partnerSource) && strpos($partnerSource, 'vanta_partner_ip_minute') !== false, 'partner redemption is IP rate limited');
expect_true(is_string($partnerSource) && strpos($partnerSource, "['preview', 'redeem']") !== false, 'partner endpoint separates preview from redemption');
expect_true(is_string($partnerSource) && strpos($partnerSource, "vanta_partner_code_offer(\$pdo, \$code, \$ip)") !== false, 'partner preview does not redeem the code');
expect_true(is_string($invantaSource) && strpos($invantaSource, "location.hash.slice(1)") !== false, 'invanta reads the collaboration code from the URL fragment');
expect_true(is_string($invantaSource) && strpos($invantaSource, "history.replaceState(null, '', '/invanta/')") !== false, 'invanta removes the collaboration code before navigation');
expect_true(is_string($invantaSource) && strpos($invantaSource, "request('preview')") !== false, 'invanta previews the collaboration benefit before user confirmation');
expect_true(is_string($invantaSource) && strpos($invantaSource, "button.onclick = async") !== false && strpos($invantaSource, "request('redeem')") !== false, 'invanta redeems only after the offer button is clicked');
expect_true(is_string($invantaSource) && strpos($invantaSource, 'bpfjjmlibgajekfiddikgagnoijohcnm') !== false, 'invanta preserves the Chrome Web Store destination');
$partnerRule = strpos((string)$rewriteSource, 'RewriteRule ^invanta/?$ invanta.php');
$genericRule = strpos((string)$rewriteSource, 'RewriteRule ^([a-z0-9][a-z0-9_-]{0,63})/?$ u.php');
expect_true($partnerRule !== false && $genericRule !== false && $partnerRule < $genericRule, 'invanta is routed before generic short links');
expect_true(is_string($adminSource) && strpos($adminSource, "if (\$action === 'save_partner_code')") !== false, 'vanta777 can register partner codes');
expect_true(is_string($adminSource) && strpos($adminSource, "if (\$action === 'toggle_partner_code')") !== false, 'vanta777 can disable partner codes');
expect_true(is_string($adminSource) && strpos($adminSource, "if (\$action === 'adjust_resets')") !== false, 'vanta777 can grant and revoke token reset credits');
expect_true(strpos((string)$adminSource, 'grant_resets = VALUES(grant_resets)') !== false, 'partner codes can grant token reset credits');
expect_true(strpos((string)$adminSource, "['dashboard', 'users', 'chats']") !== false, 'vanta777 exposes dashboard, user-management, and chat-history views');
expect_true(strpos((string)$adminSource, '/vanta777/?view=users') !== false, 'vanta777 links to the user-management view');
expect_true(strpos((string)$adminSource, '/vanta777/?view=chats') !== false, 'vanta777 links to the permanent chat-history view');
expect_true(strpos((string)$adminSource, 'function vanta_admin_chat_archive') !== false, 'vanta777 searches archived chats with server-side pagination');
expect_true(strpos((string)$adminSource, '영구 채팅 기록') !== false, 'vanta777 labels permanent chat retention clearly');
expect_true(strpos((string)$adminSource, 'data-view="<?=llnk_h($view)?>"') !== false, 'vanta777 marks the active view for server-rendered separation');
expect_true(strpos((string)$adminSource, "'set_limit',") !== false && strpos((string)$adminSource, "'reset_period',") !== false, 'user-management actions redirect back to the user view');
expect_true(strpos((string)$adminSource, 'id="userSearch"') !== false && strpos((string)$adminSource, 'id="userSort"') !== false, 'user management supports search and sorting');
expect_true(strpos((string)$adminSource, 'id="userPagination"') !== false && strpos((string)$adminSource, 'data-user-page') !== false, 'user management uses numbered pagination');
expect_true(strpos((string)$adminSource, 'body[data-view="users"] .table-wrap{max-height:none') !== false, 'user management removes the old vertically scrolling table');
expect_true(strpos((string)$adminSource, 'UNION SELECT ip_address FROM llnk_vanta_ip_limits') !== false, 'user management keeps known users visible after a usage-period rollover');
expect_true(strpos((string)$adminSource, 'AS period ON period.ip_address = known.ip_address') !== false, 'user management joins selected-period usage without filtering the known-user list');
expect_true(strpos((string)$adminSource, 'COALESCE(period.last_seen_at, lifetime.last_seen_at, names_last.last_seen_at)') !== false, 'user management falls back to lifetime activity when the selected period has no usage');
$quotaSource = file_get_contents($serverRoot . '/api/v1/vanta/quota.php');
expect_true(is_string($quotaSource) && strpos($quotaSource, "\$action === 'reset'") !== false, 'quota endpoint can consume one reset credit');

echo "PASS: VANTA server policy\n";
