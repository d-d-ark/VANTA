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
        || (int)$declaredLength > VANTA_CHAT_MAX_REQUEST_BYTES)) {
    llnk_fail('채팅 요청이 너무 큽니다.', 413);
}
$raw = file_get_contents('php://input', false, null, 0, VANTA_CHAT_MAX_REQUEST_BYTES + 1);
if (!is_string($raw) || $raw === '' || strlen($raw) > VANTA_CHAT_MAX_REQUEST_BYTES) {
    llnk_fail('채팅 요청이 너무 크거나 비어 있습니다.', 413);
}
$input = json_decode($raw, true);
if (!is_array($input) || json_last_error() !== JSON_ERROR_NONE) {
    llnk_fail('채팅 요청 형식이 올바르지 않습니다.', 422);
}

try {
    vanta_assert_allowed_keys($input, ['roomId', 'installationId', 'participantId', 'syncToken', 'text'], 'chat request');
    $roomId = is_string($input['roomId'] ?? null) ? vanta_room_id($input['roomId']) : '';
    $installationId = is_string($input['installationId'] ?? null)
        ? vanta_installation_id($input['installationId'])
        : '';
    $participantId = is_string($input['participantId'] ?? null)
        ? vanta_participant_id($input['participantId'])
        : '';
    $text = vanta_chat_text($input['text'] ?? null);

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
            llnk_fail('VANTA 채팅 인증 형식이 올바르지 않습니다.', 401);
        }
        $syncToken = $matches[1];
    } else {
        $syncToken = is_string($input['syncToken'] ?? null) ? trim($input['syncToken']) : '';
    }
    if ($roomId === '' || $installationId === '' || $participantId === '' || $syncToken === '' || $text === '') {
        llnk_fail('채팅 메시지는 최대 100자, 3줄까지 보낼 수 있습니다.', 422);
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
        llnk_fail('VANTA 채팅 인증이 만료되었거나 올바르지 않습니다.', 401);
    }
    if (!hash_equals($identity['room_id'], $roomId)
        || !hash_equals($identity['participant_id'], $participantId)
        || !hash_equals($identity['installation_id'], $installationId)
        || (int)$identity['protocol_version'] !== 3
        || (int)$identity['release_version'] !== VANTA_CURRENT_RELEASE) {
        llnk_fail('VANTA 채팅 인증 정보가 요청과 일치하지 않습니다.', 403);
    }

    $serverIdToken = vanta_server_id_token();
    $participants = vanta_read_participants($roomId, $serverIdToken);
    if (!vanta_has_active_participant($participants, $identity['uid'], $participantId, 3)) {
        llnk_fail('활성 VANTA 참여자만 채팅할 수 있습니다.', 403);
    }
    if ((int)vanta_read_scalar($roomId, 'meta/closingUntil', $serverIdToken)
        > (int)round(microtime(true) * 1000)) {
        llnk_fail('VANTA 세션이 종료 중입니다.', 409);
    }

    $name = '참여자';
    foreach (vanta_participant_list($participants) as $participant) {
        if (is_array($participant)
            && hash_equals((string)($participant['uid'] ?? ''), $identity['uid'])
            && hash_equals((string)($participant['participantId'] ?? ''), $participantId)) {
            $name = vanta_chat_display_name($participant['name'] ?? '참여자');
            break;
        }
    }

    $limit = vanta_take_chat_limits($pdo, $roomId, $participantId);
    if (!$limit['allowed']) {
        header('Retry-After: ' . $limit['retry_after']);
        llnk_add_security_event($pdo, 'vanta_chat_rate_limited', 'notice', 'vanta_chat', $ip, 'request_rejected', [
            'limit_scope' => $limit['scope'],
        ]);
        llnk_fail('채팅을 너무 빠르게 보내고 있습니다. 잠시 후 다시 보내 주세요.', 429);
    }
    $quota = vanta_usage_reserve(
        $pdo,
        $ip,
        vanta_estimated_download_bytes(
            strlen($text) + 512,
            max(1, vanta_active_participant_count($participants)),
            4096
        ),
        'chat',
        $roomId,
        $participantId,
        strlen($raw)
    );
    vanta_usage_require($quota);

    $message = [
        'id' => bin2hex(random_bytes(12)),
        'participantId' => $participantId,
        'name' => $name,
        'text' => $text,
        'at' => (int)round(microtime(true) * 1000),
    ];
    $sequence = vanta_next_chat_sequence($pdo, $roomId);
    $message['sequence'] = $sequence;
    $slot = (string)(($sequence - 1) % 20);
    $write = vanta_cursor_chat_firebase_request(
        'PUT',
        $roomId,
        'messages/' . $slot,
        $message,
        true
    );
    if (in_array($write['status'], [200, 204], true)) {
        try {
            vanta_archive_chat_message($pdo, $roomId, $message);
        } catch (Throwable $archiveError) {
            // Chat delivery must remain available even if the archive database is
            // temporarily unavailable. The failure is retained in the server log.
            error_log('[LLNKKR VANTA chat archive] ' . $archiveError->getMessage());
        }
        llnk_ok(['message' => $message, 'quota' => $quota]);
    }
    throw new RuntimeException('채팅 메시지를 저장하지 못했습니다.');
} catch (InvalidArgumentException $error) {
    llnk_fail($error->getMessage(), 422);
} catch (VantaQuotaException $error) {
    header('Retry-After: ' . vanta_quota_retry_after($quota));
    header('X-VANTA-Tokens-Remaining: 0');
    llnk_fail(vanta_quota_exhausted_message($quota), 429);
} catch (Throwable $error) {
    error_log('[LLNKKR VANTA chat] ' . $error->getMessage());
    llnk_fail('채팅을 처리하지 못했습니다.', 500);
}
