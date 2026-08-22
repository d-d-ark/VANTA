<?php
declare(strict_types=1);

const VANTA_FIREBASE_CUSTOM_TOKEN_AUDIENCE = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';
const VANTA_CURRENT_CLIENT_VERSION = '1.1.25';
const VANTA_CURRENT_RELEASE = 54;
const VANTA_SYNC_TOKEN_VERSION = 2;
// Operational bandwidth limits are intentionally much lower than Firebase's
// technical limits. Request envelopes stay larger than the decoded chunk data
// because nested JSON strings can add substantial escaping overhead.
const VANTA_SYNC_INITIALIZE_MAX_BYTES = 5242880;
const VANTA_SYNC_UPDATE_MAX_BYTES = 1048576;
const VANTA_SYNC_MAX_CHUNKS = 256;
const VANTA_SYNC_MAX_CHANGED_CHUNKS = 32;
const VANTA_SYNC_MAX_CHUNK_BYTES = 262144;
const VANTA_SYNC_MAX_MANIFEST_BYTES = 131072;
const VANTA_SYNC_MAX_TOTAL_CHUNK_BYTES = 2097152;
const VANTA_SYNC_MAX_UPDATE_CHUNK_BYTES = 262144;
const VANTA_SYNC_MAX_FANOUT_BYTES = 1048576;
const VANTA_CHUNK_PROJECT_MARKER = '{"_vantaChunked":true}';
const VANTA_CLOSING_LOCK_MS = 55000;
const VANTA_CHAT_MAX_REQUEST_BYTES = 2048;
const VANTA_CONTROL_MAX_REQUEST_BYTES = 4096;
const VANTA_FIREBASE_USAGE_REPORT_MAX_BYTES = 16384;
const VANTA_FIREBASE_USAGE_FRESH_SECONDS = 5400;
const VANTA_FIREBASE_SHARD_ROOM_BALANCE_BYTES = 8388608;
const VANTA_CHAT_MAX_CHARACTERS = 100;
const VANTA_TOKEN_BYTES = 1048576;
const VANTA_DEFAULT_QUOTA_TOKENS = 100;
const VANTA_DEFAULT_DAILY_TOKENS = VANTA_DEFAULT_QUOTA_TOKENS;
const VANTA_PRESENCE_ACCOUNT_SECONDS = 30;
const VANTA_PRESENCE_ACCOUNT_BYTES = 8192;
const VANTA_CURSOR_DIRECT_ACCESS_BYTES = 262144;
// A paid Live cursor lease lasts thirteen minutes. The extension refreshes one
// minute early, while the server reuses the existing paid lease so reconnects
// and service-worker restarts cannot charge the same interval twice.
const VANTA_CURSOR_DIRECT_ACCESS_SECONDS = 780;

class VantaSyncAuthException extends RuntimeException
{
}

class VantaSyncConflictException extends RuntimeException
{
}

class VantaQuotaException extends RuntimeException
{
    private array $quota;

    public function __construct(array $quota)
    {
        parent::__construct('VANTA token limit reached.');
        $this->quota = $quota;
    }

    public function quota(): array
    {
        return $this->quota;
    }
}

function vanta_shard_id(string $value, string $prefix): string
{
    $value = strtolower(trim($value));
    return preg_match('/^' . preg_quote($prefix, '/') . '_[a-z0-9]{1,16}$/', $value) === 1
        ? $value
        : $prefix . '_a';
}

function vanta_set_request_shards(string $syncShard = 'sync_a', string $cursorShard = 'cursor_a'): void
{
    $GLOBALS['vanta_request_sync_shard'] = vanta_shard_id($syncShard, 'sync');
    $GLOBALS['vanta_request_cursor_shard'] = vanta_shard_id($cursorShard, 'cursor');
}

function vanta_request_shard(string $kind): string
{
    $prefix = $kind === 'cursor' ? 'cursor' : 'sync';
    return vanta_shard_id((string)($GLOBALS['vanta_request_' . $prefix . '_shard'] ?? ''), $prefix);
}

function vanta_shard_config_name(string $baseName, string $shard, string $prefix): string
{
    $shard = vanta_shard_id($shard, $prefix);
    if ($shard === $prefix . '_a') {
        return $baseName;
    }
    return $baseName . '_' . strtoupper(substr($shard, strlen($prefix) + 1));
}

function vanta_shard_config_string(string $baseName, string $kind): string
{
    $prefix = $kind === 'cursor' ? 'cursor' : 'sync';
    return vanta_config_string(vanta_shard_config_name($baseName, vanta_request_shard($kind), $prefix));
}

function vanta_base64url_encode(string $value): string
{
    return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
}

function vanta_base64url_decode(string $value): string
{
    if (preg_match('/^[A-Za-z0-9_-]*$/', $value) !== 1) {
        throw new VantaSyncAuthException('Invalid VANTA sync token.');
    }
    $padding = strlen($value) % 4;
    if ($padding !== 0) {
        $value .= str_repeat('=', 4 - $padding);
    }
    $decoded = base64_decode(strtr($value, '-_', '+/'), true);
    if (!is_string($decoded)) {
        throw new VantaSyncAuthException('Invalid VANTA sync token.');
    }
    return $decoded;
}

function vanta_room_id(string $value): string
{
    $value = trim($value);
    return preg_match('/^[A-Za-z0-9_-]{20,128}$/', $value) === 1 ? $value : '';
}

function vanta_installation_id(string $value): string
{
    $value = trim($value);
    return preg_match('/^[A-Za-z0-9_-]{20,128}$/', $value) === 1 ? $value : '';
}

function vanta_participant_id(string $value): string
{
    $value = trim($value);
    return preg_match('/^[A-Za-z0-9_-]{8,64}$/', $value) === 1 ? $value : '';
}

function vanta_service_setting(PDO $pdo, string $key, string $fallback = ''): string
{
    vanta_create_usage_schema($pdo);
    $statement = $pdo->prepare(
        'SELECT setting_value FROM llnk_vanta_settings WHERE setting_key = ? LIMIT 1'
    );
    $statement->execute([$key]);
    $value = trim((string)$statement->fetchColumn());
    return $value !== '' ? $value : $fallback;
}

function vanta_minimum_client_version(PDO $pdo): string
{
    $version = vanta_service_setting($pdo, 'minimum_client_version', VANTA_CURRENT_CLIENT_VERSION);
    if (preg_match('/^[0-9]+\.[0-9]+\.[0-9]+$/', $version) !== 1
        || version_compare($version, VANTA_CURRENT_CLIENT_VERSION, '>')) {
        return VANTA_CURRENT_CLIENT_VERSION;
    }
    return $version;
}

function vanta_emergency_stopped(PDO $pdo): bool
{
    return vanta_service_setting($pdo, 'emergency_stop', '0') === '1';
}

function vanta_require_current_client(): int
{
    $pdo = llnk_db();
    if (vanta_emergency_stopped($pdo)) {
        header('Retry-After: 60');
        llnk_fail('VANTA Live가 긴급 정지되었습니다.', 503);
    }
    $provided = trim((string)($_SERVER['HTTP_X_VANTA_VERSION'] ?? ''));
    $minimum = vanta_minimum_client_version($pdo);
    if (preg_match('/^[0-9]+\.[0-9]+\.[0-9]+$/', $provided) !== 1
        || version_compare($provided, $minimum, '<')
        || version_compare($provided, VANTA_CURRENT_CLIENT_VERSION, '>')) {
        header('X-VANTA-Minimum-Version: ' . $minimum);
        header('X-VANTA-Current-Version: ' . VANTA_CURRENT_CLIENT_VERSION);
        llnk_fail('지원되는 VANTA 확장 프로그램 버전이 필요합니다.', 426);
    }
    return VANTA_CURRENT_RELEASE;
}

function vanta_sync_token_create(
    string $roomId,
    string $uid,
    string $participantId,
    string $installationId,
    int $protocolVersion,
    int $expiresAt
): string {
    if (vanta_room_id($roomId) === ''
        || preg_match('/^[A-Za-z0-9_-]{1,128}$/', $uid) !== 1
        || vanta_participant_id($participantId) === ''
        || vanta_installation_id($installationId) === ''
        || $protocolVersion !== 3) {
        throw new InvalidArgumentException('Invalid VANTA sync identity.');
    }
    $issuedAt = time();
    $expiresAtSeconds = (int)floor($expiresAt / 1000);
    if ($expiresAtSeconds <= $issuedAt || $expiresAtSeconds > $issuedAt + 86400) {
        throw new InvalidArgumentException('Invalid VANTA sync expiry.');
    }
    $payload = json_encode([
        'v' => VANTA_SYNC_TOKEN_VERSION,
        'r' => $roomId,
        'u' => $uid,
        'p' => $participantId,
        'i' => $installationId,
        'pv' => $protocolVersion,
        'rv' => VANTA_CURRENT_RELEASE,
        'iat' => $issuedAt,
        'exp' => $expiresAtSeconds,
    ], JSON_UNESCAPED_SLASHES);
    if (!is_string($payload)) {
        throw new RuntimeException('Could not create VANTA sync token.');
    }
    $encoded = vanta_base64url_encode($payload);
    $signature = hash_hmac(
        'sha256',
        'vanta-sync-v2|' . $encoded,
        vanta_config_string('LLNK_VANTA_IP_SECRET'),
        true
    );
    return $encoded . '.' . vanta_base64url_encode($signature);
}

function vanta_sync_token_verify(string $token): array
{
    if ($token === '' || strlen($token) > 2048 || substr_count($token, '.') !== 1) {
        throw new VantaSyncAuthException('Invalid VANTA sync token.');
    }
    [$encoded, $signaturePart] = explode('.', $token, 2);
    $providedSignature = vanta_base64url_decode($signaturePart);
    $expectedSignature = hash_hmac(
        'sha256',
        'vanta-sync-v2|' . $encoded,
        vanta_config_string('LLNK_VANTA_IP_SECRET'),
        true
    );
    if (!hash_equals($expectedSignature, $providedSignature)) {
        throw new VantaSyncAuthException('Invalid VANTA sync token.');
    }
    $payload = json_decode(vanta_base64url_decode($encoded), true);
    if (!is_array($payload)) {
        throw new VantaSyncAuthException('Invalid VANTA sync token.');
    }
    try {
        vanta_assert_allowed_keys($payload, ['v', 'r', 'u', 'p', 'i', 'pv', 'rv', 'iat', 'exp'], 'sync token');
    } catch (InvalidArgumentException $error) {
        throw new VantaSyncAuthException('Invalid VANTA sync token.');
    }
    $roomId = vanta_room_id((string)($payload['r'] ?? ''));
    $uid = (string)($payload['u'] ?? '');
    $participantId = vanta_participant_id((string)($payload['p'] ?? ''));
    $installationId = vanta_installation_id((string)($payload['i'] ?? ''));
    $protocolVersion = (int)($payload['pv'] ?? 0);
    $releaseVersion = (int)($payload['rv'] ?? 0);
    $issuedAt = (int)($payload['iat'] ?? 0);
    $expiresAt = (int)($payload['exp'] ?? 0);
    $now = time();
    if ((int)($payload['v'] ?? 0) !== VANTA_SYNC_TOKEN_VERSION
        || $roomId === ''
        || preg_match('/^[A-Za-z0-9_-]{1,128}$/', $uid) !== 1
        || $participantId === ''
        || $installationId === ''
        || $protocolVersion !== 3
        || $releaseVersion !== VANTA_CURRENT_RELEASE
        || $issuedAt <= 0
        || $issuedAt > $now + 60
        || $expiresAt <= $now
        || $expiresAt > $issuedAt + 86400) {
        throw new VantaSyncAuthException('Expired or invalid VANTA sync token.');
    }
    return [
        'room_id' => $roomId,
        'uid' => $uid,
        'participant_id' => $participantId,
        'installation_id' => $installationId,
        'protocol_version' => $protocolVersion,
        'release_version' => $releaseVersion,
        'issued_at' => $issuedAt,
        'expires_at' => $expiresAt * 1000,
    ];
}

function vanta_request_sync_token(array $input = []): string
{
    $authorization = trim((string)($_SERVER['HTTP_AUTHORIZATION']
        ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION']
        ?? ''));
    if ($authorization === '' && function_exists('getallheaders')) {
        foreach ((array)getallheaders() as $headerName => $headerValue) {
            if (strcasecmp((string)$headerName, 'Authorization') === 0) {
                $authorization = trim((string)$headerValue);
                break;
            }
        }
    }
    if ($authorization !== '') {
        if (preg_match('/^Bearer[ ]+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i', $authorization, $matches) !== 1) {
            throw new VantaSyncAuthException('Invalid VANTA authorization header.');
        }
        return $matches[1];
    }
    $fallbackHeader = trim((string)($_SERVER['HTTP_X_VANTA_TOKEN'] ?? ''));
    if ($fallbackHeader !== '') {
        if (preg_match('/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/', $fallbackHeader) !== 1) {
            throw new VantaSyncAuthException('Invalid VANTA token header.');
        }
        return $fallbackHeader;
    }
    return is_string($input['syncToken'] ?? null) ? trim($input['syncToken']) : '';
}

function vanta_assert_sync_identity(
    string $syncToken,
    string $roomId,
    string $participantId,
    string $installationId
): array {
    if ($syncToken === '') {
        throw new VantaSyncAuthException('Missing VANTA sync token.');
    }
    $identity = vanta_sync_token_verify($syncToken);
    if (!hash_equals($identity['room_id'], $roomId)
        || !hash_equals($identity['participant_id'], $participantId)
        || !hash_equals($identity['installation_id'], $installationId)
        || (int)$identity['protocol_version'] !== 3
        || (int)$identity['release_version'] !== VANTA_CURRENT_RELEASE) {
        throw new VantaSyncAuthException('VANTA sync identity does not match the request.');
    }
    return $identity;
}

function vanta_assert_allowed_keys(array $value, array $allowed, string $context): void
{
    $allowedMap = array_fill_keys($allowed, true);
    foreach (array_keys($value) as $key) {
        if (!is_string($key) || !isset($allowedMap[$key])) {
            throw new InvalidArgumentException('Unexpected field in VANTA ' . $context . '.');
        }
    }
}

function vanta_sync_chunk_key(string $value): string
{
    return preg_match('/^(?:manifest|(?:item|field)_[A-Za-z0-9_-]{1,500})$/', $value) === 1 ? $value : '';
}

function vanta_bounded_chunk_key(string $prefix, string $value): string
{
    $encoded = $prefix . '_' . vanta_base64url_encode($value);
    if (strlen($encoded) <= 500) {
        return $encoded;
    }
    $hash = 2166136261;
    for ($index = 0, $length = strlen($encoded); $index < $length; $index++) {
        $hash = (($hash ^ ord($encoded[$index])) * 16777619) & 0xffffffff;
    }
    return $prefix . '_long_' . base_convert((string)$hash, 10, 36);
}

function vanta_item_identity($item): string
{
    if (!is_array($item)) {
        return '';
    }
    foreach (['id', '_id', 'objectId', 'sceneId', 'variableId', 'messageId', 'funcId', 'functionId', 'tableId'] as $field) {
        $value = $item[$field] ?? null;
        if ((is_string($value) || is_int($value) || is_float($value)) && (string)$value !== '') {
            return $field . ':' . (string)$value;
        }
    }
    return '';
}

function vanta_validate_nonmanifest_chunk(string $key, $decoded): void
{
    if (strpos($key, 'field_') === 0) {
        if (strpos($key, 'field_long_') === 0) {
            return;
        }
        try {
            $name = vanta_base64url_decode(substr($key, strlen('field_')));
        } catch (VantaSyncAuthException $error) {
            throw new InvalidArgumentException('Invalid VANTA field chunk key.');
        }
        if ($name === '' || strlen($name) > 128 || vanta_bounded_chunk_key('field', $name) !== $key) {
            throw new InvalidArgumentException('Invalid VANTA field chunk key.');
        }
        return;
    }
    $identity = vanta_item_identity($decoded);
    if ($identity === '') {
        throw new InvalidArgumentException('Invalid VANTA item chunk identity.');
    }
    foreach (['objects', 'scenes', 'variables', 'messages', 'functions', 'tables'] as $collection) {
        if (vanta_bounded_chunk_key('item', $collection . ':' . $identity) === $key) {
            return;
        }
    }
    throw new InvalidArgumentException('Invalid VANTA item chunk key.');
}

function vanta_validate_bundle_chunk_grammar(array $chunks): void
{
    $manifest = json_decode((string)($chunks['manifest'] ?? ''), true);
    if (!is_array($manifest) || !is_array($manifest['fields'] ?? null)) {
        throw new InvalidArgumentException('Invalid VANTA project manifest.');
    }
    foreach ($manifest['fields'] as $descriptor) {
        if (!is_array($descriptor) || !is_string($descriptor['name'] ?? null)) {
            throw new InvalidArgumentException('Invalid VANTA project manifest field.');
        }
        $name = $descriptor['name'];
        if (($descriptor['kind'] ?? null) === 'value') {
            $key = $descriptor['key'] ?? null;
            if (!is_string($key) || vanta_bounded_chunk_key('field', $name) !== $key) {
                throw new InvalidArgumentException('Invalid VANTA project field chunk reference.');
            }
            continue;
        }
        if (($descriptor['kind'] ?? null) !== 'items'
            || !in_array($name, ['objects', 'scenes', 'variables', 'messages', 'functions', 'tables'], true)) {
            throw new InvalidArgumentException('Invalid VANTA project collection descriptor.');
        }
        foreach (($descriptor['keys'] ?? []) as $key) {
            if (!is_string($key) || !isset($chunks[$key])) {
                continue;
            }
            $item = json_decode($chunks[$key], true);
            $identity = vanta_item_identity($item);
            if ($identity === '' || vanta_bounded_chunk_key('item', $name . ':' . $identity) !== $key) {
                throw new InvalidArgumentException('Invalid VANTA project item chunk reference.');
            }
        }
    }
}

function vanta_array_is_list(array $value): bool
{
    $expected = 0;
    foreach (array_keys($value) as $key) {
        if ($key !== $expected) {
            return false;
        }
        $expected += 1;
    }
    return true;
}

function vanta_validate_chunk_json(string $key, string $chunk): array
{
    $decoded = json_decode($chunk, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        throw new InvalidArgumentException('VANTA project chunk is not valid JSON.');
    }
    if ($key !== 'manifest') {
        vanta_validate_nonmanifest_chunk($key, $decoded);
        return [];
    }
    if (!is_array($decoded)) {
        throw new InvalidArgumentException('Invalid VANTA project manifest.');
    }
    vanta_assert_allowed_keys($decoded, ['version', 'fields'], 'manifest');
    $fields = $decoded['fields'] ?? null;
    if ((int)($decoded['version'] ?? 0) !== 1
        || !is_array($fields)
        || !vanta_array_is_list($fields)
        || count($fields) > 256) {
        throw new InvalidArgumentException('Invalid VANTA project manifest.');
    }
    $referenced = [];
    $fieldNames = [];
    foreach ($fields as $descriptor) {
        if (!is_array($descriptor)) {
            throw new InvalidArgumentException('Invalid VANTA project manifest field.');
        }
        $kind = $descriptor['kind'] ?? null;
        $name = $descriptor['name'] ?? null;
        if (!is_string($name) || $name === '' || strlen($name) > 128 || isset($fieldNames[$name])) {
            throw new InvalidArgumentException('Invalid VANTA project manifest field.');
        }
        $fieldNames[$name] = true;
        if ($kind === 'value') {
            vanta_assert_allowed_keys($descriptor, ['name', 'kind', 'key'], 'manifest field');
            $keys = [$descriptor['key'] ?? null];
            if (!is_string($keys[0]) || vanta_bounded_chunk_key('field', $name) !== $keys[0]) {
                throw new InvalidArgumentException('Invalid VANTA project field chunk reference.');
            }
        } elseif ($kind === 'items') {
            vanta_assert_allowed_keys($descriptor, ['name', 'kind', 'keys'], 'manifest field');
            $keys = $descriptor['keys'] ?? null;
            if (!in_array($name, ['objects', 'scenes', 'variables', 'messages', 'functions', 'tables'], true)
                || !is_array($keys) || !vanta_array_is_list($keys) || count($keys) > VANTA_SYNC_MAX_CHUNKS) {
                throw new InvalidArgumentException('Invalid VANTA project manifest field.');
            }
        } else {
            throw new InvalidArgumentException('Invalid VANTA project manifest field.');
        }
        foreach ($keys as $chunkKey) {
            if (!is_string($chunkKey)
                || $chunkKey === 'manifest'
                || vanta_sync_chunk_key($chunkKey) === ''
                || isset($referenced[$chunkKey])) {
                throw new InvalidArgumentException('Invalid VANTA project manifest reference.');
            }
            $referenced[$chunkKey] = true;
        }
    }
    return array_keys($referenced);
}

function vanta_validate_initialize_chunks($value): array
{
    if (!is_array($value) || count($value) < 1 || count($value) > VANTA_SYNC_MAX_CHUNKS) {
        throw new InvalidArgumentException('Invalid VANTA chunk collection.');
    }
    $chunks = [];
    $totalBytes = 0;
    $manifestReferences = [];
    foreach ($value as $key => $chunk) {
        $key = is_string($key) ? vanta_sync_chunk_key($key) : '';
        if ($key === '' || !is_string($chunk)) {
            throw new InvalidArgumentException('Invalid VANTA project chunk.');
        }
        $bytes = strlen($chunk);
        $limit = $key === 'manifest' ? VANTA_SYNC_MAX_MANIFEST_BYTES : VANTA_SYNC_MAX_CHUNK_BYTES;
        if ($bytes < 1 || $bytes > $limit) {
            throw new InvalidArgumentException('VANTA project chunk is too large.');
        }
        $totalBytes += $bytes;
        if ($totalBytes > VANTA_SYNC_MAX_TOTAL_CHUNK_BYTES) {
            throw new InvalidArgumentException('VANTA project is too large.');
        }
        $references = vanta_validate_chunk_json($key, $chunk);
        if ($key === 'manifest') {
            $manifestReferences = $references;
        }
        $chunks[$key] = $chunk;
    }
    if (!isset($chunks['manifest'])) {
        throw new InvalidArgumentException('VANTA project manifest is missing.');
    }
    if (count($manifestReferences) + 1 !== count($chunks)) {
        throw new InvalidArgumentException('VANTA project contains unreferenced chunks.');
    }
    foreach ($manifestReferences as $key) {
        if (!isset($chunks[$key])) {
            throw new InvalidArgumentException('VANTA project manifest references a missing chunk.');
        }
    }
    vanta_validate_bundle_chunk_grammar($chunks);
    return $chunks;
}

function vanta_validate_stored_chunks($value): array
{
    if (!is_array($value) || count($value) < 1 || count($value) > VANTA_SYNC_MAX_CHUNKS) {
        throw new VantaSyncConflictException('Invalid stored VANTA chunk collection.');
    }
    $chunks = [];
    $totalBytes = 0;
    $manifestReferences = null;
    foreach ($value as $key => $chunk) {
        $key = is_string($key) ? vanta_sync_chunk_key($key) : '';
        if ($key === '' || !is_string($chunk)) {
            throw new VantaSyncConflictException('Invalid stored VANTA project chunk.');
        }
        $bytes = strlen($chunk);
        $limit = $key === 'manifest' ? VANTA_SYNC_MAX_MANIFEST_BYTES : VANTA_SYNC_MAX_CHUNK_BYTES;
        if ($bytes < 1 || $bytes > $limit) {
            throw new VantaSyncConflictException('Stored VANTA project chunk is too large.');
        }
        $totalBytes += $bytes;
        if ($totalBytes > VANTA_SYNC_MAX_TOTAL_CHUNK_BYTES) {
            throw new VantaSyncConflictException('Stored VANTA project is too large.');
        }
        try {
            $references = vanta_validate_chunk_json($key, $chunk);
        } catch (InvalidArgumentException $error) {
            throw new VantaSyncConflictException('Invalid stored VANTA project JSON.');
        }
        if ($key === 'manifest') {
            $manifestReferences = $references;
        }
        $chunks[$key] = $chunk;
    }
    if (!is_array($manifestReferences)) {
        throw new VantaSyncConflictException('Stored VANTA manifest is missing.');
    }
    try {
        vanta_validate_bundle_chunk_grammar($chunks);
    } catch (InvalidArgumentException $error) {
        throw new VantaSyncConflictException('Stored VANTA chunk grammar is invalid.');
    }
    // Recovery mirrors the extension's last-writer-wins merge semantics. A stale
    // concurrent manifest may briefly reference a chunk another writer removed;
    // retain that bounded state so a later delta can repair it.
    return $chunks;
}

function vanta_validate_update_delta($value): array
{
    if (!is_array($value)) {
        throw new InvalidArgumentException('Invalid VANTA project delta.');
    }
    vanta_assert_allowed_keys($value, ['changes', 'removed'], 'delta');
    $rawChanges = $value['changes'] ?? [];
    $rawRemoved = $value['removed'] ?? [];
    if (!is_array($rawChanges) || !is_array($rawRemoved)) {
        throw new InvalidArgumentException('Invalid VANTA project delta.');
    }
    if (count($rawChanges) > VANTA_SYNC_MAX_CHANGED_CHUNKS
        || count($rawRemoved) > VANTA_SYNC_MAX_CHANGED_CHUNKS
        || count($rawChanges) + count($rawRemoved) > VANTA_SYNC_MAX_CHANGED_CHUNKS) {
        throw new InvalidArgumentException('VANTA project delta has too many chunks.');
    }
    $changes = [];
    $totalBytes = 0;
    $manifestReferences = null;
    foreach ($rawChanges as $key => $chunk) {
        $key = is_string($key) ? vanta_sync_chunk_key($key) : '';
        if ($key === '' || !is_string($chunk)) {
            throw new InvalidArgumentException('Invalid VANTA changed chunk.');
        }
        $bytes = strlen($chunk);
        $limit = $key === 'manifest' ? VANTA_SYNC_MAX_MANIFEST_BYTES : VANTA_SYNC_MAX_CHUNK_BYTES;
        if ($bytes < 1 || $bytes > $limit) {
            throw new InvalidArgumentException('VANTA changed chunk is too large.');
        }
        $totalBytes += $bytes;
        if ($totalBytes > VANTA_SYNC_MAX_UPDATE_CHUNK_BYTES) {
            throw new InvalidArgumentException('VANTA project delta is too large.');
        }
        $references = vanta_validate_chunk_json($key, $chunk);
        if ($key === 'manifest') {
            $manifestReferences = array_fill_keys($references, true);
        }
        $changes[$key] = $chunk;
    }
    $removed = [];
    foreach ($rawRemoved as $key) {
        if (!is_string($key) || vanta_sync_chunk_key($key) === '' || isset($changes[$key])) {
            throw new InvalidArgumentException('Invalid VANTA removed chunk.');
        }
        $removed[$key] = true;
    }
    if (isset($removed['manifest']) && !isset($changes['manifest'])) {
        throw new InvalidArgumentException('VANTA project manifest cannot be removed.');
    }
    if (is_array($manifestReferences)) {
        foreach ($changes as $key => $_chunk) {
            if ($key !== 'manifest' && !isset($manifestReferences[$key])) {
                throw new InvalidArgumentException('VANTA delta contains an unreferenced changed chunk.');
            }
        }
        foreach ($removed as $key => $_removed) {
            if (isset($manifestReferences[$key])) {
                throw new InvalidArgumentException('VANTA delta removes a referenced chunk.');
            }
        }
        vanta_validate_bundle_chunk_grammar($changes);
    }
    if (!$changes && !$removed) {
        throw new InvalidArgumentException('VANTA project delta is empty.');
    }
    return ['changes' => $changes, 'removed' => array_keys($removed)];
}

function vanta_calculate_next_chunk_usage(
    int $currentCount,
    int $currentBytes,
    array $existingSizes,
    array $changes,
    array $removed
): array {
    if ($currentCount < 1 || $currentBytes < 1) {
        throw new VantaSyncConflictException('VANTA chunk registry is incomplete.');
    }
    $nextCount = $currentCount;
    $nextBytes = $currentBytes;
    foreach ($changes as $key => $chunk) {
        $newBytes = strlen($chunk);
        if (array_key_exists($key, $existingSizes)) {
            $nextBytes -= (int)$existingSizes[$key];
        } else {
            $nextCount += 1;
        }
        $nextBytes += $newBytes;
    }
    foreach ($removed as $key) {
        if (!array_key_exists($key, $existingSizes)) {
            continue;
        }
        $nextCount -= 1;
        $nextBytes -= (int)$existingSizes[$key];
    }
    if ($nextCount < 1
        || $nextBytes < 1
        || $nextCount > VANTA_SYNC_MAX_CHUNKS
        || $nextBytes > VANTA_SYNC_MAX_TOTAL_CHUNK_BYTES) {
        throw new InvalidArgumentException('VANTA project exceeds the stored chunk limit.');
    }
    return ['chunk_count' => $nextCount, 'chunk_bytes' => $nextBytes];
}

function vanta_config_string(string $name): string
{
    if (!defined($name)) {
        throw new RuntimeException('VANTA 서버 설정이 완료되지 않았습니다.');
    }
    $value = trim((string)constant($name));
    if ($value === '' || strpos($value, 'CHANGE_') === 0) {
        throw new RuntimeException('VANTA 서버 설정이 완료되지 않았습니다.');
    }
    return $value;
}

function vanta_abuse_identity(string $kind, string $value): string
{
    $secret = vanta_config_string('LLNK_VANTA_IP_SECRET');
    return hash_hmac('sha256', $kind . '|' . date('Y-m-d') . '|' . $value, $secret);
}

function vanta_create_limit_specs(): array
{
    return [
        [
            'scope' => 'vanta_create_ip_burst',
            'limit' => defined('LLNK_VANTA_CREATE_IP_FIVE_MINUTE_LIMIT') ? max(1, (int)LLNK_VANTA_CREATE_IP_FIVE_MINUTE_LIMIT) : 30,
            'bucket' => (string)floor(time() / 300),
            'expires_at' => date('Y-m-d H:i:s', time() + 600),
            'retry_after' => max(1, 300 - (time() % 300)),
            'identity' => 'ip',
        ],
        [
            'scope' => 'vanta_create_install_daily',
            'limit' => defined('LLNK_VANTA_CREATE_INSTALL_DAILY_LIMIT') ? max(1, (int)LLNK_VANTA_CREATE_INSTALL_DAILY_LIMIT) : 100,
            'bucket' => date('Y-m-d'),
            'expires_at' => date('Y-m-d H:i:s', strtotime('tomorrow')),
            'retry_after' => max(1, strtotime('tomorrow') - time()),
            'identity' => 'installation',
        ],
        [
            'scope' => 'vanta_create_ip_daily',
            'limit' => defined('LLNK_VANTA_CREATE_IP_DAILY_LIMIT') ? max(1, (int)LLNK_VANTA_CREATE_IP_DAILY_LIMIT) : 500,
            'bucket' => date('Y-m-d'),
            'expires_at' => date('Y-m-d H:i:s', strtotime('tomorrow')),
            'retry_after' => max(1, strtotime('tomorrow') - time()),
            'identity' => 'ip',
        ],
    ];
}

function vanta_take_create_limits(PDO $pdo, string $ip, string $installationId): array
{
    $identities = [
        'ip' => vanta_abuse_identity('ip', $ip),
        'installation' => vanta_abuse_identity('installation', $installationId),
    ];
    foreach (vanta_create_limit_specs() as $spec) {
        if (!llnk_consume_rate(
            $pdo,
            $spec['scope'],
            $identities[$spec['identity']],
            $spec['bucket'],
            $spec['expires_at'],
            $spec['limit']
        )) {
            return ['allowed' => false, 'retry_after' => $spec['retry_after'], 'scope' => $spec['scope']];
        }
    }
    return ['allowed' => true, 'retry_after' => 0, 'scope' => ''];
}

function vanta_take_join_limits(PDO $pdo, string $ip, string $installationId): bool
{
    $bucket = date('YmdHi');
    $expiresAt = date('Y-m-d H:i:s', time() + 120);
    $ipLimit = defined('LLNK_VANTA_JOIN_IP_MINUTE_LIMIT') ? max(1, (int)LLNK_VANTA_JOIN_IP_MINUTE_LIMIT) : 30;
    $installLimit = defined('LLNK_VANTA_JOIN_INSTALL_MINUTE_LIMIT') ? max(1, (int)LLNK_VANTA_JOIN_INSTALL_MINUTE_LIMIT) : 10;
    return llnk_consume_rate(
        $pdo,
        'vanta_join_ip_minute',
        vanta_abuse_identity('ip', $ip),
        $bucket,
        $expiresAt,
        $ipLimit
    ) && llnk_consume_rate(
        $pdo,
        'vanta_join_install_minute',
        vanta_abuse_identity('installation', $installationId),
        $bucket,
        $expiresAt,
        $installLimit
    );
}

function vanta_take_close_limits(PDO $pdo, string $ip, string $installationId): bool
{
    $bucket = date('YmdHi');
    $expiresAt = date('Y-m-d H:i:s', time() + 120);
    return llnk_consume_rate(
        $pdo,
        'vanta_close_ip_minute',
        vanta_abuse_identity('ip', $ip),
        $bucket,
        $expiresAt,
        30
    ) && llnk_consume_rate(
        $pdo,
        'vanta_close_install_minute',
        vanta_abuse_identity('installation', $installationId),
        $bucket,
        $expiresAt,
        30
    );
}

function vanta_take_quota_limits(PDO $pdo, string $ip, string $installationId): bool
{
    $bucket = date('YmdHi');
    $expiresAt = date('Y-m-d H:i:s', time() + 120);
    return llnk_consume_rate(
        $pdo,
        'vanta_quota_ip_minute',
        vanta_abuse_identity('ip', $ip),
        $bucket,
        $expiresAt,
        120
    ) && llnk_consume_rate(
        $pdo,
        'vanta_quota_install_minute',
        vanta_abuse_identity('installation', $installationId),
        $bucket,
        $expiresAt,
        30
    );
}

function vanta_take_quota_reset_limits(PDO $pdo, string $ip, string $installationId): bool
{
    $bucket = date('YmdHi');
    $expiresAt = date('Y-m-d H:i:s', time() + 120);
    return llnk_consume_rate(
        $pdo,
        'vanta_quota_reset_ip_minute',
        vanta_abuse_identity('ip', $ip),
        $bucket,
        $expiresAt,
        10
    ) && llnk_consume_rate(
        $pdo,
        'vanta_quota_reset_install_minute',
        vanta_abuse_identity('installation', $installationId),
        $bucket,
        $expiresAt,
        5
    );
}

function vanta_take_sync_limits(PDO $pdo, string $ip, string $installationId): array
{
    $bucket = date('YmdHi');
    $expiresAt = date('Y-m-d H:i:s', time() + 120);
    $installationLimit = defined('LLNK_VANTA_SYNC_INSTALL_MINUTE_LIMIT')
        ? max(1, (int)LLNK_VANTA_SYNC_INSTALL_MINUTE_LIMIT)
        : 300;
    $ipLimit = defined('LLNK_VANTA_SYNC_IP_MINUTE_LIMIT')
        ? max(1, (int)LLNK_VANTA_SYNC_IP_MINUTE_LIMIT)
        : 1500;
    if (!llnk_consume_rate(
        $pdo,
        'vanta_sync_install_minute',
        vanta_abuse_identity('installation', $installationId),
        $bucket,
        $expiresAt,
        $installationLimit
    )) {
        return ['allowed' => false, 'scope' => 'vanta_sync_install_minute', 'retry_after' => 60];
    }
    if (!llnk_consume_rate(
        $pdo,
        'vanta_sync_ip_minute',
        vanta_abuse_identity('ip', $ip),
        $bucket,
        $expiresAt,
        $ipLimit
    )) {
        return ['allowed' => false, 'scope' => 'vanta_sync_ip_minute', 'retry_after' => 60];
    }
    return ['allowed' => true, 'scope' => '', 'retry_after' => 0];
}

function vanta_take_control_limits(
    PDO $pdo,
    string $scopePrefix,
    string $ip,
    string $installationId,
    string $roomId,
    string $participantId,
    int $participantLimit,
    int $ipLimit
): array {
    $bucket = date('YmdHi');
    $expiresAt = date('Y-m-d H:i:s', time() + 120);
    $participantIdentity = vanta_abuse_identity(
        'participant',
        $roomId . '|' . $participantId . '|' . $installationId
    );
    if (!llnk_consume_rate(
        $pdo,
        $scopePrefix . '_participant_minute',
        $participantIdentity,
        $bucket,
        $expiresAt,
        max(1, $participantLimit)
    )) {
        return [
            'allowed' => false,
            'scope' => $scopePrefix . '_participant_minute',
            'retry_after' => max(1, 60 - (time() % 60)),
        ];
    }
    if (!llnk_consume_rate(
        $pdo,
        $scopePrefix . '_ip_minute',
        vanta_abuse_identity('ip', $ip),
        $bucket,
        $expiresAt,
        max(1, $ipLimit)
    )) {
        return [
            'allowed' => false,
            'scope' => $scopePrefix . '_ip_minute',
            'retry_after' => max(1, 60 - (time() % 60)),
        ];
    }
    return ['allowed' => true, 'scope' => '', 'retry_after' => 0];
}

function vanta_take_gateway_limits(
    PDO $pdo,
    string $ip,
    string $installationId,
    string $roomId,
    string $participantId,
    string $action
): array {
    $limits = [
        'acquire' => [12, 120],
        'heartbeat' => [12, 120],
        'revision' => [30, 300],
        'session' => [8, 80],
        'release' => [12, 120],
    ];
    if (!isset($limits[$action])) {
        throw new InvalidArgumentException('Invalid VANTA gateway action.');
    }
    return vanta_take_control_limits(
        $pdo,
        'vanta_gateway_' . $action,
        $ip,
        $installationId,
        $roomId,
        $participantId,
        $limits[$action][0],
        $limits[$action][1]
    );
}

function vanta_take_presence_limits(
    PDO $pdo,
    string $ip,
    string $installationId,
    string $roomId,
    string $participantId,
    string $action
): array {
    if (!in_array($action, ['heartbeat', 'leave'], true)) {
        throw new InvalidArgumentException('Invalid VANTA presence action.');
    }
    return vanta_take_control_limits(
        $pdo,
        'vanta_presence_' . $action,
        $ip,
        $installationId,
        $roomId,
        $participantId,
        $action === 'heartbeat' ? 12 : 8,
        $action === 'heartbeat' ? 120 : 80
    );
}

function vanta_take_stream_limits(
    PDO $pdo,
    string $ip,
    string $installationId,
    string $roomId,
    string $participantId
): array {
    return vanta_take_control_limits(
        $pdo,
        'vanta_stream_open',
        $ip,
        $installationId,
        $roomId,
        $participantId,
        6,
        100
    );
}

function vanta_stream_lock_name(string $roomId, string $participantId): string
{
    return 'vanta_stream_' . substr(hash_hmac(
        'sha256',
        $roomId . '|' . $participantId,
        vanta_config_string('LLNK_VANTA_IP_SECRET')
    ), 0, 48);
}

function vanta_acquire_stream_lock(
    PDO $pdo,
    string $roomId,
    string $participantId,
    int $waitSeconds = 5
): string
{
    $lockName = vanta_stream_lock_name($roomId, $participantId);
    $statement = $pdo->prepare('SELECT GET_LOCK(?, ?)');
    $statement->execute([$lockName, max(0, min(10, $waitSeconds))]);
    return (int)$statement->fetchColumn() === 1 ? $lockName : '';
}

function vanta_release_stream_lock(PDO $pdo, string $lockName): void
{
    if ($lockName === '') {
        return;
    }
    try {
        $statement = $pdo->prepare('SELECT RELEASE_LOCK(?)');
        $statement->execute([$lockName]);
    } catch (Throwable $error) {
        error_log('[LLNKKR VANTA stream lock] ' . $error->getMessage());
    }
}

function vanta_take_cursor_ip_limit(PDO $pdo, string $ip): bool
{
    $bucket = date('YmdHi');
    $expiresAt = date('Y-m-d H:i:s', time() + 120);
    return llnk_consume_rate(
        $pdo,
        'vanta_cursor_ip_minute',
        vanta_abuse_identity('ip', $ip),
        $bucket,
        $expiresAt,
        18000
    );
}

function vanta_take_cursor_install_limit(PDO $pdo, string $installationId): bool
{
    return llnk_consume_rate(
        $pdo,
        'vanta_cursor_install_minute',
        vanta_abuse_identity('installation', $installationId),
        date('YmdHi'),
        date('Y-m-d H:i:s', time() + 120),
        3600
    );
}

function vanta_take_cursor_live_access_limits(PDO $pdo, string $ip, string $installationId): bool
{
    $bucket = date('YmdHi');
    $expiresAt = date('Y-m-d H:i:s', time() + 120);
    if (!llnk_consume_rate(
        $pdo,
        'vanta_cursor_live_access_install_minute',
        vanta_abuse_identity('installation', $installationId),
        $bucket,
        $expiresAt,
        75
    )) {
        return false;
    }
    return llnk_consume_rate(
        $pdo,
        'vanta_cursor_live_access_ip_minute',
        vanta_abuse_identity('ip', $ip),
        $bucket,
        $expiresAt,
        375
    );
}

function vanta_take_chat_limits(PDO $pdo, string $roomId, string $participantId): array
{
    $identity = vanta_abuse_identity('chat', $roomId . '|' . $participantId);
    $now = time();
    $specs = [
        ['scope' => 'vanta_chat_second', 'bucket' => date('YmdHis', $now), 'limit' => 1, 'ttl' => 3, 'retry' => 1],
        ['scope' => 'vanta_chat_minute', 'bucket' => date('YmdHi', $now), 'limit' => 20, 'ttl' => 120, 'retry' => max(1, 60 - ($now % 60))],
        ['scope' => 'vanta_chat_ten_minute', 'bucket' => date('YmdH') . ':' . (string)floor((int)date('i', $now) / 10), 'limit' => 100, 'ttl' => 1200, 'retry' => max(1, 600 - ($now % 600))],
    ];
    foreach ($specs as $spec) {
        if (!llnk_consume_rate(
            $pdo,
            $spec['scope'],
            $identity,
            $spec['bucket'],
            date('Y-m-d H:i:s', $now + $spec['ttl']),
            $spec['limit']
        )) {
            return ['allowed' => false, 'scope' => $spec['scope'], 'retry_after' => $spec['retry']];
        }
    }
    return ['allowed' => true, 'scope' => '', 'retry_after' => 0];
}

function vanta_chat_text($value): string
{
    if (!is_string($value)) {
        return '';
    }
    $value = str_replace(["\r\n", "\r"], "\n", trim($value));
    if ($value === '' || substr_count($value, "\n") > 2
        || preg_match('/[\x00-\x09\x0B-\x1F\x7F]/u', $value) === 1) {
        return '';
    }
    $characters = preg_match_all('/./us', $value, $matches);
    if (!is_int($characters) || $characters < 1 || $characters > VANTA_CHAT_MAX_CHARACTERS) {
        return '';
    }
    return $value;
}

function vanta_chat_display_name($value): string
{
    if (!is_string($value)) {
        return '참여자';
    }
    $value = preg_replace('/[\x00-\x1F\x7F]+/u', '', $value);
    $value = preg_replace('/\s+/u', ' ', is_string($value) ? $value : '');
    $value = trim(is_string($value) ? $value : '');
    if ($value === '') {
        return '참여자';
    }
    preg_match_all('/./us', $value, $characters);
    return implode('', array_slice($characters[0] ?? [], 0, 20)) ?: '참여자';
}

function vanta_create_chat_archive_schema(PDO $pdo): void
{
    static $created = false;
    if ($created) {
        return;
    }
    try {
        $pdo->query(
            'SELECT message_id, room_id, participant_id, display_name, message_text,
                    sent_at_ms, sequence_number, cursor_shard, created_at
             FROM llnk_vanta_chat_archive LIMIT 0'
        );
        $created = true;
        return;
    } catch (PDOException $error) {
        // First deployment (or a restored database) falls through to idempotent DDL.
    }
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_vanta_chat_archive (
          archive_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          message_id CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          room_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          participant_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          display_name VARCHAR(80) NOT NULL DEFAULT '참여자',
          message_text VARCHAR(400) NOT NULL,
          sent_at_ms BIGINT UNSIGNED NOT NULL,
          sequence_number BIGINT UNSIGNED NOT NULL,
          cursor_shard VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'cursor_a',
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          PRIMARY KEY (archive_id),
          UNIQUE KEY uq_llnk_vanta_chat_message (message_id),
          KEY idx_llnk_vanta_chat_sent (sent_at_ms, archive_id),
          KEY idx_llnk_vanta_chat_room (room_id, sequence_number),
          KEY idx_llnk_vanta_chat_name (display_name, sent_at_ms)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $created = true;
}

function vanta_archive_chat_message(PDO $pdo, string $roomId, array $message): void
{
    $roomId = vanta_room_id($roomId);
    $messageId = is_string($message['id'] ?? null) ? strtolower(trim($message['id'])) : '';
    $participantId = is_string($message['participantId'] ?? null)
        ? vanta_participant_id($message['participantId'])
        : '';
    $displayName = vanta_chat_display_name($message['name'] ?? '참여자');
    $text = vanta_chat_text($message['text'] ?? null);
    $sentAtMs = is_int($message['at'] ?? null) ? $message['at'] : 0;
    $sequence = is_int($message['sequence'] ?? null) ? $message['sequence'] : 0;
    if ($roomId === '' || preg_match('/^[a-f0-9]{24}$/', $messageId) !== 1
        || $participantId === '' || $text === '' || $sentAtMs < 1 || $sequence < 1) {
        throw new InvalidArgumentException('Invalid VANTA chat archive message.');
    }
    vanta_create_chat_archive_schema($pdo);
    $statement = $pdo->prepare(
        'INSERT IGNORE INTO llnk_vanta_chat_archive
         (message_id, room_id, participant_id, display_name, message_text,
          sent_at_ms, sequence_number, cursor_shard)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    $statement->execute([
        $messageId,
        $roomId,
        $participantId,
        $displayName,
        $text,
        $sentAtMs,
        $sequence,
        vanta_request_shard('cursor'),
    ]);
}

function vanta_estimated_download_bytes(int $payloadBytes, int $recipients = 1, int $fixedBytes = 16384): int
{
    $payloadBytes = max(0, $payloadBytes);
    $recipients = max(1, min(5, $recipients));
    $fixedBytes = max(0, $fixedBytes);
    // Firebase REST/SSE wraps stored JSON strings once more and the quota also
    // includes protocol and TLS overhead. A 1.5 multiplier is deliberately
    // conservative without pretending to be Firebase's exact billable counter.
    return max(1, (int)ceil(($payloadBytes * $recipients * 1.5) + $fixedBytes));
}

function vanta_create_usage_schema(PDO $pdo): void
{
    static $created = false;
    if ($created) {
        return;
    }
    try {
        $pdo->query(
            'SELECT settings.setting_key, limits.ip_address, limits.reset_credits,
                    limits.reset_used_count, limits.reset_used_bytes, limits.lifetime_used_bytes,
                    daily.ip_address, daily.cursor_count,
                    daily.create_bytes, daily.join_bytes, daily.sync_bytes,
                    daily.chat_bytes, daily.heartbeat_bytes, daily.cursor_bytes,
                    presence.room_id, leases.room_id,
                    cursors.room_id, cursors.color, names.ip_address
             FROM llnk_vanta_settings AS settings
             LEFT JOIN llnk_vanta_ip_limits AS limits ON 1 = 0
             LEFT JOIN llnk_vanta_ip_usage_daily AS daily ON 1 = 0
             LEFT JOIN llnk_vanta_presence AS presence ON 1 = 0
             LEFT JOIN llnk_vanta_cursor_leases AS leases ON 1 = 0
             LEFT JOIN llnk_vanta_cursors AS cursors ON 1 = 0
             LEFT JOIN llnk_vanta_ip_names AS names ON 1 = 0
             LIMIT 0'
        );
        $created = true;
        return;
    } catch (PDOException $error) {
        // A new or restored installation falls through to idempotent DDL.
    }
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_vanta_settings (
          setting_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          setting_value VARCHAR(255) NOT NULL,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (setting_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_vanta_ip_limits (
          ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          daily_token_limit INT UNSIGNED NULL,
          reset_credits INT UNSIGNED NOT NULL DEFAULT 0,
          reset_used_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
          reset_used_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
          lifetime_used_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
          paused TINYINT(1) NOT NULL DEFAULT 0,
          note VARCHAR(255) NOT NULL DEFAULT '',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (ip_address),
          KEY idx_llnk_vanta_ip_limits_paused (paused, updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_vanta_ip_usage_daily (
          usage_date DATE NOT NULL,
          ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          used_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
          request_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
          bonus_tokens INT NOT NULL DEFAULT 0,
          create_count INT UNSIGNED NOT NULL DEFAULT 0,
          join_count INT UNSIGNED NOT NULL DEFAULT 0,
          sync_count INT UNSIGNED NOT NULL DEFAULT 0,
          chat_count INT UNSIGNED NOT NULL DEFAULT 0,
          heartbeat_count INT UNSIGNED NOT NULL DEFAULT 0,
          cursor_count INT UNSIGNED NOT NULL DEFAULT 0,
          create_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
          join_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
          sync_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
          chat_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
          heartbeat_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
          cursor_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
          denied_count INT UNSIGNED NOT NULL DEFAULT 0,
          last_event_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
          last_room_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
          first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (usage_date, ip_address),
          KEY idx_llnk_vanta_usage_date_bytes (usage_date, used_bytes),
          KEY idx_llnk_vanta_usage_last_seen (last_seen_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_vanta_presence (
          room_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          participant_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          installation_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          display_name VARCHAR(80) NOT NULL DEFAULT '참여자',
          country_code CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
          joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          accounted_at DATETIME NULL,
          expires_at DATETIME NOT NULL,
          PRIMARY KEY (room_id, participant_id),
          KEY idx_llnk_vanta_presence_ip (ip_address, last_seen_at),
          KEY idx_llnk_vanta_presence_expires (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_vanta_cursor_leases (
          room_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          participant_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          installation_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          accounted_until DATETIME(3) NOT NULL,
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          PRIMARY KEY (room_id, participant_id),
          KEY idx_llnk_vanta_cursor_leases_expiry (accounted_until),
          KEY idx_llnk_vanta_cursor_leases_ip (ip_address, updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_vanta_cursors (
          room_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          participant_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          display_name VARCHAR(80) NOT NULL DEFAULT '참여자',
          color CHAR(7) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '#7351FF',
          area VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'viewport',
          x_ratio DECIMAL(8,7) UNSIGNED NOT NULL DEFAULT 0,
          y_ratio DECIMAL(8,7) UNSIGNED NOT NULL DEFAULT 0,
          visible TINYINT(1) NOT NULL DEFAULT 0,
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          PRIMARY KEY (room_id, participant_id),
          KEY idx_llnk_vanta_cursors_updated (updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_vanta_ip_names (
          ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          display_name VARCHAR(80) COLLATE utf8mb4_bin NOT NULL,
          first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          use_count BIGINT UNSIGNED NOT NULL DEFAULT 1,
          PRIMARY KEY (ip_address, display_name),
          KEY idx_llnk_vanta_ip_names_recent (last_seen_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $areaColumn = $pdo->query(
        "SELECT CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llnk_vanta_cursors'
           AND COLUMN_NAME = 'area' LIMIT 1"
    )->fetchColumn();
    if ((int)$areaColumn < 40) {
        $pdo->exec(
            "ALTER TABLE llnk_vanta_cursors
             MODIFY area VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin
             NOT NULL DEFAULT 'viewport'"
        );
    }
    $colorColumn = $pdo->query(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llnk_vanta_cursors'
           AND COLUMN_NAME = 'color'"
    )->fetchColumn();
    if ((int)$colorColumn === 0) {
        $pdo->exec(
            "ALTER TABLE llnk_vanta_cursors
             ADD color CHAR(7) CHARACTER SET ascii COLLATE ascii_bin
             NOT NULL DEFAULT '#7351FF' AFTER display_name"
        );
    }
    $cursorCountColumn = $pdo->query(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llnk_vanta_ip_usage_daily'
           AND COLUMN_NAME = 'cursor_count'"
    )->fetchColumn();
    if ((int)$cursorCountColumn === 0) {
        $pdo->exec(
            'ALTER TABLE llnk_vanta_ip_usage_daily
             ADD cursor_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER heartbeat_count'
        );
    }
    $usageByteColumns = [
        'create_bytes', 'join_bytes', 'sync_bytes', 'chat_bytes',
        'heartbeat_bytes', 'cursor_bytes',
    ];
    $usageByteRows = $pdo->query(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llnk_vanta_ip_usage_daily'
           AND COLUMN_NAME IN ('create_bytes', 'join_bytes', 'sync_bytes',
                               'chat_bytes', 'heartbeat_bytes', 'cursor_bytes')"
    )->fetchAll(PDO::FETCH_COLUMN);
    $existingUsageByteColumns = array_fill_keys(array_map('strval', $usageByteRows ?: []), true);
    foreach ($usageByteColumns as $usageByteColumn) {
        if (!isset($existingUsageByteColumns[$usageByteColumn])) {
            $pdo->exec(
                'ALTER TABLE llnk_vanta_ip_usage_daily ADD ' . $usageByteColumn
                . ' BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER cursor_count'
            );
        }
    }
    $resetCreditsColumn = $pdo->query(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llnk_vanta_ip_limits'
           AND COLUMN_NAME = 'reset_credits'"
    )->fetchColumn();
    if ((int)$resetCreditsColumn === 0) {
        $pdo->exec(
            'ALTER TABLE llnk_vanta_ip_limits
             ADD reset_credits INT UNSIGNED NOT NULL DEFAULT 0 AFTER daily_token_limit'
        );
    }
    $resetUsedCountColumn = $pdo->query(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llnk_vanta_ip_limits'
           AND COLUMN_NAME = 'reset_used_count'"
    )->fetchColumn();
    if ((int)$resetUsedCountColumn === 0) {
        $pdo->exec(
            'ALTER TABLE llnk_vanta_ip_limits
             ADD reset_used_count BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER reset_credits'
        );
    }
    $resetUsedBytesColumn = $pdo->query(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llnk_vanta_ip_limits'
           AND COLUMN_NAME = 'reset_used_bytes'"
    )->fetchColumn();
    if ((int)$resetUsedBytesColumn === 0) {
        $pdo->exec(
            'ALTER TABLE llnk_vanta_ip_limits
             ADD reset_used_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER reset_used_count'
        );
    }
    $lifetimeUsedBytesColumn = $pdo->query(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llnk_vanta_ip_limits'
           AND COLUMN_NAME = 'lifetime_used_bytes'"
    )->fetchColumn();
    if ((int)$lifetimeUsedBytesColumn === 0) {
        $pdo->exec(
            'ALTER TABLE llnk_vanta_ip_limits
             ADD lifetime_used_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER reset_used_bytes'
        );
        $pdo->exec(
            'INSERT INTO llnk_vanta_ip_limits (ip_address, lifetime_used_bytes)
             SELECT daily.ip_address, COALESCE(SUM(daily.used_bytes), 0)
             FROM llnk_vanta_ip_usage_daily AS daily GROUP BY daily.ip_address
             ON DUPLICATE KEY UPDATE lifetime_used_bytes = GREATEST(
                 lifetime_used_bytes,
                 VALUES(lifetime_used_bytes) + reset_used_bytes
             )'
        );
    }
    $created = true;
}

function vanta_partner_code($value): string
{
    if (!is_string($value)) {
        return '';
    }
    $value = strtolower(trim($value));
    return preg_match('/^[a-z0-9][a-z0-9_-]{2,63}$/', $value) === 1 ? $value : '';
}

function vanta_create_partner_code_schema(PDO $pdo): void
{
    static $created = false;
    if ($created) {
        return;
    }
    try {
        $pdo->query(
            'SELECT codes.code, codes.grant_resets, codes.granted_resets,
                    redemptions.code, redemptions.granted_resets
             FROM llnk_vanta_partner_codes AS codes
             LEFT JOIN llnk_vanta_partner_redemptions AS redemptions ON 1 = 0
             LIMIT 0'
        );
        $created = true;
        return;
    } catch (PDOException $error) {
        // A new installation falls through to idempotent DDL.
    }
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_vanta_partner_codes (
          code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          label VARCHAR(80) NOT NULL DEFAULT '',
          grant_tokens INT UNSIGNED NOT NULL,
          grant_resets INT UNSIGNED NOT NULL DEFAULT 0,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          redemption_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
          granted_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
          granted_resets BIGINT UNSIGNED NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (code),
          KEY idx_llnk_vanta_partner_active (is_active, updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_vanta_partner_redemptions (
          code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          granted_tokens INT UNSIGNED NOT NULL,
          granted_resets INT UNSIGNED NOT NULL DEFAULT 0,
          redeemed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (code, ip_address),
          KEY idx_llnk_vanta_partner_redemption_ip (ip_address, redeemed_at),
          KEY idx_llnk_vanta_partner_redemption_recent (redeemed_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    foreach ([
        ['llnk_vanta_partner_codes', 'grant_resets',
            'ALTER TABLE llnk_vanta_partner_codes ADD grant_resets INT UNSIGNED NOT NULL DEFAULT 0 AFTER grant_tokens'],
        ['llnk_vanta_partner_codes', 'granted_resets',
            'ALTER TABLE llnk_vanta_partner_codes ADD granted_resets BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER granted_tokens'],
        ['llnk_vanta_partner_redemptions', 'granted_resets',
            'ALTER TABLE llnk_vanta_partner_redemptions ADD granted_resets INT UNSIGNED NOT NULL DEFAULT 0 AFTER granted_tokens'],
    ] as $migration) {
        $columnExists = $pdo->prepare(
            'SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?'
        );
        $columnExists->execute([$migration[0], $migration[1]]);
        if ((int)$columnExists->fetchColumn() === 0) {
            $pdo->exec($migration[2]);
        }
    }
    $created = true;
}

function vanta_partner_code_offer(PDO $pdo, string $code, string $ip): array
{
    $code = vanta_partner_code($code);
    if ($code === '' || filter_var($ip, FILTER_VALIDATE_IP) === false) {
        throw new InvalidArgumentException('Invalid VANTA collaboration code preview.');
    }
    vanta_create_partner_code_schema($pdo);
    $statement = $pdo->prepare(
        'SELECT label, grant_tokens, grant_resets, is_active
         FROM llnk_vanta_partner_codes WHERE code = ? LIMIT 1'
    );
    $statement->execute([$code]);
    $offer = $statement->fetch(PDO::FETCH_ASSOC);
    if (!is_array($offer) || (int)($offer['is_active'] ?? 0) !== 1) {
        return [
            'available' => false,
            'code' => $code,
            'label' => '',
            'tokens' => 0,
            'resets' => 0,
            'already_redeemed' => false,
        ];
    }
    $redeemed = $pdo->prepare(
        'SELECT 1 FROM llnk_vanta_partner_redemptions
         WHERE code = ? AND ip_address = ? LIMIT 1'
    );
    $redeemed->execute([$code, $ip]);
    $label = trim((string)($offer['label'] ?? ''));
    return [
        'available' => true,
        'code' => $code,
        'label' => $label !== '' ? mb_substr($label, 0, 80, 'UTF-8') : $code,
        'tokens' => max(0, min(10000, (int)($offer['grant_tokens'] ?? 0))),
        'resets' => max(0, min(100, (int)($offer['grant_resets'] ?? 0))),
        'already_redeemed' => $redeemed->fetchColumn() !== false,
    ];
}

function vanta_redeem_partner_code(PDO $pdo, string $code, string $ip): array
{
    $code = vanta_partner_code($code);
    if ($code === '' || filter_var($ip, FILTER_VALIDATE_IP) === false) {
        throw new InvalidArgumentException('Invalid VANTA collaboration code redemption.');
    }
    vanta_create_usage_schema($pdo);
    vanta_create_partner_code_schema($pdo);
    $pdo->beginTransaction();
    try {
        $codeStatement = $pdo->prepare(
            'SELECT grant_tokens, grant_resets, is_active
             FROM llnk_vanta_partner_codes WHERE code = ? LIMIT 1 FOR UPDATE'
        );
        $codeStatement->execute([$code]);
        $partnerCode = $codeStatement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($partnerCode) || (int)($partnerCode['is_active'] ?? 0) !== 1) {
            $pdo->rollBack();
            return ['granted' => false, 'tokens' => 0, 'resets' => 0, 'reason' => 'unavailable'];
        }

        $alreadyUsed = $pdo->prepare(
            'SELECT granted_tokens, granted_resets FROM llnk_vanta_partner_redemptions
             WHERE code = ? AND ip_address = ? LIMIT 1'
        );
        $alreadyUsed->execute([$code, $ip]);
        $previousGrant = $alreadyUsed->fetch(PDO::FETCH_ASSOC);
        if (is_array($previousGrant)) {
            $pdo->commit();
            return ['granted' => false, 'tokens' => 0, 'resets' => 0, 'reason' => 'already_redeemed'];
        }

        $pdo->prepare(
            'INSERT IGNORE INTO llnk_vanta_ip_usage_daily (usage_date, ip_address)
             VALUES (CURRENT_DATE, ?)'
        )->execute([$ip]);
        $window = vanta_usage_period_window($pdo);
        $bonusStatement = $pdo->prepare(
            'SELECT COALESCE(SUM(bonus_tokens), 0)
             FROM llnk_vanta_ip_usage_daily
             WHERE usage_date BETWEEN ? AND ? AND ip_address = ? FOR UPDATE'
        );
        $bonusStatement->execute([$window['start_date'], $window['end_date'], $ip]);
        $currentBonus = max(0, (int)$bonusStatement->fetchColumn());
        $configuredTokens = max(0, min(10000, (int)$partnerCode['grant_tokens']));
        $grantedTokens = min($configuredTokens, max(0, 100000 - $currentBonus));
        $pdo->prepare(
            'INSERT IGNORE INTO llnk_vanta_ip_limits (ip_address) VALUES (?)'
        )->execute([$ip]);
        $resetStatement = $pdo->prepare(
            'SELECT reset_credits FROM llnk_vanta_ip_limits
             WHERE ip_address = ? LIMIT 1 FOR UPDATE'
        );
        $resetStatement->execute([$ip]);
        $currentResets = max(0, (int)$resetStatement->fetchColumn());
        $configuredResets = max(0, min(100, (int)($partnerCode['grant_resets'] ?? 0)));
        $grantedResets = min($configuredResets, max(0, 1000 - $currentResets));
        if ($grantedTokens < 1 && $grantedResets < 1) {
            $pdo->rollBack();
            return ['granted' => false, 'tokens' => 0, 'resets' => 0, 'reason' => 'bonus_limit'];
        }

        if ($grantedTokens > 0) {
            $pdo->prepare(
                'UPDATE llnk_vanta_ip_usage_daily
                 SET bonus_tokens = bonus_tokens + ?, last_event_kind = ?,
                     last_seen_at = CURRENT_TIMESTAMP
                 WHERE usage_date = CURRENT_DATE AND ip_address = ?'
            )->execute([$grantedTokens, 'partner_grant', $ip]);
        }
        if ($grantedResets > 0) {
            $pdo->prepare(
                'UPDATE llnk_vanta_ip_limits
                 SET reset_credits = reset_credits + ? WHERE ip_address = ?'
            )->execute([$grantedResets, $ip]);
        }
        $pdo->prepare(
            'INSERT INTO llnk_vanta_partner_redemptions
             (code, ip_address, granted_tokens, granted_resets) VALUES (?, ?, ?, ?)'
        )->execute([$code, $ip, $grantedTokens, $grantedResets]);
        $pdo->prepare(
            'UPDATE llnk_vanta_partner_codes
             SET redemption_count = redemption_count + 1,
                 granted_tokens = granted_tokens + ?,
                 granted_resets = granted_resets + ?
             WHERE code = ?'
        )->execute([$grantedTokens, $grantedResets, $code]);
        $pdo->commit();
        return ['granted' => true, 'tokens' => $grantedTokens, 'resets' => $grantedResets, 'reason' => 'granted'];
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        // A simultaneous duplicate request is expected to lose the unique-key race.
        if ($error instanceof PDOException && (int)($error->errorInfo[1] ?? 0) === 1062) {
            return ['granted' => false, 'tokens' => 0, 'resets' => 0, 'reason' => 'already_redeemed'];
        }
        throw $error;
    }
}

function vanta_usage_period(PDO $pdo): string
{
    if (!$pdo->inTransaction()) vanta_create_usage_schema($pdo);
    $statement = $pdo->prepare(
        'SELECT setting_value FROM llnk_vanta_settings WHERE setting_key = ? LIMIT 1'
    );
    $statement->execute(['quota_period']);
    $stored = strtolower(trim((string)$statement->fetchColumn()));
    return in_array($stored, ['day', 'week', 'month'], true) ? $stored : 'week';
}

function vanta_usage_period_window(PDO $pdo): array
{
    $period = vanta_usage_period($pdo);
    $today = new DateTimeImmutable('today');
    if ($period === 'day') {
        $start = $today;
        $end = $today;
        $reset = $today->modify('+1 day');
        $label = '오늘';
        $unit = '일';
    } elseif ($period === 'month') {
        $start = $today->modify('first day of this month');
        $end = $today->modify('last day of this month');
        $reset = $start->modify('+1 month');
        $label = '이번 달';
        $unit = '월';
    } else {
        $start = $today->modify('monday this week');
        $end = $start->modify('+6 days');
        $reset = $start->modify('+1 week');
        $label = '이번 주';
        $unit = '주';
    }
    return [
        'period' => $period,
        'label' => $label,
        'unit' => $unit,
        'start_date' => $start->format('Y-m-d'),
        'end_date' => $end->format('Y-m-d'),
        'reset_at' => $reset->format(DateTimeInterface::ATOM),
    ];
}

function vanta_usage_default_tokens(PDO $pdo): int
{
    if (!$pdo->inTransaction()) vanta_create_usage_schema($pdo);
    $configured = defined('LLNK_VANTA_QUOTA_TOKENS')
        ? (int)LLNK_VANTA_QUOTA_TOKENS
        : (defined('LLNK_VANTA_DAILY_TOKENS')
        ? (int)LLNK_VANTA_DAILY_TOKENS
        : VANTA_DEFAULT_QUOTA_TOKENS);
    $statement = $pdo->prepare(
        'SELECT setting_key, setting_value FROM llnk_vanta_settings
         WHERE setting_key IN (?, ?)'
    );
    $statement->execute(['quota_tokens', 'daily_tokens']);
    $settings = [];
    foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $settings[(string)$row['setting_key']] = (string)$row['setting_value'];
    }
    $stored = $settings['quota_tokens'] ?? $settings['daily_tokens'] ?? '';
    if (preg_match('/^[0-9]{1,6}$/', $stored) === 1) {
        $configured = (int)$stored;
    }
    return max(1, min(100000, $configured));
}

function vanta_usage_limit(PDO $pdo, string $ip): array
{
    if (!$pdo->inTransaction()) vanta_create_usage_schema($pdo);
    $statement = $pdo->prepare(
        'SELECT daily_token_limit, reset_credits, paused, note
         FROM llnk_vanta_ip_limits WHERE ip_address = ? LIMIT 1'
    );
    $statement->execute([$ip]);
    $row = $statement->fetch(PDO::FETCH_ASSOC);
    $defaultTokens = vanta_usage_default_tokens($pdo);
    $override = is_array($row) && $row['daily_token_limit'] !== null
        ? max(1, min(100000, (int)$row['daily_token_limit']))
        : null;
    return [
        'default_tokens' => $defaultTokens,
        'period_tokens' => $override ?? $defaultTokens,
        'daily_tokens' => $override ?? $defaultTokens,
        'override_tokens' => $override,
        'reset_credits' => is_array($row) ? max(0, (int)($row['reset_credits'] ?? 0)) : 0,
        'paused' => is_array($row) && (int)($row['paused'] ?? 0) === 1,
        'note' => is_array($row) ? (string)($row['note'] ?? '') : '',
    ];
}

function vanta_usage_quota_result(
    array $limit,
    array $window,
    int $usedBytes,
    int $bonusTokens,
    bool $allowed
): array {
    $baseTokens = (int)$limit['period_tokens'];
    $effectiveTokens = max(0, $baseTokens + $bonusTokens);
    $limitBytes = $effectiveTokens * VANTA_TOKEN_BYTES;
    $usedBytes = max(0, $usedBytes);
    $usedPercent = $limitBytes > 0 ? min(100, round(($usedBytes / $limitBytes) * 100, 1)) : 100;
    return [
        'allowed' => $allowed,
        'paused' => (bool)$limit['paused'],
        'period' => (string)$window['period'],
        'period_label' => (string)$window['label'],
        'period_unit' => (string)$window['unit'],
        'period_start' => (string)$window['start_date'],
        'period_end' => (string)$window['end_date'],
        'reset_at' => (string)$window['reset_at'],
        'used_bytes' => $usedBytes,
        'limit_bytes' => $limitBytes,
        'used_tokens' => round($usedBytes / VANTA_TOKEN_BYTES, 2),
        'limit_tokens' => $effectiveTokens,
        'remaining_tokens' => round(max(0, $limitBytes - $usedBytes) / VANTA_TOKEN_BYTES, 2),
        'percent' => $usedPercent,
        'remaining_percent' => max(0, round(100 - $usedPercent, 1)),
        'reset_credits' => max(0, (int)($limit['reset_credits'] ?? 0)),
    ];
}

function vanta_usage_status(PDO $pdo, string $ip): array
{
    if (filter_var($ip, FILTER_VALIDATE_IP) === false) {
        throw new InvalidArgumentException('Invalid VANTA usage IP.');
    }
    if (!$pdo->inTransaction()) vanta_create_usage_schema($pdo);
    $limit = vanta_usage_limit($pdo, $ip);
    $window = vanta_usage_period_window($pdo);
    $statement = $pdo->prepare(
        'SELECT COALESCE(SUM(used_bytes), 0) AS used_bytes,
                COALESCE(SUM(bonus_tokens), 0) AS bonus_tokens
         FROM llnk_vanta_ip_usage_daily
         WHERE usage_date BETWEEN ? AND ? AND ip_address = ?'
    );
    $statement->execute([$window['start_date'], $window['end_date'], $ip]);
    $usage = $statement->fetch(PDO::FETCH_ASSOC) ?: [];
    $usedBytes = max(0, (int)($usage['used_bytes'] ?? 0));
    $bonusTokens = (int)($usage['bonus_tokens'] ?? 0);
    $effectiveTokens = max(0, (int)$limit['period_tokens'] + $bonusTokens);
    $allowed = !$limit['paused'] && $usedBytes < ($effectiveTokens * VANTA_TOKEN_BYTES);
    return vanta_usage_quota_result($limit, $window, $usedBytes, $bonusTokens, $allowed);
}

function vanta_usage_reset_with_credit(PDO $pdo, string $ip): array
{
    if (filter_var($ip, FILTER_VALIDATE_IP) === false) {
        throw new InvalidArgumentException('Invalid VANTA usage IP.');
    }
    vanta_create_usage_schema($pdo);
    $window = vanta_usage_period_window($pdo);
    $pdo->beginTransaction();
    try {
        $pdo->prepare(
            'INSERT IGNORE INTO llnk_vanta_ip_usage_daily (usage_date, ip_address)
             VALUES (CURRENT_DATE, ?)'
        )->execute([$ip]);
        $usageRows = $pdo->prepare(
            'SELECT usage_date, used_bytes FROM llnk_vanta_ip_usage_daily
             WHERE usage_date BETWEEN ? AND ? AND ip_address = ? FOR UPDATE'
        );
        $usageRows->execute([$window['start_date'], $window['end_date'], $ip]);
        $usedBeforeResetBytes = 0;
        foreach ($usageRows->fetchAll(PDO::FETCH_ASSOC) as $usageRow) {
            $usedBeforeResetBytes += max(0, (int)($usageRow['used_bytes'] ?? 0));
        }
        $pdo->prepare(
            'INSERT IGNORE INTO llnk_vanta_ip_limits (ip_address) VALUES (?)'
        )->execute([$ip]);
        $consume = $pdo->prepare(
            'UPDATE llnk_vanta_ip_limits
             SET reset_credits = reset_credits - 1,
                 reset_used_count = reset_used_count + 1,
                 reset_used_bytes = reset_used_bytes + ?
             WHERE ip_address = ? AND reset_credits > 0'
        );
        $consume->execute([$usedBeforeResetBytes, $ip]);
        if ($consume->rowCount() !== 1) {
            $pdo->rollBack();
            return ['used' => false, 'quota' => vanta_usage_status($pdo, $ip)];
        }
        $pdo->prepare(
            'UPDATE llnk_vanta_ip_usage_daily
             SET used_bytes = 0, last_event_kind = ?, last_seen_at = CURRENT_TIMESTAMP
             WHERE usage_date BETWEEN ? AND ? AND ip_address = ?'
        )->execute(['quota_reset', $window['start_date'], $window['end_date'], $ip]);
        $pdo->commit();
        return ['used' => true, 'quota' => vanta_usage_status($pdo, $ip)];
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $error;
    }
}

function vanta_usage_admin_reset_period(
    PDO $pdo,
    ?string $ip = null,
    bool $clearResetCredits = false
): array {
    if ($ip !== null && filter_var($ip, FILTER_VALIDATE_IP) === false) {
        throw new InvalidArgumentException('Invalid VANTA usage IP.');
    }
    vanta_create_usage_schema($pdo);
    $window = vanta_usage_period_window($pdo);
    $pdo->beginTransaction();
    try {
        $usageSql = 'SELECT usage_date, ip_address FROM llnk_vanta_ip_usage_daily
                     WHERE usage_date BETWEEN ? AND ?';
        $usageParameters = [$window['start_date'], $window['end_date']];
        if ($ip !== null) {
            $usageSql .= ' AND ip_address = ?';
            $usageParameters[] = $ip;
        }
        $usageLock = $pdo->prepare($usageSql . ' FOR UPDATE');
        $usageLock->execute($usageParameters);
        $usageRows = $usageLock->rowCount();

        $resetSql = 'UPDATE llnk_vanta_ip_usage_daily SET used_bytes = 0
                     WHERE usage_date BETWEEN ? AND ?';
        if ($ip !== null) {
            $resetSql .= ' AND ip_address = ?';
        }
        $pdo->prepare($resetSql)->execute($usageParameters);

        $creditRows = 0;
        if ($clearResetCredits) {
            $creditSql = 'SELECT ip_address FROM llnk_vanta_ip_limits';
            $creditParameters = [];
            if ($ip !== null) {
                $creditSql .= ' WHERE ip_address = ?';
                $creditParameters[] = $ip;
            }
            $creditLock = $pdo->prepare($creditSql . ' FOR UPDATE');
            $creditLock->execute($creditParameters);
            $creditRows = $creditLock->rowCount();
            $creditUpdate = 'UPDATE llnk_vanta_ip_limits SET reset_credits = 0';
            if ($ip !== null) {
                $creditUpdate .= ' WHERE ip_address = ?';
            }
            $pdo->prepare($creditUpdate)->execute($creditParameters);
        }
        $pdo->commit();
        return [
            'usage_rows' => max(0, (int)$usageRows),
            'credit_rows' => max(0, (int)$creditRows),
            'period_label' => (string)$window['label'],
        ];
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $error;
    }
}

function vanta_quota_retry_after(array $quota): int
{
    $resetAt = strtotime((string)($quota['reset_at'] ?? ''));
    return max(1, ($resetAt !== false ? $resetAt : strtotime('tomorrow')) - time());
}

function vanta_quota_exhausted_message(array $quota): string
{
    $label = trim((string)($quota['period_label'] ?? '현재 기간'));
    return $label . ' 사용할 수 있는 VANTA 토큰을 모두 사용했습니다.';
}

function vanta_usage_reserve(
    PDO $pdo,
    string $ip,
    int $estimatedBytes,
    string $kind,
    string $roomId = '',
    string $participantId = '',
    int $requestBytes = 0
): array {
    if (filter_var($ip, FILTER_VALIDATE_IP) === false) {
        throw new InvalidArgumentException('Invalid VANTA usage IP.');
    }
    $allowedKinds = ['create', 'join', 'sync', 'chat', 'heartbeat', 'cursor'];
    if (!in_array($kind, $allowedKinds, true)) {
        throw new InvalidArgumentException('Invalid VANTA usage kind.');
    }
    $estimatedBytes = max(1, min(134217728, $estimatedBytes));
    $requestBytes = max(0, min(16777216, $requestBytes));
    $roomId = vanta_room_id($roomId) !== '' ? $roomId : '';
    $participantId = vanta_participant_id($participantId) !== '' ? $participantId : '';
    if (!$pdo->inTransaction()) vanta_create_usage_schema($pdo);
    $ownsTransaction = !$pdo->inTransaction();
    if ($ownsTransaction) {
        $pdo->beginTransaction();
    }
    try {
        $limit = vanta_usage_limit($pdo, $ip);
        $window = vanta_usage_period_window($pdo);
        $insert = $pdo->prepare(
            'INSERT IGNORE INTO llnk_vanta_ip_usage_daily
             (usage_date, ip_address) VALUES (CURRENT_DATE, ?)'
        );
        $insert->execute([$ip]);
        $select = $pdo->prepare(
            'SELECT used_bytes, bonus_tokens
             FROM llnk_vanta_ip_usage_daily
             WHERE usage_date BETWEEN ? AND ? AND ip_address = ? FOR UPDATE'
        );
        $select->execute([$window['start_date'], $window['end_date'], $ip]);
        $usedBytes = 0;
        $bonusTokens = 0;
        foreach ($select->fetchAll(PDO::FETCH_ASSOC) as $usageRow) {
            $usedBytes += max(0, (int)($usageRow['used_bytes'] ?? 0));
            $bonusTokens += (int)($usageRow['bonus_tokens'] ?? 0);
        }
        $baseTokens = (int)$limit['period_tokens'];
        $effectiveTokens = max(0, $baseTokens + $bonusTokens);
        $limitBytes = $effectiveTokens * VANTA_TOKEN_BYTES;
        $allowed = !$limit['paused'] && $usedBytes + $estimatedBytes <= $limitBytes;
        if ($allowed) {
            $counterColumn = $kind . '_count';
            $byteColumn = $kind . '_bytes';
            $update = $pdo->prepare(
                "UPDATE llnk_vanta_ip_usage_daily
                 SET used_bytes = used_bytes + ?, request_bytes = request_bytes + ?,
                     {$counterColumn} = {$counterColumn} + 1,
                     {$byteColumn} = {$byteColumn} + ?,
                     last_event_kind = ?, last_room_id = ?, last_seen_at = CURRENT_TIMESTAMP
                 WHERE usage_date = CURRENT_DATE AND ip_address = ?"
            );
            $update->execute([$estimatedBytes, $requestBytes, $estimatedBytes, $kind, $roomId, $ip]);
            $pdo->prepare(
                'INSERT INTO llnk_vanta_ip_limits (ip_address, lifetime_used_bytes)
                 VALUES (?, ?) ON DUPLICATE KEY UPDATE
                 lifetime_used_bytes = lifetime_used_bytes + VALUES(lifetime_used_bytes)'
            )->execute([$ip, $estimatedBytes]);
            $usedBytes += $estimatedBytes;
        } else {
            $denied = $pdo->prepare(
                'UPDATE llnk_vanta_ip_usage_daily
                 SET denied_count = denied_count + 1, last_event_kind = ?,
                     last_room_id = ?, last_seen_at = CURRENT_TIMESTAMP
                 WHERE usage_date = CURRENT_DATE AND ip_address = ?'
            );
            $denied->execute([$kind . '_denied', $roomId, $ip]);
        }
        if ($ownsTransaction) {
            $pdo->commit();
        }
        return vanta_usage_quota_result($limit, $window, $usedBytes, $bonusTokens, $allowed);
    } catch (Throwable $error) {
        if ($ownsTransaction && $pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $error;
    }
}

function vanta_usage_require(array $quota): void
{
    if (empty($quota['allowed'])) {
        throw new VantaQuotaException($quota);
    }
}

function vanta_usage_room_chunk_bytes(PDO $pdo, string $roomId): int
{
    vanta_create_room_registry_schema($pdo);
    $statement = $pdo->prepare(
        'SELECT chunk_bytes FROM llnk_vanta_sync_usage WHERE room_id = ? LIMIT 1'
    );
    $statement->execute([$roomId]);
    return max(0, (int)$statement->fetchColumn());
}

function vanta_presence_touch(
    PDO $pdo,
    string $ip,
    string $roomId,
    string $participantId,
    string $installationId,
    string $displayName
): array {
    vanta_create_usage_schema($pdo);
    $ownsTransaction = !$pdo->inTransaction();
    if ($ownsTransaction) {
        $pdo->beginTransaction();
    }
    try {
        $select = $pdo->prepare(
            'SELECT accounted_at FROM llnk_vanta_presence
             WHERE room_id = ? AND participant_id = ? FOR UPDATE'
        );
        $select->execute([$roomId, $participantId]);
        $accountedAt = $select->fetchColumn();
        $shouldAccount = !is_string($accountedAt)
            || strtotime($accountedAt) <= time() - VANTA_PRESENCE_ACCOUNT_SECONDS;
        $quota = vanta_usage_reserve(
            $pdo,
            $ip,
            $shouldAccount ? VANTA_PRESENCE_ACCOUNT_BYTES : 1,
            'heartbeat',
            $roomId,
            $participantId,
            0
        );
        vanta_usage_require($quota);
        $country = strtoupper(trim((string)($_SERVER['HTTP_CF_IPCOUNTRY'] ?? '')));
        if (preg_match('/^[A-Z]{2}$/', $country) !== 1) {
            $country = '';
        }
        $safeDisplayName = vanta_chat_display_name($displayName);
        $statement = $pdo->prepare(
            'INSERT INTO llnk_vanta_presence
             (room_id, participant_id, installation_hash, ip_address, display_name,
              country_code, joined_at, last_seen_at, accounted_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                     CURRENT_TIMESTAMP, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 45 SECOND))
             ON DUPLICATE KEY UPDATE
               installation_hash = VALUES(installation_hash), ip_address = VALUES(ip_address),
               display_name = VALUES(display_name), country_code = VALUES(country_code),
               last_seen_at = CURRENT_TIMESTAMP,
               accounted_at = IF(?, CURRENT_TIMESTAMP, accounted_at),
               expires_at = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 45 SECOND)'
        );
        $statement->execute([
            $roomId,
            $participantId,
            hash('sha256', $installationId),
            $ip,
            $safeDisplayName,
            $country,
            $shouldAccount ? 1 : 0,
        ]);
        $nameHistory = $pdo->prepare(
            'INSERT INTO llnk_vanta_ip_names
             (ip_address, display_name, first_seen_at, last_seen_at, use_count)
             VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)
             ON DUPLICATE KEY UPDATE last_seen_at = CURRENT_TIMESTAMP,
               use_count = use_count + 1'
        );
        $nameHistory->execute([$ip, $safeDisplayName]);
        if ($ownsTransaction) {
            $pdo->commit();
        }
        return $quota;
    } catch (Throwable $error) {
        if ($ownsTransaction && $pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $error;
    }
}

function vanta_require_active_presence(
    PDO $pdo,
    string $roomId,
    string $participantId,
    string $installationId
): array {
    vanta_create_usage_schema($pdo);
    $statement = $pdo->prepare(
        'SELECT ip_address, display_name, expires_at
         FROM llnk_vanta_presence
         WHERE room_id = ? AND participant_id = ? AND installation_hash = ?
           AND expires_at > CURRENT_TIMESTAMP
         LIMIT 1'
    );
    $statement->execute([$roomId, $participantId, hash('sha256', $installationId)]);
    $presence = $statement->fetch(PDO::FETCH_ASSOC);
    if (!is_array($presence)) {
        throw new VantaSyncAuthException('Active metered VANTA presence is required.');
    }
    return $presence;
}

function vanta_presence_leave(PDO $pdo, string $roomId, string $participantId): void
{
    vanta_create_usage_schema($pdo);
    $statement = $pdo->prepare(
        'UPDATE llnk_vanta_presence
         SET last_seen_at = CURRENT_TIMESTAMP, expires_at = CURRENT_TIMESTAMP
         WHERE room_id = ? AND participant_id = ?'
    );
    $statement->execute([$roomId, $participantId]);
}

function vanta_create_room_registry_schema(PDO $pdo): void
{
    static $created = false;
    if ($created) {
        return;
    }
    try {
        // The schema normally already exists. A zero-row probe avoids taking
        // CREATE TABLE metadata locks on every high-frequency sync request.
        $pdo->query(
            'SELECT rooms.room_id, rooms.sync_shard, rooms.cursor_shard, rooms.chat_sequence,
                    sync_usage.room_id, sync_chunks.room_id
             FROM llnk_vanta_rooms AS rooms
             LEFT JOIN llnk_vanta_sync_usage AS sync_usage ON 1 = 0
             LEFT JOIN llnk_vanta_sync_chunks AS sync_chunks ON 1 = 0
             LIMIT 0'
        );
        $created = true;
        return;
    } catch (PDOException $error) {
        // First deployment (or a restored database) falls through to idempotent DDL.
    }
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_vanta_rooms (
          room_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          sync_shard VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'sync_a',
          cursor_shard VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'cursor_a',
          chat_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          checked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (room_id),
          KEY idx_llnk_vanta_rooms_checked (checked_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $roomColumns = $pdo->query(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llnk_vanta_rooms'
           AND COLUMN_NAME IN ('sync_shard', 'cursor_shard', 'chat_sequence')"
    )->fetchAll(PDO::FETCH_COLUMN) ?: [];
    if (!in_array('sync_shard', $roomColumns, true)) {
        $pdo->exec(
            "ALTER TABLE llnk_vanta_rooms
             ADD sync_shard VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin
             NOT NULL DEFAULT 'sync_a' AFTER room_id"
        );
    }
    if (!in_array('cursor_shard', $roomColumns, true)) {
        $pdo->exec(
            "ALTER TABLE llnk_vanta_rooms
             ADD cursor_shard VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin
             NOT NULL DEFAULT 'cursor_a' AFTER sync_shard"
        );
    }
    if (!in_array('chat_sequence', $roomColumns, true)) {
        $pdo->exec(
            "ALTER TABLE llnk_vanta_rooms
             ADD chat_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER cursor_shard"
        );
    }
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_vanta_sync_usage (
          room_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          chunk_count SMALLINT UNSIGNED NOT NULL,
          chunk_bytes BIGINT UNSIGNED NOT NULL,
          revision BIGINT UNSIGNED NOT NULL,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (room_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_vanta_sync_chunks (
          room_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          chunk_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          byte_size INT UNSIGNED NOT NULL,
          PRIMARY KEY (room_id, chunk_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $created = true;
}

function vanta_register_room(
    PDO $pdo,
    string $roomId,
    string $syncShard = 'sync_a',
    string $cursorShard = 'cursor_a'
): void
{
    vanta_create_room_registry_schema($pdo);
    if (preg_match('/^[a-z][a-z0-9_]{0,31}$/', $syncShard) !== 1
        || preg_match('/^[a-z][a-z0-9_]{0,31}$/', $cursorShard) !== 1) {
        throw new InvalidArgumentException('Invalid VANTA shard id.');
    }
    $statement = $pdo->prepare(
        'INSERT INTO llnk_vanta_rooms (room_id, sync_shard, cursor_shard) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE checked_at = CURRENT_TIMESTAMP'
    );
    $statement->execute([$roomId, $syncShard, $cursorShard]);
}

function vanta_room_shards(PDO $pdo, string $roomId): array
{
    vanta_create_room_registry_schema($pdo);
    $statement = $pdo->prepare(
        'SELECT sync_shard, cursor_shard FROM llnk_vanta_rooms WHERE room_id = ? LIMIT 1'
    );
    $statement->execute([$roomId]);
    $row = $statement->fetch(PDO::FETCH_ASSOC);
    return [
        'sync' => is_array($row) && preg_match('/^[a-z][a-z0-9_]{0,31}$/', (string)($row['sync_shard'] ?? '')) === 1
            ? (string)$row['sync_shard'] : 'sync_a',
        'cursor' => is_array($row) && preg_match('/^[a-z][a-z0-9_]{0,31}$/', (string)($row['cursor_shard'] ?? '')) === 1
            ? (string)$row['cursor_shard'] : 'cursor_a',
    ];
}

function vanta_next_chat_sequence(PDO $pdo, string $roomId): int
{
    if (vanta_room_id($roomId) === '') {
        throw new InvalidArgumentException('Invalid VANTA chat room.');
    }
    vanta_create_room_registry_schema($pdo);
    $statement = $pdo->prepare(
        'UPDATE llnk_vanta_rooms
         SET chat_sequence = LAST_INSERT_ID(chat_sequence + 1),
             checked_at = CURRENT_TIMESTAMP
         WHERE room_id = ?'
    );
    $statement->execute([$roomId]);
    if ($statement->rowCount() !== 1) {
        throw new RuntimeException('VANTA room registry is missing.');
    }
    $sequence = (int)$pdo->query('SELECT LAST_INSERT_ID()')->fetchColumn();
    if ($sequence < 1) {
        throw new RuntimeException('Could not allocate a VANTA chat sequence.');
    }
    return $sequence;
}

function vanta_shard_configured(string $kind, string $shard, bool $requireApiKey = false): bool
{
    $prefix = $kind === 'cursor' ? 'cursor' : 'sync';
    $shard = vanta_shard_id($shard, $prefix);
    $bases = $kind === 'cursor'
        ? ['LLNK_VANTA_CURSOR_FIREBASE_DATABASE_URL', 'LLNK_VANTA_CURSOR_FIREBASE_CLIENT_EMAIL', 'LLNK_VANTA_CURSOR_FIREBASE_PRIVATE_KEY_BASE64']
        : ['LLNK_VANTA_FIREBASE_DATABASE_URL', 'LLNK_VANTA_FIREBASE_CLIENT_EMAIL', 'LLNK_VANTA_FIREBASE_PRIVATE_KEY_BASE64', 'LLNK_VANTA_FIREBASE_API_KEY'];
    if ($requireApiKey && $kind === 'cursor') {
        $bases[] = 'LLNK_VANTA_CURSOR_FIREBASE_API_KEY';
    }
    foreach ($bases as $base) {
        $name = vanta_shard_config_name($base, $shard, $prefix);
        if (!defined($name)) return false;
        $value = trim((string)constant($name));
        if ($value === '' || stripos($value, 'CHANGE_') !== false) return false;
    }
    return true;
}

function vanta_use_room_shards(PDO $pdo, string $roomId): array
{
    $shards = vanta_room_shards($pdo, $roomId);
    vanta_set_request_shards($shards['sync'], $shards['cursor']);
    return $shards;
}

function vanta_new_room_shards(PDO $pdo): array
{
    $sync = vanta_choose_sync_shard($pdo);
    $cursor = vanta_shard_id(vanta_service_setting($pdo, 'cursor_active_shard', 'cursor_a'), 'cursor');
    if (!vanta_shard_configured('sync', $sync)) $sync = 'sync_a';
    if (!vanta_shard_configured('cursor', $cursor)) $cursor = 'cursor_a';
    return ['sync' => $sync, 'cursor' => $cursor];
}

function vanta_create_firebase_usage_schema(PDO $pdo): void
{
    static $created = false;
    if ($created) return;
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_vanta_firebase_usage (
          shard_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          shard_kind ENUM('sync','cursor') NOT NULL,
          project_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          download_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
          download_limit_bytes BIGINT UNSIGNED NOT NULL DEFAULT 10737418240,
          storage_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
          storage_limit_bytes BIGINT UNSIGNED NOT NULL DEFAULT 1073741824,
          assignment_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
          report_status VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'waiting',
          measured_at DATETIME NULL,
          reported_at DATETIME NULL,
          PRIMARY KEY (shard_id),
          KEY idx_llnk_vanta_firebase_usage_kind (shard_kind, reported_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_vanta_firebase_usage_history (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          shard_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          shard_kind ENUM('sync','cursor') NOT NULL,
          project_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          download_bytes BIGINT UNSIGNED NOT NULL,
          download_limit_bytes BIGINT UNSIGNED NOT NULL,
          storage_bytes BIGINT UNSIGNED NOT NULL,
          storage_limit_bytes BIGINT UNSIGNED NOT NULL,
          report_status VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          measured_at DATETIME NOT NULL,
          reported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uq_llnk_vanta_firebase_history_measurement (shard_id, measured_at),
          KEY idx_llnk_vanta_firebase_history_project (project_id, measured_at),
          KEY idx_llnk_vanta_firebase_history_kind (shard_kind, measured_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $created = true;
}

function vanta_firebase_configured_shards(string $kind): array
{
    $prefix = $kind === 'cursor' ? 'cursor' : 'sync';
    $result = [];
    foreach (range('a', 'z') as $suffix) {
        $shard = $prefix . '_' . $suffix;
        if (vanta_shard_configured($kind, $shard)) {
            $result[] = $shard;
        }
    }
    return $result;
}

function vanta_firebase_usage_rows(PDO $pdo): array
{
    vanta_create_firebase_usage_schema($pdo);
    $rows = $pdo->query(
        'SELECT shard_id, shard_kind, project_id, download_bytes, download_limit_bytes,
                storage_bytes, storage_limit_bytes, assignment_count, report_status,
                measured_at, reported_at
         FROM llnk_vanta_firebase_usage
         ORDER BY FIELD(shard_kind, \'sync\', \'cursor\'), shard_id'
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];
    $historyRows = $pdo->query(
        'SELECT shard_id, COUNT(*) AS sample_count,
                MIN(measured_at) AS history_started_at,
                MAX(measured_at) AS history_latest_at
         FROM llnk_vanta_firebase_usage_history GROUP BY shard_id'
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];
    $historyByShard = [];
    foreach ($historyRows as $historyRow) {
        $historyByShard[(string)$historyRow['shard_id']] = $historyRow;
    }
    $now = time();
    foreach ($rows as &$row) {
        $reportedAt = is_string($row['reported_at'] ?? null)
            ? strtotime((string)$row['reported_at']) : false;
        $row['fresh'] = $reportedAt !== false
            && $reportedAt >= $now - VANTA_FIREBASE_USAGE_FRESH_SECONDS;
        foreach (['download_bytes', 'download_limit_bytes', 'storage_bytes',
                  'storage_limit_bytes', 'assignment_count'] as $key) {
            $row[$key] = max(0, (int)($row[$key] ?? 0));
        }
        $history = $historyByShard[(string)$row['shard_id']] ?? [];
        $row['sample_count'] = max(0, (int)($history['sample_count'] ?? 0));
        $row['history_started_at'] = (string)($history['history_started_at'] ?? '');
        $row['history_latest_at'] = (string)($history['history_latest_at'] ?? '');
    }
    unset($row);
    return $rows;
}

function vanta_record_firebase_usage(PDO $pdo, array $report): void
{
    vanta_create_firebase_usage_schema($pdo);
    $kind = (string)($report['kind'] ?? '');
    $shard = vanta_shard_id((string)($report['shard'] ?? ''), $kind);
    $projectId = strtolower(trim((string)($report['projectId'] ?? '')));
    $status = strtolower(trim((string)($report['status'] ?? 'ok')));
    $measuredAt = (int)($report['measuredAt'] ?? 0);
    if (!in_array($kind, ['sync', 'cursor'], true)
        || strpos($shard, $kind . '_') !== 0
        || preg_match('/^[a-z][a-z0-9-]{4,62}[a-z0-9]$/', $projectId) !== 1
        || preg_match('/^[a-z0-9_-]{1,32}$/', $status) !== 1
        || $measuredAt < time() - 86400 || $measuredAt > time() + 300) {
        throw new InvalidArgumentException('Invalid Firebase usage report.');
    }
    $numeric = [];
    foreach (['downloadBytes', 'downloadLimitBytes', 'storageBytes', 'storageLimitBytes'] as $key) {
        $value = $report[$key] ?? null;
        if (!is_int($value) || $value < 0 || $value > 1099511627776) {
            throw new InvalidArgumentException('Invalid Firebase usage value.');
        }
        $numeric[$key] = $value;
    }
    if ($numeric['downloadBytes'] === 0 && $numeric['storageBytes'] === 0) {
        $currentStatement = $pdo->prepare(
            'SELECT download_bytes, storage_bytes
             FROM llnk_vanta_firebase_usage WHERE shard_id = ? FOR UPDATE'
        );
        $currentStatement->execute([$shard]);
        $current = $currentStatement->fetch(PDO::FETCH_ASSOC);
        if (is_array($current)
            && ((int)($current['download_bytes'] ?? 0) > 0
                || (int)($current['storage_bytes'] ?? 0) > 0)) {
            throw new InvalidArgumentException('Suspicious zero Firebase usage report.');
        }
    }
    $statement = $pdo->prepare(
        'INSERT INTO llnk_vanta_firebase_usage
         (shard_id, shard_kind, project_id, download_bytes, download_limit_bytes,
          storage_bytes, storage_limit_bytes, assignment_count, report_status,
          measured_at, reported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, FROM_UNIXTIME(?), CURRENT_TIMESTAMP)
         ON DUPLICATE KEY UPDATE
           shard_kind = VALUES(shard_kind), project_id = VALUES(project_id),
           download_bytes = VALUES(download_bytes),
           download_limit_bytes = VALUES(download_limit_bytes),
           storage_bytes = VALUES(storage_bytes),
           storage_limit_bytes = VALUES(storage_limit_bytes),
           assignment_count = 0, report_status = VALUES(report_status),
           measured_at = IF(VALUES(measured_at) >= COALESCE(measured_at, \'1970-01-01\'),
                            VALUES(measured_at), measured_at),
           reported_at = CURRENT_TIMESTAMP'
    );
    $statement->execute([
        $shard, $kind, $projectId,
        $numeric['downloadBytes'], $numeric['downloadLimitBytes'],
        $numeric['storageBytes'], $numeric['storageLimitBytes'],
        $status, $measuredAt,
    ]);
    $history = $pdo->prepare(
        'INSERT IGNORE INTO llnk_vanta_firebase_usage_history
         (shard_id, shard_kind, project_id, download_bytes, download_limit_bytes,
          storage_bytes, storage_limit_bytes, report_status, measured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?))'
    );
    $history->execute([
        $shard, $kind, $projectId,
        $numeric['downloadBytes'], $numeric['downloadLimitBytes'],
        $numeric['storageBytes'], $numeric['storageLimitBytes'],
        $status, $measuredAt,
    ]);
}

function vanta_choose_sync_shard(PDO $pdo): string
{
    $fallback = vanta_shard_id(
        vanta_service_setting($pdo, 'sync_active_shard', 'sync_a'),
        'sync'
    );
    $configured = vanta_firebase_configured_shards('sync');
    if (count($configured) < 2) {
        return in_array($fallback, $configured, true) ? $fallback : 'sync_a';
    }
    vanta_create_firebase_usage_schema($pdo);
    $ownsTransaction = !$pdo->inTransaction();
    if ($ownsTransaction) $pdo->beginTransaction();
    try {
        $placeholders = implode(',', array_fill(0, count($configured), '?'));
        $statement = $pdo->prepare(
            "SELECT shard_id, download_bytes, assignment_count, reported_at
             FROM llnk_vanta_firebase_usage
             WHERE shard_kind = 'sync' AND shard_id IN ({$placeholders})
             FOR UPDATE"
        );
        $statement->execute($configured);
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC) ?: [];
        $scores = [];
        $freshAfter = time() - VANTA_FIREBASE_USAGE_FRESH_SECONDS;
        foreach ($rows as $row) {
            $reportedAt = strtotime((string)($row['reported_at'] ?? ''));
            if ($reportedAt === false || $reportedAt < $freshAfter) continue;
            $scores[(string)$row['shard_id']] = max(0, (int)$row['download_bytes'])
                + max(0, (int)$row['assignment_count']) * VANTA_FIREBASE_SHARD_ROOM_BALANCE_BYTES;
        }
        if (count($scores) !== count($configured)) {
            if ($ownsTransaction) $pdo->commit();
            return in_array($fallback, $configured, true) ? $fallback : $configured[0];
        }
        asort($scores, SORT_NUMERIC);
        $chosen = (string)array_key_first($scores);
        $update = $pdo->prepare(
            'UPDATE llnk_vanta_firebase_usage
             SET assignment_count = assignment_count + 1 WHERE shard_id = ?'
        );
        $update->execute([$chosen]);
        if ($ownsTransaction) $pdo->commit();
        return $chosen;
    } catch (Throwable $error) {
        if ($ownsTransaction && $pdo->inTransaction()) $pdo->rollBack();
        error_log('VANTA automatic Firebase routing: ' . $error->getMessage());
        return in_array($fallback, $configured, true) ? $fallback : $configured[0];
    }
}

function vanta_unregister_room(PDO $pdo, string $roomId): void
{
    vanta_create_room_registry_schema($pdo);
    vanta_create_usage_schema($pdo);
    $statement = $pdo->prepare('DELETE FROM llnk_vanta_cursors WHERE room_id = ?');
    $statement->execute([$roomId]);
    $statement = $pdo->prepare('DELETE FROM llnk_vanta_sync_chunks WHERE room_id = ?');
    $statement->execute([$roomId]);
    $statement = $pdo->prepare('DELETE FROM llnk_vanta_sync_usage WHERE room_id = ?');
    $statement->execute([$roomId]);
    $statement = $pdo->prepare('DELETE FROM llnk_vanta_rooms WHERE room_id = ?');
    $statement->execute([$roomId]);
}

function vanta_sync_registry_rollback(PDO $pdo): void
{
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
}

function vanta_sync_registry_lock_room(PDO $pdo, string $roomId): void
{
    $statement = $pdo->prepare(
        'SELECT room_id FROM llnk_vanta_rooms WHERE room_id = ? FOR UPDATE'
    );
    $statement->execute([$roomId]);
    if ($statement->fetchColumn() === false) {
        throw new VantaSyncConflictException('VANTA room registry is missing.');
    }
}

function vanta_sync_registry_begin_locked(PDO $pdo, string $roomId): void
{
    vanta_create_room_registry_schema($pdo);
    if ($pdo->inTransaction()) {
        throw new RuntimeException('VANTA registry transaction is already active.');
    }
    $pdo->beginTransaction();
    try {
        vanta_sync_registry_lock_room($pdo, $roomId);
    } catch (Throwable $error) {
        vanta_sync_registry_rollback($pdo);
        throw $error;
    }
}

function vanta_sync_registry_replace_locked(
    PDO $pdo,
    string $roomId,
    array $chunks,
    int $revision
): array {
    if (!$pdo->inTransaction() || $revision < 2) {
        throw new RuntimeException('VANTA registry replacement is not locked.');
    }
    $chunkCount = count($chunks);
    $chunkBytes = 0;
    foreach ($chunks as $chunk) {
        $chunkBytes += strlen($chunk);
    }
    if ($chunkCount < 1
        || $chunkCount > VANTA_SYNC_MAX_CHUNKS
        || $chunkBytes < 1
        || $chunkBytes > VANTA_SYNC_MAX_TOTAL_CHUNK_BYTES) {
        throw new InvalidArgumentException('VANTA project exceeds the stored chunk limit.');
    }
    $pdo->prepare('DELETE FROM llnk_vanta_sync_chunks WHERE room_id = ?')->execute([$roomId]);
    $pdo->prepare('DELETE FROM llnk_vanta_sync_usage WHERE room_id = ?')->execute([$roomId]);
    $insertChunk = $pdo->prepare(
        'INSERT INTO llnk_vanta_sync_chunks (room_id, chunk_key, byte_size) VALUES (?, ?, ?)'
    );
    foreach ($chunks as $key => $chunk) {
        $insertChunk->execute([$roomId, $key, strlen($chunk)]);
    }
    $usage = $pdo->prepare(
        'INSERT INTO llnk_vanta_sync_usage
         (room_id, chunk_count, chunk_bytes, revision) VALUES (?, ?, ?, ?)'
    );
    $usage->execute([$roomId, $chunkCount, $chunkBytes, $revision]);
    return ['chunk_count' => $chunkCount, 'chunk_bytes' => $chunkBytes, 'revision' => $revision];
}

function vanta_sync_registry_stage_initialize(PDO $pdo, string $roomId, array $chunks): array
{
    vanta_sync_registry_begin_locked($pdo, $roomId);
    try {
        return vanta_sync_registry_replace_locked($pdo, $roomId, $chunks, 2);
    } catch (Throwable $error) {
        vanta_sync_registry_rollback($pdo);
        throw $error;
    }
}

function vanta_sync_registry_stage_update(
    PDO $pdo,
    string $roomId,
    array $changes,
    array $removed
): array {
    vanta_sync_registry_begin_locked($pdo, $roomId);
    try {
        $usageStatement = $pdo->prepare(
            'SELECT chunk_count, chunk_bytes, revision
             FROM llnk_vanta_sync_usage WHERE room_id = ? FOR UPDATE'
        );
        $usageStatement->execute([$roomId]);
        $current = $usageStatement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($current)) {
            throw new VantaSyncConflictException('VANTA chunk registry is missing.');
        }
        $affectedKeys = array_values(array_unique(array_merge(array_keys($changes), $removed)));
        $existingSizes = [];
        if ($affectedKeys) {
            $placeholders = implode(',', array_fill(0, count($affectedKeys), '?'));
            $sizeStatement = $pdo->prepare(
                'SELECT chunk_key, byte_size FROM llnk_vanta_sync_chunks
                 WHERE room_id = ? AND chunk_key IN (' . $placeholders . ')'
            );
            $sizeStatement->execute(array_merge([$roomId], $affectedKeys));
            while ($row = $sizeStatement->fetch(PDO::FETCH_ASSOC)) {
                $existingSizes[(string)$row['chunk_key']] = (int)$row['byte_size'];
            }
        }
        $next = vanta_calculate_next_chunk_usage(
            (int)$current['chunk_count'],
            (int)$current['chunk_bytes'],
            $existingSizes,
            $changes,
            $removed
        );
        $upsert = $pdo->prepare(
            'INSERT INTO llnk_vanta_sync_chunks (room_id, chunk_key, byte_size)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE byte_size = VALUES(byte_size)'
        );
        foreach ($changes as $key => $chunk) {
            $upsert->execute([$roomId, $key, strlen($chunk)]);
        }
        if ($removed) {
            $placeholders = implode(',', array_fill(0, count($removed), '?'));
            $delete = $pdo->prepare(
                'DELETE FROM llnk_vanta_sync_chunks
                 WHERE room_id = ? AND chunk_key IN (' . $placeholders . ')'
            );
            $delete->execute(array_merge([$roomId], $removed));
        }
        $nextRevision = (int)$current['revision'] + 1;
        $update = $pdo->prepare(
            'UPDATE llnk_vanta_sync_usage
             SET chunk_count = ?, chunk_bytes = ?, revision = ?, updated_at = CURRENT_TIMESTAMP
             WHERE room_id = ?'
        );
        $update->execute([
            $next['chunk_count'],
            $next['chunk_bytes'],
            $nextRevision,
            $roomId,
        ]);
        return [
            'chunk_count' => $next['chunk_count'],
            'chunk_bytes' => $next['chunk_bytes'],
            'current_revision' => (int)$current['revision'],
            'revision' => $nextRevision,
        ];
    } catch (Throwable $error) {
        vanta_sync_registry_rollback($pdo);
        throw $error;
    }
}

function vanta_participant_list($value): array
{
    if (!is_array($value)) {
        return [];
    }
    if (isset($value['participants']) && is_array($value['participants'])) {
        return $value['participants'];
    }
    return $value;
}

function vanta_active_participant_count($participants, ?int $now = null): int
{
    $now = $now ?? (int)round(microtime(true) * 1000);
    $active = 0;
    foreach (vanta_participant_list($participants) as $participant) {
        if (is_array($participant) && (int)($participant['expiresAt'] ?? 0) > $now) {
            $active += 1;
        }
    }
    return $active;
}

function vanta_has_active_participant(
    $participants,
    string $uid,
    string $participantId,
    int $protocolVersion,
    ?int $now = null
): bool {
    $now = $now ?? (int)round(microtime(true) * 1000);
    foreach (vanta_participant_list($participants) as $participant) {
        if (is_array($participant)
            && hash_equals((string)($participant['uid'] ?? ''), $uid)
            && hash_equals((string)($participant['participantId'] ?? ''), $participantId)
            && (int)($participant['protocolVersion'] ?? 0) === $protocolVersion
            && (int)($participant['releaseVersion'] ?? 0) === VANTA_CURRENT_RELEASE
            && (int)($participant['expiresAt'] ?? 0) > $now) {
            return true;
        }
    }
    return false;
}

function vanta_participant_slot(
    $participants,
    string $uid,
    string $participantId,
    int $protocolVersion,
    bool $requireActive = true,
    ?int $now = null
): ?string {
    $now = $now ?? (int)round(microtime(true) * 1000);
    foreach (vanta_participant_list($participants) as $slot => $participant) {
        $slot = (string)$slot;
        if (preg_match('/^[0-4]$/', $slot) !== 1 || !is_array($participant)) {
            continue;
        }
        if (hash_equals((string)($participant['uid'] ?? ''), $uid)
            && hash_equals((string)($participant['participantId'] ?? ''), $participantId)
            && (int)($participant['protocolVersion'] ?? 0) === $protocolVersion
            && (int)($participant['releaseVersion'] ?? 0) === VANTA_CURRENT_RELEASE
            && (!$requireActive || (int)($participant['expiresAt'] ?? 0) > $now)) {
            return $slot;
        }
    }
    return null;
}

function vanta_read_participants(string $roomId, string $serverIdToken)
{
    $result = vanta_firebase_session_path_request('GET', $roomId, 'participants', $serverIdToken);
    if ($result['status'] !== 200) {
        throw new RuntimeException('Could not read VANTA participants.');
    }
    return $result['body'];
}

function vanta_read_scalar(string $roomId, string $path, string $serverIdToken)
{
    $result = vanta_firebase_session_path_request('GET', $roomId, $path, $serverIdToken);
    if ($result['status'] !== 200) {
        throw new RuntimeException('Could not read VANTA room state.');
    }
    return $result['body'];
}

function vanta_acquire_closing_lock(string $roomId, string $serverIdToken): ?int
{
    $path = 'meta/closingUntil';
    $read = vanta_firebase_session_path_request(
        'GET',
        $roomId,
        $path,
        $serverIdToken,
        null,
        ['X-Firebase-ETag: true']
    );
    if ($read['status'] !== 200) {
        throw new RuntimeException('Could not inspect VANTA closing lock.');
    }
    $now = (int)round(microtime(true) * 1000);
    if ((int)$read['body'] > $now) {
        return null;
    }
    $etag = (string)($read['headers']['etag'] ?? '');
    if ($etag === '') {
        throw new RuntimeException('VANTA closing lock ETag is missing.');
    }
    $closingUntil = $now + VANTA_CLOSING_LOCK_MS;
    $locked = vanta_firebase_session_path_request(
        'PUT',
        $roomId,
        $path,
        $serverIdToken,
        $closingUntil,
        ['If-Match: ' . $etag]
    );
    if ($locked['status'] === 412) {
        return null;
    }
    if (!in_array($locked['status'], [200, 204], true)) {
        throw new RuntimeException('Could not acquire VANTA closing lock.');
    }
    return $closingUntil;
}

function vanta_release_closing_lock(string $roomId, string $serverIdToken, int $closingUntil): void
{
    try {
        $path = 'meta/closingUntil';
        $read = vanta_firebase_session_path_request(
            'GET',
            $roomId,
            $path,
            $serverIdToken,
            null,
            ['X-Firebase-ETag: true']
        );
        if ($read['status'] !== 200 || (int)$read['body'] !== $closingUntil) {
            return;
        }
        $etag = (string)($read['headers']['etag'] ?? '');
        if ($etag !== '') {
            vanta_firebase_session_path_request(
                'DELETE',
                $roomId,
                $path,
                $serverIdToken,
                null,
                ['If-Match: ' . $etag]
            );
        }
    } catch (Throwable $error) {
        error_log('VANTA closing lock release: ' . $error->getMessage());
    }
}

function vanta_delete_room_storage(PDO $pdo, string $roomId, string $serverIdToken): void
{
    $deleted = vanta_firebase_session_request('DELETE', $roomId, $serverIdToken);
    if (!in_array($deleted['status'], [200, 204], true)) {
        throw new RuntimeException('Could not delete empty VANTA room.');
    }
    if (vanta_cursor_firebase_configured()) {
        try { vanta_cursor_firebase_request('DELETE', $roomId); } catch (Throwable $error) {
            error_log('VANTA cursor cleanup: ' . $error->getMessage());
        }
        try { vanta_cursor_chat_firebase_request('DELETE', $roomId); } catch (Throwable $error) {
            error_log('VANTA chat cleanup: ' . $error->getMessage());
        }
    }
    vanta_unregister_room($pdo, $roomId);
}

function vanta_delete_room_if_empty(PDO $pdo, string $roomId, string $serverIdToken, $participants = null): bool
{
    if ($participants === null) {
        $participants = vanta_read_participants($roomId, $serverIdToken);
    }
    if (vanta_active_participant_count($participants) > 0) {
        return false;
    }

    // A missing participants node is indistinguishable from an empty one. Verify a
    // small scalar before taking the lock so cleanup never creates a partial room.
    if ((int)vanta_read_scalar($roomId, 'meta/version', $serverIdToken) !== 1) {
        vanta_unregister_room($pdo, $roomId);
        return true;
    }
    $releaseVersion = (int)vanta_read_scalar($roomId, 'meta/releaseVersion', $serverIdToken);
    if ($releaseVersion !== VANTA_CURRENT_RELEASE) {
        // Current Firebase Rules intentionally reject writes to legacy room
        // metadata, so a closing lock cannot be added to an old room. Those
        // rooms cannot accept current participants either. Re-read presence
        // immediately before deleting to preserve the same empty-room guard.
        $participantsBeforeDelete = vanta_read_participants($roomId, $serverIdToken);
        if (vanta_active_participant_count($participantsBeforeDelete) > 0) {
            return false;
        }
        vanta_delete_room_storage($pdo, $roomId, $serverIdToken);
        return true;
    }
    $closingUntil = vanta_acquire_closing_lock($roomId, $serverIdToken);
    if ($closingUntil === null) {
        return false;
    }
    $participantsAfterLock = vanta_read_participants($roomId, $serverIdToken);
    if (vanta_active_participant_count($participantsAfterLock) > 0) {
        vanta_release_closing_lock($roomId, $serverIdToken, $closingUntil);
        return false;
    }

    try {
        vanta_delete_room_storage($pdo, $roomId, $serverIdToken);
    } catch (Throwable $error) {
        vanta_release_closing_lock($roomId, $serverIdToken, $closingUntil);
        throw $error;
    }
    return true;
}

function vanta_cleanup_empty_rooms(PDO $pdo, string $serverIdToken, int $limit = 8): int
{
    vanta_create_room_registry_schema($pdo);
    $allowed = llnk_consume_rate(
        $pdo,
        'vanta_empty_room_cleanup',
        'global',
        date('YmdHi'),
        date('Y-m-d H:i:s', time() + 120),
        1
    );
    if (!$allowed) {
        return 0;
    }
    $limit = max(1, min(20, $limit));
    $originalSyncShard = vanta_request_shard('sync');
    $originalCursorShard = vanta_request_shard('cursor');
    $configuredSyncShards = vanta_firebase_configured_shards('sync');
    if (!$configuredSyncShards) {
        $configuredSyncShards = [$originalSyncShard];
    }
    $lastCleanupShard = vanta_service_setting($pdo, 'cleanup_sync_shard_cursor', '');
    $lastCleanupIndex = array_search($lastCleanupShard, $configuredSyncShards, true);
    $cleanupSyncShard = $lastCleanupIndex === false
        ? $configuredSyncShards[0]
        : $configuredSyncShards[($lastCleanupIndex + 1) % count($configuredSyncShards)];
    $cleanupCursor = $pdo->prepare(
        'INSERT INTO llnk_vanta_settings (setting_key, setting_value)
         VALUES (\'cleanup_sync_shard_cursor\', ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)'
    );
    $cleanupCursor->execute([$cleanupSyncShard]);
    $cleaned = 0;
    try {
        vanta_set_request_shards($cleanupSyncShard, $originalCursorShard);
        $cleanupServerIdToken = $cleanupSyncShard === $originalSyncShard
            ? $serverIdToken
            : vanta_server_id_token();
        $roomQuery = $pdo->prepare(
            'SELECT room_id, cursor_shard FROM llnk_vanta_rooms
             WHERE sync_shard = ? AND checked_at <= DATE_SUB(NOW(), INTERVAL 30 SECOND)
             ORDER BY checked_at ASC
             LIMIT ' . $limit
        );
        $roomQuery->execute([$cleanupSyncShard]);
        $rooms = $roomQuery->fetchAll(PDO::FETCH_ASSOC) ?: [];
        foreach ($rooms as $room) {
            $roomId = vanta_room_id((string)($room['room_id'] ?? ''));
            if ($roomId === '') {
                continue;
            }
            // Rooms sharing one Sync project may use different Cursor projects.
            // Select the registered Cursor shard before deleting its ephemeral tree.
            vanta_set_request_shards(
                $cleanupSyncShard,
                vanta_shard_id((string)($room['cursor_shard'] ?? ''), 'cursor')
            );
            $pdo->prepare('UPDATE llnk_vanta_rooms SET checked_at = NOW() WHERE room_id = ?')->execute([$roomId]);
            try {
                if (vanta_delete_room_if_empty($pdo, $roomId, $cleanupServerIdToken)) {
                    $cleaned += 1;
                }
            } catch (Throwable $error) {
                error_log('VANTA empty room cleanup (' . $cleanupSyncShard . '): ' . $error->getMessage());
            }
        }
    } finally {
        vanta_set_request_shards($originalSyncShard, $originalCursorShard);
    }
    return $cleaned;
}

function vanta_private_key()
{
    $decoded = base64_decode(vanta_shard_config_string('LLNK_VANTA_FIREBASE_PRIVATE_KEY_BASE64', 'sync'), true);
    if (!is_string($decoded) || $decoded === '') {
        throw new RuntimeException('VANTA Firebase 개인 키가 올바르지 않습니다.');
    }
    $key = openssl_pkey_get_private($decoded);
    if ($key === false) {
        throw new RuntimeException('VANTA Firebase 개인 키를 읽을 수 없습니다.');
    }
    return $key;
}

function vanta_create_custom_token(string $uid, array $claims): string
{
    if (preg_match('/^[A-Za-z0-9_-]{1,128}$/', $uid) !== 1) {
        throw new InvalidArgumentException('VANTA Firebase 사용자 ID가 올바르지 않습니다.');
    }
    $now = time();
    $email = vanta_shard_config_string('LLNK_VANTA_FIREBASE_CLIENT_EMAIL', 'sync');
    $header = vanta_base64url_encode((string)json_encode(['alg' => 'RS256', 'typ' => 'JWT']));
    $payload = vanta_base64url_encode((string)json_encode([
        'iss' => $email,
        'sub' => $email,
        'aud' => VANTA_FIREBASE_CUSTOM_TOKEN_AUDIENCE,
        'iat' => $now,
        'exp' => $now + 3600,
        'uid' => $uid,
        'claims' => $claims,
    ], JSON_UNESCAPED_SLASHES));
    $unsigned = $header . '.' . $payload;
    $signature = '';
    if (!openssl_sign($unsigned, $signature, vanta_private_key(), OPENSSL_ALGO_SHA256)) {
        throw new RuntimeException('VANTA Firebase 토큰 서명에 실패했습니다.');
    }
    return $unsigned . '.' . vanta_base64url_encode($signature);
}

function vanta_http_json(string $url, string $method, $body = null, array $headers = []): array
{
    $encoded = $body === null ? '' : json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($body !== null && !is_string($encoded)) {
        throw new RuntimeException('VANTA 서버 요청을 만들 수 없습니다.');
    }
    $requestHeaders = array_merge(['Accept: application/json'], $headers);
    if ($body !== null) {
        $requestHeaders[] = 'Content-Type: application/json';
    }
    if (function_exists('curl_init')) {
        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $requestHeaders,
            CURLOPT_POSTFIELDS => $body === null ? null : $encoded,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HEADER => true,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => 15,
        ]);
        $raw = curl_exec($curl);
        if (!is_string($raw)) {
            $message = curl_error($curl);
            curl_close($curl);
            throw new RuntimeException('VANTA 외부 서버 연결 실패: ' . $message);
        }
        $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        $headerSize = (int)curl_getinfo($curl, CURLINFO_HEADER_SIZE);
        curl_close($curl);
        $rawHeaders = substr($raw, 0, $headerSize);
        $rawBody = substr($raw, $headerSize);
    } else {
        $context = stream_context_create(['http' => [
            'method' => $method,
            'header' => implode("\r\n", $requestHeaders),
            'content' => $body === null ? '' : $encoded,
            'ignore_errors' => true,
            'timeout' => 15,
        ]]);
        $rawBody = file_get_contents($url, false, $context);
        if (!is_string($rawBody)) {
            throw new RuntimeException('VANTA 외부 서버에 연결하지 못했습니다.');
        }
        $responseHeaders = $http_response_header ?? [];
        $rawHeaders = implode("\r\n", $responseHeaders);
        $status = preg_match('/\s(\d{3})\s/', (string)($responseHeaders[0] ?? ''), $matches) === 1
            ? (int)$matches[1]
            : 0;
    }
    $parsedHeaders = [];
    foreach (preg_split('/\r?\n/', $rawHeaders) ?: [] as $line) {
        if (strpos($line, ':') === false) {
            continue;
        }
        [$name, $value] = explode(':', $line, 2);
        $parsedHeaders[strtolower(trim($name))] = trim($value);
    }
    $decoded = json_decode($rawBody, true);
    $decodedSuccessfully = json_last_error() === JSON_ERROR_NONE;
    return [
        'status' => $status,
        'headers' => $parsedHeaders,
        'body' => $decodedSuccessfully ? $decoded : $rawBody,
    ];
}

function vanta_exchange_custom_token(string $customToken): array
{
    $url = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key='
        . rawurlencode(vanta_shard_config_string('LLNK_VANTA_FIREBASE_API_KEY', 'sync'));
    $result = vanta_http_json($url, 'POST', ['token' => $customToken, 'returnSecureToken' => true]);
    if ($result['status'] !== 200 || !is_array($result['body']) || empty($result['body']['idToken'])) {
        throw new RuntimeException('VANTA Firebase 서버 인증에 실패했습니다.');
    }
    return $result['body'];
}

function vanta_apcu_available(): bool
{
    if (!function_exists('apcu_fetch') || !function_exists('apcu_store')) {
        return false;
    }
    return !function_exists('apcu_enabled') || apcu_enabled();
}

function vanta_server_token_context(string $kind = 'sync'): string
{
    if ($kind === 'cursor') {
        return vanta_shard_config_string('LLNK_VANTA_CURSOR_FIREBASE_CLIENT_EMAIL', 'cursor')
            . '|' . vanta_shard_config_string('LLNK_VANTA_CURSOR_FIREBASE_DATABASE_URL', 'cursor');
    }
    return vanta_shard_config_string('LLNK_VANTA_FIREBASE_CLIENT_EMAIL', 'sync')
        . '|' . vanta_shard_config_string('LLNK_VANTA_FIREBASE_DATABASE_URL', 'sync');
}

function vanta_server_token_cache_handle(string $context = '')
{
    $secret = vanta_config_string('LLNK_VANTA_IP_SECRET');
    $context = $context !== '' ? $context : vanta_server_token_context();
    if (defined('LLNK_VANTA_PRIVATE_CACHE_DIR')) {
        $directory = rtrim(trim((string)constant('LLNK_VANTA_PRIVATE_CACHE_DIR')), "/\\");
        if ($directory === '' || preg_match('~^(?:/|[A-Za-z]:[\\\\/])~', $directory) !== 1) {
            return null;
        }
    } else {
        $directory = rtrim(sys_get_temp_dir(), "/\\") . DIRECTORY_SEPARATOR
            . 'llnk-vanta-' . substr(hash_hmac('sha256', 'dir|' . $context, $secret), 0, 24);
    }
    if (!is_dir($directory) && !@mkdir($directory, 0700, false) && !is_dir($directory)) {
        return null;
    }
    if (is_link($directory)) {
        return null;
    }
    @chmod($directory, 0700);
    $resolvedDirectory = realpath($directory);
    if (!is_string($resolvedDirectory) || $resolvedDirectory === '') {
        return null;
    }
    if (DIRECTORY_SEPARATOR === '/') {
        $mode = @fileperms($resolvedDirectory);
        if (!is_int($mode) || ($mode & 0077) !== 0) {
            return null;
        }
    }
    $documentRoot = realpath((string)($_SERVER['DOCUMENT_ROOT'] ?? ''));
    if (is_string($documentRoot) && $documentRoot !== '') {
        $normalizedRoot = rtrim(str_replace('\\', '/', $documentRoot), '/');
        $normalizedDirectory = rtrim(str_replace('\\', '/', $resolvedDirectory), '/');
        if (DIRECTORY_SEPARATOR === '\\') {
            $normalizedRoot = strtolower($normalizedRoot);
            $normalizedDirectory = strtolower($normalizedDirectory);
        }
        if ($normalizedDirectory === $normalizedRoot
            || strpos($normalizedDirectory . '/', $normalizedRoot . '/') === 0) {
            return null;
        }
    }
    $fileName = 'firebase-' . substr(
        hash_hmac('sha256', 'file|' . $context, $secret),
        0,
        24
    ) . '.bin';
    $path = $resolvedDirectory . DIRECTORY_SEPARATOR . $fileName;
    if (is_link($path)) {
        return null;
    }
    $handle = @fopen($path, 'c+b');
    if (!is_resource($handle)) {
        return null;
    }
    @chmod($path, 0600);
    $stat = @fstat($handle);
    if (!is_array($stat)
        || (DIRECTORY_SEPARATOR === '/' && (((int)$stat['mode'] & 0170000) !== 0100000
            || ((int)$stat['mode'] & 0077) !== 0))) {
        fclose($handle);
        return null;
    }
    return $handle;
}

function vanta_server_token_cache_keys(string $context = ''): array
{
    $secret = vanta_config_string('LLNK_VANTA_IP_SECRET');
    $context = $context !== '' ? $context : vanta_server_token_context();
    return [
        'context_hash' => hash('sha256', $context, true),
        'encryption' => hash_hmac('sha256', 'vanta-token-cache|enc|' . $context, $secret, true),
        'mac' => hash_hmac('sha256', 'vanta-token-cache|mac|' . $context, $secret, true),
    ];
}

function vanta_server_token_cache_read_locked($handle, string $context = ''): ?array
{
    if (!is_resource($handle) || !rewind($handle)) {
        return null;
    }
    $raw = stream_get_contents($handle, 32769);
    if (!is_string($raw) || strlen($raw) < 69 || strlen($raw) > 32768
        || substr($raw, 0, 4) !== 'VTC1') {
        return null;
    }
    $iv = substr($raw, 4, 16);
    $providedMac = substr($raw, 20, 32);
    $ciphertext = substr($raw, 52);
    $keys = vanta_server_token_cache_keys($context);
    $expectedMac = hash_hmac(
        'sha256',
        "VTC1\0" . $keys['context_hash'] . $iv . $ciphertext,
        $keys['mac'],
        true
    );
    if (!hash_equals($expectedMac, $providedMac)) {
        return null;
    }
    $plain = openssl_decrypt(
        $ciphertext,
        'aes-256-cbc',
        $keys['encryption'],
        OPENSSL_RAW_DATA,
        $iv
    );
    if (!is_string($plain)) {
        return null;
    }
    $value = json_decode($plain, true);
    $token = is_array($value) && is_string($value['token'] ?? null) ? $value['token'] : '';
    $refreshAt = is_array($value) ? (int)($value['refresh_at'] ?? 0) : 0;
    $hardExpiresAt = is_array($value) ? (int)($value['hard_expires_at'] ?? 0) : 0;
    if ((int)($value['version'] ?? 0) !== 1
        || $token === ''
        || strlen($token) > 16384
        || preg_match('/^[A-Za-z0-9_.-]{20,16384}$/', $token) !== 1
        || $refreshAt <= 0
        || $hardExpiresAt <= $refreshAt) {
        return null;
    }
    return [
        'token' => $token,
        'refresh_at' => $refreshAt,
        'hard_expires_at' => $hardExpiresAt,
    ];
}

function vanta_server_token_cache_write_locked($handle, array $value, string $context = ''): void
{
    $plain = json_encode([
        'version' => 1,
        'token' => $value['token'],
        'refresh_at' => $value['refresh_at'],
        'hard_expires_at' => $value['hard_expires_at'],
    ], JSON_UNESCAPED_SLASHES);
    if (!is_string($plain)) {
        throw new RuntimeException('Could not encode VANTA server token cache.');
    }
    $keys = vanta_server_token_cache_keys($context);
    $iv = random_bytes(16);
    $ciphertext = openssl_encrypt(
        $plain,
        'aes-256-cbc',
        $keys['encryption'],
        OPENSSL_RAW_DATA,
        $iv
    );
    if (!is_string($ciphertext)) {
        throw new RuntimeException('Could not encrypt VANTA server token cache.');
    }
    $mac = hash_hmac(
        'sha256',
        "VTC1\0" . $keys['context_hash'] . $iv . $ciphertext,
        $keys['mac'],
        true
    );
    $encoded = 'VTC1' . $iv . $mac . $ciphertext;
    if (!rewind($handle) || !ftruncate($handle, 0)) {
        throw new RuntimeException('Could not reset VANTA server token cache.');
    }
    $offset = 0;
    $length = strlen($encoded);
    while ($offset < $length) {
        $written = fwrite($handle, substr($encoded, $offset));
        if (!is_int($written) || $written < 1) {
            throw new RuntimeException('Could not write VANTA server token cache.');
        }
        $offset += $written;
    }
    if (!fflush($handle)) {
        throw new RuntimeException('Could not flush VANTA server token cache.');
    }
    if (function_exists('fsync')) {
        @fsync($handle);
    }
}

function vanta_generate_server_id_token(): array
{
    $now = time();
    $customToken = vanta_create_custom_token('vanta-llnkkr-server', [
        'vanta_server' => true,
        'vanta_expires_at' => (int)round(microtime(true) * 1000) + 3600000,
    ]);
    $exchange = vanta_exchange_custom_token($customToken);
    $expiresIn = max(300, min(3600, (int)($exchange['expiresIn'] ?? 3600)));
    $hardExpiresAt = $now + $expiresIn;
    return [
        'token' => (string)$exchange['idToken'],
        'refresh_at' => max($now + 60, $hardExpiresAt - 120),
        'hard_expires_at' => $hardExpiresAt,
    ];
}

function vanta_server_id_token(): string
{
    static $requestTokens = [];
    static $requestExpiresAt = [];
    $now = time();
    $context = vanta_server_token_context();
    if (($requestTokens[$context] ?? '') !== ''
        && ($requestExpiresAt[$context] ?? 0) > $now + 30) {
        return $requestTokens[$context];
    }
    $cacheKey = 'llnk_vanta_server_token_' . substr(hash('sha256', $context), 0, 20);
    $apcuAvailable = vanta_apcu_available();
    if ($apcuAvailable) {
        $success = false;
        $cached = apcu_fetch($cacheKey, $success);
        if ($success
            && is_array($cached)
             && is_string($cached['token'] ?? null)
             && (int)($cached['refresh_at'] ?? 0) > $now + 30) {
            $requestTokens[$context] = $cached['token'];
            $requestExpiresAt[$context] = (int)$cached['refresh_at'];
            return $requestTokens[$context];
        }
    }

    $accept = static function (array $value, bool $grace = false) use (
        &$requestTokens,
        &$requestExpiresAt,
        $context,
        $cacheKey,
        $apcuAvailable
    ): string {
        $now = time();
        $requestTokens[$context] = (string)$value['token'];
        $requestExpiresAt[$context] = $grace
            ? min((int)$value['hard_expires_at'], $now + 60)
            : (int)$value['refresh_at'];
        if ($apcuAvailable && !$grace) {
            apcu_store(
                $cacheKey,
                $value,
                max(60, (int)$value['hard_expires_at'] - $now)
            );
        }
        return $requestTokens[$context];
    };

    $handle = vanta_server_token_cache_handle($context);
    if (is_resource($handle)) {
        try {
            if (flock($handle, LOCK_SH)) {
                $cached = vanta_server_token_cache_read_locked($handle, $context);
                if (is_array($cached) && $cached['refresh_at'] > time() + 30) {
                    return $accept($cached);
                }
                flock($handle, LOCK_UN);
            } else {
                $cached = null;
            }
            if (flock($handle, LOCK_EX)) {
                $cached = vanta_server_token_cache_read_locked($handle, $context);
                if (is_array($cached) && $cached['refresh_at'] > time() + 30) {
                    return $accept($cached);
                }
                try {
                    $fresh = vanta_generate_server_id_token();
                } catch (Throwable $error) {
                    if (is_array($cached) && $cached['hard_expires_at'] > time() + 30) {
                        return $accept($cached, true);
                    }
                    throw $error;
                }
                try {
                    vanta_server_token_cache_write_locked($handle, $fresh, $context);
                } catch (Throwable $cacheError) {
                    error_log('VANTA server token cache write failed.');
                }
                return $accept($fresh);
            }
        } finally {
            @flock($handle, LOCK_UN);
            fclose($handle);
        }
    }
    return $accept(vanta_generate_server_id_token());
}

function vanta_cursor_private_key()
{
    $decoded = base64_decode(
        vanta_shard_config_string('LLNK_VANTA_CURSOR_FIREBASE_PRIVATE_KEY_BASE64', 'cursor'),
        true
    );
    if (!is_string($decoded) || $decoded === '') {
        throw new RuntimeException('VANTA Cursor Firebase private key is invalid.');
    }
    $key = openssl_pkey_get_private($decoded);
    if ($key === false) {
        throw new RuntimeException('VANTA Cursor Firebase private key could not be read.');
    }
    return $key;
}

function vanta_create_cursor_custom_token(string $uid, array $claims): string
{
    if (preg_match('/^[A-Za-z0-9_-]{1,128}$/', $uid) !== 1) {
        throw new InvalidArgumentException('Invalid VANTA Cursor uid.');
    }
    $now = time();
    $email = vanta_shard_config_string('LLNK_VANTA_CURSOR_FIREBASE_CLIENT_EMAIL', 'cursor');
    $header = vanta_base64url_encode((string)json_encode(['alg' => 'RS256', 'typ' => 'JWT']));
    $payload = vanta_base64url_encode((string)json_encode([
        'iss' => $email,
        'sub' => $email,
        'aud' => VANTA_FIREBASE_CUSTOM_TOKEN_AUDIENCE,
        'iat' => $now,
        'exp' => $now + 3600,
        'uid' => $uid,
        'claims' => $claims,
    ], JSON_UNESCAPED_SLASHES));
    $unsigned = $header . '.' . $payload;
    $signature = '';
    if (!openssl_sign($unsigned, $signature, vanta_cursor_private_key(), OPENSSL_ALGO_SHA256)) {
        throw new RuntimeException('VANTA Cursor token signing failed.');
    }
    return $unsigned . '.' . vanta_base64url_encode($signature);
}

function vanta_exchange_cursor_custom_token(string $customToken): array
{
    $url = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key='
        . rawurlencode(vanta_shard_config_string('LLNK_VANTA_CURSOR_FIREBASE_API_KEY', 'cursor'));
    $result = vanta_http_json($url, 'POST', ['token' => $customToken, 'returnSecureToken' => true]);
    if ((int)$result['status'] !== 200 || !is_array($result['body']) || empty($result['body']['idToken'])) {
        throw new RuntimeException('VANTA Cursor Firebase client authentication failed.');
    }
    return $result['body'];
}

function vanta_cursor_direct_enabled(PDO $pdo): bool
{
    return vanta_service_setting($pdo, 'cursor_live_enabled', '1') === '1';
}

function vanta_cursor_direct_access(array $identity, ?int $expiresAt = null): array
{
    if (!vanta_shard_configured('cursor', vanta_request_shard('cursor'), true)) {
        throw new RuntimeException('VANTA Cursor direct Firebase is not configured.');
    }
    $now = (int)round(microtime(true) * 1000);
    $expiresAt = $expiresAt ?? ($now + (VANTA_CURSOR_DIRECT_ACCESS_SECONDS * 1000));
    if ($expiresAt <= $now + 30000
        || $expiresAt > $now + (VANTA_CURSOR_DIRECT_ACCESS_SECONDS * 1000)) {
        throw new InvalidArgumentException('Invalid VANTA Cursor access expiry.');
    }
    $token = vanta_create_cursor_custom_token((string)$identity['uid'], [
        'vanta_cursor_room' => (string)$identity['room_id'],
        'vanta_cursor_participant' => (string)$identity['participant_id'],
        'vanta_cursor_release' => VANTA_CURRENT_RELEASE,
        'vanta_cursor_shard' => vanta_request_shard('cursor'),
        'vanta_cursor_expires_at' => $expiresAt,
    ]);
    $exchange = vanta_exchange_cursor_custom_token($token);
    return [
        'idToken' => (string)$exchange['idToken'],
        'expiresAt' => $expiresAt,
        'databaseUrl' => rtrim(vanta_shard_config_string('LLNK_VANTA_CURSOR_FIREBASE_DATABASE_URL', 'cursor'), '/'),
        'shard' => vanta_request_shard('cursor'),
    ];
}

function vanta_cursor_firebase_configured(): bool
{
    return vanta_shard_configured('cursor', vanta_request_shard('cursor'));
}

function vanta_generate_cursor_access_token(): array
{
    $now = time();
    $email = vanta_shard_config_string('LLNK_VANTA_CURSOR_FIREBASE_CLIENT_EMAIL', 'cursor');
    $header = vanta_base64url_encode((string)json_encode(['alg' => 'RS256', 'typ' => 'JWT']));
    $payload = vanta_base64url_encode((string)json_encode([
        'iss' => $email,
        'sub' => $email,
        'aud' => 'https://oauth2.googleapis.com/token',
        'scope' => 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
        'iat' => $now,
        'exp' => $now + 3600,
    ], JSON_UNESCAPED_SLASHES));
    $unsigned = $header . '.' . $payload;
    $signature = '';
    if (!openssl_sign($unsigned, $signature, vanta_cursor_private_key(), OPENSSL_ALGO_SHA256)) {
        throw new RuntimeException('VANTA Cursor OAuth token signing failed.');
    }
    $assertion = $unsigned . '.' . vanta_base64url_encode($signature);
    $form = http_build_query([
        'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        'assertion' => $assertion,
    ], '', '&', PHP_QUERY_RFC3986);
    $headers = [
        'Accept: application/json',
        'Content-Type: application/x-www-form-urlencoded',
    ];
    if (function_exists('curl_init')) {
        $curl = curl_init('https://oauth2.googleapis.com/token');
        curl_setopt_array($curl, [
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_POSTFIELDS => $form,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => 15,
        ]);
        $raw = curl_exec($curl);
        $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        $message = curl_error($curl);
        curl_close($curl);
        if (!is_string($raw)) {
            throw new RuntimeException('VANTA Cursor OAuth connection failed: ' . $message);
        }
    } else {
        $context = stream_context_create(['http' => [
            'method' => 'POST',
            'header' => implode("\r\n", $headers),
            'content' => $form,
            'ignore_errors' => true,
            'timeout' => 15,
        ]]);
        $raw = file_get_contents('https://oauth2.googleapis.com/token', false, $context);
        $responseHeaders = $http_response_header ?? [];
        $status = preg_match('/\s(\d{3})\s/', (string)($responseHeaders[0] ?? ''), $matches) === 1
            ? (int)$matches[1] : 0;
        if (!is_string($raw)) {
            throw new RuntimeException('VANTA Cursor OAuth connection failed.');
        }
    }
    $decoded = json_decode($raw, true);
    if ($status !== 200 || !is_array($decoded) || !is_string($decoded['access_token'] ?? null)) {
        throw new RuntimeException('VANTA Cursor OAuth authentication failed.');
    }
    $expiresIn = max(300, min(3600, (int)($decoded['expires_in'] ?? 3600)));
    $hardExpiresAt = $now + $expiresIn;
    return [
        'token' => $decoded['access_token'],
        'refresh_at' => max($now + 60, $hardExpiresAt - 120),
        'hard_expires_at' => $hardExpiresAt,
    ];
}

function vanta_cursor_access_token(): string
{
    static $requestTokens = [];
    static $requestExpiresAt = [];
    $now = time();
    $context = vanta_server_token_context('cursor');
    if (($requestTokens[$context] ?? '') !== ''
        && ($requestExpiresAt[$context] ?? 0) > $now + 30) {
        return $requestTokens[$context];
    }
    $cacheKey = 'llnk_vanta_cursor_token_' . substr(hash('sha256', $context), 0, 20);
    $apcuAvailable = vanta_apcu_available();
    if ($apcuAvailable) {
        $success = false;
        $cached = apcu_fetch($cacheKey, $success);
        if ($success && is_array($cached) && is_string($cached['token'] ?? null)
            && (int)($cached['refresh_at'] ?? 0) > $now + 30) {
            $requestTokens[$context] = $cached['token'];
            $requestExpiresAt[$context] = (int)$cached['refresh_at'];
            return $requestTokens[$context];
        }
    }
    $accept = static function (array $value, bool $grace = false) use (
        &$requestTokens,
        &$requestExpiresAt,
        $context,
        $cacheKey,
        $apcuAvailable
    ): string {
        $now = time();
        $requestTokens[$context] = (string)$value['token'];
        $requestExpiresAt[$context] = $grace
            ? min((int)$value['hard_expires_at'], $now + 60)
            : (int)$value['refresh_at'];
        if ($apcuAvailable && !$grace) {
            apcu_store($cacheKey, $value, max(60, (int)$value['hard_expires_at'] - $now));
        }
        return $requestTokens[$context];
    };
    $handle = vanta_server_token_cache_handle($context);
    if (is_resource($handle)) {
        try {
            if (flock($handle, LOCK_SH)) {
                $cached = vanta_server_token_cache_read_locked($handle, $context);
                if (is_array($cached) && $cached['refresh_at'] > time() + 30) {
                    return $accept($cached);
                }
                flock($handle, LOCK_UN);
            } else {
                $cached = null;
            }
            if (flock($handle, LOCK_EX)) {
                $cached = vanta_server_token_cache_read_locked($handle, $context);
                if (is_array($cached) && $cached['refresh_at'] > time() + 30) {
                    return $accept($cached);
                }
                try {
                    $fresh = vanta_generate_cursor_access_token();
                } catch (Throwable $error) {
                    if (is_array($cached) && $cached['hard_expires_at'] > time() + 30) {
                        return $accept($cached, true);
                    }
                    throw $error;
                }
                try {
                    vanta_server_token_cache_write_locked($handle, $fresh, $context);
                } catch (Throwable $cacheError) {
                    error_log('VANTA Cursor token cache write failed.');
                }
                return $accept($fresh);
            }
        } finally {
            @flock($handle, LOCK_UN);
            fclose($handle);
        }
    }
    return $accept(vanta_generate_cursor_access_token());
}

function vanta_cursor_firebase_url(string $roomId, string $childPath = '', string $accessToken = ''): string
{
    if (vanta_room_id($roomId) === '') {
        throw new InvalidArgumentException('Invalid VANTA Cursor room.');
    }
    $base = rtrim(vanta_shard_config_string('LLNK_VANTA_CURSOR_FIREBASE_DATABASE_URL', 'cursor'), '/');
    $path = 'vanta/cursors/' . rawurlencode($roomId);
    $childPath = vanta_firebase_path($childPath);
    if ($childPath !== '') {
        $path .= '/' . $childPath;
    }
    $token = $accessToken !== '' ? $accessToken : vanta_cursor_access_token();
    return $base . '/' . $path . '.json?access_token=' . rawurlencode($token);
}

function vanta_cursor_firebase_request(
    string $method,
    string $roomId,
    string $childPath = '',
    $body = null,
    bool $silent = false
): array {
    $url = vanta_cursor_firebase_url($roomId, $childPath);
    if ($silent && in_array(strtoupper($method), ['PUT', 'PATCH'], true)) {
        $url .= '&print=silent';
    }
    return vanta_http_json($url, $method, $body);
}

function vanta_cursor_chat_firebase_url(string $roomId, string $childPath = '', string $accessToken = ''): string
{
    if (vanta_room_id($roomId) === '') {
        throw new InvalidArgumentException('Invalid VANTA chat room.');
    }
    $base = rtrim(vanta_shard_config_string('LLNK_VANTA_CURSOR_FIREBASE_DATABASE_URL', 'cursor'), '/');
    $path = 'vanta/chat/' . rawurlencode($roomId);
    $childPath = vanta_firebase_path($childPath);
    if ($childPath !== '') {
        $path .= '/' . $childPath;
    }
    $token = $accessToken !== '' ? $accessToken : vanta_cursor_access_token();
    return $base . '/' . $path . '.json?access_token=' . rawurlencode($token);
}

function vanta_cursor_chat_firebase_request(
    string $method,
    string $roomId,
    string $childPath = '',
    $body = null,
    bool $silent = false
): array {
    $url = vanta_cursor_chat_firebase_url($roomId, $childPath);
    if ($silent && in_array(strtoupper($method), ['PUT', 'PATCH'], true)) {
        $url .= '&print=silent';
    }
    return vanta_http_json($url, $method, $body);
}

function vanta_room_access(
    string $roomId,
    string $role,
    int $protocolVersion = 3,
    string $participantId = '',
    string $installationId = ''
): array
{
    if ($protocolVersion !== 3
        || vanta_participant_id($participantId) === ''
        || vanta_installation_id($installationId) === '') {
        throw new InvalidArgumentException('Invalid VANTA room access identity.');
    }
    // Keep the same Firebase identity when the same installation refreshes its
    // room authorization. This preserves owner-only room settings without exposing
    // the installation identifier in Firebase.
    $uid = 'vanta_' . vanta_base64url_encode(substr(hash_hmac(
        'sha256',
        'room-uid|' . $roomId . '|' . $installationId,
        vanta_config_string('LLNK_VANTA_IP_SECRET'),
        true
    ), 0, 18));
    $lifetime = defined('LLNK_VANTA_ROOM_ACCESS_SECONDS')
        ? max(300, min(86400, (int)LLNK_VANTA_ROOM_ACCESS_SECONDS))
        : 86400;
    $expiresAt = (int)round(microtime(true) * 1000) + ($lifetime * 1000);
    $access = [
        'uid' => $uid,
        'custom_token' => vanta_create_custom_token($uid, [
            'vanta_room' => $roomId,
            'vanta_role' => $role,
            'vanta_participant' => $participantId,
            'vanta_protocol' => $protocolVersion,
            'vanta_release' => VANTA_CURRENT_RELEASE,
            'vanta_sync_shard' => vanta_request_shard('sync'),
            'vanta_expires_at' => $expiresAt,
        ]),
        'expires_at' => $expiresAt,
        'sync_token' => null,
        'sync_token_expires_at' => 0,
        'release_version' => VANTA_CURRENT_RELEASE,
    ];
    $access['sync_token'] = vanta_sync_token_create(
        $roomId,
        $uid,
        $participantId,
        $installationId,
        $protocolVersion,
        $expiresAt
    );
    $access['sync_token_expires_at'] = $expiresAt;
    return $access;
}

function vanta_firebase_path(string $childPath): string
{
    $childPath = trim($childPath, '/');
    if ($childPath === '') {
        return '';
    }
    $encoded = [];
    foreach (explode('/', $childPath) as $segment) {
        if (preg_match('/^[A-Za-z0-9_-]{1,128}$/', $segment) !== 1) {
            throw new InvalidArgumentException('Invalid VANTA Firebase path.');
        }
        $encoded[] = rawurlencode($segment);
    }
    return implode('/', $encoded);
}

function vanta_firebase_session_path_request(
    string $method,
    string $roomId,
    string $childPath,
    string $idToken,
    $body = null,
    array $headers = [],
    bool $silent = false
): array {
    $roomId = vanta_room_id($roomId);
    if ($roomId === '') {
        throw new InvalidArgumentException('Invalid VANTA room id.');
    }
    $url = vanta_firebase_session_url($roomId, $childPath, $idToken, $silent);
    return vanta_http_json($url, $method, $body, $headers);
}

function vanta_firebase_session_url(
    string $roomId,
    string $childPath,
    string $idToken,
    bool $silent = false
): string {
    $roomId = vanta_room_id($roomId);
    if ($roomId === '' || $idToken === '') {
        throw new InvalidArgumentException('Invalid VANTA Firebase request.');
    }
    $base = rtrim(vanta_shard_config_string('LLNK_VANTA_FIREBASE_DATABASE_URL', 'sync'), '/');
    $path = '/vanta/v1/sessions/' . rawurlencode($roomId);
    $encodedChildPath = vanta_firebase_path($childPath);
    if ($encodedChildPath !== '') {
        $path .= '/' . $encodedChildPath;
    }
    $query = ['auth' => $idToken];
    if ($silent) {
        $query['print'] = 'silent';
    }
    return $base . $path . '.json?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986);
}

function vanta_firebase_session_request(
    string $method,
    string $roomId,
    string $idToken,
    $body = null,
    array $headers = [],
    bool $silent = false
): array {
    return vanta_firebase_session_path_request($method, $roomId, '', $idToken, $body, $headers, $silent);
}

function vanta_cors(array $methods = ['POST', 'OPTIONS']): void
{
    $origin = trim((string)($_SERVER['HTTP_ORIGIN'] ?? ''));
    $allowed = $origin === ''
        || $origin === 'https://playentry.org'
        || $origin === 'https://llnk.kr'
        || preg_match('/^chrome-extension:\/\/[a-p]{32}$/', $origin) === 1;
    if (!$allowed) {
        llnk_fail('허용되지 않은 요청 출처입니다.', 403);
    }
    if ($origin !== '') {
        header('Access-Control-Allow-Origin: ' . $origin);
    }
    header('Access-Control-Allow-Headers: Authorization, Content-Type, X-VANTA-Version, X-VANTA-Token');
    $methods = array_values(array_unique(array_map('strtoupper', $methods)));
    if (!in_array('OPTIONS', $methods, true)) {
        $methods[] = 'OPTIONS';
    }
    header('Access-Control-Allow-Methods: ' . implode(', ', $methods));
    header('Cache-Control: no-store');
    header('Vary: Origin');
    header('X-Content-Type-Options: nosniff');
    if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) === 'OPTIONS') {
        llnk_set_status(204);
        exit;
    }
}
