<?php
// 해킹은 범죄입니다. LLNKKR 서비스와 API를 악용하지 마세요.
declare(strict_types=1);

require_once __DIR__ . '/config.php';

date_default_timezone_set('Asia/Seoul');

$GLOBALS['llnk_started_at'] = microtime(true);
$GLOBALS['llnk_status_code'] = 200;

function llnk_db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }
    $pdo = new PDO(
        'mysql:host=' . LLNK_DB_HOST . ';dbname=' . LLNK_DB_NAME . ';charset=' . LLNK_DB_CHARSET,
        LLNK_DB_USER,
        LLNK_DB_PASS,
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]
    );
    $pdo->exec("SET time_zone = '+09:00'");
    return $pdo;
}

function llnk_h(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function llnk_clip(string $value, int $max): string
{
    $value = trim($value);
    return mb_strlen($value, 'UTF-8') > $max
        ? mb_substr($value, 0, $max, 'UTF-8')
        : $value;
}

function llnk_client_ip(): string
{
    $keys = defined('LLNK_TRUST_PROXY_HEADERS') && LLNK_TRUST_PROXY_HEADERS
        ? ['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR']
        : ['REMOTE_ADDR'];
    foreach ($keys as $key) {
        $raw = (string)($_SERVER[$key] ?? '');
        foreach (explode(',', $raw) as $candidate) {
            $ip = trim($candidate);
            if ($ip !== '' && filter_var($ip, FILTER_VALIDATE_IP)) {
                return $ip;
            }
        }
    }
    return '';
}

function llnk_request_meta(): array
{
    return [
        'ip' => llnk_client_ip(),
        'user_agent' => llnk_clip((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 255),
        'referer' => llnk_clip((string)($_SERVER['HTTP_REFERER'] ?? ''), 1024),
        'accept_language' => llnk_clip((string)($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? ''), 120),
        'cf_country' => preg_match('/^[A-Z]{2}$/', strtoupper((string)($_SERVER['HTTP_CF_IPCOUNTRY'] ?? '')))
            ? strtoupper((string)$_SERVER['HTTP_CF_IPCOUNTRY'])
            : '',
        'cf_ray' => llnk_clip((string)($_SERVER['HTTP_CF_RAY'] ?? ''), 80),
        'method' => llnk_clip((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'), 12),
    ];
}

function llnk_redact_query(string $query): string
{
    if ($query === '') {
        return '';
    }
    parse_str($query, $values);
    array_walk_recursive($values, static function (&$value, $key): void {
        if (preg_match('/token|password|secret|authorization|cookie|key|url/i', (string)$key)) {
            $value = '[redacted]';
        } elseif (is_string($value)) {
            $value = llnk_clip($value, 200);
        }
    });
    return llnk_clip(http_build_query($values), 1024);
}

function llnk_request_body_preview(): string
{
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return '';
    }
    $data = json_decode($raw, true);
    if (is_array($data)) {
        foreach (['password', 'token', 'secret'] as $key) {
            if (array_key_exists($key, $data)) {
                $data[$key] = '[redacted]';
            }
        }
        $encoded = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        return llnk_clip(is_string($encoded) ? $encoded : $raw, 1200);
    }
    return llnk_clip($raw, 1200);
}

function llnk_ensure_schema(PDO $pdo): void
{
}

function llnk_create_poll_schema(PDO $pdo): void
{
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_polls (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          path_code VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          question VARCHAR(160) NOT NULL,
          content_type VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'poll',
          correct_option_order TINYINT UNSIGNED NULL,
          total_votes INT UNSIGNED NOT NULL DEFAULT 0,
          source_extension_version VARCHAR(20) NOT NULL DEFAULT '',
          created_ip_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uq_llnk_poll_code (path_code),
          KEY idx_llnk_poll_active_created (is_active, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_poll_options (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          poll_id BIGINT UNSIGNED NOT NULL,
          option_order TINYINT UNSIGNED NOT NULL,
          label VARCHAR(100) NOT NULL,
          vote_count INT UNSIGNED NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uq_llnk_poll_option_order (poll_id, option_order),
          KEY idx_llnk_poll_option_poll (poll_id, id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_poll_voters (
          poll_id BIGINT UNSIGNED NOT NULL,
          voter_ip_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          option_id BIGINT UNSIGNED NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (poll_id, voter_ip_hash),
          KEY idx_llnk_poll_voter_option (option_id),
          KEY idx_llnk_poll_voter_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $optionColumn = $pdo->query("SHOW COLUMNS FROM llnk_poll_voters LIKE 'option_id'");
    if (!$optionColumn || !$optionColumn->fetch()) {
        $pdo->exec(
            'ALTER TABLE llnk_poll_voters
             ADD COLUMN option_id BIGINT UNSIGNED NULL AFTER voter_ip_hash,
             ADD KEY idx_llnk_poll_voter_option (option_id)'
        );
    }
    $typeColumn = $pdo->query("SHOW COLUMNS FROM llnk_polls LIKE 'content_type'");
    if (!$typeColumn || !$typeColumn->fetch()) {
        $pdo->exec(
            "ALTER TABLE llnk_polls
             ADD COLUMN content_type VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'poll' AFTER question"
        );
    }
    $correctColumn = $pdo->query("SHOW COLUMNS FROM llnk_polls LIKE 'correct_option_order'");
    if (!$correctColumn || !$correctColumn->fetch()) {
        $pdo->exec(
            'ALTER TABLE llnk_polls
             ADD COLUMN correct_option_order TINYINT UNSIGNED NULL AFTER content_type'
        );
    }
}

function llnk_poll_ip_hash(?string $ip = null): string
{
    $secret = defined('LLNK_POLL_IP_SECRET') ? trim((string)LLNK_POLL_IP_SECRET) : '';
    if ($secret === '' || strpos($secret, 'CHANGE_TO_') === 0) {
        $secret = defined('LLNK_NEWS_IP_SECRET') ? trim((string)LLNK_NEWS_IP_SECRET) : '';
    }
    if ($secret === '' || strpos($secret, 'CHANGE_TO_') === 0) {
        $secret = hash('sha256', LLNK_DB_HOST . '|' . LLNK_DB_NAME . '|' . LLNK_DB_USER . '|' . LLNK_DB_PASS);
    }
    return hash_hmac('sha256', $ip ?? llnk_client_ip(), $secret);
}

function llnk_create_security_schema(PDO $pdo): void
{
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_rate_counters (
          counter_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          scope VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          bucket_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          request_count INT UNSIGNED NOT NULL DEFAULT 0,
          expires_at DATETIME NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (counter_key),
          KEY idx_llnk_rate_expires (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_ip_blocks (
          scope VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          reason_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          blocked_until DATETIME NOT NULL,
          hit_count INT UNSIGNED NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (scope, ip_address),
          KEY idx_llnk_blocks_until (blocked_until)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_security_events (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          event_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          severity VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'warning',
          scope VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
          request_path VARCHAR(512) NOT NULL DEFAULT '',
          action_taken VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
          detail_json TEXT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_llnk_security_created (created_at),
          KEY idx_llnk_security_ip (ip_address, created_at),
          KEY idx_llnk_security_type (event_type, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_request_sessions (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          identity_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          request_path VARCHAR(512) NOT NULL DEFAULT '',
          method VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'GET',
          request_host VARCHAR(255) NOT NULL DEFAULT '',
          ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
          user_agent VARCHAR(255) NOT NULL DEFAULT '',
          referer VARCHAR(1024) NOT NULL DEFAULT '',
          cf_country CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
          first_status_code SMALLINT UNSIGNED NOT NULL DEFAULT 0,
          last_status_code SMALLINT UNSIGNED NOT NULL DEFAULT 0,
          request_count BIGINT UNSIGNED NOT NULL DEFAULT 1,
          success_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
          error_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
          rate_limited_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
          auth_failure_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
          total_duration_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
          max_duration_ms INT UNSIGNED NOT NULL DEFAULT 0,
          first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_llnk_request_identity (identity_key, last_seen_at),
          KEY idx_llnk_request_ip (ip_address, last_seen_at),
          KEY idx_llnk_request_path (request_path(191), last_seen_at),
          KEY idx_llnk_request_last_seen (last_seen_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_link_visit_sessions (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          identity_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          link_id BIGINT UNSIGNED NOT NULL,
          path_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          link_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'url',
          target_url VARCHAR(2048) NOT NULL,
          ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
          user_agent VARCHAR(255) NOT NULL DEFAULT '',
          referer VARCHAR(1024) NOT NULL DEFAULT '',
          request_uri VARCHAR(1024) NOT NULL DEFAULT '',
          accept_language VARCHAR(120) NOT NULL DEFAULT '',
          cf_country CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
          cf_ray VARCHAR(80) NOT NULL DEFAULT '',
          method VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'GET',
          visit_count BIGINT UNSIGNED NOT NULL DEFAULT 1,
          first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_llnk_visit_identity (identity_key, last_seen_at),
          KEY idx_llnk_visit_link (link_id, last_seen_at),
          KEY idx_llnk_visit_ip (ip_address, last_seen_at),
          KEY idx_llnk_visit_last_seen (last_seen_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_api_keys (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          key_prefix VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          key_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          display_name VARCHAR(120) NOT NULL,
          notes VARCHAR(500) NOT NULL DEFAULT '',
          daily_limit INT UNSIGNED NOT NULL DEFAULT 3000,
          minute_limit INT UNSIGNED NOT NULL DEFAULT 300,
          burst_limit INT UNSIGNED NOT NULL DEFAULT 60,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          request_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
          created_link_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
          last_used_at DATETIME NULL,
          last_used_ip VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
          expires_at DATETIME NULL,
          revoked_at DATETIME NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uq_llnk_api_key_prefix (key_prefix),
          KEY idx_llnk_api_key_active (is_active, expires_at),
          KEY idx_llnk_api_key_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
}

function llnk_create_article_comment_schema(PDO $pdo): void
{
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS llnk_article_comments (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          article_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          body VARCHAR(1000) NOT NULL,
          body_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
          user_agent VARCHAR(255) NOT NULL DEFAULT '',
          referer VARCHAR(1024) NOT NULL DEFAULT '',
          accept_language VARCHAR(120) NOT NULL DEFAULT '',
          cf_country CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
          cf_ray VARCHAR(80) NOT NULL DEFAULT '',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_llnk_article_comments_article (article_key, created_at, id),
          KEY idx_llnk_article_comments_ip (ip_address, created_at),
          KEY idx_llnk_article_comments_duplicate (article_key, ip_address, body_hash, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
}

function llnk_security_query(PDO $pdo, callable $operation)
{
    try {
        return $operation();
    } catch (PDOException $error) {
        $driverCode = (int)($error->errorInfo[1] ?? 0);
        if ($error->getCode() !== '42S02' && $driverCode !== 1146) {
            throw $error;
        }
        llnk_create_security_schema($pdo);
        return $operation();
    }
}

function llnk_consume_rate(PDO $pdo, string $scope, string $identity, string $bucket, string $expiresAt, int $limit): bool
{
    $limit = max(1, $limit);
    $counterKey = hash('sha256', $scope . '|' . $identity . '|' . $bucket);
    $allowed = llnk_security_query($pdo, static function () use ($pdo, $counterKey, $scope, $bucket, $expiresAt, $limit): bool {
        $pdo->prepare(
            'INSERT IGNORE INTO llnk_rate_counters
             (counter_key, scope, bucket_key, request_count, expires_at)
             VALUES (?, ?, ?, 0, ?)'
        )->execute([$counterKey, $scope, $bucket, $expiresAt]);
        $increment = $pdo->prepare(
            'UPDATE llnk_rate_counters
             SET request_count = request_count + 1
             WHERE counter_key = ? AND request_count < ?'
        );
        $increment->execute([$counterKey, $limit]);
        return $increment->rowCount() === 1;
    });
    try {
        if (random_int(1, 200) === 1) {
            $pdo->exec('DELETE FROM llnk_rate_counters WHERE expires_at < NOW() LIMIT 500');
        }
    } catch (Throwable $error) {
    }
    return $allowed;
}

function llnk_daily_quota(PDO $pdo, string $scope, string $identity, int $limit): bool
{
    return llnk_consume_rate(
        $pdo,
        $scope,
        $identity,
        date('Y-m-d'),
        date('Y-m-d H:i:s', strtotime('tomorrow')),
        $limit
    );
}

function llnk_active_block_retry_after(PDO $pdo, string $scope, string $ip): int
{
    if ($ip === '') {
        return 0;
    }
    return (int)llnk_security_query($pdo, static function () use ($pdo, $scope, $ip): int {
        $statement = $pdo->prepare(
            'SELECT GREATEST(0, UNIX_TIMESTAMP(blocked_until) - UNIX_TIMESTAMP(NOW()))
             FROM llnk_ip_blocks
             WHERE scope = ? AND ip_address = ? AND blocked_until > NOW()
             LIMIT 1'
        );
        $statement->execute([$scope, $ip]);
        return (int)($statement->fetchColumn() ?: 0);
    });
}

function llnk_add_security_event(PDO $pdo, string $eventType, string $severity, string $scope, string $ip, string $action, array $details = []): void
{
    llnk_security_query($pdo, static function () use ($pdo, $eventType, $severity, $scope, $ip, $action, $details): void {
        $uri = (string)($_SERVER['REQUEST_URI'] ?? '/');
        $encoded = json_encode($details, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $pdo->prepare(
            'INSERT INTO llnk_security_events
             (event_type, severity, scope, ip_address, request_path, action_taken, detail_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)'
        )->execute([
            llnk_clip($eventType, 64),
            llnk_clip($severity, 16),
            llnk_clip($scope, 64),
            $ip,
            llnk_clip((string)(parse_url($uri, PHP_URL_PATH) ?: '/'), 512),
            llnk_clip($action, 64),
            is_string($encoded) ? $encoded : '{}',
        ]);
    });
}

function llnk_block_ip(PDO $pdo, string $scope, string $ip, string $reasonCode, int $seconds, array $details = []): int
{
    if ($ip === '') {
        return 0;
    }
    $seconds = max(60, min(86400, $seconds));
    $blockedUntil = date('Y-m-d H:i:s', time() + $seconds);
    llnk_security_query($pdo, static function () use ($pdo, $scope, $ip, $reasonCode, $blockedUntil): void {
        $pdo->prepare(
            'INSERT INTO llnk_ip_blocks
             (scope, ip_address, reason_code, blocked_until)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               reason_code = VALUES(reason_code),
               blocked_until = GREATEST(blocked_until, VALUES(blocked_until)),
               hit_count = hit_count + 1'
        )->execute([$scope, $ip, $reasonCode, $blockedUntil]);
    });
    llnk_add_security_event($pdo, $reasonCode, 'warning', $scope, $ip, 'temporary_block', $details + [
        'blocked_seconds' => $seconds,
    ]);
    return $seconds;
}

function llnk_note_image_lookup_miss(PDO $pdo, string $code): int
{
    $ip = llnk_client_ip();
    if ($ip === '') {
        return 0;
    }
    $minuteLimit = defined('LLNK_IMAGE_LOOKUP_MISS_PER_MINUTE') ? (int)LLNK_IMAGE_LOOKUP_MISS_PER_MINUTE : 20;
    $hourLimit = defined('LLNK_IMAGE_LOOKUP_MISS_PER_HOUR') ? (int)LLNK_IMAGE_LOOKUP_MISS_PER_HOUR : 120;
    $minuteAllowed = llnk_consume_rate(
        $pdo,
        'image_lookup_miss_minute',
        $ip,
        date('YmdHi'),
        date('Y-m-d H:i:s', time() + 120),
        $minuteLimit
    );
    $hourAllowed = llnk_consume_rate(
        $pdo,
        'image_lookup_miss_hour',
        $ip,
        date('YmdH'),
        date('Y-m-d H:i:s', time() + 7200),
        $hourLimit
    );
    if ($minuteAllowed && $hourAllowed) {
        return 0;
    }
    $blockSeconds = defined('LLNK_IMAGE_LOOKUP_BLOCK_SECONDS') ? (int)LLNK_IMAGE_LOOKUP_BLOCK_SECONDS : 3600;
    return llnk_block_ip($pdo, 'image_lookup', $ip, 'image_code_enumeration', $blockSeconds, [
        'last_code' => llnk_clip($code, 16),
        'minute_limit' => $minuteLimit,
        'hour_limit' => $hourLimit,
    ]);
}

function llnk_set_status(int $status): void
{
    $GLOBALS['llnk_status_code'] = $status;
    http_response_code($status);
}

function llnk_enforce_request_rate(PDO $pdo): void
{
    if (PHP_SAPI === 'cli') {
        return;
    }
    $ip = llnk_client_ip();
    if ($ip === '') {
        return;
    }
    $uri = (string)($_SERVER['REQUEST_URI'] ?? '/');
    $path = llnk_clip((string)(parse_url($uri, PHP_URL_PATH) ?: '/'), 512);
    $method = llnk_clip((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'), 12);
    $retryAfter = llnk_active_block_retry_after($pdo, 'request_abuse', $ip);
    if ($retryAfter > 0) {
        header('Retry-After: ' . $retryAfter);
        header('Content-Type: text/plain; charset=utf-8');
        llnk_set_status(429);
        echo 'Too many requests.';
        exit;
    }

    $pathIdentity = hash('sha256', $ip . '|' . $method . '|' . $path);
    $minuteLimit = defined('LLNK_REQUEST_RATE_PER_MINUTE') ? (int)LLNK_REQUEST_RATE_PER_MINUTE : 240;
    $tenMinutePathLimit = defined('LLNK_REQUEST_RATE_PER_TEN_MINUTES') ? (int)LLNK_REQUEST_RATE_PER_TEN_MINUTES : 600;
    if ($path === '/api/v1/shorten.php') {
        $minuteLimit = max($minuteLimit, 360);
        $tenMinutePathLimit = max($tenMinutePathLimit, 3600);
    }
    $minuteAllowed = llnk_consume_rate(
        $pdo,
        'request_global_minute',
        $ip,
        date('YmdHi'),
        date('Y-m-d H:i:s', time() + 120),
        $minuteLimit
    );
    $tenMinuteBucket = (string)floor(time() / 600);
    $pathAllowed = llnk_consume_rate(
        $pdo,
        'request_path_ten_minutes',
        $pathIdentity,
        $tenMinuteBucket,
        date('Y-m-d H:i:s', time() + 1200),
        $tenMinutePathLimit
    );
    if ($minuteAllowed && $pathAllowed) {
        return;
    }

    $blockSeconds = defined('LLNK_REQUEST_RATE_BLOCK_SECONDS') ? (int)LLNK_REQUEST_RATE_BLOCK_SECONDS : 600;
    llnk_block_ip($pdo, 'request_abuse', $ip, 'repeated_request_abuse', $blockSeconds, [
        'method' => $method,
        'path' => $path,
        'minute_limit' => $minuteLimit,
        'ten_minute_path_limit' => $tenMinutePathLimit,
    ]);
    header('Retry-After: ' . $blockSeconds);
    header('Content-Type: text/plain; charset=utf-8');
    llnk_set_status(429);
    echo 'Too many requests.';
    exit;
}

function llnk_update_request_session(PDO $pdo, array $record): void
{
    $gapSeconds = defined('LLNK_REQUEST_SESSION_GAP_SECONDS')
        ? max(60, (int)LLNK_REQUEST_SESSION_GAP_SECONDS)
        : 600;
    $cutoff = date('Y-m-d H:i:s', time() - $gapSeconds);
    $pdo->beginTransaction();
    try {
        $select = $pdo->prepare(
            'SELECT id
             FROM llnk_request_sessions
             WHERE identity_key = ?
               AND first_seen_at >= CURRENT_DATE
               AND last_seen_at >= ?
             ORDER BY last_seen_at DESC
             LIMIT 1
             FOR UPDATE'
        );
        $select->execute([$record['identity_key'], $cutoff]);
        $sessionId = (int)($select->fetchColumn() ?: 0);
        if ($sessionId > 0) {
            $update = $pdo->prepare(
                'UPDATE llnk_request_sessions
                 SET last_status_code = ?,
                     request_count = request_count + 1,
                     success_count = success_count + ?,
                     error_count = error_count + ?,
                     rate_limited_count = rate_limited_count + ?,
                     auth_failure_count = auth_failure_count + ?,
                     total_duration_ms = total_duration_ms + ?,
                     max_duration_ms = GREATEST(max_duration_ms, ?),
                     user_agent = ?,
                     referer = ?,
                     cf_country = ?,
                     last_seen_at = NOW()
                 WHERE id = ?'
            );
            $update->execute([
                $record['status_code'], $record['success_count'], $record['error_count'],
                $record['rate_limited_count'], $record['auth_failure_count'],
                $record['duration_ms'], $record['duration_ms'], $record['user_agent'],
                $record['referer'], $record['cf_country'], $sessionId,
            ]);
        } else {
            $insert = $pdo->prepare(
                'INSERT INTO llnk_request_sessions
                 (identity_key, request_path, method, request_host, ip_address, user_agent, referer, cf_country,
                  first_status_code, last_status_code, request_count, success_count, error_count,
                  rate_limited_count, auth_failure_count, total_duration_ms, max_duration_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)'
            );
            $insert->execute([
                $record['identity_key'], $record['request_path'], $record['method'],
                $record['request_host'], $record['ip_address'], $record['user_agent'],
                $record['referer'], $record['cf_country'], $record['status_code'],
                $record['status_code'], $record['success_count'], $record['error_count'],
                $record['rate_limited_count'], $record['auth_failure_count'],
                $record['duration_ms'], $record['duration_ms'],
            ]);
        }
        $pdo->commit();
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $error;
    }
}

function llnk_log_access(): void
{
    try {
        $pdo = llnk_db();
        llnk_ensure_schema($pdo);
        $uri = (string)($_SERVER['REQUEST_URI'] ?? '/');
        $meta = llnk_request_meta();
        $requestPath = llnk_clip((string)(parse_url($uri, PHP_URL_PATH) ?: '/'), 512);
        $requestHost = llnk_clip((string)($_SERVER['HTTP_HOST'] ?? ''), 255);
        $statusCode = (int)($GLOBALS['llnk_status_code'] ?? http_response_code());
        $durationMs = max(0, (int)round((microtime(true) - (float)$GLOBALS['llnk_started_at']) * 1000));
        $record = [
            'identity_key' => hash('sha256', $meta['ip'] . '|' . $meta['method'] . '|' . $requestHost . '|' . $requestPath),
            'request_path' => $requestPath,
            'method' => $meta['method'],
            'request_host' => $requestHost,
            'status_code' => $statusCode,
            'duration_ms' => $durationMs,
            'ip_address' => $meta['ip'],
            'user_agent' => $meta['user_agent'],
            'referer' => $meta['referer'],
            'cf_country' => $meta['cf_country'],
            'success_count' => $statusCode < 400 ? 1 : 0,
            'error_count' => $statusCode >= 400 ? 1 : 0,
            'rate_limited_count' => $statusCode === 429 ? 1 : 0,
            'auth_failure_count' => $statusCode === 401 ? 1 : 0,
        ];
        llnk_security_query($pdo, static function () use ($pdo, $record): void {
            llnk_update_request_session($pdo, $record);
        });
    } catch (Throwable $error) {
    }
}

if (!defined('LLNK_ACCESS_LOG_REGISTERED')) {
    define('LLNK_ACCESS_LOG_REGISTERED', true);
    register_shutdown_function('llnk_log_access');
}

if (!defined('LLNK_REQUEST_RATE_CHECKED')) {
    define('LLNK_REQUEST_RATE_CHECKED', true);
    try {
        llnk_enforce_request_rate(llnk_db());
    } catch (Throwable $error) {
    }
}

function llnk_json_input(): array
{
    $raw = file_get_contents('php://input');
    $data = json_decode($raw === false ? '' : $raw, true);
    if (is_array($data)) {
        return $data;
    }
    if (!empty($_POST)) {
        return is_array($_POST) ? $_POST : [];
    }
    $formData = [];
    if (is_string($raw) && $raw !== '') {
        parse_str($raw, $formData);
    }
    return is_array($formData) ? $formData : [];
}

function llnk_ok(array $payload = []): void
{
    header('Content-Type: application/json; charset=utf-8');
    llnk_set_status(200);
    echo json_encode(['ok' => true] + $payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function llnk_fail(string $message, int $status = 400): void
{
    header('Content-Type: application/json; charset=utf-8');
    llnk_set_status($status);
    echo json_encode(['ok' => false, 'error' => $message], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function llnk_normalize_target(string $raw): string
{
    $url = trim($raw);
    if ($url === '' || strlen($url) > LLNK_MAX_TARGET_LENGTH || preg_match('/[\x00-\x1F\x7F]/', $url)) {
        throw new InvalidArgumentException('올바른 URL을 입력해 주세요.');
    }
    if (!preg_match('#^https?://#i', $url)) {
        $url = 'https://' . $url;
    }
    if (!filter_var($url, FILTER_VALIDATE_URL)) {
        throw new InvalidArgumentException('http 또는 https URL만 사용할 수 있습니다.');
    }
    $parts = parse_url($url);
    $scheme = strtolower((string)($parts['scheme'] ?? ''));
    $host = strtolower(rtrim((string)($parts['host'] ?? ''), '.'));
    if (!in_array($scheme, ['http', 'https'], true) || $host === '' || isset($parts['user']) || isset($parts['pass'])) {
        throw new InvalidArgumentException('안전한 http 또는 https URL만 사용할 수 있습니다.');
    }
    $serviceHost = strtolower(rtrim((string)parse_url(LLNK_BASE_URL, PHP_URL_HOST), '.'));
    if ($serviceHost !== '' && ($host === $serviceHost || $host === 'www.' . $serviceHost)) {
        throw new InvalidArgumentException('이미 LlNK.kr로 단축된 링크는 다시 단축할 수 없습니다.');
    }
    if ($host === 'localhost' || substr($host, -10) === '.localhost' || substr($host, -6) === '.local' || substr($host, -9) === '.internal') {
        throw new InvalidArgumentException('내부 네트워크 주소는 줄일 수 없습니다.');
    }
    if (filter_var($host, FILTER_VALIDATE_IP) && !filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
        throw new InvalidArgumentException('내부 또는 예약 IP 주소는 줄일 수 없습니다.');
    }
    return $url;
}

function llnk_normalize_image(string $raw): string
{
    $url = llnk_normalize_target($raw);
    $parts = parse_url($url);
    $host = strtolower((string)($parts['host'] ?? ''));
    $path = (string)($parts['path'] ?? '');
    if ($host !== 'playentry.org' || strpos($path, '/uploads/') !== 0 || !preg_match('/\.(?:png|jpe?g|gif|webp|svg)$/i', $path)) {
        throw new InvalidArgumentException('엔트리에 업로드된 이미지 URL만 사용할 수 있습니다.');
    }
    if (preg_match('#^/uploads/(?:fonts|thumb)/#i', $path) || stripos($path, 'EmptyImage.svg') !== false) {
        throw new InvalidArgumentException('사용할 수 없는 이미지 URL입니다.');
    }
    return $url;
}

function llnk_generate_code(PDO $pdo, string $prefix, int $length): string
{
    $alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
    for ($attempt = 0; $attempt < 20; $attempt += 1) {
        $code = $prefix;
        for ($index = 0; $index < $length; $index += 1) {
            $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        }
        $stmt = $pdo->prepare('SELECT id FROM llnk_links WHERE path_code = ? LIMIT 1');
        $stmt->execute([$code]);
        if (!$stmt->fetchColumn()) {
            return $code;
        }
    }
    throw new RuntimeException('짧은 주소를 만들지 못했습니다.');
}

function llnk_generate_poll_code(PDO $pdo, string $prefix = 'v'): string
{
    $prefix = $prefix === 'q' ? 'q' : 'v';
    $alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
    $length = defined('LLNK_POLL_CODE_LENGTH') ? max(5, min(12, (int)LLNK_POLL_CODE_LENGTH)) : 7;
    for ($attempt = 0; $attempt < 30; $attempt += 1) {
        $code = $prefix;
        for ($index = 0; $index < $length; $index += 1) {
            $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        }
        $poll = $pdo->prepare('SELECT id FROM llnk_polls WHERE path_code = ? LIMIT 1');
        $poll->execute([$code]);
        if ($poll->fetchColumn()) {
            continue;
        }
        $link = $pdo->prepare('SELECT id FROM llnk_links WHERE path_code = ? LIMIT 1');
        $link->execute([$code]);
        if (!$link->fetchColumn()) {
            return $code;
        }
    }
    throw new RuntimeException('참여 주소를 만들지 못했습니다.');
}

function llnk_take_create_quota(PDO $pdo, string $ip, string $type): bool
{
    if ($type === 'image') {
        return llnk_consume_rate(
            $pdo,
            'image_create_hour',
            $ip,
            date('YmdH'),
            date('Y-m-d H:i:s', time() + 7200),
            60
        );
    }
    return llnk_daily_quota($pdo, 'url_create_daily', $ip, (int)LLNK_URL_DAILY_LIMIT);
}

function llnk_create_link(PDO $pdo, string $target, string $type, array $source = [], bool $skipRateLimit = false): array
{
    llnk_ensure_schema($pdo);
    $type = in_array($type, ['image', 'file', 'api', 'repost'], true) ? $type : 'url';
    $meta = llnk_request_meta();
    if (!$skipRateLimit && !llnk_take_create_quota($pdo, $meta['ip'], $type)) {
        header('Retry-After: 3600');
        throw new RuntimeException($type === 'image'
            ? '이 IP에서 만든 이미지 링크가 너무 많습니다. 잠시 후 다시 시도해 주세요.'
            : '오늘 생성할 수 있는 단축링크는 IP당 30개까지입니다.');
    }
    $prefix = $type === 'image' ? 'i' : ($type === 'file' ? 'f' : ($type === 'api' ? 'a' : ($type === 'repost' ? 'r' : 'u')));
    $length = $type === 'image' ? LLNK_IMAGE_CODE_LENGTH : ($type === 'repost' ? 7 : LLNK_URL_CODE_LENGTH);
    $pathCode = llnk_generate_code($pdo, $prefix, $length);
    $stmt = $pdo->prepare(
        'INSERT INTO llnk_links
         (path_code, link_type, target_url, source_extension_version, created_ip, created_user_agent)
         VALUES (?, ?, ?, ?, ?, ?)'
    );
    $stmt->execute([
        $pathCode, $type, $target,
        llnk_clip((string)($source['extension_version'] ?? ''), 20),
        $meta['ip'], $meta['user_agent'],
    ]);
    return [
        'id' => (int)$pdo->lastInsertId(),
        'path_code' => $pathCode,
        'short_url' => LLNK_BASE_URL . '/' . $pathCode,
        'target_url' => $target,
        'link_type' => $type,
    ];
}

function llnk_api_token_from_request(): string
{
    $authorization = trim((string)($_SERVER['HTTP_AUTHORIZATION'] ?? ''));
    if (preg_match('/^Bearer\s+(.+)$/i', $authorization, $match)) {
        return trim((string)$match[1]);
    }
    return trim((string)($_SERVER['HTTP_X_API_KEY'] ?? ''));
}

function llnk_api_key_prefix_from_token(string $token): string
{
    if (!preg_match('/^(llnk_live_[23456789abcdefghjkmnpqrstuvwxyz]{8})_[a-f0-9]{48}$/', $token, $match)) {
        return '';
    }
    return (string)$match[1];
}

function llnk_find_api_key(PDO $pdo, string $token): ?array
{
    $prefix = llnk_api_key_prefix_from_token($token);
    if ($prefix === '') {
        return null;
    }
    llnk_create_security_schema($pdo);
    $statement = $pdo->prepare(
        'SELECT * FROM llnk_api_keys
         WHERE key_prefix = ? AND is_active = 1 AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > NOW())
         LIMIT 1'
    );
    $statement->execute([$prefix]);
    $key = $statement->fetch();
    if (!is_array($key) || !password_verify($token, (string)$key['key_hash'])) {
        return null;
    }
    return $key;
}

function llnk_take_public_api_limits(PDO $pdo, ?array $apiKey): array
{
    $ip = llnk_client_ip();
    $identity = $apiKey === null ? $ip : 'key:' . (int)$apiKey['id'];
    $anonymousDaily = defined('LLNK_PUBLIC_API_ANONYMOUS_DAILY_LIMIT')
        ? (int)LLNK_PUBLIC_API_ANONYMOUS_DAILY_LIMIT
        : 300;
    $defaultKeyDaily = defined('LLNK_PUBLIC_API_KEY_DAILY_LIMIT')
        ? (int)LLNK_PUBLIC_API_KEY_DAILY_LIMIT
        : 3000;
    $defaultKeyMinute = defined('LLNK_PUBLIC_API_KEY_MINUTE_LIMIT')
        ? (int)LLNK_PUBLIC_API_KEY_MINUTE_LIMIT
        : 300;
    $defaultKeyBurst = defined('LLNK_PUBLIC_API_KEY_BURST_LIMIT')
        ? (int)LLNK_PUBLIC_API_KEY_BURST_LIMIT
        : 60;
    $dailyLimit = $apiKey === null
        ? max(1, $anonymousDaily)
        : max(1, min(100000, (int)($apiKey['daily_limit'] ?: $defaultKeyDaily)));
    $minuteLimit = $apiKey === null
        ? 60
        : max(1, min(3000, (int)($apiKey['minute_limit'] ?: $defaultKeyMinute)));
    $burstLimit = $apiKey === null
        ? 20
        : max(1, min(600, (int)($apiKey['burst_limit'] ?: $defaultKeyBurst)));
    $scope = $apiKey === null ? 'public_api_anonymous' : 'public_api_key';

    $dailyAllowed = llnk_daily_quota($pdo, $scope . '_daily', $identity, $dailyLimit);
    $minuteAllowed = llnk_consume_rate(
        $pdo,
        $scope . '_minute',
        $identity,
        date('YmdHi'),
        date('Y-m-d H:i:s', time() + 120),
        $minuteLimit
    );
    $burstAllowed = llnk_consume_rate(
        $pdo,
        $scope . '_ten_seconds',
        $identity,
        (string)floor(time() / 10),
        date('Y-m-d H:i:s', time() + 20),
        $burstLimit
    );

    if (!$dailyAllowed || !$minuteAllowed || !$burstAllowed) {
        $retryAfter = !$dailyAllowed
            ? max(1, strtotime('tomorrow') - time())
            : (!$minuteAllowed ? 60 : 10);
        return [
            'allowed' => false,
            'retry_after' => $retryAfter,
            'daily_limit' => $dailyLimit,
            'minute_limit' => $minuteLimit,
            'burst_limit' => $burstLimit,
        ];
    }

    return [
        'allowed' => true,
        'retry_after' => 0,
        'daily_limit' => $dailyLimit,
        'minute_limit' => $minuteLimit,
        'burst_limit' => $burstLimit,
    ];
}

function llnk_note_api_key_request(PDO $pdo, int $apiKeyId, bool $createdLink): void
{
    if ($apiKeyId < 1) {
        return;
    }
    $statement = $pdo->prepare(
        'UPDATE llnk_api_keys
         SET request_count = request_count + 1,
             created_link_count = created_link_count + ?,
             last_used_at = NOW(),
             last_used_ip = ?
         WHERE id = ?'
    );
    $statement->execute([$createdLink ? 1 : 0, llnk_client_ip(), $apiKeyId]);
}

function llnk_update_link_visit_session(PDO $pdo, array $record): void
{
    $gapSeconds = defined('LLNK_REQUEST_SESSION_GAP_SECONDS')
        ? max(60, (int)LLNK_REQUEST_SESSION_GAP_SECONDS)
        : 600;
    $cutoff = date('Y-m-d H:i:s', time() - $gapSeconds);
    $pdo->beginTransaction();
    try {
        $select = $pdo->prepare(
            'SELECT id
             FROM llnk_link_visit_sessions
             WHERE identity_key = ?
               AND first_seen_at >= CURRENT_DATE
               AND last_seen_at >= ?
             ORDER BY last_seen_at DESC
             LIMIT 1
             FOR UPDATE'
        );
        $select->execute([$record['identity_key'], $cutoff]);
        $sessionId = (int)($select->fetchColumn() ?: 0);
        if ($sessionId > 0) {
            $pdo->prepare(
                'UPDATE llnk_link_visit_sessions
                 SET visit_count = visit_count + 1,
                     user_agent = ?, referer = ?, request_uri = ?, accept_language = ?,
                     cf_country = ?, cf_ray = ?, last_seen_at = NOW()
                 WHERE id = ?'
            )->execute([
                $record['user_agent'], $record['referer'], $record['request_uri'],
                $record['accept_language'], $record['cf_country'], $record['cf_ray'], $sessionId,
            ]);
        } else {
            $pdo->prepare(
                'INSERT INTO llnk_link_visit_sessions
                 (identity_key, link_id, path_code, link_type, target_url, ip_address, user_agent,
                  referer, request_uri, accept_language, cf_country, cf_ray, method)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            )->execute([
                $record['identity_key'], $record['link_id'], $record['path_code'],
                $record['link_type'], $record['target_url'], $record['ip_address'],
                $record['user_agent'], $record['referer'], $record['request_uri'],
                $record['accept_language'], $record['cf_country'], $record['cf_ray'], $record['method'],
            ]);
        }
        $pdo->prepare('UPDATE llnk_links SET visit_count = visit_count + 1, last_visited_at = NOW() WHERE id = ?')
            ->execute([$record['link_id']]);
        $pdo->commit();
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $error;
    }
}

function llnk_record_visit(PDO $pdo, array $link): void
{
    $meta = llnk_request_meta();
    $record = [
        'identity_key' => hash('sha256', (int)$link['id'] . '|' . $meta['ip'] . '|' . $meta['method']),
        'link_id' => (int)$link['id'],
        'path_code' => (string)$link['path_code'],
        'link_type' => (string)$link['link_type'],
        'target_url' => (string)$link['target_url'],
        'ip_address' => $meta['ip'],
        'user_agent' => $meta['user_agent'],
        'referer' => $meta['referer'],
        'request_uri' => llnk_clip((string)($_SERVER['REQUEST_URI'] ?? '/'), 1024),
        'accept_language' => $meta['accept_language'],
        'cf_country' => $meta['cf_country'],
        'cf_ray' => $meta['cf_ray'],
        'method' => $meta['method'],
    ];
    llnk_security_query($pdo, static function () use ($pdo, $record): void {
        llnk_update_link_visit_session($pdo, $record);
    });
}
