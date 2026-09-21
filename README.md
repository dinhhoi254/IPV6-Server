# IPv6 Proxy API — Hệ thống cho thuê IPv6 Proxy với 3proxy

Hệ thống API cho thuê proxy IPv6 trên VPS Ubuntu 22.04. Mỗi proxy là 1 IPv6 riêng + 1 port, xác thực username/password, hỗ trợ billing theo thời gian hoặc lưu lượng, và xoay IP tự động (rotating).

## Kiến trúc

```
Client --HTTPS--> Nginx :443 --> Node.js API :8080 (127.0.0.1) --> SQLite
                                      |
                                3proxy manager (systemd template)
                                      |
                                nftables accounting
```

- **API**: Node.js 20 + Express, listen `127.0.0.1:8080`, sau Nginx reverse proxy
- **DB**: SQLite (`better-sqlite3`, WAL mode)
- **Proxy**: 3proxy multi-instance qua `systemd template` `3proxy@.service`, ports `30000-40000`
- **Traffic**: nftables counters per IPv6, sync mỗi 60s
- **Rotation**: cron mỗi 60s, đổi IPv6 theo `rotation_interval`
- **Process**: PM2
- **Tự dò IPv6**: `scripts/detect-ipv6.sh` tự phát hiện prefix /64 từ `ip -6 addr/route`, netplan hoặc `curl -6`, chuẩn hoá về /64

---

## Deploy — Tự động 100%

### A. Chạy TRỰC TIẾP trên VPS (tự dò prefix, không cần truyền gì)

> Yêu cầu: VPS Ubuntu 22.04, đã có dải IPv6 /64, quyền **root**.

```bash
# Cách nhanh nhất — tự dò prefix, tự setup full
sudo bash scripts/bootstrap.sh

# Tuỳ chọn thêm:
sudo bash scripts/bootstrap.sh --pool 7000 --domain proxy.example.com --email admin@example.com

# Nếu muốn chỉ định prefix thủ công (ghi đè tự dò):
sudo bash scripts/bootstrap.sh --prefix 2001:db8:abcd:1234::/64 --pool 7000
```

`bootstrap.sh` sẽ tự: `install.sh` (cài Node/3proxy/sysctl/ufw) → tự dò `IPV6_PREFIX`/`PUBLIC_IP`/`NET_IFACE` → `setup-ipv6.sh` (route local /64) → `add-ipv6-pool.sh` (sinh pool) → `pm2 start` → (tuỳ chọn) `setup-nginx.sh`.

```bash
# VPS mới tinh chưa có code:
sudo apt update && sudo apt install -y git
sudo git clone https://github.com/YOU/repo.git /opt/ipv6-proxy
sudo bash /opt/ipv6-proxy/scripts/bootstrap.sh
```

### B. Deploy TỪ MÁY LOCAL qua SSH (tự login + setup full) — dành cho nhiều VPS

#### Trên Linux / macOS / WSL / Git Bash (Windows)

```bash
# 1 VPS — dùng mật khẩu
bash scripts/deploy.sh root@160.187.246.219 --password '?BG8a$s7D-'

# Dùng SSH key
bash scripts/deploy.sh root@160.187.246.219 --key ~/.ssh/id_rsa

# Chỉ định prefix + domain
bash scripts/deploy.sh root@1.2.3.4 --password 'MyPass' --prefix 2001:db8::/64 --domain proxy.example.com --email admin@example.com --pool 7000

# SSH port khác
bash scripts/deploy.sh root@1.2.3.4 --port 2222 --password 'MyPass'

# Nhiều VPS — chạy vòng lặp
for ip in 160.187.246.219 1.2.3.5 1.2.3.6; do
  bash scripts/deploy.sh root@$ip --password '?BG8a$s7D-' --pool 7000
done

# Hoặc truyền danh sách cách nhau bằng dấu phẩy (deploy.ps1 hỗ trợ, deploy.sh chạy từng cái)
```

#### Trên Windows PowerShell (native)

```powershell
# 1 VPS — dùng mật khẩu (cần sshpass trong Git Bash, hoặc sẽ hướng dẫn)
.\scripts\deploy.ps1 -Vps "root@160.187.246.219" -Password '?BG8a$s7D-'

# Dùng key
.\scripts\deploy.ps1 -Vps "root@160.187.246.219" -Key "$env:USERPROFILE\.ssh\id_rsa"

# Nhiều VPS cùng lúc
.\scripts\deploy.ps1 -Vps "root@1.1.1.1,root@2.2.2.2" -Password 'mypass' -Pool 7000

# Kèm domain
.\scripts\deploy.ps1 -Vps "root@1.2.3.4" -Password 'pass' -Domain "proxy.example.com" -Email "admin@example.com"
```

> **Lưu ý Windows PowerShell native:** `sshpass` không có sẵn. Để dùng `--password` trên PowerShell, hãy chạy `deploy.sh` trong **Git Bash** (`C:\Program Files\Git\git-bash.exe`), hoặc dùng `--key` thay cho password.

### C. Chạy từng bước thủ công (debug)

```bash
sudo bash scripts/install.sh              # tự dò IP/prefix/iface, tạo .env, npm install
sudo bash scripts/setup-ipv6.sh           # tự dò prefix nếu không truyền arg
sudo bash scripts/add-ipv6-pool.sh        # tự dò prefix nếu không truyền arg
pm2 start ecosystem.config.js --env production
pm2 save && pm2 startup
sudo bash scripts/setup-nginx.sh proxy.example.com admin@example.com  # tuỳ chọn
```

Sau bootstrap, API chạy tại `http://127.0.0.1:8080` và (nếu có domain) `https://proxy.example.com`.

---

## Cấu hình .env

Xem [.env.example](.env.example). Khi chạy `install.sh`/`bootstrap.sh`, các biến sau được **tự dò**:

| Biến | Tự dò từ | Mô tả |
|---|---|---|
| `IPV6_PREFIX` | `ip -6 addr`, `ip -6 route`, netplan, `curl -6 ifconfig.co` | Prefix /64 của VPS |
| `PUBLIC_IP` | `curl -4 ifconfig.me`, `hostname -I` | IP công khai IPv4 |
| `NET_IFACE` | `ip -o -4 route show to default` | Interface mạng |
| `WEBHOOK_SECRET` | `openssl rand -hex 24` | Secret HMAC webhook |
| `ADMIN_API_KEY` | `openssl rand -hex 16` | Key admin |
| `JWT_SECRET` | `openssl rand -hex 24` | JWT secret |

Các biến pricing/port/pool giữ nguyên từ `.env.example`.

---

## API Endpoints

Tất cả endpoint (trừ `register`, `login`, `health`, `webhook`) yêu cầu header `X-API-Key: <key>`.

### Auth — Đăng ký & đăng nhập

```bash
curl -s http://127.0.0.1:8080/api/v1/user/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"a@b.com","password":"StrongPass123"}'
# => {"status":"success","api_key":"ipx_...","balance":0}

curl -s http://127.0.0.1:8080/api/v1/user/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"a@b.com","password":"StrongPass123"}'
```

### User

```bash
API_KEY="ipx_..."
curl -s http://127.0.0.1:8080/api/v1/user/me -H "X-API-Key: $API_KEY"
curl -s http://127.0.0.1:8080/api/v1/user/balance -H "X-API-Key: $API_KEY"
```

### Tạo proxy (endpoint quan trọng nhất)

```bash
curl -s http://127.0.0.1:8080/api/v1/admin/user/1/topup \
  -H "X-API-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"amount":100}'

curl -s http://127.0.0.1:8080/api/v1/proxy/create \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"quantity":10,"type":"static","billing":"time","duration_hours":24,"protocol":"socks5"}'

curl -s http://127.0.0.1:8080/api/v1/proxy/create \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"quantity":5,"type":"rotating","billing":"time","duration_hours":24,"rotation_interval":60,"protocol":"socks5"}'

curl -s http://127.0.0.1:8080/api/v1/proxy/create \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"quantity":10,"type":"static","billing":"traffic","traffic_limit_gb":50,"protocol":"socks5"}'

# Idempotency
curl -s http://127.0.0.1:8080/api/v1/proxy/create \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"quantity":10,"type":"static","billing":"time","duration_hours":24,"request_id":"my-req-001"}'
```

### Các endpoint khác

```bash
curl -s "http://127.0.0.1:8080/api/v1/proxy/list?page=1&limit=20" -H "X-API-Key: $API_KEY"
curl -s "http://127.0.0.1:8080/api/v1/proxy/usage?order_id=ord_xxxx" -H "X-API-Key: $API_KEY"
curl -s http://127.0.0.1:8080/api/v1/proxy/renew -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" -d '{"order_id":"ord_xxxx","extend_hours":24}'
curl -s http://127.0.0.1:8080/api/v1/proxy/rotate -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" -d '{"proxy_id":1}'
curl -s -X DELETE http://127.0.0.1:8080/api/v1/proxy/delete -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" -d '{"order_id":"ord_xxxx"}'
curl -s -X DELETE http://127.0.0.1:8080/api/v1/proxy/delete -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" -d '{"proxy_ids":[1,2,3]}'

SECRET="your_webhook_secret"
SIG=$(echo -n "a@b.com:50:txn_123" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')
curl -s http://127.0.0.1:8080/api/v1/webhook/payment -H "Content-Type: application/json" -d "{\"user_email\":\"a@b.com\",\"amount\":50,\"ref\":\"txn_123\",\"signature\":\"$SIG\"}"

curl -s http://127.0.0.1:8080/health
curl -s http://127.0.0.1:8080/api/v1/admin/stats -H "X-API-Key: $ADMIN_KEY"
```

---

## Test proxy SOCKS5

```bash
curl -x socks5h://u_abc12345:p_xyz98765432@160.187.246.219:30001 https://ifconfig.co
curl -x http://u_abc12345:p_xyz98765432@160.187.246.219:30001 https://ifconfig.co
```

---

## Bộ lệnh verify A→Z (copy-paste trên VPS)

```bash
BASE="http://127.0.0.1:8080"
ADMIN_KEY="$(grep ADMIN_API_KEY /opt/ipv6-proxy/.env | cut -d= -f2-)"

curl -s $BASE/health | jq .
REG=$(curl -s $BASE/api/v1/user/register -H 'Content-Type: application/json' -d '{"email":"test@example.com","password":"Test123456"}')
echo $REG | jq .; API_KEY=$(echo $REG | jq -r .api_key)
curl -s $BASE/api/v1/admin/user/1/topup -H "X-API-Key: $ADMIN_KEY" -H 'Content-Type: application/json' -d '{"amount":100}' | jq .
ORDER=$(curl -s $BASE/api/v1/proxy/create -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' -d '{"quantity":10,"type":"static","billing":"time","duration_hours":24,"protocol":"socks5"}')
echo $ORDER | jq .; ORDER_ID=$(echo $ORDER | jq -r .order_id); PROXY_ID=$(echo $ORDER | jq -r .proxies[0].id)
P_USER=$(echo $ORDER | jq -r .proxies[0].username); P_PASS=$(echo $ORDER | jq -r .proxies[0].password); P_PORT=$(echo $ORDER | jq -r .proxies[0].port)
PUBIP=$(grep PUBLIC_IP /opt/ipv6-proxy/.env | cut -d= -f2- | tr -d '"')
curl -x socks5h://$P_USER:$P_PASS@$PUBIP:$P_PORT https://ifconfig.co --max-time 10 -v
curl -s $BASE/api/v1/proxy/rotate -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' -d "{\"proxy_id\":$PROXY_ID}" | jq .
curl -s "$BASE/api/v1/proxy/usage?order_id=$ORDER_ID" -H "X-API-Key: $API_KEY" | jq .
curl -s -X DELETE $BASE/api/v1/proxy/delete -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' -d "{\"order_id\":\"$ORDER_ID\"}" | jq .
curl -s $BASE/health | jq .
```

---

## Scripts

| Script | Mô tả |
|---|---|
| `scripts/detect-ipv6.sh` | Tự dò IPv6 /64 prefix của VPS (dùng trên VPS) |
| `scripts/bootstrap.sh` | **1 lệnh duy nhất trên VPS** — tự dò prefix, setup full (không cần --prefix) |
| `scripts/deploy.sh` | Deploy từ máy local (Linux/macOS/Git Bash) qua SSH — tự login + upload + bootstrap |
| `scripts/deploy.ps1` | Deploy từ Windows PowerShell qua SSH — tự login + upload + bootstrap |
| `scripts/install.sh` | Cài dependency, Node 20, 3proxy, sysctl, firewall, npm install (tự dò prefix/IP/iface) |
| `scripts/setup-ipv6.sh [prefix]` | Route `local` cho /64, persist sau reboot (tự dò nếu không truyền) |
| `scripts/add-ipv6-pool.sh [prefix] [count]` | Sinh pool IPv6 vào SQLite (tự dò nếu không truyền) |
| `scripts/rotate-ip.sh <proxy_id>` | Xoay IP thủ công |
| `scripts/setup-nginx.sh <domain> [email]` | Nginx reverse proxy + Let's Encrypt |

---

## Vận hành

```bash
pm2 logs ipv6-proxy-api
pm2 reload ecosystem.config.js
systemctl status 3proxy@30001
nft -j list table ip6 proxyacct
sqlite3 data/app.db "SELECT status, COUNT(*) FROM ipv6_pool GROUP BY status;"
bash scripts/detect-ipv6.sh   # kiểm tra prefix tự dò
```

## Bảo mật

- API chỉ listen `127.0.0.1:8080`, ra ngoài qua Nginx + HTTPS
- `helmet`, `cors`, `rate-limit` (100 req/phút/key)
- Không log password/API key
- Webhook verify HMAC SHA256

## License

MIT
