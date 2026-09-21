#!/bin/bash
set -e
# setup-ipv6.sh — Thêm route IPv6 /64 vào interface
# Usage: bash scripts/setup-ipv6.sh [prefix]
# Nếu không truyền arg, tự dò prefix (detect-ipv6.sh) hoặc đọc từ .env

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$PROJECT_DIR/.env" ]; then
  set -a; source "$PROJECT_DIR/.env"; set +a
fi

# Ưu tiên: arg > .env > tự dò
PREFIX="${1:-$IPV6_PREFIX}"
IFACE="${NET_IFACE:-eth0}"

# Tự dò nếu chưa có hoặc còn placeholder
if [ -z "$PREFIX" ] || echo "$PREFIX" | grep -q "xxxx"; then
  echo "Chưa có IPV6_PREFIX, thử tự dò ..."
  if [ -x "$SCRIPT_DIR/detect-ipv6.sh" ]; then
    PREFIX=$(bash "$SCRIPT_DIR/detect-ipv6.sh" 2>/dev/null) || true
  fi
  if [ -z "$PREFIX" ] || echo "$PREFIX" | grep -q "xxxx"; then
    # Fallback inline
    CIDR=$(ip -6 addr show scope global 2>/dev/null | grep -oP 'inet6 \K[0-9a-fA-F:]+/[0-9]+' | grep -v '^fe80' | head -1) || true
    [ -z "$CIDR" ] && CIDR=$(ip -6 route show 2>/dev/null | grep -oP '^[0-9a-fA-F:]+/[0-9]+' | grep -v '^fe80' | head -1) || true
    if [ -n "$CIDR" ]; then
      if command -v python3 &>/dev/null; then
        PREFIX=$(python3 -c "
import ipaddress
try:
    net = ipaddress.IPv6Network('$CIDR', strict=False)
    print(str(ipaddress.IPv6Network(str(net.network_address)+'/64', strict=False)))
except: print('$CIDR')
" 2>/dev/null) || true
      else
        PREFIX=$(echo "$CIDR" | sed 's|/[0-9]*$|/64|')
      fi
    fi
  fi
fi

if [ -z "$PREFIX" ] || echo "$PREFIX" | grep -q "xxxx"; then
  echo "ERROR: Không xác định được IPV6_PREFIX."
  echo "  Cách 1: bash scripts/setup-ipv6.sh 2001:db8:abcd:1234::/64"
  echo "  Cách 2: sửa .env (IPV6_PREFIX=...) rồi chạy lại: bash scripts/setup-ipv6.sh"
  echo "  Gợi ý: ip -6 addr show scope global"
  exit 1
fi

# Tự dò IFACE nếu chưa có hoặc không tồn tại
if ! ip link show "$IFACE" &>/dev/null; then
  DETECTED_IFACE=$(ip -o -4 route show to default 2>/dev/null | awk '{print $5}' | head -1)
  [ -z "$DETECTED_IFACE" ] && DETECTED_IFACE=$(ip -o link show 2>/dev/null | awk -F': ' '{print $2}' | grep -v lo | head -1)
  if [ -n "$DETECTED_IFACE" ]; then
    echo "Interface $IFACE không tồn tại, dùng $DETECTED_IFACE"
    IFACE="$DETECTED_IFACE"
  fi
fi

echo "Prefix: $PREFIX"
echo "Interface: $IFACE"

if ip -6 route show 2>/dev/null | grep -q "$PREFIX"; then
  echo "Route $PREFIX đã tồn tại, bỏ qua"
else
  ip -6 route add local "$PREFIX" dev "$IFACE" 2>/dev/null || ip -6 route replace local "$PREFIX" dev "$IFACE"
  echo "Đã thêm: ip -6 route add local $PREFIX dev $IFACE"
fi

echo "--- Routes IPv6 ---"
ip -6 route show 2>/dev/null | grep -E "local|$PREFIX" || true

echo "--- Persist route sau reboot ---"
if [ -d /etc/netplan ]; then
  NETPLAN_FILE="/etc/netplan/99-ipv6-proxy.yaml"
  EXISTING=$(ls /etc/netplan/*.yaml 2>/dev/null | head -1)
  if [ -n "$EXISTING" ]; then
    echo "Phát hiện netplan: $EXISTING"
    echo "Vui lòng thêm thủ công vào $EXISTING:"
    echo "  network:"
    echo "    ethernets:"
    echo "      $IFACE:"
    echo "        routes:"
    echo "          - to: $PREFIX"
    echo "            scope: host"
    echo "            type: local"
  else
    cat > "$NETPLAN_FILE" <<YAML
network:
  version: 2
  ethernets:
    $IFACE:
      routes:
        - to: $PREFIX
          scope: host
          type: local
YAML
    echo "Đã tạo $NETPLAN_FILE"
    netplan apply 2>/dev/null || echo "Chạy 'netplan apply' thủ công nếu cần"
  fi
elif [ -f /etc/network/interfaces ]; then
  if ! grep -q "$PREFIX" /etc/network/interfaces 2>/dev/null; then
    echo "up ip -6 route add local $PREFIX dev $IFACE" >> /etc/network/interfaces
    echo "Đã thêm vào /etc/network/interfaces"
  fi
else
  cat > /etc/systemd/system/ipv6-proxy-route.service <<UNIT
[Unit]
Description=Add IPv6 proxy route
After=network.target

[Service]
Type=oneshot
ExecStart=/sbin/ip -6 route replace local $PREFIX dev $IFACE
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable ipv6-proxy-route.service > /dev/null 2>&1 || true
  echo "Đã tạo systemd service ipv6-proxy-route.service"
fi

echo 1 > /proc/sys/net/ipv6/conf/all/proxy_ndp 2>/dev/null || true
echo 1 > /proc/sys/net/ipv6/conf/all/forwarding 2>/dev/null || true
echo "Done."
