<?php
declare(strict_types=1);

require_once dirname(__DIR__, 3) . '/llnk_lib.php';
require_once __DIR__ . '/lib.php';

if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'POST') {
    header('Allow: POST');
    llnk_fail('POST requests only.', 405);
}

$declaredLength = trim((string)($_SERVER['CONTENT_LENGTH'] ?? ''));
if ($declaredLength !== ''
    && (preg_match('/^[0-9]+$/', $declaredLength) !== 1
        || (int)$declaredLength > VANTA_FIREBASE_USAGE_REPORT_MAX_BYTES)) {
    llnk_fail('Firebase usage report is too large.', 413);
}
$raw = file_get_contents(
    'php://input',
    false,
    null,
    0,
    VANTA_FIREBASE_USAGE_REPORT_MAX_BYTES + 1
);
if (!is_string($raw) || $raw === '' || strlen($raw) > VANTA_FIREBASE_USAGE_REPORT_MAX_BYTES) {
    llnk_fail('Firebase usage report is invalid.', 413);
}

try {
    $timestampText = trim((string)($_SERVER['HTTP_X_VANTA_USAGE_TIMESTAMP'] ?? ''));
    $signature = strtolower(trim((string)($_SERVER['HTTP_X_VANTA_USAGE_SIGNATURE'] ?? '')));
    if (preg_match('/^[0-9]{10}$/', $timestampText) !== 1
        || abs(time() - (int)$timestampText) > 300
        || preg_match('/^v1=[a-f0-9]{64}$/', $signature) !== 1) {
        llnk_fail('Firebase usage reporter authentication failed.', 401);
    }
    $secret = vanta_config_string('LLNK_VANTA_FIREBASE_USAGE_REPORT_SECRET');
    $expected = 'v1=' . hash_hmac('sha256', $timestampText . "\n" . $raw, $secret);
    if (!hash_equals($expected, $signature)) {
        llnk_fail('Firebase usage reporter authentication failed.', 401);
    }

    $input = json_decode($raw, true);
    $reports = is_array($input) ? ($input['reports'] ?? null) : null;
    if (!is_array($reports) || count($reports) < 1 || count($reports) > 12) {
        llnk_fail('Firebase usage report payload is invalid.', 422);
    }

    $pdo = llnk_db();
    vanta_create_usage_schema($pdo);
    vanta_create_firebase_usage_schema($pdo);
    $pdo->beginTransaction();
    foreach ($reports as $report) {
        if (!is_array($report)) {
            throw new InvalidArgumentException('Invalid Firebase usage report.');
        }
        $kind = (string)($report['kind'] ?? '');
        $shard = vanta_shard_id((string)($report['shard'] ?? ''), $kind);
        if (!in_array($kind, ['sync', 'cursor'], true)
            || !vanta_shard_configured($kind, $shard)) {
            throw new InvalidArgumentException('Unknown Firebase shard.');
        }
        $prefix = $kind === 'cursor' ? 'cursor' : 'sync';
        $emailBase = $kind === 'cursor'
            ? 'LLNK_VANTA_CURSOR_FIREBASE_CLIENT_EMAIL'
            : 'LLNK_VANTA_FIREBASE_CLIENT_EMAIL';
        $emailName = vanta_shard_config_name($emailBase, $shard, $prefix);
        $email = vanta_config_string($emailName);
        if (preg_match('/@([a-z][a-z0-9-]{4,62}[a-z0-9])\.iam\.gserviceaccount\.com$/', $email, $matches) !== 1
            || !hash_equals($matches[1], strtolower(trim((string)($report['projectId'] ?? ''))))) {
            throw new InvalidArgumentException('Firebase shard project does not match server configuration.');
        }
        vanta_record_firebase_usage($pdo, $report);
    }
    $pdo->commit();
    llnk_ok(['accepted' => count($reports), 'reportedAt' => time()]);
} catch (InvalidArgumentException $error) {
    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) $pdo->rollBack();
    llnk_fail($error->getMessage(), 422);
} catch (Throwable $error) {
    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) $pdo->rollBack();
    error_log('VANTA Firebase usage reporter: ' . $error->getMessage());
    llnk_fail('Firebase usage report could not be stored.', 503);
}
