# Tài Liệu Tích Hợp — Đấu IPv6 Proxy API vào Web Chính

> Dành cho **developer web chính** (frontend + backend) tích hợp Proxy API làm microservice.
> Web chính gọi sang Proxy API qua HTTP nội bộ hoặc public, **không share DB**.

---

## 1. Tổng quan

```
[Browser] → [Web Chính (Next.js/PHP/Laravel...)]  —HTTP + X-API-Key→  [IPv6 Proxy API :8080]
                                              ←—— JSON ————————————
```

- **Base URL (production):** `http://127.0.0.1:8080` (nội bộ, sau Nginx) hoặc `https://proxy.example.com`
- **Auth:** Header `X-API-Key: <key>` — mỗi user = 1 key. Web chính có thể dùng 1 service key (admin) hoặc tạo key riêng cho từng end-user qua `/register`.
- **Content-Type:** `application/json`
- **Rate limit:** 100 req/phút / key (trả `429 RATE_LIMITED`)
- **CORS:** Mở theo `CORS_ORIGIN` trong `.env` (đặt domain web chính, VD: `https://webchinh.com`)

---

## 2. Xác thực

### 2.1 Luồng đề xuất

Có 2 cách:

**A. Web chính quản lý user, Proxy API chỉ là kho proxy (khuyên dùng):**

- Web chính tự có bảng `users` riêng, khi user mua proxy thì backend web chính gọi `POST /proxy/create` bằng **ADMIN_API_KEY** hoặc **service user key**.
- Không cần đồng bộ tài khoản — đơn giản nhất.

**B. Đồng bộ tài khoản (user web chính = user proxy API):**

- Khi user đăng ký trên web chính → gọi `POST /api/v1/user/register` sang Proxy API để tạo user + `api_key`.
- Lưu `api_key` vào DB web chính (`users.proxy_api_key`).
- Mọi thao tác proxy của user đó dùng `api_key` riêng.

Tài liệu này mô tả cả 2, web chính chọn 1.

### 2.2 Keys

| Key | Lấy từ | Dùng cho |
|---|---|---|
| `ADMIN_API_KEY` | `cat /opt/ipv6-proxy/.env \| grep ADMIN_API_KEY` | Admin: `topup`, `stats`, `orders`, và có thể `proxy/create` cho mọi user |
| `api_key` (user) | `POST /user/register` → `api_key` | Thao tác proxy của user đó |

### 2.3 Public endpoints (không cần key)

- `GET /health`
- `POST /api/v1/user/register`, `POST /api/v1/user/login`
- `POST /api/v1/webhook/payment`

Còn lại đều cần `X-API-Key`.

---

## 3. Endpoints chi tiết

### 3.1 `POST /api/v1/user/register`

Tạo user mới (chỉ dùng nếu chọn luồng B).

- **Body:** `{ "email": "a@b.com", "password": "P@ss123" }` — email unique, password ≥6 ký tự
- **201:** `{ "status":"success", "api_key":"ipx_...", "balance":0, "user_id":1 }`
- **400:** `{ "status":"error", "code":"EMAIL_EXISTS" }` hoặc `VALIDATION_ERROR`

### 3.2 `POST /api/v1/user/login`

- **Body:** `{ "email","password" }`
- **200:** `{ "status":"success", "api_key":"ipx_...", "balance": 12.5 }`
- **401:** `INVALID_CREDENTIALS`

### 3.3 `GET /api/v1/user/me` & `GET /api/v1/user/balance`

- **Header:** `X-API-Key: ipx_...`
- **200 `/me`:** `{ status, data: { id, email, balance, total_proxies, total_orders, created_at } }`
- **200 `/balance`:** `{ status:"success", balance: 12.5 }`

### 3.4 `POST /api/v1/user/regenerate-key`

Đổi key (thu hồi key cũ).

- **Header:** `X-API-Key: ipx_cũ`
- **200:** `{ status:"success", api_key:"ipx_mới" }`

### 3.5 `POST /api/v1/proxy/create` ⭐

Tạo order + proxy. **Trừ tiền ngay, cần check balance trước.**

- **Header:** `X-API-Key`
- **Body:**

```json
{
  "quantity": 10,
  "type": "static",
  "billing": "time",
  "duration_hours": 720,
  "traffic_limit_gb": 100,
  "rotation_interval": 60,
  "protocol": "socks5",
  "auth_mode": "auto",
  "request_id": "webchinh_ord_168xxx"
}
```

| Field | Bắt buộc | Ràng buộc | Ghi chú |
|---|---|---|---|
| `quantity` | có | 1–1000 | Số proxy |
| `type` | không | `static`/`rotating` (mặc định `static`) | Rotating = IP tự đổi |
| `billing` | không | `time`/`traffic` (mặc định `time`) | Cách tính tiền |
| `duration_hours` | khi `billing=time` | 1–8760 | Thời hạn |
| `traffic_limit_gb` | khi `billing=traffic` | 0.1–10000 | Giới hạn GB |
| `rotation_interval` | khi `type=rotating` | 10–86400 (giây) | Chu kỳ đổi IP |
| `protocol` | không | `socks5`/`http`/`both` (mặc định `socks5`) | `both` = 2 port (socks + http) |
| `auth_mode` | không | `auto`/`custom` | `custom` kèm `username`+`password` |
| `request_id` | không | chuỗi ≤64 | **Idempotency key — BẮT BUỘC khi tích hợp web chính** |

- **Tính giá:** `billing=time` → `quantity * duration_hours * PRICE_PER_IP_HOUR`; `billing=traffic` → `quantity * PRICE_PER_IP_TRAFFIC_MODE + traffic_limit_gb * PRICE_PER_GB`. Trả `400 INSUFFICIENT_BALANCE` nếu không đủ.
- **201:** 
```json
{
  "status":"success",
  "order_id":"ord_a1b2c3d4",
  "type":"static", "billing":"time",
  "expires_at":"2026-10-21T10:00:00.000Z",
  "price_charged":7.2,
  "proxies":[
    {
      "id":1, "ip":"2001:db8::a1b2", "port":30001,
      "protocol":"socks5", "username":"u_abc12345", "password":"p_xyz...",
      "type":"static",
      "socks5_url":"socks5://u_abc:...@160.187.246.219:30001",
      "http_url":"http://u_abc:...@160.187.246.219:30001"
    }
  ]
}
```
- **Lỗi:** `400 VALIDATION_ERROR`, `400 INSUFFICIENT_BALANCE`, `503 INSUFFICIENT_POOL`, `503 NO_PORTS`
- **Idempotency:** Gửi cùng `request_id` + cùng `X-API-Key` lần 2 → trả **kết quả cũ**, không trừ tiền lần 2. Web chính **phải** sinh `request_id` = mã đơn bên web chính (VD: `order_${webOrderId}`).

### 3.6 `GET /api/v1/proxy/list`

- **Query:** `status` (active/expired/cancelled/suspended), `order_id`, `page` (≥1), `limit` (1–200, mặc định 50)
- **200:** `{ status:"success", total, page, limit, data:[{id, order_id, ip, port, protocol, username, password, type, status, bytes_in, bytes_out, last_rotation, socks5_url, http_url}] }`

### 3.7 `GET /api/v1/proxy/usage?order_id=ord_xxx`

- **200:** `{ status, order_id, traffic_used_bytes, traffic_limit_gb, traffic_limit_bytes, billing, expires_at, proxies:[{id, ip, port, bytes_in, bytes_out, status}] }`

### 3.8 `POST /api/v1/proxy/rotate` — `{ proxy_id }`

Đổi IP mới cho 1 proxy (IP cũ vào cooldown 60s).

### 3.9 `POST /api/v1/proxy/renew` — `{ order_id, extend_hours }`

Chỉ `billing=time` + `status=active`. Trả `200 { status, order_id, expires_at, charged }`.

### 3.10 `DELETE /api/v1/proxy/delete`

- **Body:** `{ "order_id":"ord_..." }` **hoặc** `{ "proxy_ids":[1,2,3] }` (một trong hai, không gửi cả hai)
- **200:** `{ status:"success", message:"..." }`

### 3.11 `GET /health`

Không cần key. `{ status:"ok", uptime, proxies_active, version, timestamp }`

### 3.12 Admin (cần `ADMIN_API_KEY`)

| Endpoint | Mô tả |
|---|---|
| `GET /api/v1/admin/stats` | `{ users, orders_active, proxies_active, pool:{available,in_use,cooldown,total}, revenue }` |
| `GET /api/v1/admin/users?page=&limit=` | List users |
| `GET /api/v1/admin/orders?status=&page=&limit=` | List orders |
| `POST /api/v1/admin/user/:id/topup` `{amount, ref?}` | Nạp tiền cho user |
| `POST /api/v1/admin/user/:id/ban` / `unban` | Khoá/mở user |
| `POST /api/v1/admin/pool/add` `{ipv6, count?}` | Thêm IP vào pool |

---

## 4. Webhook thanh toán

Khi web chính nhận tiền (VNPay/MoMo/Bank), gọi sang Proxy API để cộng tiền.

```
POST /api/v1/webhook/payment
Content-Type: application/json
Body: { "user_email":"a@b.com", "amount":50, "ref":"txn_123", "signature":"..." }
```

- **Không cần** `X-API-Key`.
- **Chữ ký:** `HMAC-SHA256(WEBHOOK_SECRET, "user_email:amount:ref")` → hex. `amount` giữ nguyên dạng số như gửi (VD: `50`, không phải `50.00`).
- **Idempotency theo `ref`:** Gửi trùng `ref` + `type=deposit` → trả `{ Already processed }`, không cộng tiền lần 2.
- **404 USER_NOT_FOUND** nếu email chưa đăng ký.

### Node.js

```js
const crypto = require('crypto');
function sign(email, amount, ref, secret) {
  return crypto.createHmac('sha256', secret).update(`${email}:${amount}:${ref}`).digest('hex');
}
await fetch('https://proxy.example.com/api/v1/webhook/payment', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    user_email: 'a@b.com',
    amount: 50,
    ref: 'txn_' + Date.now(),
    signature: sign('a@b.com', 50, 'txn_...', process.env.WEBHOOK_SECRET),
  }),
}).then(r => r.json());
```

### PHP

```php
$sig = hash_hmac('sha256', "$email:$amount:$ref", getenv('WEBHOOK_SECRET'));
```

### Thay thế: gọi trực tiếp `POST /admin/user/:id/topup` bằng `ADMIN_API_KEY`

Nếu không muốn ký HMAC, web chính có thể tự lookup `user_id` rồi:

```
POST /api/v1/admin/user/123/topup
X-API-Key: admin_xxx
Body: { "amount": 50, "ref": "txn_123" }
```

---

## 5. Mã lỗi chuẩn

Mọi lỗi trả:

```json
{ "status":"error", "code":"INSUFFICIENT_BALANCE", "message":"Need $7.20, have $1.00" }
```

| HTTP | code | Khi nào |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Thiếu/sai field (xem `message`) |
| 401 | `UNAUTHORIZED` | Thiếu `X-API-Key` |
| 401 | `INVALID_API_KEY` | Sai key hoặc user bị `is_active=0` |
| 401 | `INVALID_SIGNATURE` | Webhook sai chữ ký |
| 403 | `FORBIDDEN` | Proxy/order không thuộc user, hoặc thiếu admin |
| 404 | `NOT_FOUND` | Route/order/proxy không tồn tại |
| 404 | `USER_NOT_FOUND` | Webhook email không khớp user |
| 429 | `RATE_LIMITED` | Quá 100 req/phút |
| 503 | `INSUFFICIENT_POOL` | Hết IPv6 available |
| 503 | `NO_PORTS` | Hết port 30000-40000 |
| 500 | `INTERNAL_ERROR` | Lỗi server |

Web chính nên map `code` để hiện thông báo tiếng Việt, không hiện `message` gốc cho user.

---

## 6. Ví dụ tích hợp đầy đủ (Node.js/Express — Web chính)

```js
// webchinh/src/proxyClient.js
const BASE = process.env.PROXY_API_URL; // https://proxy.example.com
const ADMIN_KEY = process.env.PROXY_ADMIN_KEY; // admin_xxx
const WEBHOOK_SECRET = process.env.PROXY_WEBHOOK_SECRET;

async function proxyFetch(path, { method='GET', apiKey, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json.message || 'Proxy API error');
    err.code = json.code; err.status = res.status; err.json = json;
    throw err;
  }
  return json;
}

// Khi user bấm "Mua 10 proxy 30 ngày"
async function handleBuyProxy(user) {
  // user.proxyApiKey đã lưu khi register (luồng B), hoặc dùng ADMIN_KEY (luồng A)
  const apiKey = user.proxyApiKey || ADMIN_KEY;

  // 1. Check số dư
  const me = await proxyFetch('/api/v1/user/me', { apiKey });
  // hoặc: await proxyFetch('/api/v1/user/balance', { apiKey });

  // 2. Tạo order — request_id = mã đơn web chính để idempotent
  const order = await proxyFetch('/api/v1/proxy/create', {
    method: 'POST',
    apiKey,
    body: {
      quantity: 10,
      type: 'static',
      billing: 'time',
      duration_hours: 720,
      protocol: 'socks5',
      request_id: `web_${user.id}_${Date.now()}`, // unique
    },
  });

  // 3. Lưu order_id + proxies vào DB web chính
  await db.orders.create({
    userId: user.id,
    proxyOrderId: order.order_id,
    proxies: order.proxies, // lưu JSON
    expiresAt: order.expires_at,
  });

  return order;
}

// Khi thanh toán thành công (callback VNPay, v.v.)
async function handlePaymentSuccess(userEmail, amount, txnRef) {
  const crypto = require('crypto');
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET)
    .update(`${userEmail}:${amount}:${txnRef}`).digest('hex');

  return proxyFetch('/api/v1/webhook/payment', {
    method: 'POST',
    body: { user_email: userEmail, amount, ref: txnRef, signature: sig },
  });
}
```

**PHP/Laravel:**

```php
use Illuminate\Support\Facades\Http;

$base = env('PROXY_API_URL');
$res = Http::withHeaders(['X-API-Key' => $user->proxy_api_key])
  ->post("$base/api/v1/proxy/create", [
    'quantity' => 10,
    'type' => 'static',
    'billing' => 'time',
    'duration_hours' => 720,
    'protocol' => 'socks5',
    'request_id' => "web_{$user->id}_" . time(),
  ]);
if ($res->failed()) {
  $code = $res->json('code'); // INSUFFICIENT_BALANCE, etc.
  throw new Exception($res->json('message'), $res->status());
}
$order = $res->json();
```

---

## 7. Frontend (Web chính)

- `GET /user/me`, `/proxy/list`, `/proxy/usage`, `POST /proxy/rotate|renew`, `DELETE /proxy/delete` — proxy trực tiếp qua backend web chính, **không gọi Proxy API từ browser** (tránh lộ `X-API-Key`).
- Backend web chính làm gateway:

```
Browser → Web Chính /api/proxies/* → Proxy API
```

- Hiển thị proxy dạng bảng: `IP:PORT — USER:PASS — Copy SOCKS5 URL — Copy HTTP URL — Rotate — Delete`.
- Nút "Copy" copy `socks5_url` / `http_url` trả về từ `create/list`.
- Khi `billing=traffic`, hiện progress `traffic_used_bytes / traffic_limit_bytes` và cảnh báo khi gần vượt.

---

## 8. Checklist đấu nối

- [ ] Đặt `PROXY_API_URL`, `PROXY_ADMIN_KEY`, `PROXY_WEBHOOK_SECRET` trong `.env` web chính
- [ ] Mở firewall / security group: web chính → Proxy API (port 8080 hoặc 443 nếu qua Nginx)
- [ ] Đặt `CORS_ORIGIN=https://webchinh.com` trong `.env` của Proxy API (nếu browser gọi trực tiếp, không khuyến khích)
- [ ] Test `GET /health` từ web chính
- [ ] Test `POST /user/register` + `POST /proxy/create` với `quantity=1` trên staging
- [ ] Lưu `api_key` / `order_id` / `request_id` vào DB web chính
- [ ] Webhook: test `POST /webhook/payment` với chữ ký đúng/sai, test trùng `ref`
- [ ] Xử lý lỗi: map `code` → thông báo TV, retry khi `429` (backoff 60s), báo admin khi `503`
- [ ] Idempotency: mọi `proxy/create` từ web chính **phải** gửi `request_id`
- [ ] Không log `X-API-Key`, `password` ra file/log browser
- [ ] Health check định kỳ: cron 5 phút `GET /health` + alert khi `status != ok`

---

## 9. Vận hành & Debug

Từ web chính có thể gọi sang để debug:

```bash
# Health
curl -s https://proxy.example.com/health | jq .

# Stats (admin)
curl -s https://proxy.example.com/api/v1/admin/stats -H "X-API-Key: admin_xxx" | jq .

# Pool
curl -s https://proxy.example.com/api/v1/admin/stats -H "X-API-Key: admin_xxx" | jq .pool
```

Log Proxy API: `pm2 logs ipv6-proxy-api` trên VPS Proxy.

---

## 10. Bảo mật

- `X-API-Key` và `ADMIN_API_KEY` là bí mật — chỉ lưu trong `.env` server, không trả về client.
- `WEBHOOK_SECRET` dùng HMAC — không hardcode trong frontend.
- Proxy API chỉ listen `127.0.0.1:8080`, ra ngoài qua Nginx + HTTPS + `helmet`.
- Rate limit 100 req/phút/key — web chính nên debounce/gộp request.

