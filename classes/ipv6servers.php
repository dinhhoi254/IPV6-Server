<?php
// Helper quản lý cụm server IPv6 — tương thích với options mã hoá AES hiện tại
// Dùng DB::get_row / get_list / insert / update / query (snake_case) và encryptAES/decryptAES

if (!function_exists('ipv6ServersList')) {
function ipv6ServersList($activeOnly = false) {
    if ($activeOnly) {
        return DB::get_list("SELECT * FROM ipv6_servers WHERE status=1 ORDER BY sort_order ASC, id ASC");
    }
    return DB::get_list("SELECT * FROM ipv6_servers ORDER BY sort_order ASC, id ASC");
}
}

if (!function_exists('ipv6ServerGet')) {
function ipv6ServerGet($id) {
    return DB::get_row("SELECT * FROM ipv6_servers WHERE id=" . intval($id));
}
}

if (!function_exists('ipv6ServerDecryptKey')) {
function ipv6ServerDecryptKey($row) {
    if (!$row) return '';
    $enc = $row['admin_key'] ?? '';
    if ($enc === '') return '';
    // thử decrypt AES, fallback plain nếu không phải base64 encrypted
    if (function_exists('decryptAES')) {
        $dec = decryptAES($enc);
        if ($dec !== '' && $dec !== false) return $dec;
    }
    return $enc;
}
}

if (!function_exists('ipv6ServerDecryptWebhook')) {
function ipv6ServerDecryptWebhook($row) {
    if (!$row) return '';
    $enc = $row['webhook_secret'] ?? '';
    if ($enc === '') return '';
    if (function_exists('decryptAES')) {
        $dec = decryptAES($enc);
        if ($dec !== '' && $dec !== false) return $dec;
    }
    return $enc;
}
}

if (!function_exists('ipv6ServerClient')) {
function ipv6ServerClient($row) {
    if (!$row) return null;
    if (!class_exists('Ipv6ProxyApi')) {
        // fallback: trả về mảng config thô
        return [
            'base_url' => $row['api_url'] ?? '',
            'api_key'  => ipv6ServerDecryptKey($row),
        ];
    }
    $url = rtrim($row['api_url'] ?? '', '/');
    $key = ipv6ServerDecryptKey($row);
    return new Ipv6ProxyApi($url, $key);
}
}

if (!function_exists('ipv6ServerDefault')) {
function ipv6ServerDefault() {
    $row = DB::get_row("SELECT * FROM ipv6_servers WHERE status=1 ORDER BY sort_order ASC, id ASC LIMIT 1");
    if ($row) return $row;
    // fallback options cũ nếu bảng rỗng
    $url = function_exists('ipv6ProxyOption') ? ipv6ProxyOption('ipv6_proxy_api_url', '') : '';
    if ($url === '') return null;
    return [
        'id' => 0,
        'name' => 'Default (options)',
        'api_url' => $url,
        'public_ip' => function_exists('ipv6ProxyOption') ? ipv6ProxyOption('ipv6_proxy_public_ip', '') : '',
        'admin_key' => function_exists('ipv6ProxyOption') ? ipv6ProxyOption('ipv6_proxy_admin_key', '') : '',
        'webhook_secret' => function_exists('ipv6ProxyOption') ? ipv6ProxyOption('ipv6_proxy_webhook_secret', '') : '',
        'location' => '',
        'status' => 1,
        'sort_order' => 0,
    ];
}
}

if (!function_exists('ipv6ServerOptions')) {
function ipv6ServerOptions($serverId = null) {
    // Lấy options từ bảng ipv6_servers nếu có rows, fallback về options table
    $cnt = 0;
    try { $r = DB::get_row("SELECT COUNT(*) as c FROM ipv6_servers"); $cnt = intval($r['c'] ?? 0); } catch (Exception $e) {}
    if ($cnt > 0) {
        $row = $serverId ? ipv6ServerGet($serverId) : ipv6ServerDefault();
        if ($row) {
            return [
                'api_url'        => $row['api_url'] ?? '',
                'public_ip'      => $row['public_ip'] ?? '',
                'admin_key'      => ipv6ServerDecryptKey($row),
                'webhook_secret' => ipv6ServerDecryptWebhook($row),
                'location'       => $row['location'] ?? '',
                'server_id'      => $row['id'] ?? 0,
                'server_name'    => $row['name'] ?? '',
            ];
        }
    }
    // fallback options cũ
    return [
        'api_url'        => function_exists('ipv6ProxyOption') ? ipv6ProxyOption('ipv6_proxy_api_url', '') : '',
        'public_ip'      => function_exists('ipv6ProxyOption') ? ipv6ProxyOption('ipv6_proxy_public_ip', '') : '',
        'admin_key'      => function_exists('ipv6ProxyAdminKey') ? ipv6ProxyAdminKey() : (function_exists('ipv6ProxyOption') ? ipv6ProxyOption('ipv6_proxy_admin_key','') : ''),
        'webhook_secret' => function_exists('ipv6ProxyWebhookSecret') ? ipv6ProxyWebhookSecret() : '',
        'location'       => '',
        'server_id'      => null,
        'server_name'    => 'Default',
    ];
}
}
