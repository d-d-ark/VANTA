<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli' || count($argv) !== 2 || !is_file((string)$argv[1])) {
    fwrite(STDERR, "Usage: php inspect-rooms.php <private-config.php>\n");
    exit(2);
}

require (string)$argv[1];
require dirname(__DIR__, 2) . '/01-LLNKKR/Development/Server/api/v1/vanta/lib.php';

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
$rooms = $pdo->query(
    'SELECT room_id, created_at, checked_at
     FROM llnk_vanta_rooms
     ORDER BY created_at DESC
     LIMIT 8'
)->fetchAll(PDO::FETCH_ASSOC) ?: [];
$serverToken = vanta_server_id_token();
$output = [];
foreach ($rooms as $room) {
    $roomId = vanta_room_id((string)($room['room_id'] ?? ''));
    if ($roomId === '') {
        continue;
    }
    $remote = vanta_firebase_session_request('GET', $roomId, $serverToken);
    $body = is_array($remote['body']) ? $remote['body'] : null;
    $projectJson = json_encode($body['snapshot']['project'] ?? null);
    $output[] = [
        'room_hash' => substr(hash('sha256', $roomId), 0, 12),
        'registered_at' => $room['created_at'] ?? null,
        'checked_at' => $room['checked_at'] ?? null,
        'firebase_status' => $remote['status'],
        'exists' => $body !== null,
        'revision' => (int)($body['snapshot']['revision'] ?? 0),
        'project_bytes' => is_string($projectJson) ? strlen($projectJson) : 0,
        'active_participants' => vanta_active_participant_count($body),
    ];
}

echo json_encode($output, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
