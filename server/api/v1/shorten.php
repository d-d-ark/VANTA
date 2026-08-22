<?php
// 해킹은 범죄입니다. LLNKKR 서비스와 API를 악용하지 마세요.
declare(strict_types=1);

require_once dirname(__DIR__, 2) . '/llnk_lib.php';

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-API-Key');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Cache-Control: no-store');
header('Vary: Origin');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    llnk_set_status(204);
    exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    llnk_fail('POST 요청만 지원합니다.', 405);
}

try {
    $pdo = llnk_db();
    llnk_ensure_schema($pdo);
    llnk_create_security_schema($pdo);

    $token = llnk_api_token_from_request();
    $apiKey = null;
    if ($token !== '') {
        $apiKey = llnk_find_api_key($pdo, $token);
        if ($apiKey === null) {
            $ip = llnk_client_ip();
            $allowed = llnk_consume_rate(
                $pdo,
                'public_api_invalid_key_minute',
                $ip,
                date('YmdHi'),
                date('Y-m-d H:i:s', time() + 120),
                10
            );
            if (!$allowed) {
                header('Retry-After: 60');
                llnk_fail('API 키 확인 요청이 너무 많습니다.', 429);
            }
            llnk_fail('API 키가 올바르지 않거나 사용할 수 없습니다.', 401);
        }
    }

    $input = llnk_json_input();
    $target = llnk_normalize_target((string)($input['url'] ?? ''));
    $limits = llnk_take_public_api_limits($pdo, $apiKey);
    header('X-RateLimit-Daily-Limit: ' . $limits['daily_limit']);
    header('X-RateLimit-Minute-Limit: ' . $limits['minute_limit']);
    header('X-RateLimit-Burst-Limit: ' . $limits['burst_limit']);
    if (!$limits['allowed']) {
        header('Retry-After: ' . $limits['retry_after']);
        llnk_fail('요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.', 429);
    }

    $keyPrefix = is_array($apiKey) ? (string)$apiKey['key_prefix'] : 'anonymous';
    $link = llnk_create_link($pdo, $target, 'api', [
        'extension_version' => llnk_clip('api:' . $keyPrefix, 20),
    ], true);
    if (is_array($apiKey)) {
        llnk_note_api_key_request($pdo, (int)$apiKey['id'], true);
    }

    header('Content-Type: application/json; charset=utf-8');
    llnk_set_status(200);
    echo json_encode([
        'ok' => true,
        'success' => true,
        'code' => $link['path_code'],
        'shortUrl' => $link['short_url'],
        'createdAt' => date(DATE_ATOM),
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
} catch (InvalidArgumentException $error) {
    llnk_fail($error->getMessage(), 422);
} catch (Throwable $error) {
    llnk_fail('단축링크를 만들지 못했습니다.', 500);
}
