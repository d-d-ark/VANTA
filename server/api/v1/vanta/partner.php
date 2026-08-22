<?php
declare(strict_types=1);

require_once dirname(__DIR__, 3) . '/llnk_lib.php';
require_once __DIR__ . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');

if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'POST') {
    header('Allow: POST');
    llnk_fail('POST 요청만 지원합니다.', 405);
}

$declaredLength = trim((string)($_SERVER['CONTENT_LENGTH'] ?? ''));
if ($declaredLength !== ''
    && (preg_match('/^[0-9]+$/', $declaredLength) !== 1 || (int)$declaredLength > 512)) {
    llnk_fail('협업 코드 요청이 너무 큽니다.', 413);
}
$raw = file_get_contents('php://input', false, null, 0, 513);
if (!is_string($raw) || $raw === '' || strlen($raw) > 512) {
    llnk_fail('협업 코드 요청이 비어 있거나 너무 큽니다.', 413);
}
$input = json_decode($raw, true);
if (!is_array($input) || json_last_error() !== JSON_ERROR_NONE) {
    llnk_fail('협업 코드 요청 형식이 올바르지 않습니다.', 422);
}

try {
    vanta_assert_allowed_keys($input, ['code', 'action'], 'partner code request');
    $action = is_string($input['action'] ?? null)
        ? strtolower(trim($input['action']))
        : 'redeem';
    if (!in_array($action, ['preview', 'redeem'], true)) {
        throw new InvalidArgumentException('지원하지 않는 협업 코드 요청입니다.');
    }
    $code = vanta_partner_code($input['code'] ?? null);
    if ($code === '') {
        throw new InvalidArgumentException('협업 코드가 올바르지 않습니다.');
    }
    $ip = llnk_client_ip();
    if ($ip === '' || filter_var($ip, FILTER_VALIDATE_IP) === false) {
        llnk_fail('요청 주소를 확인할 수 없습니다.', 400);
    }
    $pdo = llnk_db();
    llnk_create_security_schema($pdo);
    $blockedFor = llnk_active_block_retry_after($pdo, 'request_abuse', $ip);
    if ($blockedFor > 0) {
        header('Retry-After: ' . $blockedFor);
        llnk_fail('차단된 요청 주소입니다.', 429);
    }
    $minuteAllowed = llnk_consume_rate(
        $pdo,
        'vanta_partner_ip_minute',
        $ip,
        date('Y-m-d H:i'),
        date('Y-m-d H:i:s', strtotime('+2 minutes')),
        30
    );
    $dailyAllowed = llnk_daily_quota($pdo, 'vanta_partner_ip_day', $ip, 100);
    if (!$minuteAllowed || !$dailyAllowed) {
        header('Retry-After: 60');
        llnk_fail('협업 코드를 너무 자주 확인하고 있습니다.', 429);
    }
    if ($action === 'preview') {
        llnk_ok(['offer' => vanta_partner_code_offer($pdo, $code, $ip)]);
    }
    llnk_ok(['redemption' => vanta_redeem_partner_code($pdo, $code, $ip)]);
} catch (InvalidArgumentException $error) {
    llnk_fail($error->getMessage(), 422);
} catch (Throwable $error) {
    error_log('[LLNKKR VANTA partner] ' . $error->getMessage());
    llnk_fail('협업 코드를 처리할 수 없습니다.', 503);
}
