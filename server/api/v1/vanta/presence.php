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
    && (preg_match('/^[0-9]+$/', $declaredLength) !== 1 || (int)$declaredLength > 4096)) {
    llnk_fail('VANTA 연결 확인 요청이 너무 큽니다.', 413);
}
$raw = file_get_contents('php://input', false, null, 0, 4097);
if (!is_string($raw) || $raw === '' || strlen($raw) > 4096) {
    llnk_fail('VANTA 연결 확인 요청이 너무 크거나 비어 있습니다.', 413);
}
$input = json_decode($raw, true);
if (!is_array($input) || json_last_error() !== JSON_ERROR_NONE) {
    llnk_fail('VANTA 연결 확인 요청 형식이 올바르지 않습니다.', 422);
}

try {
    vanta_assert_allowed_keys(
        $input,
        ['action', 'roomId', 'installationId', 'participantId', 'syncToken', 'name'],
        'presence request'
    );
    $action = strtolower(trim((string)($input['action'] ?? 'heartbeat')));
    $roomId = is_string($input['roomId'] ?? null) ? vanta_room_id($input['roomId']) : '';
    $installationId = is_string($input['installationId'] ?? null)
        ? vanta_installation_id($input['installationId'])
        : '';
    $participantId = is_string($input['participantId'] ?? null)
        ? vanta_participant_id($input['participantId'])
        : '';
    $name = vanta_chat_display_name($input['name'] ?? '참여자');
    if (!in_array($action, ['heartbeat', 'leave'], true)
        || $roomId === '' || $installationId === '' || $participantId === '') {
        throw new InvalidArgumentException('VANTA 연결 확인 정보가 올바르지 않습니다.');
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
            llnk_fail('VANTA 연결 확인 인증 형식이 올바르지 않습니다.', 401);
        }
        $syncToken = $matches[1];
    } elseif (is_string($input['syncToken'] ?? null)) {
        $syncToken = trim($input['syncToken']);
    }
    if ($syncToken === '') {
        llnk_fail('VANTA 연결 확인 인증이 필요합니다.', 401);
    }
    try {
        $identity = vanta_sync_token_verify($syncToken);
    } catch (VantaSyncAuthException $error) {
        llnk_fail('VANTA 연결 확인 인증이 만료되었거나 올바르지 않습니다.', 401);
    }
    if (!hash_equals($identity['room_id'], $roomId)
        || !hash_equals($identity['participant_id'], $participantId)
        || !hash_equals($identity['installation_id'], $installationId)
        || (int)$identity['protocol_version'] !== 3
        || (int)$identity['release_version'] !== VANTA_CURRENT_RELEASE) {
        llnk_fail('VANTA 연결 확인 인증 정보가 요청과 일치하지 않습니다.', 403);
    }

    $pdo = llnk_db();
    vanta_use_room_shards($pdo, $roomId);
    llnk_create_security_schema($pdo);
    $ip = llnk_client_ip();
    if ($ip === '') {
        llnk_fail('요청 주소를 확인할 수 없습니다.', 400);
    }
    $blockedFor = llnk_active_block_retry_after($pdo, 'request_abuse', $ip);
    if ($blockedFor > 0) {
        header('Retry-After: ' . $blockedFor);
        llnk_fail('차단된 요청 주소입니다.', 429);
    }

    $limit = vanta_take_presence_limits(
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
            'vanta_presence_rate_limited',
            'notice',
            'vanta_presence',
            $ip,
            'request_rejected',
            ['action' => $action, 'limit_scope' => $limit['scope']]
        );
        llnk_fail('VANTA presence requests are temporarily limited.', 429);
    }

    if ($action === 'leave') {
        vanta_presence_leave($pdo, $roomId, $participantId);
        llnk_ok(['left' => true]);
    }

    $serverIdToken = vanta_server_id_token();
    $participants = vanta_read_participants($roomId, $serverIdToken);
    if (!vanta_has_active_participant(
        $participants,
        $identity['uid'],
        $participantId,
        3
    )) {
        llnk_fail('활성 VANTA 참여자만 연결을 갱신할 수 있습니다.', 403);
    }
    $quota = vanta_presence_touch(
        $pdo,
        $ip,
        $roomId,
        $participantId,
        $installationId,
        $name
    );
    header('X-VANTA-Tokens-Remaining: ' . (string)$quota['remaining_tokens']);
    llnk_ok(['quota' => $quota]);
} catch (VantaQuotaException $error) {
    $quota = $error->quota();
    header('Retry-After: ' . vanta_quota_retry_after($quota));
    header('X-VANTA-Tokens-Remaining: 0');
    llnk_fail(vanta_quota_exhausted_message($quota), 429);
} catch (InvalidArgumentException $error) {
    llnk_fail($error->getMessage(), 422);
} catch (Throwable $error) {
    error_log('[LLNKKR VANTA presence] ' . $error->getMessage());
    llnk_fail('VANTA 연결 사용량을 확인할 수 없습니다.', 503);
}
