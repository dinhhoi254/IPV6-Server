#!/bin/bash
set -e
# detect-ipv6.sh — Tự phát hiện IPv6 prefix /64 của VPS
# Chạy trực tiếp trên VPS, không cần tham số
# In ra prefix dạng 2001:db8:abcd:1234::/64, exit 0 nếu ok, exit 1 nếu fail

prefix_to_64() {
  local cidr="$1"
  [ -z "$cidr" ] && return 1
  if command -v python3 &>/dev/null; then
    python3 -c "
import ipaddress, sys
try:
    net = ipaddress.IPv6Network('$cidr', strict=False)
    sup = ipaddress.IPv6Network(str(net.network_address) + '/64', strict=False)
    print(str(sup))
except Exception:
    print('$cidr')
" 2>/dev/null
  else
    local ip="${cidr%%/*}"
    # Fallback đơn giản: lấy 4 hextet đầu
    echo "$ip" | awk -F: '{printf "%s:%s:%s:%s::/64\n", $1,$2,$3,$4}'
  fi
}

# 1) ip -6 addr scope global (đáng tin nhất)
try_addr() {
  ip -6 addr show scope global 2>/dev/null | grep -oP 'inet6 \K[0-9a-fA-F:]+/[0-9]+' | grep -v '^fe80' | head -1
}

# 2) ip -6 route
try_route() {
  ip -6 route show 2>/dev/null | grep -oP '^[0-9a-fA-F:]+/[0-9]+' | grep -v '^fe80' | grep -v '^::' | head -1
}

# 3) netplan config
try_netplan() {
  grep -rh -oP '[0-9a-fA-F:]+::/[0-9]+' /etc/netplan/*.yaml 2>/dev/null | head -1
}

# 4) curl ra ngoài lấy IP rồi suy prefix
try_external() {
  local ip=""
  ip=$(curl -6 -s --max-time 5 https://ifconfig.co 2>/dev/null | tr -d '[:space:]') || true
  [ -z "$ip" ] && ip=$(curl -6 -s --max-time 5 https://icanhazip.com 2>/dev/null | tr -d '[:space:]') || true
  if [ -n "$ip" ] && echo "$ip" | grep -q ":"; then
    echo "$ip" | awk -F: '{printf "%s:%s:%s:%s::/64\n", $1,$2,$3,$4}'
  fi
}

CIDR=""
for fn in try_addr try_route try_netplan try_external; do
  CIDR=$($fn) || true
  [ -n "$CIDR" ] && break
done

if [ -z "$CIDR" ]; then
  echo "ERROR: Không thể tự phát hiện IPv6 prefix." >&2
  echo "  Kiểm tra: ip -6 addr show scope global" >&2
  echo "  Hoặc truyền thủ công: --prefix 2001:db8:xxxx::/64" >&2
  exit 1
fi

# Đảm bảo /64
if ! echo "$CIDR" | grep -q "/64"; then
  CIDR=$(echo "$CIDR" | sed 's|/[0-9]*$|/64|')
  # Nếu không có / gì cả thì thêm
  echo "$CIDR" | grep -q "/" || CIDR="${CIDR}/64"
fi

# Chuẩn hoá network address về .0
RESULT=$(prefix_to_64 "$CIDR") || RESULT="$CIDR"
echo "$RESULT" | grep -q "/64" || RESULT="${RESULT}/64"
echo "$RESULT"
