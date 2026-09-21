#!/bin/bash
set -e
# add-ipv6-pool.sh — Sinh pool IPv6 vào SQLite
# Usage: bash scripts/add-ipv6-pool.sh [prefix] [count]
# Nếu không truyền prefix, sẽ tự dò (detect-ipv6.sh) hoặc đọc .env

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

if [ -f .env ]; then
  set -a; source .env; set +a
fi

PREFIX="${1:-$IPV6_PREFIX}"
COUNT="${2:-$POOL_SIZE}"
COUNT="${COUNT:-7000}"

# Tự dò nếu chưa có hoặc còn placeholder
if [ -z "$PREFIX" ] || echo "$PREFIX" | grep -q "xxxx"; then
  echo "Chưa có IPV6_PREFIX, thử tự dò ..."
  if [ -x "$SCRIPT_DIR/detect-ipv6.sh" ]; then
    PREFIX=$(bash "$SCRIPT_DIR/detect-ipv6.sh" 2>/dev/null) || true
  fi
  if [ -z "$PREFIX" ] || echo "$PREFIX" | grep -q "xxxx"; then
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
  echo "ERROR: Không xác định được IPV6_PREFIX. Sửa .env hoặc truyền arg:"
  echo "  bash scripts/add-ipv6-pool.sh 2001:db8:abcd:1234::/64 7000"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Chưa có node_modules, đang cài..."
  npm install --production > /dev/null 2>&1 || npm install > /dev/null 2>&1
fi

echo "Sinh $COUNT IPv6 trong $PREFIX ..."
node -e "
require('dotenv').config();
if ('$PREFIX' !== process.env.IPV6_PREFIX) process.env.IPV6_PREFIX='$PREFIX';
if ('$COUNT' !== process.env.POOL_SIZE) process.env.POOL_SIZE='$COUNT';
const { initPool } = require('./src/ipv6-pool');
const total = initPool('$PREFIX', parseInt('$COUNT',10));
console.log('Pool ready: ' + total + ' available');
"

node -e "
require('dotenv').config();
const { getPoolStats } = require('./src/ipv6-pool');
console.log(JSON.stringify(getPoolStats(), null, 2));
"
