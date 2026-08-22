<?php
declare(strict_types=1);

require_once dirname(__DIR__, 3) . '/llnk_lib.php';
require_once __DIR__ . '/lib.php';

vanta_cors();
if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'POST') {
    header('Allow: POST, OPTIONS');
    llnk_fail('POST 요청만 지원합니다.', 405);
}
vanta_require_current_client();

$declaredLength = trim((string)($_SERVER['CONTENT_LENGTH'] ?? ''));
if ($declaredLength !== ''
    && (preg_match('/^[0-9]+$/', $declaredLength) !== 1
        || (int)$declaredLength > VANTA_CONTROL_MAX_REQUEST_BYTES)) {
    llnk_fail('VANTA 방 요청이 너무 큽니다.', 413);
}
$raw = file_get_contents('php://input', false, null, 0, VANTA_CONTROL_MAX_REQUEST_BYTES + 1);
if (!is_string($raw) || $raw === '' || strlen($raw) > VANTA_CONTROL_MAX_REQUEST_BYTES) {
    llnk_fail('VANTA 방 요청이 너무 크거나 비어 있습니다.', 413);
}
$input = json_decode($raw, true);
if (!is_array($input) || json_last_error() !== JSON_ERROR_NONE) {
    llnk_fail('VANTA 방 요청 형식이 올바르지 않습니다.', 422);
}

try {
    $action = strtolower(trim((string)($input['action'] ?? '')));
    $roomId = vanta_room_id((string)($input['roomId'] ?? ''));
    $installationId = vanta_installation_id((string)($input['installationId'] ?? ''));
    $participantId = vanta_participant_id((string)($input['participantId'] ?? ''));
    $protocolVersion = (int)($input['protocolVersion'] ?? 0);
    $maxParticipants = $action === 'create' ? (int)($input['maxParticipants'] ?? 5) : 5;
    if (!in_array($action, ['create', 'join', 'close'], true)
        || $roomId === ''
        || $installationId === ''
        || $protocolVersion !== 3
        || ($action === 'create' && $participantId === '')
        || ($action === 'create' && ($maxParticipants < 2 || $maxParticipants > 5))
        || ($action === 'join' && $participantId === '')) {
        llnk_fail('VANTA 방 요청이 올바르지 않습니다.', 422);
    }

    $pdo = llnk_db();
    llnk_create_security_schema($pdo);
    vanta_create_usage_schema($pdo);
    if ($action === 'create') {
        $roomShards = vanta_new_room_shards($pdo);
        vanta_set_request_shards($roomShards['sync'], $roomShards['cursor']);
    } else {
        $roomShards = vanta_use_room_shards($pdo, $roomId);
    }
    $ip = llnk_client_ip();
    if ($ip === '') {
        llnk_fail('요청 주소를 확인할 수 없습니다.', 400);
    }

    if ($action === 'create') {
        $limit = vanta_take_create_limits($pdo, $ip, $installationId);
        if (!$limit['allowed']) {
            header('Retry-After: ' . $limit['retry_after']);
            llnk_add_security_event($pdo, 'vanta_create_rate_limited', 'notice', 'vanta_create', $ip, 'request_rejected', [
                'limit_scope' => $limit['scope'],
            ]);
            llnk_fail($limit['scope'] === 'vanta_create_install_daily'
                ? '오늘 만들 수 있는 VANTA 방을 모두 사용했습니다.'
                : 'VANTA 방을 너무 많이 만들고 있습니다. 잠시 후 다시 시도해 주세요.', 429);
        }
        $quota = vanta_usage_reserve(
            $pdo,
            $ip,
            65536,
            'create',
            $roomId,
            $participantId,
            max(0, (int)($_SERVER['CONTENT_LENGTH'] ?? 0))
        );
        vanta_usage_require($quota);
    } elseif ($action === 'join' && !vanta_take_join_limits($pdo, $ip, $installationId)) {
        header('Retry-After: 60');
        llnk_fail('VANTA 연결 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', 429);
    } elseif ($action === 'close' && !vanta_take_close_limits($pdo, $ip, $installationId)) {
        header('Retry-After: 60');
        llnk_fail('VANTA 종료 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', 429);
    }

    $serverIdToken = vanta_server_id_token();
    if ($action !== 'close') {
        try {
            vanta_cleanup_empty_rooms($pdo, $serverIdToken);
        } catch (Throwable $cleanupError) {
            error_log('VANTA scheduled cleanup: ' . $cleanupError->getMessage());
        }
        vanta_set_request_shards($roomShards['sync'], $roomShards['cursor']);
        $serverIdToken = vanta_server_id_token();
    }

    if ($action === 'close') {
        $participants = vanta_read_participants($roomId, $serverIdToken);
        $activeParticipants = vanta_active_participant_count($participants);
        $closed = vanta_delete_room_if_empty($pdo, $roomId, $serverIdToken, $participants);
        llnk_ok([
            'roomId' => $roomId,
            'closed' => $closed,
            'participantCount' => $closed ? 0 : $activeParticipants,
        ]);
    }

    if ($action === 'join') {
        $releaseVersion = (int)vanta_read_scalar($roomId, 'meta/releaseVersion', $serverIdToken);
        if ($releaseVersion !== VANTA_CURRENT_RELEASE) {
            llnk_fail('최신 VANTA에서 만든 방만 연결할 수 있습니다.', 426);
        }
        $closingUntil = (int)vanta_read_scalar($roomId, 'meta/closingUntil', $serverIdToken);
        if ($closingUntil > (int)round(microtime(true) * 1000)) {
            llnk_fail('VANTA 세션이 종료 중입니다.', 409);
        }
        $revision = (int)vanta_read_scalar($roomId, 'snapshot/revision', $serverIdToken);
        if ($revision <= 0) {
            llnk_fail('VANTA 세션을 찾을 수 없습니다.', 404);
        }
        if ($revision === 1) {
            llnk_fail('VANTA 세션을 준비하고 있습니다. 잠시 후 다시 시도해 주세요.', 409);
        }
        $syncVersion = (int)vanta_read_scalar($roomId, 'snapshot/syncVersion', $serverIdToken);
        if ($syncVersion !== 2) {
            llnk_fail('지원되지 않는 VANTA 세션입니다.', 426);
        }
        $chunkVersion = (int)vanta_read_scalar($roomId, 'snapshot/chunkVersion', $serverIdToken);
        $projectMarker = vanta_read_scalar($roomId, 'snapshot/project', $serverIdToken);
        if ($chunkVersion !== 1 || !is_string($projectMarker) || $projectMarker !== VANTA_CHUNK_PROJECT_MARKER) {
            llnk_fail('손상된 VANTA 세션입니다.', 409);
        }
        $participants = vanta_read_participants($roomId, $serverIdToken);
        if (vanta_active_participant_count($participants) === 0) {
            vanta_delete_room_if_empty($pdo, $roomId, $serverIdToken, $participants);
            llnk_fail('종료된 VANTA 세션입니다.', 404);
        }
        if ((int)vanta_read_scalar($roomId, 'meta/closingUntil', $serverIdToken)
            > (int)round(microtime(true) * 1000)) {
            llnk_fail('VANTA 세션이 종료 중입니다.', 409);
        }
        vanta_register_room($pdo, $roomId);
        $quota = vanta_usage_reserve(
            $pdo,
            $ip,
            1,
            'join',
            $roomId,
            $participantId,
            max(0, (int)($_SERVER['CONTENT_LENGTH'] ?? 0))
        );
        vanta_usage_require($quota);
        $access = vanta_room_access($roomId, 'member', $protocolVersion, $participantId, $installationId);
        $response = [
            'roomId' => $roomId,
            'uid' => $access['uid'],
            'roomAccessExpiresAt' => $access['expires_at'],
            'releaseVersion' => $access['release_version'],
            'quota' => $quota,
        ];
        if (is_string($access['sync_token'])) {
            $response['syncToken'] = $access['sync_token'];
            $response['syncTokenExpiresAt'] = $access['sync_token_expires_at'];
        }
        llnk_ok($response);
    }

    $access = vanta_room_access($roomId, 'owner', $protocolVersion, $participantId, $installationId);
    $now = (int)round(microtime(true) * 1000);
    $remote = [
        'meta' => [
            'version' => 1,
            'releaseVersion' => VANTA_CURRENT_RELEASE,
            'ownerUid' => $access['uid'],
            'createdAt' => $now,
            'maxParticipants' => $maxParticipants,
            'liveCursor' => true,
            'closingUntil' => 0,
        ],
        'snapshot' => [
            'revision' => 1,
            'updatedAt' => $now,
            'updatedBy' => $participantId,
            // Firebase removes empty arrays/objects. Keep the initialization snapshot non-empty
            // until the extension writes the real Entry project as revision 2.
            'project' => ['_vantaInitializing' => true],
        ],
        'participants' => [
            '0' => [
                'uid' => $access['uid'],
                'participantId' => $participantId,
                'protocolVersion' => $protocolVersion,
                'releaseVersion' => VANTA_CURRENT_RELEASE,
                'joinedAt' => $now,
                'expiresAt' => $now + 60000,
            ],
        ],
    ];
    $created = vanta_firebase_session_request(
        'PUT',
        $roomId,
        $serverIdToken,
        $remote,
        ['If-Match: null_etag']
    );
    if ($created['status'] === 412) {
        llnk_fail('이미 사용 중인 VANTA 링크입니다.', 409);
    }
    if ($created['status'] !== 200) {
        throw new RuntimeException('VANTA Firebase 방 생성에 실패했습니다.');
    }
    vanta_register_room($pdo, $roomId, $roomShards['sync'], $roomShards['cursor']);
    $response = [
        'roomId' => $roomId,
        'uid' => $access['uid'],
        'roomAccessExpiresAt' => $access['expires_at'],
        'releaseVersion' => $access['release_version'],
        'quota' => $quota,
    ];
    if (is_string($access['sync_token'])) {
        $response['syncToken'] = $access['sync_token'];
        $response['syncTokenExpiresAt'] = $access['sync_token_expires_at'];
    }
    llnk_ok($response);
} catch (InvalidArgumentException $error) {
    llnk_fail($error->getMessage(), 422);
} catch (VantaQuotaException $error) {
    header('Retry-After: ' . vanta_quota_retry_after($quota));
    header('X-VANTA-Tokens-Remaining: 0');
    llnk_fail(vanta_quota_exhausted_message($quota), 429);
} catch (Throwable $error) {
    error_log('VANTA sessions API: ' . $error->getMessage());
    llnk_fail('VANTA 방 서버를 사용할 수 없습니다.', 503);
}
