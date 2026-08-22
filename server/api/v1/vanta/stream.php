<?php
declare(strict_types=1);

require_once dirname(__DIR__, 3) . '/llnk_lib.php';
require_once __DIR__ . '/lib.php';

vanta_cors(['GET', 'OPTIONS']);
if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'GET') {
    header('Allow: GET, OPTIONS');
    llnk_fail('GET requests only.', 405);
}
vanta_require_current_client();

$pdo = null;
$streamLock = '';
try {
    $roomId = vanta_room_id((string)($_GET['roomId'] ?? ''));
    $installationId = vanta_installation_id((string)($_GET['installationId'] ?? ''));
    $participantId = vanta_participant_id((string)($_GET['participantId'] ?? ''));
    $channel = strtolower(trim((string)($_GET['channel'] ?? '')));
    $syncVersion = (int)($_GET['syncVersion'] ?? 0);
    $channels = [
        'participants' => 'participants',
        'chat' => 'chat/messages',
        'meta' => 'meta',
        'latest' => 'snapshot/latest',
        'all' => '',
    ];
    if ($roomId === ''
        || $installationId === ''
        || $participantId === ''
        || !isset($channels[$channel])
        || $syncVersion !== 2) {
        throw new InvalidArgumentException('Invalid VANTA stream request.');
    }
    $identity = vanta_assert_sync_identity(
        vanta_request_sync_token(),
        $roomId,
        $participantId,
        $installationId
    );
    $pdo = llnk_db();
    vanta_use_room_shards($pdo, $roomId);
    llnk_create_security_schema($pdo);
    $ip = llnk_client_ip();
    if ($ip === '') {
        llnk_fail('Request address could not be verified.', 400);
    }
    $blockedFor = llnk_active_block_retry_after($pdo, 'request_abuse', $ip);
    if ($blockedFor > 0) {
        header('Retry-After: ' . $blockedFor);
        llnk_fail('This request address is temporarily blocked.', 429);
    }
    $serverIdToken = vanta_server_id_token();
    $participants = vanta_read_participants($roomId, $serverIdToken);
    if (!vanta_has_active_participant($participants, $identity['uid'], $participantId, 3)) {
        llnk_fail('Active VANTA participants only.', 403);
    }
    vanta_require_active_presence($pdo, $roomId, $participantId, $installationId);
    $streamLock = vanta_acquire_stream_lock($pdo, $roomId, $participantId);
    if ($streamLock === '') {
        header('Retry-After: 2');
        llnk_fail('A VANTA real-time stream is already open for this participant.', 429);
    }
    register_shutdown_function(static function () use ($pdo, &$streamLock): void {
        if ($streamLock !== '') {
            vanta_release_stream_lock($pdo, $streamLock);
            $streamLock = '';
        }
    });
    // Count only streams that actually acquired the participant lock. A stale
    // connection can otherwise make older clients retry until they exhaust the
    // open limit before the original stream has had time to shut down.
    $limit = vanta_take_stream_limits(
        $pdo,
        $ip,
        $installationId,
        $roomId,
        $participantId
    );
    if (!$limit['allowed']) {
        header('Retry-After: ' . $limit['retry_after']);
        llnk_add_security_event(
            $pdo,
            'vanta_stream_rate_limited',
            'notice',
            'vanta_stream',
            $ip,
            'request_rejected',
            ['limit_scope' => $limit['scope']]
        );
        llnk_fail('VANTA stream connections are temporarily limited.', 429);
    }
    if (!function_exists('curl_init')) {
        throw new RuntimeException('Streaming transport is unavailable.');
    }

    header('Content-Type: text/event-stream; charset=utf-8');
    header('Cache-Control: no-cache, no-store, must-revalidate');
    header('Connection: keep-alive');
    header('X-Accel-Buffering: no');
    while (ob_get_level() > 0) {
        @ob_end_flush();
    }
    @set_time_limit(60);
    // Let a disconnected browser terminate this request immediately so the
    // advisory lock is released by the shutdown handler instead of lingering.
    ignore_user_abort(false);

    if ($channel === 'all') {
        $sources = [
            'participants' => vanta_firebase_session_url($roomId, 'participants', $serverIdToken),
            'chat' => vanta_cursor_chat_firebase_url($roomId, 'messages'),
            'meta' => vanta_firebase_session_url($roomId, 'meta', $serverIdToken),
            'latest' => vanta_firebase_session_url(
                $roomId,
                'snapshot/latest',
                $serverIdToken
            ),
        ];
        $multi = curl_multi_init();
        $handles = [];
        $buffers = [];
        foreach ($sources as $sourceName => $sourceUrl) {
            $buffers[$sourceName] = '';
            $handle = curl_init($sourceUrl);
            curl_setopt_array($handle, [
                CURLOPT_HTTPHEADER => ['Accept: text/event-stream', 'Cache-Control: no-cache'],
                CURLOPT_RETURNTRANSFER => false,
                CURLOPT_CONNECTTIMEOUT => 5,
                CURLOPT_TIMEOUT => 55,
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_WRITEFUNCTION => static function ($curlHandle, string $chunk) use (
                    $sourceName,
                    &$buffers
                ): int {
                    $buffers[$sourceName] .= $chunk;
                    while (preg_match('/^(.*?)(?:\r?\n){2}/s', $buffers[$sourceName], $matches) === 1) {
                        $block = $matches[1];
                        $buffers[$sourceName] = substr($buffers[$sourceName], strlen($matches[0]));
                        $event = 'message';
                        $data = [];
                        foreach (preg_split('/\r?\n/', $block) ?: [] as $line) {
                            if (strpos($line, 'event:') === 0) {
                                $event = trim(substr($line, 6));
                            } elseif (strpos($line, 'data:') === 0) {
                                $data[] = ltrim(substr($line, 5));
                            }
                        }
                        if (!$data || $event === 'keep-alive') {
                            continue;
                        }
                        $decoded = json_decode(implode("\n", $data), true);
                        if (json_last_error() !== JSON_ERROR_NONE) {
                            continue;
                        }
                        $encoded = json_encode([
                            'channel' => $sourceName,
                            'payload' => $decoded,
                        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                        if (is_string($encoded)) {
                            echo 'event: ' . $event . "\n";
                            echo 'data: ' . $encoded . "\n\n";
                            @flush();
                        }
                    }
                    return strlen($chunk);
                },
            ]);
            $handles[$sourceName] = $handle;
            curl_multi_add_handle($multi, $handle);
        }
        $running = null;
        $startedAt = microtime(true);
        do {
            $status = curl_multi_exec($multi, $running);
            if ($status !== CURLM_OK) {
                break;
            }
            if ($running > 0) {
                $selected = curl_multi_select($multi, 1.0);
                if ($selected === -1) {
                    usleep(10000);
                }
            }
        } while ($running > 0 && microtime(true) - $startedAt < 55 && !connection_aborted());
        foreach ($handles as $handle) {
            curl_multi_remove_handle($multi, $handle);
            curl_close($handle);
        }
        curl_multi_close($multi);
        vanta_release_stream_lock($pdo, $streamLock);
        $streamLock = '';
        return;
    }
    $url = $channel === 'chat'
        ? vanta_cursor_chat_firebase_url($roomId, 'messages')
        : vanta_firebase_session_url($roomId, $channels[$channel], $serverIdToken);
    $curl = curl_init($url);
    curl_setopt_array($curl, [
        CURLOPT_HTTPHEADER => ['Accept: text/event-stream', 'Cache-Control: no-cache'],
        CURLOPT_RETURNTRANSFER => false,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 55,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk): int {
            echo $chunk;
            @flush();
            return strlen($chunk);
        },
    ]);
    $ok = curl_exec($curl);
    $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $error = curl_error($curl);
    curl_close($curl);
    if ($ok === false || $status < 200 || $status >= 300) {
        error_log('[LLNKKR VANTA stream] upstream=' . $status . ' ' . $error);
    }
    vanta_release_stream_lock($pdo, $streamLock);
    $streamLock = '';
} catch (VantaSyncAuthException $error) {
    llnk_fail('VANTA authorization expired or is invalid.', 401);
} catch (InvalidArgumentException $error) {
    llnk_fail($error->getMessage(), 422);
} catch (Throwable $error) {
    error_log('[LLNKKR VANTA stream] ' . $error->getMessage());
    llnk_fail('VANTA stream is unavailable.', 503);
}
