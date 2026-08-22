<?php
declare(strict_types=1);

require_once dirname(__DIR__, 3) . '/llnk_lib.php';
require_once __DIR__ . '/lib.php';

vanta_cors();
if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'POST') {
    header('Allow: POST, OPTIONS');
    llnk_fail('POST requests only.', 405);
}
vanta_require_current_client();

$declaredLength = trim((string)($_SERVER['CONTENT_LENGTH'] ?? ''));
if ($declaredLength !== ''
    && (preg_match('/^[0-9]+$/', $declaredLength) !== 1
        || (int)$declaredLength > VANTA_CONTROL_MAX_REQUEST_BYTES)) {
    llnk_fail('VANTA gateway request is too large.', 413);
}
$raw = file_get_contents('php://input', false, null, 0, VANTA_CONTROL_MAX_REQUEST_BYTES + 1);
if (!is_string($raw) || $raw === '' || strlen($raw) > VANTA_CONTROL_MAX_REQUEST_BYTES) {
    llnk_fail('VANTA gateway request is empty or too large.', 413);
}
$input = json_decode($raw, true);
if (!is_array($input) || json_last_error() !== JSON_ERROR_NONE) {
    llnk_fail('Invalid VANTA gateway request.', 422);
}

function vanta_gateway_profile_color($value): string
{
    $color = strtoupper(trim((string)$value));
    return preg_match('/^#[0-9A-F]{6}$/', $color) === 1 ? $color : '#7351FF';
}

function vanta_gateway_active_participants($value, int $now): array
{
    $participants = [];
    foreach (is_array($value) ? $value : [] as $slot => $participant) {
        if (preg_match('/^[0-4]$/', (string)$slot) !== 1
            || !is_array($participant)
            || (int)($participant['expiresAt'] ?? 0) <= $now) {
            continue;
        }
        $participants[(string)$slot] = $participant;
    }
    return $participants;
}

function vanta_gateway_read_participants_with_etag(
    string $roomId,
    string $serverIdToken
): array {
    $result = vanta_firebase_session_path_request(
        'GET',
        $roomId,
        'participants',
        $serverIdToken,
        null,
        ['X-Firebase-ETag: true']
    );
    $etag = (string)($result['headers']['etag'] ?? '');
    if ($result['status'] !== 200 || $etag === '') {
        throw new RuntimeException('Could not read VANTA participants.');
    }
    return ['participants' => is_array($result['body']) ? $result['body'] : [], 'etag' => $etag];
}

function vanta_gateway_acquire(
    string $roomId,
    array $identity,
    string $participantId,
    string $name,
    string $color,
    string $serverIdToken
): array {
    $metaResult = vanta_firebase_session_path_request('GET', $roomId, 'meta', $serverIdToken);
    $meta = is_array($metaResult['body']) ? $metaResult['body'] : [];
    if ($metaResult['status'] !== 200
        || (int)($meta['releaseVersion'] ?? 0) !== VANTA_CURRENT_RELEASE
        || (int)($meta['closingUntil'] ?? 0) > (int)round(microtime(true) * 1000)) {
        throw new VantaSyncConflictException('VANTA room is unavailable.');
    }
    $maxParticipants = max(2, min(5, (int)($meta['maxParticipants'] ?? 5)));
    for ($attempt = 0; $attempt < 5; $attempt += 1) {
        $read = vanta_gateway_read_participants_with_etag($roomId, $serverIdToken);
        $now = (int)round(microtime(true) * 1000);
        $participants = vanta_gateway_active_participants($read['participants'], $now);
        $slot = null;
        foreach ($participants as $candidate => $participant) {
            if (hash_equals((string)($participant['uid'] ?? ''), (string)$identity['uid'])) {
                $slot = (string)$candidate;
                break;
            }
        }
        if ($slot === null) {
            for ($index = 0; $index < $maxParticipants; $index += 1) {
                if (!isset($participants[(string)$index])) {
                    $slot = (string)$index;
                    break;
                }
            }
        }
        if ($slot === null) {
            throw new VantaSyncConflictException('VANTA room is full.');
        }
        $joinedAt = (int)($participants[$slot]['joinedAt'] ?? $now);
        $participants[$slot] = [
            'uid' => (string)$identity['uid'],
            'participantId' => $participantId,
            'protocolVersion' => 3,
            'releaseVersion' => VANTA_CURRENT_RELEASE,
            'name' => $name,
            'color' => $color,
            'joinedAt' => $joinedAt,
            'expiresAt' => $now + 45000,
        ];
        ksort($participants, SORT_NUMERIC);
        $write = vanta_firebase_session_path_request(
            'PUT',
            $roomId,
            'participants',
            $serverIdToken,
            $participants,
            ['If-Match: ' . $read['etag']]
        );
        if (in_array($write['status'], [200, 204], true)) {
            return [
                'slot' => $slot,
                'maxParticipants' => $maxParticipants,
                'participants' => $participants,
                'ownerUid' => (string)($meta['ownerUid'] ?? ''),
                'expiresAt' => $now + 45000,
            ];
        }
        if ($write['status'] !== 412) {
            throw new RuntimeException('Could not update VANTA participants.');
        }
    }
    throw new VantaSyncConflictException('VANTA participants changed concurrently.');
}

$roomId = '';
$participantId = '';
$acquiredSlot = '';
$serverIdToken = '';
try {
    vanta_assert_allowed_keys(
        $input,
        ['action', 'roomId', 'installationId', 'participantId', 'syncToken', 'name', 'color', 'slot'],
        'gateway request'
    );
    $action = strtolower(trim((string)($input['action'] ?? '')));
    $roomId = vanta_room_id((string)($input['roomId'] ?? ''));
    $installationId = vanta_installation_id((string)($input['installationId'] ?? ''));
    $participantId = vanta_participant_id((string)($input['participantId'] ?? ''));
    if (!in_array($action, ['session', 'revision', 'acquire', 'heartbeat', 'release'], true)
        || $roomId === '' || $installationId === '' || $participantId === '') {
        throw new InvalidArgumentException('Invalid VANTA gateway identity.');
    }
    $identity = vanta_assert_sync_identity(
        vanta_request_sync_token($input),
        $roomId,
        $participantId,
        $installationId
    );
    $pdo = llnk_db();
    vanta_use_room_shards($pdo, $roomId);
    llnk_create_security_schema($pdo);
    vanta_create_room_registry_schema($pdo);
    $ip = llnk_client_ip();
    if ($ip === '') {
        llnk_fail('Request address could not be verified.', 400);
    }
    $blockedFor = llnk_active_block_retry_after($pdo, 'request_abuse', $ip);
    if ($blockedFor > 0) {
        header('Retry-After: ' . $blockedFor);
        llnk_fail('This request address is temporarily blocked.', 429);
    }
    $limit = vanta_take_gateway_limits(
        $pdo,
        $ip,
        $installationId,
        $roomId,
        $participantId,
        $action
    );
    if (!$limit['allowed']) {
        header('Retry-After: ' . $limit['retry_after']);
        llnk_add_security_event(
            $pdo,
            'vanta_gateway_rate_limited',
            'notice',
            'vanta_gateway',
            $ip,
            'request_rejected',
            ['action' => $action, 'limit_scope' => $limit['scope']]
        );
        llnk_fail('VANTA real-time requests are temporarily limited.', 429);
    }
    $serverIdToken = vanta_server_id_token();

    if ($action === 'acquire' || $action === 'heartbeat') {
        $displayName = vanta_chat_display_name($input['name'] ?? 'Participant');
        $result = vanta_gateway_acquire(
            $roomId,
            $identity,
            $participantId,
            vanta_chat_display_name($input['name'] ?? '참여자'),
            vanta_gateway_profile_color($input['color'] ?? '#7351FF'),
            $serverIdToken
        );
        $acquiredSlot = (string)($result['slot'] ?? '');
        $quota = vanta_presence_touch(
            $pdo,
            $ip,
            $roomId,
            $participantId,
            $installationId,
            $displayName
        );
        $result['quota'] = $quota;
        header('X-VANTA-Tokens-Remaining: ' . (string)$quota['remaining_tokens']);
        vanta_register_room($pdo, $roomId);
        llnk_ok($result);
    }

    $participants = vanta_read_participants($roomId, $serverIdToken);
    if (!vanta_has_active_participant($participants, $identity['uid'], $participantId, 3)) {
        llnk_fail('Active VANTA participants only.', 403);
    }

    if ($action === 'release') {
        $slot = preg_match('/^[0-4]$/', (string)($input['slot'] ?? '')) === 1
            ? (string)$input['slot'] : '';
        if ($slot !== '') {
            $stored = is_array($participants[$slot] ?? null) ? $participants[$slot] : null;
            if ($stored
                && hash_equals((string)($stored['uid'] ?? ''), (string)$identity['uid'])
                && hash_equals((string)($stored['participantId'] ?? ''), $participantId)) {
                vanta_firebase_session_path_request(
                    'DELETE',
                    $roomId,
                    'participants/' . $slot,
                    $serverIdToken,
                    null,
                    [],
                    true
                );
                unset($participants[$slot]);
            }
        }
        $activeParticipants = vanta_gateway_active_participants(
            $participants,
            (int)round(microtime(true) * 1000)
        );
        if (vanta_cursor_firebase_configured()) {
            vanta_cursor_firebase_request('DELETE', $roomId, $participantId);
            if (count($activeParticipants) === 0) {
                vanta_cursor_firebase_request('DELETE', $roomId);
                vanta_cursor_chat_firebase_request('DELETE', $roomId);
            }
        }
        llnk_ok([
            'released' => true,
            'empty' => count($activeParticipants) === 0,
            'participants' => $activeParticipants,
        ]);
    }

    if ($action === 'revision') {
        vanta_require_active_presence($pdo, $roomId, $participantId, $installationId);
        llnk_ok(['revision' => (int)vanta_read_scalar($roomId, 'snapshot/revision', $serverIdToken)]);
    }

    vanta_require_active_presence($pdo, $roomId, $participantId, $installationId);
    $roomChunkBytes = vanta_usage_room_chunk_bytes($pdo, $roomId);
    $sessionMissing = false;
    $pdo->beginTransaction();
    try {
        $quota = vanta_usage_reserve(
            $pdo,
            $ip,
            vanta_estimated_download_bytes(
                $roomChunkBytes,
                1,
                65536
            ),
            'join',
            $roomId,
            $participantId,
            strlen($raw)
        );
        vanta_usage_require($quota);
        $meta = vanta_firebase_session_path_request('GET', $roomId, 'meta', $serverIdToken);
        $snapshot = vanta_firebase_session_path_request('GET', $roomId, 'snapshot', $serverIdToken);
        $sessionMissing = $meta['status'] !== 200 || $snapshot['status'] !== 200
            || !is_array($meta['body']) || !is_array($snapshot['body']);
        if ($sessionMissing) $pdo->rollBack();
        else $pdo->commit();
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $error;
    }
    if ($sessionMissing) {
        llnk_fail('VANTA session was not found.', 404);
    }
    header('X-VANTA-Tokens-Remaining: ' . (string)$quota['remaining_tokens']);
    llnk_ok(['session' => ['meta' => $meta['body'], 'snapshot' => $snapshot['body']]]);
} catch (VantaQuotaException $error) {
    if ($acquiredSlot !== '' && $serverIdToken !== '' && $roomId !== '') {
        try {
            vanta_firebase_session_path_request(
                'DELETE',
                $roomId,
                'participants/' . $acquiredSlot,
                $serverIdToken,
                null,
                [],
                true
            );
        } catch (Throwable $cleanupError) {
            error_log('[LLNKKR VANTA gateway cleanup] ' . $cleanupError->getMessage());
        }
    }
    $quota = $error->quota();
    header('Retry-After: ' . vanta_quota_retry_after($quota));
    header('X-VANTA-Tokens-Remaining: 0');
    llnk_fail(vanta_quota_exhausted_message($quota), 429);
} catch (VantaSyncAuthException $error) {
    llnk_fail('VANTA authorization expired or is invalid.', 401);
} catch (VantaSyncConflictException $error) {
    llnk_fail($error->getMessage(), 409);
} catch (InvalidArgumentException $error) {
    llnk_fail($error->getMessage(), 422);
} catch (Throwable $error) {
    error_log('[LLNKKR VANTA gateway] ' . $error->getMessage());
    llnk_fail('VANTA gateway is unavailable.', 503);
}
