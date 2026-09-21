# Hướng Dẫn Sử Dụng — IPv6 Proxy API

> Dành cho **người dùng cuối** mua và sử dụng proxy. Không cần biết DEV.

---

## 1. Proxy là gì?

Proxy là cổng trung gian giúp bạn truy cập Internet bằng một địa chỉ IP khác.
Dịch vụ này cấp cho bạn **IPv6 riêng** (1 IP / 1 proxy), dùng qua giao thức **SOCKS5** hoặc **HTTP**.

Mỗi proxy gồm:
```
IP:PORT:USERNAME:PASSWORD
Ví dụ: 160.187.246.219:30001:u_a1b2c3d4:p_9f8e7d6c5b4a
```

---

## 2. Tài khoản & Đăng nhập

### 2.1 Đăng ký

```bash
curl -X POST https://proxy.example.com/api/v1/user/register \
  -H "Content-Type: application/json" \
  -d '{"email":"ban@example.com","password":"MatKhau123"}'
```

Trả về:
```json
{ "status":"success", "api_key":"ipx_abc123...", "balance":0 }
```

> **Lưu `api_key` cẩn thận** — mọi request sau đều dùng nó trong header `X-API-Key`.

### 2.2 Đăng nhập (lấy lại key)

```bash
curl -X POST https://proxy.example.com/api/v1/user/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ban@example.com","password":"MatKhau123"}'
```

### 2.3 Xem số dư & thông tin

```bash
# Header bắt buộc: X-API-Key: ipx_xxx
curl https://proxy.example.com/api/v1/user/me -H "X-API-Key: ipx_xxx"
curl https://proxy.example.com/api/v1/user/balance -H "X-API-Key: ipx_xxx"
```

---

## 3. Nạp tiền

Liên hệ admin hoặc thanh toán qua cổng được tích hợp trên web chính.
Sau khi thanh toán, số dư `balance` sẽ tự tăng — kiểm tra bằng `/balance`.

Webhook nạp tiền tự động (dành cho admin/web chính, không cần làm tay):
```
POST /api/v1/webhook/payment  {user_email, amount, ref, signature}
```

---

## 4. Mua Proxy

### 4.1 Các lựa chọn khi mua

| Tham số | Giá trị | Giải thích |
|---|---|---|
| `quantity` | 1–1000 | Số proxy cần mua (1 proxy = 1 IP + 1 port) |
| `type` | `static` / `rotating` | `static` = IP cố định đến khi hết hạn; `rotating` = IP tự đổi theo chu kỳ |
| `billing` | `time` / `traffic` | `time` = trả theo giờ; `traffic` = trả theo GB sử dụng |
| `duration_hours` | số giờ | Bắt buộc khi `billing=time` (VD: 24, 720 = 30 ngày) |
| `traffic_limit_gb` | số GB | Bắt buộc khi `billing=traffic` |
| `rotation_interval` | giây (≥10) | Bắt buộc khi `type=rotating` — chu kỳ đổi IP (VD: 60 = 1 phút) |
| `protocol` | `socks5` / `http` / `both` | Giao thức proxy |
| `auth_mode` | `auto` / `custom` | `auto` = hệ thống tự sinh user/pass; `custom` = bạn tự đặt |

**Giá** cấu hình trong `.env`:
- `PRICE_PER_IP_HOUR` — giá 1 IP / 1 giờ (VD: $0.01)
- `PRICE_PER_GB` — giá 1 GB traffic

### 4.2 Ví dụ mua

**Mua 10 proxy tĩnh, dùng 30 ngày:**

```bash
curl -X POST https://proxy.example.com/api/v1/proxy/create \
  -H "X-API-Key: ipx_xxx" -H "Content-Type: application/json" \
  -d '{
    "quantity": 10,
    "type": "static",
    "billing": "time",
    "duration_hours": 720,
    "protocol": "socks5"
  }'
```

**Mua 5 proxy xoay, đổi IP mỗi 5 phút:**

```bash
curl -X POST https://proxy.example.com/api/v1/proxy/create \
  -H "X-API-Key: ipx_xxx" -H "Content-Type: application/json" \
  -d '{
    "quantity": 5,
    "type": "rotating",
    "billing": "time",
    "duration_hours": 24,
    "rotation_interval": 300,
    "protocol": "socks5"
  }'
```

**Mua 20 proxy tính tiền theo dung lượng 100GB:**

```bash
curl -X POST https://proxy.example.com/api/v1/proxy/create \
  -H "X-API-Key: ipx_xxx" -H "Content-Type: application/json" \
  -d '{
    "quantity": 20,
    "type": "static",
    "billing": "traffic",
    "traffic_limit_gb": 100,
    "protocol": "socks5"
  }'
```

Trả về:
```json
{
  "status": "success",
  "order_id": "ord_a1b2c3d4",
  "type": "static",
  "billing": "time",
  "expires_at": "2026-10-21T10:00:00Z",
  "price_charged": 7.2,
  "proxies": [
    {
      "id": 1,
      "ip": "2001:db8:abcd:1234::a1b2",
      "port": 30001,
      "protocol": "socks5",
      "username": "u_abc12345",
      "password": "p_xyz98765432",
      "socks5_url": "socks5://u_abc12345:p_xyz98765432@160.187.246.219:30001",
      "http_url": "http://u_abc12345:p_xyz98765432@160.187.246.219:30001"
    }
  ]
}
```

> Lưu `order_id` để gia hạn / xem traffic / xoá.
> Gửi kèm `request_id` (chuỗi ngẫu nhiên của bạn) để tránh bị trừ tiền 2 lần khi bấm mua 2 lần do mạng lag — hệ thống sẽ trả kết quả cũ nếu `request_id` trùng.

---

## 5. Sử dụng Proxy

### 5.1 Test nhanh bằng curl

```bash
curl -x socks5h://u_abc12345:p_xyz98765432@160.187.246.219:30001 https://ifconfig.co
# Phải trả về IPv6 của proxy, ví dụ: 2001:db8:abcd:1234::a1b2
```

HTTP proxy:
```bash
curl -x http://u_abc12345:p_xyz98765432@160.187.246.219:30001 https://ifconfig.co
```

### 5.2 Dùng trong trình duyệt

Cài extension **SwitchyOmega** (Chrome) hoặc **FoxyProxy** (Firefox):
- Type: SOCKS5, Host: `160.187.246.219`, Port: `30001`, User/Pass như trên.

### 5.3 Dùng trong code (Python ví dụ)

```python
import requests

proxy = "socks5h://u_abc12345:p_xyz98765432@160.187.246.219:30001"
proxies = {"http": proxy, "https": proxy}
r = requests.get("https://ifconfig.co", proxies=proxies, timeout=10)
print(r.text)  # IP hiện tại
# Cần: pip install requests[socks]
```

Node.js:
```js
const { SocksProxyAgent } = require('socks-proxy-agent');
const agent = new SocksProxyAgent('socks5://u_abc12345:p_xyz98765432@160.187.246.219:30001');
fetch('https://ifconfig.co', { agent }).then(r => r.text()).then(console.log);
```

---

## 6. Quản lý Proxy

### 6.1 Xem danh sách

```bash
# Tất cả proxy đang hoạt động
curl "https://proxy.example.com/api/v1/proxy/list?page=1&limit=50" -H "X-API-Key: ipx_xxx"

# Lọc theo order
curl "https://proxy.example.com/api/v1/proxy/list?order_id=ord_a1b2c3d4" -H "X-API-Key: ipx_xxx"
```

### 6.2 Xem traffic đã dùng

```bash
curl "https://proxy.example.com/api/v1/proxy/usage?order_id=ord_a1b2c3d4" -H "X-API-Key: ipx_xxx"
# => { traffic_used_bytes, traffic_limit_gb, proxies: [{bytes_in, bytes_out}] }
```

> Billing `time`: không giới hạn traffic.
> Billing `traffic`: khi vượt `traffic_limit_gb` → order bị `suspended`, proxy ngừng hoạt động.

### 6.3 Đổi IP (rotate)

```bash
curl -X POST https://proxy.example.com/api/v1/proxy/rotate \
  -H "X-API-Key: ipx_xxx" -H "Content-Type: application/json" \
  -d '{"proxy_id": 123}'
```

Rotating order đã tự xoay theo `rotation_interval`, không cần gọi tay.
Static order gọi khi muốn đổi IP mới.

### 6.4 Gia hạn (chỉ billing=time)

```bash
curl -X POST https://proxy.example.com/api/v1/proxy/renew \
  -H "X-API-Key: ipx_xxx" -H "Content-Type: application/json" \
  -d '{"order_id":"ord_a1b2c3d4","extend_hours":720}'
```

### 6.5 Xoá / Huỷ

```bash
# Xoá cả order
curl -X DELETE https://proxy.example.com/api/v1/proxy/delete \
  -H "X-API-Key: ipx_xxx" -H "Content-Type: application/json" \
  -d '{"order_id":"ord_a1b2c3d4"}'

# Xoá 1 vài proxy lẻ
curl -X DELETE https://proxy.example.com/api/v1/proxy/delete \
  -H "X-API-Key: ipx_xxx" -H "Content-Type: application/json" \
  -d '{"proxy_ids":[1,2,3]}'
```

Sau xoá, IPv6 được đưa vào cooldown 60s rồi quay lại pool cho người khác dùng.

---

## 7. Xử lý lỗi thường gặp

| Lỗi | Nguyên nhân | Cách fix |
|---|---|---|
| `401 INVALID_API_KEY` | Sai hoặc thiếu `X-API-Key` | Kiểm tra key, đăng nhập lại |
| `400 INSUFFICIENT_BALANCE` | Số dư không đủ | Nạp thêm tiền, xem `GET /balance` |
| `503 INSUFFICIENT_POOL` | Hết IP trong pool | Giảm `quantity` hoặc liên hệ admin |
| `503 NO_PORTS` | Hết port (30000-40000) | Liên hệ admin mở rộng dải port |
| `429 RATE_LIMITED` | Quá 100 req/phút | Chờ 1 phút rồi thử lại |
| Proxy không kết nối | Sai user/pass, order hết hạn | Kiểm tra `/list?order_id=`, xem `expires_at` |
| `403 FORBIDDEN` | Proxy không phải của bạn | Dùng đúng `api_key` của tài khoản đã mua |

Mọi lỗi đều trả JSON:
```json
{ "status":"error", "code":"INSUFFICIENT_BALANCE", "message":"Need $7.20, have $1.00" }
```

---

## 8. Checklist nhanh

1. Đăng ký → lấy `api_key`
2. Nạp tiền → check `/balance`
3. `POST /proxy/create` → lưu `order_id` + `username/password/port`
4. Test `curl -x socks5h://...`
5. Dùng trong app / trình duyệt
6. Theo dõi `GET /proxy/usage` và gia hạn trước khi hết hạn
