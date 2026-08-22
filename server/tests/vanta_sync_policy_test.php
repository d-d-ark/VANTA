<?php
declare(strict_types=1);

function sync_expect(bool $condition, string $message): void
{
    if (!$condition) {
        fwrite(STDERR, "FAIL: {$message}\n");
        exit(1);
    }
}

define('LLNK_VANTA_IP_SECRET', str_repeat('test-sync-secret-', 3));
define('LLNK_VANTA_FIREBASE_CLIENT_EMAIL', 'server-test@example.invalid');
define('LLNK_VANTA_FIREBASE_DATABASE_URL', 'https://test.invalid');

require_once dirname(__DIR__) . '/api/v1/vanta/lib.php';

$roomId = str_repeat('r', 32);
$uid = 'vanta_test_uid';
$participantId = 'participant_789';
$installationId = str_repeat('i', 32);
$token = vanta_sync_token_create(
    $roomId,
    $uid,
    $participantId,
    $installationId,
    3,
    ((int)round(microtime(true) * 1000)) + 3600000
);
$identity = vanta_sync_token_verify($token);
sync_expect($identity['room_id'] === $roomId, 'sync token binds room');
sync_expect($identity['uid'] === $uid, 'sync token binds uid');
sync_expect($identity['participant_id'] === $participantId, 'sync token binds participant');
sync_expect($identity['installation_id'] === $installationId, 'sync token binds installation');
sync_expect($identity['protocol_version'] === 3, 'sync token binds protocol 3');
sync_expect($identity['release_version'] === VANTA_CURRENT_RELEASE, 'sync token binds current release');

[$payload, $signature] = explode('.', $token, 2);
$tamperedSignature = ($signature[0] === 'A' ? 'B' : 'A') . substr($signature, 1);
$tamperedRejected = false;
try {
    vanta_sync_token_verify($payload . '.' . $tamperedSignature);
} catch (VantaSyncAuthException $error) {
    $tamperedRejected = true;
}
sync_expect($tamperedRejected, 'tampered HMAC is rejected');

$objectsKey = vanta_bounded_chunk_key('field', 'objects');
$scenesKey = vanta_bounded_chunk_key('field', 'scenes');
$objectItemKey = vanta_bounded_chunk_key('item', 'objects:id:object');
$orphanItemKey = vanta_bounded_chunk_key('item', 'objects:id:concurrent');
$manifest = json_encode(['version' => 1, 'fields' => [
    ['name' => 'objects', 'kind' => 'value', 'key' => $objectsKey],
]], JSON_UNESCAPED_SLASHES);
$chunks = vanta_validate_initialize_chunks([
    'manifest' => $manifest,
    $objectsKey => '[]',
]);
sync_expect(count($chunks) === 2, 'initialize chunks pass validation');
$storedChunks = vanta_validate_stored_chunks([
    'manifest' => $manifest,
    $objectsKey => '[]',
    $orphanItemKey => '{"id":"concurrent"}',
]);
sync_expect(count($storedChunks) === 3, 'registry recovery preserves bounded concurrent orphan chunks');
$storedMissingReference = vanta_validate_stored_chunks([
    'manifest' => json_encode(['version' => 1, 'fields' => [
        ['name' => 'scenes', 'kind' => 'value', 'key' => $scenesKey],
    ]], JSON_UNESCAPED_SLASHES),
]);
sync_expect(count($storedMissingReference) === 1, 'registry recovery preserves stale manifest merge state');
$delta = vanta_validate_update_delta([
    'changes' => [$objectItemKey => '{"id":"object"}'],
    'removed' => [$scenesKey],
]);
sync_expect(count($delta['changes']) === 1, 'changed chunk passes validation');
sync_expect($delta['removed'] === [$scenesKey], 'removed chunk passes validation');

$identityMismatchRejected = false;
try {
    vanta_validate_update_delta([
        'changes' => [$objectItemKey => '{"id":"different"}'],
        'removed' => [],
    ]);
} catch (InvalidArgumentException $error) {
    $identityMismatchRejected = true;
}
sync_expect($identityMismatchRejected, 'item identity must match its deterministic chunk key');

$longFieldRejected = false;
try {
    $longName = str_repeat('x', 129);
    $longKey = vanta_bounded_chunk_key('field', $longName);
    vanta_validate_initialize_chunks([
        'manifest' => json_encode(['version' => 1, 'fields' => [
            ['name' => $longName, 'kind' => 'value', 'key' => $longKey],
        ]], JSON_UNESCAPED_SLASHES),
        $longKey => '{}',
    ]);
} catch (InvalidArgumentException $error) {
    $longFieldRejected = true;
}
sync_expect($longFieldRejected, 'server rejects field names that the client cannot assemble');

$usage = vanta_calculate_next_chunk_usage(
    2,
    12,
    ['field_objects' => 10],
    ['field_objects' => '[]', 'item_new' => '{}'],
    []
);
sync_expect($usage['chunk_count'] === 3, 'new chunk increments cumulative count');
sync_expect($usage['chunk_bytes'] === 6, 'overwrite replaces cumulative bytes');

$overwriteAtLimit = vanta_calculate_next_chunk_usage(
    VANTA_SYNC_MAX_CHUNKS,
    100,
    ['item_existing' => 10],
    ['item_existing' => '{}'],
    []
);
sync_expect($overwriteAtLimit['chunk_count'] === VANTA_SYNC_MAX_CHUNKS, 'overwrite remains allowed at count limit');

$countLimitRejected = false;
try {
    vanta_calculate_next_chunk_usage(
        VANTA_SYNC_MAX_CHUNKS,
        100,
        [],
        ['item_orphan' => '{}'],
        []
    );
} catch (InvalidArgumentException $error) {
    $countLimitRejected = true;
}
sync_expect($countLimitRejected, 'repeated orphan additions cannot exceed cumulative chunk count');

$byteLimitRejected = false;
try {
    vanta_calculate_next_chunk_usage(
        2,
        VANTA_SYNC_MAX_TOTAL_CHUNK_BYTES,
        [],
        ['item_orphan' => '{}'],
        []
    );
} catch (InvalidArgumentException $error) {
    $byteLimitRejected = true;
}
sync_expect($byteLimitRejected, 'repeated orphan additions cannot exceed cumulative bytes');

$cacheHandle = tmpfile();
sync_expect(is_resource($cacheHandle), 'temporary encrypted cache test file opens');
$cacheValue = [
    'token' => 'aaa.bbb.ccc.ddd.eee.fff',
    'refresh_at' => time() + 600,
    'hard_expires_at' => time() + 900,
];
vanta_server_token_cache_write_locked($cacheHandle, $cacheValue);
$cacheDecoded = vanta_server_token_cache_read_locked($cacheHandle);
sync_expect(is_array($cacheDecoded) && $cacheDecoded['token'] === $cacheValue['token'], 'server token cache round-trips encrypted');
fclose($cacheHandle);

$badKeyRejected = false;
try {
    vanta_validate_update_delta(['changes' => ['arbitrary' => '{}'], 'removed' => []]);
} catch (InvalidArgumentException $error) {
    $badKeyRejected = true;
}
sync_expect($badKeyRejected, 'non-protocol chunk key is rejected');

$serverRoot = dirname(__DIR__);
$librarySource = file_get_contents($serverRoot . '/api/v1/vanta/lib.php');
$sessionsSource = file_get_contents($serverRoot . '/api/v1/vanta/sessions.php');
$syncSource = file_get_contents($serverRoot . '/api/v1/vanta/sync.php');
sync_expect(is_string($librarySource) && strpos($librarySource, "'vanta_participant' => \$participantId") !== false, 'custom token includes participant claim');
sync_expect(is_string($librarySource) && strpos($librarySource, "'vanta_protocol' => \$protocolVersion") !== false, 'custom token includes protocol claim');
sync_expect(is_string($librarySource) && strpos($librarySource, "'vanta_release' => VANTA_CURRENT_RELEASE") !== false, 'custom token includes release claim');
sync_expect(is_string($sessionsSource) && strpos($sessionsSource, 'If-Match: null_etag') !== false, 'create uses null_etag');
sync_expect(is_string($sessionsSource) && strpos($sessionsSource, "vanta_firebase_session_request('GET'") === false, 'sessions has no root GET');
sync_expect(is_string($syncSource) && strpos($syncSource, 'HTTP_AUTHORIZATION') !== false, 'sync accepts Authorization bearer token');
sync_expect(is_string($syncSource) && strpos($syncSource, 'vanta_require_current_client();') !== false, 'sync endpoint requires current client version');
sync_expect(is_string($syncSource) && strpos($syncSource, "'latest/revision' => ['.sv' => ['increment' => 1]]") !== false, 'update increments latest revision atomically');
sync_expect(is_string($syncSource) && strpos($syncSource, 'vanta_sync_rebuild_registry') !== false, 'registry drift has an automatic recovery path');
sync_expect(is_string($librarySource) && strpos($librarySource, 'llnk_vanta_sync_chunks') !== false, 'cumulative chunk registry is present');
sync_expect(VANTA_CLOSING_LOCK_MS >= 30000, 'closing lock covers participant reread and delete timeouts');

echo "PASS: VANTA sync policy\n";
