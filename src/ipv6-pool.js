'use strict';
const crypto = require('crypto');
const { db, logger } = require('./db');

// Sinh IPv6 ngẫu nhiên trong prefix /64
// prefix dạng "2001:db8:abcd:1234::" hoặc "2001:db8:abcd:1234::/64"
function randomIPv6InPrefix(prefix) {
  // Lấy 4 hextet đầu (64 bit prefix)
  const clean = prefix.replace(/\/\d+$/, '').replace(/::$/, ':');
  const parts = clean.split(':').filter(Boolean);
  // Đảm bảo có 4 hextet
  while (parts.length < 4) parts.push('0');
  const prefixParts = parts.slice(0, 4);
  // Sinh 4 hextet ngẫu nhiên cho 64 bit còn lại
  const suffix = Array.from({ length: 4 }, () =>
    crypto.randomInt(0, 0x10000).toString(16).padStart(4, '0')
  );
  return [...prefixParts, ...suffix].join(':');
}

// Sinh pool IPv6, bỏ qua IP đã tồn tại
function initPool(prefix, count) {
  if (!prefix || !count) throw new Error('prefix và count là bắt buộc');
  const insertStmt = db.prepare(
    'INSERT OR IGNORE INTO ipv6_pool (ipv6, status) VALUES (?, ?)'
  );
  const tx = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const ip = randomIPv6InPrefix(prefix);
      insertStmt.run(ip, 'available');
    }
  });
  tx();
  const total = db.prepare("SELECT COUNT(*) as c FROM ipv6_pool WHERE status='available'").get().c;
  logger.info({ prefix, count, total }, 'IPv6 pool initialized');
  return total;
}

function initPoolFromEnv() {
  require('dotenv').config();
  const prefix = process.env.IPV6_PREFIX;
  const count = parseInt(process.env.POOL_SIZE || '7000', 10);
  if (!prefix || prefix.includes('xxxx')) {
    console.error('Vui lòng cấu hình IPV6_PREFIX thật trong .env trước khi init pool');
    process.exit(1);
  }
  const total = initPool(prefix, count);
  console.log(`Pool ready: ${total} IPs available`);
}

// Cấp phát n IP available (atomic transaction)
function allocate(n, orderId) {
  if (n <= 0) throw new Error('n phải > 0');
  const result = db.transaction(() => {
    const rows = db.prepare(
      "SELECT id, ipv6 FROM ipv6_pool WHERE status='available' LIMIT ?"
    ).all(n);
    if (rows.length < n) {
      throw Object.assign(new Error(`Không đủ IP available: cần ${n}, có ${rows.length}`), { code: 'INSUFFICIENT_POOL' });
    }
    const upd = db.prepare(
      "UPDATE ipv6_pool SET status='in_use', assigned_order_id=?, assigned_at=datetime('now') WHERE id=?"
    );
    for (const r of rows) upd.run(orderId, r.id);
    return rows.map((r) => r.ipv6);
  })();
  logger.info({ orderId, count: result.length }, 'IPs allocated');
  return result;
}

// Thu hồi 1 IP về cooldown
function release(ipv6) {
  const cooldownSec = parseInt(process.env.COOLDOWN_SECONDS || '60', 10);
  db.prepare(
    "UPDATE ipv6_pool SET status='cooldown', cooldown_until=datetime('now', ?), assigned_order_id=NULL WHERE ipv6=?"
  ).run(`+${cooldownSec} seconds`, ipv6);
  logger.debug({ ipv6 }, 'IP released to cooldown');
}

// Thu hồi toàn bộ IP của 1 order (dùng khi delete/expire)
function releaseByOrder(orderId) {
  const cooldownSec = parseInt(process.env.COOLDOWN_SECONDS || '60', 10);
  const count = db.prepare(
    "UPDATE ipv6_pool SET status='cooldown', cooldown_until=datetime('now', ?), assigned_order_id=NULL WHERE assigned_order_id=?"
  ).run(`+${cooldownSec} seconds`, orderId).changes;
  logger.info({ orderId, count }, 'IPs released by order');
  return count;
}

// Đưa IP cooldown hết hạn về available (chạy cron mỗi 30s)
function recycleCooldowns() {
  const count = db.prepare(
    "UPDATE ipv6_pool SET status='available', cooldown_until=NULL WHERE status='cooldown' AND cooldown_until <= datetime('now')"
  ).run().changes;
  if (count > 0) logger.info({ count }, 'Cooldown IPs recycled');
  return count;
}

function getPoolStats() {
  const rows = db.prepare("SELECT status, COUNT(*) as c FROM ipv6_pool GROUP BY status").all();
  const stats = { available: 0, in_use: 0, cooldown: 0, total: 0 };
  for (const r of rows) { stats[r.status] = r.c; stats.total += r.c; }
  return stats;
}

module.exports = { initPool, initPoolFromEnv, allocate, release, releaseByOrder, recycleCooldowns, getPoolStats, randomIPv6InPrefix };
