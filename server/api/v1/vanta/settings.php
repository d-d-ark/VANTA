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
    llnk_fail('VANTA 방 설정 요청이 너무 큽니다.', 413);
}
$raw = file_get_contents('php://input', false, null, 0, VANTA_CONTROL_MAX_REQUEST_BYTES + 1);
if (!is_string($raw) || $raw === '' || strlen($raw) > VANTA_CONTROL_MAX_REQUEST_BYTES) {
    llnk_fail('VANTA 방 설정 요청이 너무 크거나 비어 있습니다.', 413);
}
$input = json_decode($raw, true);
if (!is_array($input) || json_last_error() !== JSON_ERROR_NONE) {
    llnk_fail('VANTA 방 설정 요청 형식이 올바르지 않습니다.', 422);
}

try {
    vanta_assert_allowed_keys(
        $input,
        ['action', 'roomId', 'installationId', 'participantId', 'syncToken', 'maxParticipants', 'liveCursor'],
        'settings request'
    );
    $action = strtolower(trim((string)($input['action'] ?? 'get')));
    $roomId = vanta_room_id((string)($input['roomId'] ?? ''));
    $installationId = vanta_installation_id((string)($input['installationId'] ?? ''));
    $participantId = vanta_participant_id((string)($input['participantId'] ?? ''));
    if (!in_array($action, ['get', 'update'], true)
        || $roomId === '' || $installationId === '' || $participantId === '') {
        throw new InvalidArgumentException('VANTA 방 설정 요청이 올바르지 않습니다.');
    }

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
            llnk_fail('VANTA 방 설정 인증 형식이 올바르지 않습니다.', 401);
        }
        $syncToken = $matches[1];
    } elseif (is_string($input['syncToken'] ?? null)) {
        $syncToken = trim($input['syncToken']);
    }
    if ($syncToken === '') llnk_fail('VANTA 방 설정 인증이 필요합니다.', 401);

    try {
        $identity = vanta_sync_token_verify($syncToken);
    } catch (VantaSyncAuthException $error) {
        llnk_fail('VANTA 방 설정 인증이 만료되었거나 올바르지 않습니다.', 401);
    }
    if (!hash_equals($identity['room_id'], $roomId)
        || !hash_equals($identity['participant_id'], $participantId)
        || !hash_equals($identity['installation_id'], $installationId)
        || (int)$identity['protocol_version'] !== 3
        || (int)$identity['release_version'] !== VANTA_CURRENT_RELEASE) {
        llnk_fail('VANTA 방 설정 인증 정보가 요청과 일치하지 않습니다.', 403);
    }

    $pdo = llnk_db();
    vanta_use_room_shards($pdo, $roomId);
    $serverIdToken = vanta_server_id_token();
    $participants = vanta_read_participants($roomId, $serverIdToken);
    if (!vanta_has_active_participant($participants, $identity['uid'], $participantId, 3)) {
        llnk_fail('활성 VANTA 참여자만 방 설정을 확인할 수 있습니다.', 403);
    }
    $ownerUid = (string)vanta_read_scalar($roomId, 'meta/ownerUid', $serverIdToken);
    $isOwner = $ownerUid !== '' && hash_equals($ownerUid, (string)$identity['uid']);
    $maxParticipants = max(2, min(5, (int)vanta_read_scalar(
        $roomId,
        'meta/maxParticipants',
        $serverIdToken
    )));
    $liveCursor = vanta_read_scalar($roomId, 'meta/liveCursor', $serverIdToken) === true;

    if ($action === 'update') {
        $hasMaxParticipants = array_key_exists('maxParticipants', $input);
        $hasLiveCursor = array_key_exists('liveCursor', $input);
        if (!$hasMaxParticipants && !$hasLiveCursor) {
            throw new InvalidArgumentException('변경할 VANTA 방 설정이 필요합니다.');
        }
        if (!$isOwner) llnk_fail('방을 만든 사람만 방 설정을 변경할 수 있습니다.', 403);

        $patch = [];
        if ($hasMaxParticipants) {
            $requested = (int)$input['maxParticipants'];
            if ($requested < 2 || $requested > 5) {
                throw new InvalidArgumentException('최대 인원은 2명부터 5명까지 설정할 수 있습니다.');
            }
            $activeCount = vanta_active_participant_count($participants);
            $minimumForActiveSlots = 2;
            $nowMs = (int)round(microtime(true) * 1000);
            foreach (vanta_participant_list($participants) as $slot => $participant) {
                if (preg_match('/^[0-4]$/', (string)$slot) === 1
                    && is_array($participant)
                    && (int)($participant['expiresAt'] ?? 0) > $nowMs) {
                    $minimumForActiveSlots = max($minimumForActiveSlots, (int)$slot + 1);
                }
            }
            if ($requested < max($activeCount, $minimumForActiveSlots)) {
                llnk_fail('현재 참여 인원보다 작게 설정할 수 없습니다.', 409);
            }
            $patch['maxParticipants'] = $requested;
        }

        if ($hasLiveCursor) {
            if (!is_bool($input['liveCursor'])) {
                throw new InvalidArgumentException('Live 커서 설정이 올바르지 않습니다.');
            }
            $requestedLiveCursor = $input['liveCursor'];
            if ($requestedLiveCursor && !$liveCursor) {
                if (!vanta_cursor_direct_enabled($pdo)) {
                    llnk_fail('현재 Live 커서를 사용할 수 없습니다.', 503);
                }
                $nowMs = (int)round(microtime(true) * 1000);
                $activeParticipantIds = [];
                foreach (vanta_participant_list($participants) as $participant) {
                    if (is_array($participant) && (int)($participant['expiresAt'] ?? 0) > $nowMs) {
                        $activeParticipantIds[(string)($participant['participantId'] ?? '')] = true;
                    }
                }
                $presenceQuery = $pdo->prepare(
                    'SELECT participant_id, ip_address FROM llnk_vanta_presence
                     WHERE room_id = ? AND expires_at > NOW()'
                );
                $presenceQuery->execute([$roomId]);
                $presenceByParticipant = [];
                foreach ($presenceQuery->fetchAll(PDO::FETCH_ASSOC) ?: [] as $presenceRow) {
                    $presenceByParticipant[(string)$presenceRow['participant_id']] = (string)$presenceRow['ip_address'];
                }
                foreach (array_keys($activeParticipantIds) as $activeParticipantId) {
                    $participantIp = $presenceByParticipant[$activeParticipantId] ?? '';
                    if ($participantIp === '') {
                        llnk_fail('모든 참여자의 연결 확인 후 Live 커서를 켤 수 있습니다.', 409);
                    }
                    $participantQuota = vanta_usage_status($pdo, $participantIp);
                    if (($participantQuota['paused'] ?? false) === true
                        || (float)($participantQuota['remaining_tokens'] ?? 0) < 1) {
                        llnk_fail('토큰이 부족한 참여자가 있어 Live 커서를 켤 수 없습니다.', 409);
                    }
                }
            }
            $patch['liveCursor'] = $requestedLiveCursor;
        }

        $updated = vanta_firebase_session_path_request(
            'PATCH',
            $roomId,
            'meta',
            $serverIdToken,
            $patch
        );
        if ($updated['status'] !== 200) {
            throw new RuntimeException('VANTA 방 설정 저장에 실패했습니다.');
        }
        if (isset($patch['maxParticipants'])) $maxParticipants = (int)$patch['maxParticipants'];
        if (array_key_exists('liveCursor', $patch)) $liveCursor = $patch['liveCursor'] === true;
    }

    llnk_ok([
        'maxParticipants' => $maxParticipants,
        'liveCursor' => $liveCursor,
        'isOwner' => $isOwner,
    ]);
} catch (InvalidArgumentException $error) {
    llnk_fail($error->getMessage(), 422);
} catch (Throwable $error) {
    error_log('[LLNKKR VANTA settings] ' . $error->getMessage());
    llnk_fail('VANTA 방 설정을 처리하지 못했습니다.', 503);
}
