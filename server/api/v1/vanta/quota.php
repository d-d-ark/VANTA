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
    && (preg_match('/^[0-9]+$/', $declaredLength) !== 1 || (int)$declaredLength > 1024)) {
    llnk_fail('VANTA 토큰 확인 요청이 너무 큽니다.', 413);
}
$raw = file_get_contents('php://input', false, null, 0, 1025);
if (!is_string($raw) || $raw === '' || strlen($raw) > 1024) {
    llnk_fail('VANTA 토큰 확인 요청이 너무 크거나 비어 있습니다.', 413);
}
$input = json_decode($raw, true);
if (!is_array($input) || json_last_error() !== JSON_ERROR_NONE) {
    llnk_fail('VANTA 토큰 확인 요청 형식이 올바르지 않습니다.', 422);
}

try {
    vanta_assert_allowed_keys($input, ['installationId', 'action'], 'quota request');
    $action = is_string($input['action'] ?? null) ? strtolower(trim($input['action'])) : 'status';
    if (!in_array($action, ['status', 'reset'], true)) {
        throw new InvalidArgumentException('VANTA 토큰 요청 동작이 올바르지 않습니다.');
    }
    $installationId = is_string($input['installationId'] ?? null)
        ? vanta_installation_id($input['installationId'])
        : '';
    if ($installationId === '') {
        throw new InvalidArgumentException('VANTA 설치 정보가 올바르지 않습니다.');
    }
    $pdo = llnk_db();
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
    $rateAllowed = $action === 'reset'
        ? vanta_take_quota_reset_limits($pdo, $ip, $installationId)
        : vanta_take_quota_limits($pdo, $ip, $installationId);
    if (!$rateAllowed) {
        header('Retry-After: 60');
        llnk_fail($action === 'reset'
            ? '토큰 초기화를 너무 자주 요청하고 있습니다.'
            : 'VANTA 토큰을 너무 자주 확인하고 있습니다.', 429);
    }
    if ($action === 'reset') {
        $reset = vanta_usage_reset_with_credit($pdo, $ip);
        if (empty($reset['used'])) {
            llnk_fail('보유한 토큰 초기화가 없습니다.', 409);
        }
        $quota = $reset['quota'];
    } else {
        $quota = vanta_usage_status($pdo, $ip);
    }
    header('Cache-Control: no-store');
    header('X-VANTA-Tokens-Remaining: ' . (string)$quota['remaining_tokens']);
    llnk_ok(['quota' => $quota]);
} catch (InvalidArgumentException $error) {
    llnk_fail($error->getMessage(), 422);
} catch (Throwable $error) {
    error_log('[LLNKKR VANTA quota] ' . $error->getMessage());
    llnk_fail('VANTA 토큰을 확인할 수 없습니다.', 503);
}
