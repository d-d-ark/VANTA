<?php
declare(strict_types=1);

require_once dirname(__DIR__, 3) . '/llnk_lib.php';
require_once __DIR__ . '/lib.php';

vanta_cors();
if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'POST') {
    header('Allow: POST, OPTIONS');
    llnk_fail('POST requests only.', 405);
}
vanta_require_current_client();

$declaredLength = trim((string)($_SERVER['CONTENT_LENGTH'] ?? ''));
if ($declaredLength !== ''
    && (preg_match('/^[0-9]+$/', $declaredLength) !== 1 || (int)$declaredLength > 4096)) {
    llnk_fail('Live 커서 요청이 너무 큽니다.', 413);
}
$raw = file_get_contents('php://input', false, null, 0, 4097);
if (!is_string($raw) || $raw === '' || strlen($raw) > 4096) {
    llnk_fail('Live 커서 요청이 너무 크거나 비어 있습니다.', 413);
}
$input = json_decode($raw, true);
if (!is_array($input) || json_last_error() !== JSON_ERROR_NONE) {
    llnk_fail('Live 커서 요청 형식이 올바르지 않습니다.', 422);
}

$authorizedRoom = false;
$roomId = '';
function vanta_disable_live_cursor_room(string $roomId): void
{
    if (vanta_room_id($roomId) === '') return;
    try {
        $serverIdToken = vanta_server_id_token();
        vanta_firebase_session_path_request(
            'PATCH',
            $roomId,
            'meta',
            $serverIdToken,
            ['liveCursor' => false]
        );
    } catch (Throwable $error) {
        error_log('[LLNKKR VANTA cursor access fallback] ' . $error->getMessage());
    }
}

try {
    vanta_assert_allowed_keys($input, ['roomId', 'installationId', 'participantId'], 'cursor access');
    $roomId = vanta_room_id((string)($input['roomId'] ?? ''));
    $installationId = vanta_installation_id((string)($input['installationId'] ?? ''));
    $participantId = vanta_participant_id((string)($input['participantId'] ?? ''));
    if ($roomId === '' || $installationId === '' || $participantId === '') {
        throw new InvalidArgumentException('Live 커서 요청 정보가 올바르지 않습니다.');
    }
    $identity = vanta_assert_sync_identity(
        vanta_request_sync_token(),
        $roomId,
        $participantId,
        $installationId
    );
    $pdo = llnk_db();
    llnk_create_security_schema($pdo);
    vanta_create_usage_schema($pdo);
    $shards = vanta_use_room_shards($pdo, $roomId);
    $serverIdToken = vanta_server_id_token();
    if (vanta_read_scalar($roomId, 'meta/liveCursor', $serverIdToken) !== true) {
        llnk_fail('이 방에서는 Live 커서를 사용하지 않습니다.', 409);
    }
    $participants = vanta_read_participants($roomId, $serverIdToken);
    if (!vanta_has_active_participant($participants, $identity['uid'], $participantId, 3)) {
        llnk_fail('활성 VANTA 참여자만 Live 커서를 사용할 수 있습니다.', 403);
    }
    $installationHash = hash('sha256', $installationId);
    $presence = $pdo->prepare(
        'SELECT 1 FROM llnk_vanta_presence
         WHERE room_id = ? AND participant_id = ? AND installation_hash = ?
           AND expires_at > NOW() LIMIT 1'
    );
    $presence->execute([$roomId, $participantId, $installationHash]);
    if ($presence->fetchColumn() === false) {
        llnk_fail('활성 VANTA 참여자만 Live 커서를 사용할 수 있습니다.', 403);
    }
    $authorizedRoom = true;
    if (!vanta_cursor_direct_enabled($pdo)) {
        llnk_fail('현재 Live 커서를 사용할 수 없습니다.', 503);
    }
    $ip = llnk_client_ip();
    if ($ip === '' || llnk_active_block_retry_after($pdo, 'request_abuse', $ip) > 0
        || !vanta_take_cursor_live_access_limits($pdo, $ip, $installationId)) {
        header('Retry-After: 60');
        llnk_fail('Live 커서 연결 요청이 너무 많습니다.', 429);
    }
    $pdo->exec(
        'DELETE FROM llnk_vanta_cursor_leases
         WHERE accounted_until < DATE_SUB(NOW(), INTERVAL 1 DAY) LIMIT 100'
    );
    $pdo->beginTransaction();
    try {
        $pdo->prepare(
            'INSERT IGNORE INTO llnk_vanta_cursor_leases
             (room_id, participant_id, installation_hash, ip_address, accounted_until)
             VALUES (?, ?, ?, ?, FROM_UNIXTIME(1))'
        )->execute([$roomId, $participantId, $installationHash, $ip]);
        $leaseStatement = $pdo->prepare(
            'SELECT installation_hash, ip_address,
                    CAST(UNIX_TIMESTAMP(accounted_until) * 1000 AS UNSIGNED) AS accounted_until_ms
             FROM llnk_vanta_cursor_leases
             WHERE room_id = ? AND participant_id = ? FOR UPDATE'
        );
        $leaseStatement->execute([$roomId, $participantId]);
        $lease = $leaseStatement->fetch(PDO::FETCH_ASSOC) ?: [];
        $nowMs = (int)round(microtime(true) * 1000);
        $paidUntil = max(0, (int)($lease['accounted_until_ms'] ?? 0));
        $reusePaidLease = isset($lease['installation_hash'], $lease['ip_address'])
            && hash_equals((string)$lease['installation_hash'], $installationHash)
            && hash_equals((string)$lease['ip_address'], $ip)
            && $paidUntil > $nowMs + 60000;
        if ($reusePaidLease) {
            $quota = vanta_usage_status($pdo, $ip);
            $expiresAt = $paidUntil;
        } else {
            $quota = vanta_usage_reserve(
                $pdo,
                $ip,
                VANTA_CURSOR_DIRECT_ACCESS_BYTES,
                'cursor',
                $roomId,
                $participantId,
                strlen($raw)
            );
            vanta_usage_require($quota);
            $expiresAt = (time() + VANTA_CURSOR_DIRECT_ACCESS_SECONDS) * 1000;
        }
        $access = vanta_cursor_direct_access($identity, $expiresAt);
        if (!$reusePaidLease) {
            $pdo->prepare(
                'UPDATE llnk_vanta_cursor_leases
                 SET installation_hash = ?, ip_address = ?, accounted_until = FROM_UNIXTIME(?)
                 WHERE room_id = ? AND participant_id = ?'
            )->execute([
                $installationHash,
                $ip,
                intdiv($expiresAt, 1000),
                $roomId,
                $participantId,
            ]);
        }
        $pdo->commit();
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $error;
    }
    llnk_ok([
        'roomId' => $roomId,
        'participantId' => $participantId,
        'idToken' => $access['idToken'],
        'expiresAt' => $access['expiresAt'],
        'databaseUrl' => $access['databaseUrl'],
        'shard' => $shards['cursor'],
        'quota' => $quota,
    ]);
} catch (VantaQuotaException $error) {
    header('Retry-After: ' . vanta_quota_retry_after($error->quota()));
    header('X-VANTA-Tokens-Remaining: 0');
    llnk_fail(vanta_quota_exhausted_message($error->quota()), 429);
} catch (VantaSyncAuthException $error) {
    llnk_fail('Live 커서 인증이 만료되었거나 올바르지 않습니다.', 401);
} catch (InvalidArgumentException $error) {
    llnk_fail($error->getMessage(), 422);
} catch (Throwable $error) {
    error_log('VANTA cursor access: ' . $error->getMessage());
    llnk_fail('Live 커서 서버를 사용할 수 없습니다.', 503);
}
