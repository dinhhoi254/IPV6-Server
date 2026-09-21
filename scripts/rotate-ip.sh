#!/bin/bash
set -e
# rotate-ip.sh — Xoay IP cho 1 proxy (dùng thủ công hoặc cron)
# Usage: bash scripts/rotate-ip.sh <proxy_id>
#   hoặc: bash scripts/rotate-ip.sh --order <order_id>

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

if [ -z "$1" ]; then
  echo "Usage: bash scripts/rotate-ip.sh <proxy_id>"
  echo "   hoặc: bash scripts/rotate-ip.sh --order <order_id>"
  exit 1
fi

if [ "$1" = "--order" ]; then
  ORDER_ID="$2"
  node -e "
    require('dotenv').config();
    const { db } = require('./src/db');
    const { rotateSingleProxy } = require('./src/rotation');
    const rows = db.prepare('SELECT id FROM proxies WHERE order_id=?').all('$ORDER_ID');
    if (rows.length===0) { console.error('No proxies for order $ORDER_ID'); process.exit(1); }
    for (const r of rows) {
      try { const u = rotateSingleProxy(r.id); console.log('Rotated proxy '+r.id+' -> '+u.ipv6); } catch(e) { console.error('Proxy '+r.id+' failed: '+e.message); }
    }
  "
else
  PROXY_ID="$1"
  node -e "
    require('dotenv').config();
    const { rotateSingleProxy } = require('./src/rotation');
    const u = rotateSingleProxy(parseInt('$PROXY_ID',10));
    console.log('Rotated proxy '+u.id+' -> '+u.ipv6+' port '+u.port);
  "
fi
