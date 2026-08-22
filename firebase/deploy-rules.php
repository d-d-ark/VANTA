<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli' || count($argv) !== 3) {
    fwrite(STDERR, "Usage: php deploy-rules.php <private-config.php> <database.rules.json>\n");
    exit(2);
}

$configPath = (string)$argv[1];
$rulesPath = (string)$argv[2];
if (!is_file($configPath) || !is_file($rulesPath)) {
    fwrite(STDERR, "Firebase deployment input is missing.\n");
    exit(2);
}

require $configPath;

function deploy_base64url(string $value): string
{
    return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
}

function deploy_http_status(array $headers): int
{
    foreach (array_reverse($headers) as $header) {
        if (preg_match('/^HTTP\/\S+\s+(\d{3})/', $header, $matches) === 1) {
            return (int)$matches[1];
        }
    }
    return 0;
}

function deploy_request(string $url, string $method, string $content, string $contentType): array
{
    $context = stream_context_create(['http' => [
        'method' => $method,
        'header' => "Content-Type: {$contentType}\r\nAccept: application/json",
        'content' => $content,
        'ignore_errors' => true,
        'timeout' => 30,
    ]]);
    $response = file_get_contents($url, false, $context);
    $headers = $http_response_header ?? [];
    return [deploy_http_status($headers), is_string($response) ? $response : ''];
}

$clientEmail = trim((string)constant('LLNK_VANTA_FIREBASE_CLIENT_EMAIL'));
$databaseUrl = rtrim(trim((string)constant('LLNK_VANTA_FIREBASE_DATABASE_URL')), '/');
$privateKeyPem = base64_decode((string)constant('LLNK_VANTA_FIREBASE_PRIVATE_KEY_BASE64'), true);
if ($clientEmail === '' || $databaseUrl === '' || !is_string($privateKeyPem) || $privateKeyPem === '') {
    fwrite(STDERR, "Firebase service account configuration is invalid.\n");
    exit(2);
}

$now = time();
$header = deploy_base64url((string)json_encode(['alg' => 'RS256', 'typ' => 'JWT']));
$claims = deploy_base64url((string)json_encode([
    'iss' => $clientEmail,
    'scope' => 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    'aud' => 'https://oauth2.googleapis.com/token',
    'iat' => $now,
    'exp' => $now + 3600,
], JSON_UNESCAPED_SLASHES));
$unsigned = $header . '.' . $claims;
$signature = '';
$privateKey = openssl_pkey_get_private($privateKeyPem);
if ($privateKey === false || !openssl_sign($unsigned, $signature, $privateKey, OPENSSL_ALGO_SHA256)) {
    fwrite(STDERR, "Firebase OAuth assertion signing failed.\n");
    exit(1);
}
$assertion = $unsigned . '.' . deploy_base64url($signature);

[$tokenStatus, $tokenBody] = deploy_request(
    'https://oauth2.googleapis.com/token',
    'POST',
    http_build_query([
        'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        'assertion' => $assertion,
    ]),
    'application/x-www-form-urlencoded'
);
$tokenPayload = json_decode($tokenBody, true);
if ($tokenStatus !== 200 || !is_array($tokenPayload) || empty($tokenPayload['access_token'])) {
    fwrite(STDERR, "Firebase OAuth token request failed ({$tokenStatus}).\n");
    exit(1);
}

$rulesText = file_get_contents($rulesPath);
$rules = is_string($rulesText) ? json_decode($rulesText, true) : null;
if (!is_string($rulesText) || !is_array($rules) || !isset($rules['rules'])) {
    fwrite(STDERR, "Firebase rules JSON is invalid.\n");
    exit(2);
}
$rulesUrl = $databaseUrl . '/.settings/rules.json?access_token=' . rawurlencode((string)$tokenPayload['access_token']);
[$putStatus, $putBody] = deploy_request($rulesUrl, 'PUT', $rulesText, 'application/json');
if ($putStatus !== 200) {
    $message = preg_replace('/[\r\n]+/', ' ', substr($putBody, 0, 500));
    fwrite(STDERR, "Firebase rules update failed ({$putStatus}): {$message}\n");
    exit(1);
}

[$getStatus, $getBody] = deploy_request($rulesUrl, 'GET', '', 'application/json');
$deployedRules = json_decode($getBody, true);
if ($getStatus !== 200 || $deployedRules !== $rules) {
    fwrite(STDERR, "Firebase rules readback verification failed.\n");
    exit(1);
}

echo 'PASS: Firebase Realtime Database rules deployed and verified (' . hash('sha256', $rulesText) . ")\n";
