#!/bin/bash
set -e
# bootstrap.sh — Setup trọn bộ chỉ với 1 lệnh, TỰ DÒ PREFIX nếu không truyền
#
# Trên VPS mới (root):
#   bash scripts/bootstrap.sh
#   bash scripts/bootstrap.sh --pool 7000
#   bash scripts/bootstrap.sh --prefix 2001:db8:abcd::/64 --pool 7000
#   bash scripts/bootstrap.sh --domain proxy.example.com --email admin@example.com
#
# Hoặc từ máy local deploy qua SSH (dùng deploy.sh):
#   bash scripts/deploy.sh root@160.187.246.219
#
# Tham số: --prefix, --pool, --domain, --email, --repo, --dir, --yes

PREFIX=""
POOL="7000"
DOMAIN=""
EMAIL=""
REPO=""
INSTALL_DIR="/opt/ipv6-proxy"
ASSUME_YES="0"

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2;;
    --pool) POOL="$2"; shift 2;;
    --domain) DOMAIN="$2"; shift 2;;
    --email) EMAIL="$2"; shift 2;;
    --repo) REPO="$2"; shift 2;;
    --dir) INSTALL_DIR="$2"; shift 2;;
    --yes|-y) ASSUME_YES="1"; shift;;
    --help|-h)
      echo "Usage: bash bootstrap.sh [--prefix <ipv6/64>] [--pool 7000] [--domain example.com --email admin@example.com] [--repo <git-url>] [--dir /opt/ipv6-proxy] [--yes]"
      echo "  Nếu không truyền --prefix, script sẽ tự dò IPv6 prefix của VPS."
      exit 0;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

if [ "$(id -u)" != "0" ]; then
  echo "Vui lòng chạy với quyền root: sudo bash scripts/bootstrap.sh"
  exit 1
fi

# Xác định PROJECT_DIR
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo "$INSTALL_DIR")"
if [ -f "$INSTALL_DIR/package.json" ]; then
  PROJECT_DIR="$INSTALL_DIR"
elif [ -f "$SCRIPT_DIR/../package.json" ]; then
  PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
elif [ -f "./package.json" ]; then
  PROJECT_DIR="$(pwd)"
else
  PROJECT_DIR="$INSTALL_DIR"
fi

# Clone nếu có --repo và chưa có code
if [ -n "$REPO" ] && [ ! -f "$INSTALL_DIR/package.json" ]; then
  echo "=== Clone repo $REPO -> $INSTALL_DIR ==="
  if [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    echo "Thư mục $INSTALL_DIR đã tồn tại và không rỗng, bỏ qua clone"
  else
    apt-get update -qq 2>/dev/null || true
    apt-get install -y -qq git 2>/dev/null || true
    git clone "$REPO" "$INSTALL_DIR"
    PROJECT_DIR="$INSTALL_DIR"
  fi
fi

# ── Tự dò PREFIX nếu không truyền ──
if [ -z "$PREFIX" ]; then
  echo ">>> Tự dò IPv6 prefix (không có --prefix) ..."
  if [ -x "$PROJECT_DIR/scripts/detect-ipv6.sh" ]; then
    PREFIX=$(bash "$PROJECT_DIR/scripts/detect-ipv6.sh" 2>/dev/null) || true
  fi
  # Fallback inline nếu chưa có file detect
  if [ -z "$PREFIX" ]; then
    CIDR=$(ip -6 addr show scope global 2>/dev/null | grep -oP 'inet6 \K[0-9a-fA-F:]+/[0-9]+' | grep -v '^fe80' | head -1) || true
    [ -z "$CIDR" ] && CIDR=$(ip -6 route show 2>/dev/null | grep -oP '^[0-9a-fA-F:]+/[0-9]+' | grep -v '^fe80' | grep -v '^::' | head -1) || true
    if [ -n "$CIDR" ] && command -v python3 &>/dev/null; then
      PREFIX=$(python3 -c "
import ipaddress
try:
    net = ipaddress.IPv6Network('$CIDR', strict=False)
    print(str(ipaddress.IPv6Network(str(net.network_address)+'/64', strict=False)))
except: print('$CIDR')
" 2>/dev/null) || true
    elif [ -n "$CIDR" ]; then
      PREFIX=$(echo "$CIDR" | sed 's|/[0-9]*$|/64|')
    fi
  fi
  if [ -z "$PREFIX" ] || echo "$PREFIX" | grep -q "xxxx"; then
    echo "ERROR: Không tự dò được IPv6 prefix. Hãy truyền thủ công:"
    echo "  bash scripts/bootstrap.sh --prefix 2001:db8:abcd:1234::/64"
    echo "  Gợi ý kiểm tra: ip -6 addr show scope global"
    exit 1
  fi
  echo "  => Tự dò được: $PREFIX"
fi

echo "======================================================"
echo "  IPv6 Proxy Bootstrap"
echo "  Prefix: $PREFIX"
echo "  Pool:   $POOL"
echo "  Dir:    $PROJECT_DIR"
[ -n "$DOMAIN" ] && echo "  Domain: $DOMAIN"
echo "======================================================"

# 1. Cài hệ thống
echo ""
echo ">>> [1/5] Cài đặt hệ thống (install.sh) ..."
bash "$PROJECT_DIR/scripts/install.sh"

# 2. Ghi IPV6_PREFIX vào .env
if grep -q "xxxx" "$PROJECT_DIR/.env" 2>/dev/null; then
  sed -i "s|^IPV6_PREFIX=.*|IPV6_PREFIX=$PREFIX|" "$PROJECT_DIR/.env"
  echo "Đã cập nhật IPV6_PREFIX=$PREFIX trong .env"
elif ! grep -q "^IPV6_PREFIX=$PREFIX" "$PROJECT_DIR/.env" 2>/dev/null; then
  # Nếu .env đã có prefix khác, ưu tiên prefix vừa dò/truyền (ghi đè)
  sed -i "s|^IPV6_PREFIX=.*|IPV6_PREFIX=$PREFIX|" "$PROJECT_DIR/.env"
  echo "Đã cập nhật IPV6_PREFIX=$PREFIX trong .env"
fi
if [ "$POOL" != "7000" ]; then
  sed -i "s|^POOL_SIZE=.*|POOL_SIZE=$POOL|" "$PROJECT_DIR/.env"
fi

# 3. Route IPv6
echo ""
echo ">>> [2/5] Cấu hình IPv6 route ..."
bash "$PROJECT_DIR/scripts/setup-ipv6.sh" "$PREFIX"

# 4. Sinh pool
echo ""
echo ">>> [3/5] Sinh pool $POOL IPs ..."
bash "$PROJECT_DIR/scripts/add-ipv6-pool.sh" "$PREFIX" "$POOL"

# 5. Khởi động API
echo ""
echo ">>> [4/5] Khởi động API (PM2) ..."
cd "$PROJECT_DIR"
if [ "$PROJECT_DIR" != "/opt/ipv6-proxy" ]; then
  sed -i "s|/opt/ipv6-proxy|$PROJECT_DIR|g" "$PROJECT_DIR/ecosystem.config.js" 2>/dev/null || true
fi
pm2 delete ipv6-proxy-api 2>/dev/null || true
pm2 start "$PROJECT_DIR/ecosystem.config.js" --env production
pm2 save 2>/dev/null || true
pm2 startup systemd -u root --hp /root 2>/dev/null | tail -1 | bash 2>/dev/null || true

# 6. Nginx
if [ -n "$DOMAIN" ]; then
  echo ""
  echo ">>> [5/5] Cấu hình Nginx cho $DOMAIN ..."
  bash "$PROJECT_DIR/scripts/setup-nginx.sh" "$DOMAIN" "$EMAIL"
else
  echo ""
  echo ">>> [5/5] Bỏ qua Nginx (không có --domain)."
  echo "    Sau này: bash $PROJECT_DIR/scripts/setup-nginx.sh yourdomain.com admin@yourdomain.com"
fi

echo ""
echo "======================================================"
echo "  Bootstrap hoàn tất!"
echo "======================================================"
ADMIN_KEY=$(grep ADMIN_API_KEY "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2- || echo "unknown")
PUBIP=$(grep PUBLIC_IP "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || echo "unknown")
echo "  API health:  curl http://127.0.0.1:8080/health"
[ -n "$DOMAIN" ] && echo "  Public:      https://$DOMAIN"
echo "  Public IP:   $PUBIP"
echo "  Prefix:      $PREFIX"
echo "  Admin key:   $ADMIN_KEY"
echo "  Pool:        $POOL IPs"
echo "  Logs:        pm2 logs ipv6-proxy-api"
echo "======================================================"
