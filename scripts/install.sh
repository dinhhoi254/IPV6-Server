#!/bin/bash
set -e
# install.sh — Cài đặt trọn bộ IPv6 Proxy API trên Ubuntu 22.04
# Chạy với quyền root: bash scripts/install.sh

if [ "$(id -u)" != "0" ]; then
  echo "Vui lòng chạy với quyền root: sudo bash scripts/install.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

echo "=== [1/10] Cập nhật hệ thống ==="
apt-get update -qq

echo "=== [2/10] Cài dependency hệ thống ==="
apt-get install -y -qq build-essential curl git nginx nftables sqlite3 ufw jq uuid-runtime python3 > /dev/null

echo "=== [3/10] Cài Node.js 20 ==="
if ! command -v node &>/dev/null || ! node -v | grep -q "v20"; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs
fi
echo "Node $(node -v) / npm $(npm -v)"
npm i -g pm2 > /dev/null 2>&1 || true

echo "=== [4/10] Cài 3proxy ==="
if ! command -v 3proxy &>/dev/null && [ ! -f /usr/local/bin/3proxy ]; then
  rm -rf /tmp/3proxy
  git clone --depth 1 https://github.com/3proxy/3proxy.git /tmp/3proxy
  cd /tmp/3proxy
  make -f Makefile.Linux -j"$(nproc)" > /dev/null 2>&1
  make -f Makefile.Linux install > /dev/null 2>&1 || cp bin/3proxy /usr/local/bin/3proxy
  cd "$PROJECT_DIR"
  echo "3proxy installed: $(/usr/local/bin/3proxy --help 2>&1 | head -1 || echo ok)"
else
  echo "3proxy đã có sẵn"
fi

echo "=== [5/10] Tạo cấu trúc thư mục ==="
mkdir -p /opt/ipv6-proxy/{src/routes,templates,scripts,configs/3proxy,data,logs}
if [ "$PROJECT_DIR" != "/opt/ipv6-proxy" ]; then
  echo "Copy project vào /opt/ipv6-proxy ..."
  cp -rn "$PROJECT_DIR"/* /opt/ipv6-proxy/ 2>/dev/null || true
  cp -rn "$PROJECT_DIR"/.env.example /opt/ipv6-proxy/.env.example 2>/dev/null || true
  PROJECT_DIR="/opt/ipv6-proxy"
fi

echo "=== [6/10] Cấu hình sysctl ==="
grep -q "net.ipv6.conf.all.forwarding" /etc/sysctl.conf 2>/dev/null || cat >> /etc/sysctl.conf <<'SYSCTL'
net.ipv6.conf.all.forwarding=1
net.ipv6.conf.all.proxy_ndp=1
net.ipv6.conf.default.forwarding=1
net.core.somaxconn=65535
fs.file-max=2097152
net.core.netdev_max_backlog=5000
SYSCTL
sysctl -p > /dev/null 2>&1 || true

echo "=== [7/10] Cấu hình ulimits ==="
grep -q "2097152" /etc/security/limits.conf 2>/dev/null || cat >> /etc/security/limits.conf <<'LIMITS'
* soft nofile 2097152
* hard nofile 2097152
root soft nofile 2097152
root hard nofile 2097152
LIMITS

echo "=== [8/10] Cài systemd template ==="
cp "$PROJECT_DIR/scripts/3proxy@.service" /etc/systemd/system/3proxy@.service
systemctl daemon-reload

echo "=== [9/10] Cấu hình firewall ==="
ufw allow 22/tcp > /dev/null 2>&1 || true
ufw allow 80/tcp > /dev/null 2>&1 || true
ufw allow 443/tcp > /dev/null 2>&1 || true
ufw allow 30000:40000/tcp > /dev/null 2>&1 || true
ufw allow 30000:40000/udp > /dev/null 2>&1 || true
echo "y" | ufw enable > /dev/null 2>&1 || true

echo "=== [10/10] Cài npm dependencies + tạo .env ==="
cd "$PROJECT_DIR"
if [ -f .env ]; then
  echo ".env đã tồn tại, giữ nguyên"
else
  cp .env.example .env

  # Tự phát hiện PUBLIC_IP, NET_IFACE, IPV6_PREFIX
  DETECTED_IP=$(curl -4 -s --max-time 5 ifconfig.me 2>/dev/null || curl -4 -s --max-time 5 icanhazip.com 2>/dev/null || echo "")
  [ -z "$DETECTED_IP" ] && DETECTED_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ -z "$DETECTED_IP" ] && DETECTED_IP="127.0.0.1"

  DETECTED_IFACE=$(ip -o -4 route show to default 2>/dev/null | awk '{print $5}' | head -1)
  [ -z "$DETECTED_IFACE" ] && DETECTED_IFACE=$(ip -o link show 2>/dev/null | awk -F': ' '{print $2}' | grep -v lo | head -1)
  [ -z "$DETECTED_IFACE" ] && DETECTED_IFACE="eth0"

  # Tự dò IPv6 prefix
  DETECTED_PREFIX=""
  if [ -x "$PROJECT_DIR/scripts/detect-ipv6.sh" ]; then
    DETECTED_PREFIX=$(bash "$PROJECT_DIR/scripts/detect-ipv6.sh" 2>/dev/null) || true
  fi

  sed -i "s|^PUBLIC_IP=.*|PUBLIC_IP=$DETECTED_IP|" .env
  sed -i "s|^NET_IFACE=.*|NET_IFACE=$DETECTED_IFACE|" .env
  if [ -n "$DETECTED_PREFIX" ]; then
    sed -i "s|^IPV6_PREFIX=.*|IPV6_PREFIX=$DETECTED_PREFIX|" .env
    echo "Tự phát hiện IPV6_PREFIX=$DETECTED_PREFIX"
  else
    echo "WARN: Không tự dò được IPV6_PREFIX, cần sửa thủ công trong .env"
  fi

  RAND_SECRET=$(openssl rand -hex 24 2>/dev/null || uuidgen 2>/dev/null | tr -d '-' || echo "change_me_$(date +%s)")
  RAND_ADMIN=$(openssl rand -hex 16 2>/dev/null || uuidgen 2>/dev/null | tr -d '-' || echo "admin_$(date +%s)")
  RAND_JWT=$(openssl rand -hex 24 2>/dev/null || uuidgen 2>/dev/null | tr -d '-' || echo "jwt_$(date +%s)")
  sed -i "s|^WEBHOOK_SECRET=.*|WEBHOOK_SECRET=$RAND_SECRET|" .env
  sed -i "s|^ADMIN_API_KEY=.*|ADMIN_API_KEY=admin_$RAND_ADMIN|" .env
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$RAND_JWT|" .env
  echo "Đã tạo .env: PUBLIC_IP=$DETECTED_IP, NET_IFACE=$DETECTED_IFACE"
  echo "ADMIN_API_KEY=admin_$RAND_ADMIN"
fi

npm install --production > /dev/null 2>&1 || npm install > /dev/null 2>&1
echo ""
echo "======================================================"
echo "  Cài đặt xong!"
echo "======================================================"
echo "  .env hiện tại:"
echo "    IPV6_PREFIX=$(grep IPV6_PREFIX "$PROJECT_DIR/.env" | cut -d= -f2-)"
echo "    PUBLIC_IP=$(grep PUBLIC_IP "$PROJECT_DIR/.env" | cut -d= -f2-)"
echo "    NET_IFACE=$(grep NET_IFACE "$PROJECT_DIR/.env" | cut -d= -f2-)"
echo ""
echo "  Nếu IPV6_PREFIX vẫn là placeholder, sửa rồi chạy:"
echo "    bash $PROJECT_DIR/scripts/setup-ipv6.sh"
echo "    bash $PROJECT_DIR/scripts/add-ipv6-pool.sh"
echo "    pm2 start $PROJECT_DIR/ecosystem.config.js --env production && pm2 save"
echo ""
echo "  Hoặc bootstrap full 1 lệnh:"
echo "    bash $PROJECT_DIR/scripts/bootstrap.sh"
echo "======================================================"
