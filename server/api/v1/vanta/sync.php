<?php
declare(strict_types=1);

// The shared 600-per-ten-minute path limiter is intentionally lower than VANTA's
// authenticated sync budget. This endpoint applies its own 300/install and
// 1,500/IP minute limits after verifying the signed request identity.
if (!defined('LLNK_REQUEST_RATE_CHECKED')) {
    define('LLNK_REQUEST_RATE_CHECKED', true);
}
require_once dirname(__DIR__, 3) . '/llnk_lib.php';
require_once __DIR__ . '/lib.php';

function vanta_sync_rebuild_registry(PDO $pdo, string $roomId, string $serverIdToken): void
{
    vanta_sync_registry_begin_locked($pdo, $roomId);
    try {
        // This larger read is recovery-only. Normal create/join/update paths continue
        // to read participants and scalar snapshot fields separately.
        $result = vanta_firebase_session_path_request(
            'GET',
            $roomId,
            'snapshot',
            $serverIdToken
        );
        $snapshot = $result['body'];
        if ($result['status'] !== 200
            || !is_array($snapshot)
            || (int)($snapshot['syncVersion'] ?? 0) !== 2
            || (int)($snapshot['chunkVersion'] ?? 0) !== 1
            || (int)($snapshot['revision'] ?? 0) < 2
            || !is_string($snapshot['project'] ?? null)
            || $snapshot['project'] !== VANTA_CHUNK_PROJECT_MARKER) {
            throw new VantaSyncConflictException('VANTA snapshot cannot rebuild its registry.');
        }
        $chunks = vanta_validate_stored_chunks($snapshot['chunks'] ?? null);
        vanta_sync_registry_replace_locked(
            $pdo,
            $roomId,
            $chunks,
            (int)$snapshot['revision']
        );
        $pdo->commit();
    } catch (Throwable $error) {
        vanta_sync_registry_rollback($pdo);
        throw $error;
    }
}

vanta_cors();
if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'POST') {
    header('Allow: POST, OPTIONS');
    llnk_fail('POST 요청만 지원합니다.', 405);
}
vanta_require_current_client();

$declaredLength = trim((string)($_SERVER['CONTENT_LENGTH'] ?? ''));
if ($declaredLength !== ''
    && (preg_match('/^[0-9]+$/', $declaredLength) !== 1
        || (int)$declaredLength > VANTA_SYNC_INITIALIZE_MAX_BYTES)) {
    llnk_fail('VANTA 동기화 요청이 너무 큽니다.', 413);
}

$raw = file_get_contents('php://input', false, null, 0, VANTA_SYNC_INITIALIZE_MAX_BYTES + 1);
if (!is_string($raw) || $raw === '' || strlen($raw) > VANTA_SYNC_INITIALIZE_MAX_BYTES) {
    llnk_fail('VANTA 동기화 요청이 너무 크거나 비어 있습니다.', 413);
}
$input = json_decode($raw, true);
if (!is_array($input) || json_last_error() !== JSON_ERROR_NONE) {
    llnk_fail('VANTA 동기화 요청 형식이 올바르지 않습니다.', 422);
}
$action = is_string($input['action'] ?? null) ? strtolower(trim($input['action'])) : '';
if (!in_array($action, ['initialize', 'update'], true)) {
    llnk_fail('VANTA 동기화 작업이 올바르지 않습니다.', 422);
}
if ($action === 'update' && strlen($raw) > VANTA_SYNC_UPDATE_MAX_BYTES) {
    llnk_fail('VANTA 변경 요청이 너무 큽니다.', 413);
}

try {
    $commonFields = ['action', 'roomId', 'installationId', 'participantId', 'protocolVersion', 'syncToken', 'baseRevision'];
    $allowedFields = $action === 'initialize'
        ? array_merge($commonFields, ['syncVersion', 'chunkVersion', 'project', 'chunks', 'updatedBy'])
        : array_merge($commonFields, ['syncVersion', 'delta', 'updatedBy']);
    vanta_assert_allowed_keys($input, $allowedFields, 'sync request');

    $roomId = is_string($input['roomId'] ?? null) ? vanta_room_id($input['roomId']) : '';
    $installationId = is_string($input['installationId'] ?? null)
        ? vanta_installation_id($input['installationId'])
        : '';
    $participantId = is_string($input['participantId'] ?? null)
        ? vanta_participant_id($input['participantId'])
        : '';
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
    $syncToken = '';
    if ($authorization !== '') {
        if (preg_match('/^Bearer[ ]+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i', $authorization, $matches) !== 1) {
            llnk_fail('VANTA 동기화 인증 형식이 올바르지 않습니다.', 401);
        }
        $syncToken = $matches[1];
    } else {
        $syncToken = is_string($input['syncToken'] ?? null) ? trim($input['syncToken']) : '';
    }
    $baseRevision = is_int($input['baseRevision'] ?? null) ? $input['baseRevision'] : 0;
    if ($roomId === '' || $installationId === '' || $participantId === '' || $syncToken === '') {
        throw new InvalidArgumentException('VANTA 동기화 식별 정보가 올바르지 않습니다.');
    }
    if (isset($input['protocolVersion'])
        && (!is_int($input['protocolVersion']) || $input['protocolVersion'] !== 3)) {
        throw new InvalidArgumentException('지원하지 않는 VANTA 프로토콜입니다.');
    }
    if (isset($input['syncVersion'])
        && (!is_int($input['syncVersion']) || $input['syncVersion'] !== 2)) {
        throw new InvalidArgumentException('지원하지 않는 VANTA 동기화 버전입니다.');
    }
    if (isset($input['updatedBy'])
        && (!is_string($input['updatedBy']) || !hash_equals($participantId, $input['updatedBy']))) {
        throw new InvalidArgumentException('VANTA 변경 작성자가 일치하지 않습니다.');
    }

    $pdo = llnk_db();
    vanta_use_room_shards($pdo, $roomId);
    llnk_create_security_schema($pdo);
    vanta_create_usage_schema($pdo);
    $ip = llnk_client_ip();
    if ($ip === '') {
        llnk_fail('요청 주소를 확인할 수 없습니다.', 400);
    }
    $blockedFor = llnk_active_block_retry_after($pdo, 'request_abuse', $ip);
    if ($blockedFor > 0) {
        header('Retry-After: ' . $blockedFor);
        llnk_fail('차단된 요청 주소입니다.', 429);
    }

    try {
        $identity = vanta_sync_token_verify($syncToken);
    } catch (VantaSyncAuthException $error) {
        llnk_fail('VANTA 동기화 인증이 만료되었거나 올바르지 않습니다.', 401);
    }
    if (!hash_equals($identity['room_id'], $roomId)
        || !hash_equals($identity['participant_id'], $participantId)
        || !hash_equals($identity['installation_id'], $installationId)
        || (int)$identity['protocol_version'] !== 3
        || (int)$identity['release_version'] !== VANTA_CURRENT_RELEASE) {
        llnk_fail('VANTA 동기화 인증 정보가 요청과 일치하지 않습니다.', 403);
    }
    $limit = vanta_take_sync_limits($pdo, $ip, $installationId);
    if (!$limit['allowed']) {
        header('Retry-After: ' . $limit['retry_after']);
        llnk_add_security_event($pdo, 'vanta_sync_rate_limited', 'notice', 'vanta_sync', $ip, 'request_rejected', [
            'limit_scope' => $limit['scope'],
        ]);
        llnk_fail('VANTA 동기화 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', 429);
    }

    $serverIdToken = vanta_server_id_token();
    $participants = vanta_read_participants($roomId, $serverIdToken);
    $activeParticipantCount = max(1, vanta_active_participant_count($participants));
    if (!vanta_has_active_participant(
        $participants,
        $identity['uid'],
        $participantId,
        3
    )) {
        llnk_fail('활성 VANTA 참여자만 작품을 동기화할 수 있습니다.', 403);
    }
    if ((int)vanta_read_scalar($roomId, 'meta/closingUntil', $serverIdToken)
        > (int)round(microtime(true) * 1000)) {
        llnk_fail('VANTA 세션이 종료 중입니다.', 409);
    }

    if ($action === 'initialize') {
        if ($baseRevision !== 1
            || (isset($input['chunkVersion'])
                && (!is_int($input['chunkVersion']) || $input['chunkVersion'] !== 1))
            || (isset($input['project'])
                && (!is_string($input['project']) || $input['project'] !== VANTA_CHUNK_PROJECT_MARKER))) {
            throw new InvalidArgumentException('VANTA 초기화 버전이 올바르지 않습니다.');
        }
        $chunks = vanta_validate_initialize_chunks($input['chunks'] ?? null);
        $snapshot = vanta_firebase_session_path_request(
            'GET',
            $roomId,
            'snapshot',
            $serverIdToken,
            null,
            ['X-Firebase-ETag: true']
        );
        $current = $snapshot['body'];
        $etag = (string)($snapshot['headers']['etag'] ?? '');
        if ($snapshot['status'] !== 200
            || !is_array($current)
            || (int)($current['revision'] ?? 0) !== 1
            || !is_array($current['project'] ?? null)
            || ($current['project']['_vantaInitializing'] ?? null) !== true
            || $etag === '') {
            llnk_fail('VANTA 세션을 초기화할 수 없습니다.', 409);
        }
        $now = (int)round(microtime(true) * 1000);
        $changeId = bin2hex(random_bytes(12));
        $stored = [
            'syncVersion' => 2,
            'chunkVersion' => 1,
            'revision' => 2,
            'updatedAt' => $now,
            'updatedBy' => $participantId,
            'project' => VANTA_CHUNK_PROJECT_MARKER,
            'chunks' => $chunks,
            'latest' => [
                'revision' => 2,
                'changeId' => $changeId,
                'baseRevision' => 1,
                'updatedAt' => $now,
                'updatedBy' => $participantId,
                'patch' => '{"full":true}',
            ],
        ];
        $registry = vanta_sync_registry_stage_initialize($pdo, $roomId, $chunks);
        try {
            $quota = vanta_usage_reserve(
                $pdo,
                $ip,
                vanta_estimated_download_bytes((int)$registry['chunk_bytes'], 1, 65536),
                'sync',
                $roomId,
                $participantId,
                strlen($raw)
            );
            vanta_usage_require($quota);
            $written = vanta_firebase_session_path_request(
                'PUT',
                $roomId,
                'snapshot',
                $serverIdToken,
                $stored,
                ['If-Match: ' . $etag]
            );
            if ($written['status'] === 412) {
                vanta_sync_registry_rollback($pdo);
                llnk_fail('VANTA 세션이 동시에 변경되어 초기화하지 못했습니다.', 409);
            }
            if ($written['status'] !== 200) {
                vanta_sync_registry_rollback($pdo);
                throw new RuntimeException('VANTA Firebase 초기화에 실패했습니다.');
            }
            $pdo->commit();
        } catch (Throwable $error) {
            vanta_sync_registry_rollback($pdo);
            throw $error;
        }
        llnk_ok([
            'roomId' => $roomId,
            'syncVersion' => 2,
            'revision' => 2,
            'changeId' => $changeId,
            'updatedAt' => $now,
            'quota' => $quota,
        ]);
    }

    if ($baseRevision < 2) {
        throw new InvalidArgumentException('VANTA 기준 revision이 올바르지 않습니다.');
    }
    $delta = vanta_validate_update_delta($input['delta'] ?? null);
    $encodedPatch = json_encode([
        'version' => 1,
        'changes' => $delta['changes'],
        'removed' => $delta['removed'],
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if (!is_string($encodedPatch) || strlen($encodedPatch) > VANTA_SYNC_UPDATE_MAX_BYTES) {
        llnk_fail('VANTA 변경 요청이 너무 큽니다.', 413);
    }
    $estimatedDownloadBytes = vanta_estimated_download_bytes(
        strlen($encodedPatch),
        $activeParticipantCount,
        4096
    );
    if ($estimatedDownloadBytes > VANTA_SYNC_MAX_FANOUT_BYTES) {
        llnk_fail('VANTA 변경의 예상 전송량이 너무 큽니다.', 413);
    }
    $now = (int)round(microtime(true) * 1000);
    $changeId = bin2hex(random_bytes(12));
    $patch = [
        'revision' => ['.sv' => ['increment' => 1]],
        'updatedAt' => $now,
        'updatedBy' => $participantId,
        'latest/revision' => ['.sv' => ['increment' => 1]],
        'latest/changeId' => $changeId,
        'latest/baseRevision' => $baseRevision,
        'latest/updatedAt' => $now,
        'latest/updatedBy' => $participantId,
        'latest/patch' => $encodedPatch,
    ];
    foreach ($delta['changes'] as $key => $chunk) {
        $patch['chunks/' . $key] = $chunk;
    }
    foreach ($delta['removed'] as $key) {
        $patch['chunks/' . $key] = null;
    }
    $writeCompleted = false;
    for ($registryAttempt = 0; $registryAttempt < 2; $registryAttempt += 1) {
        try {
            $registry = vanta_sync_registry_stage_update(
                $pdo,
                $roomId,
                $delta['changes'],
                $delta['removed']
            );
        } catch (VantaSyncConflictException $error) {
            if ($registryAttempt !== 0) {
                throw $error;
            }
            vanta_sync_rebuild_registry($pdo, $roomId, $serverIdToken);
            continue;
        }
        try {
            $firebaseRevision = (int)vanta_read_scalar(
                $roomId,
                'snapshot/revision',
                $serverIdToken
            );
            if ($firebaseRevision !== $registry['current_revision']) {
                vanta_sync_registry_rollback($pdo);
                if ($registryAttempt !== 0) {
                    throw new VantaSyncConflictException('VANTA registry revision changed twice.');
                }
                vanta_sync_rebuild_registry($pdo, $roomId, $serverIdToken);
                continue;
            }
            if ($baseRevision > $firebaseRevision) {
                vanta_sync_registry_rollback($pdo);
                llnk_fail('VANTA 기준 revision이 현재 작품보다 큽니다.', 409);
            }
            $quota = vanta_usage_reserve(
                $pdo,
                $ip,
                $estimatedDownloadBytes,
                'sync',
                $roomId,
                $participantId,
                strlen($raw)
            );
            vanta_usage_require($quota);
            $written = vanta_firebase_session_path_request(
                'PATCH',
                $roomId,
                'snapshot',
                $serverIdToken,
                $patch,
                [],
                true
            );
            if (!in_array($written['status'], [200, 204], true)) {
                vanta_sync_registry_rollback($pdo);
                throw new RuntimeException('VANTA Firebase 변경 저장에 실패했습니다.');
            }
            $pdo->commit();
            $writeCompleted = true;
            break;
        } catch (Throwable $error) {
            vanta_sync_registry_rollback($pdo);
            throw $error;
        }
    }
    if (!$writeCompleted) {
        throw new VantaSyncConflictException('VANTA registry could not be reconciled.');
    }
    llnk_ok([
        'roomId' => $roomId,
        'syncVersion' => 2,
        'revision' => 0,
        'changeId' => $changeId,
        'updatedAt' => $now,
        'confirmed' => false,
        'quota' => $quota,
    ]);
} catch (VantaSyncConflictException $error) {
    llnk_fail('VANTA 작품 상태를 다시 연결해야 합니다.', 409);
} catch (VantaQuotaException $error) {
    if (isset($pdo) && $pdo instanceof PDO) {
        vanta_sync_registry_rollback($pdo);
    }
    header('Retry-After: ' . vanta_quota_retry_after($quota));
    header('X-VANTA-Tokens-Remaining: 0');
    llnk_fail(vanta_quota_exhausted_message($quota), 429);
} catch (InvalidArgumentException $error) {
    llnk_fail($error->getMessage(), 422);
} catch (Throwable $error) {
    error_log('VANTA sync API: ' . $error->getMessage());
    llnk_fail('VANTA 동기화 서버를 사용할 수 없습니다.', 503);
}
