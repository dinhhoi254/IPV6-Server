'use strict';
const { db, logger } = require('./db');

function getPricing() {
  return {
    perIpHour: parseFloat(process.env.PRICE_PER_IP_HOUR || '0.01'),
    perGb: parseFloat(process.env.PRICE_PER_GB || '0.05'),
    perIpTrafficMode: parseFloat(process.env.PRICE_PER_IP_TRAFFIC_MODE || process.env.PRICE_PER_GB || '0.05'),
  };
}

// Tính giá cho đơn hàng mới
function calcPrice({ quantity, billing, duration_hours, traffic_limit_gb }) {
  const { perIpHour, perGb, perIpTrafficMode } = getPricing();
  if (billing === 'time') {
    if (!duration_hours || duration_hours <= 0) throw Object.assign(new Error('duration_hours required for billing=time'), { code: 'VALIDATION_ERROR' });
    return quantity * duration_hours * perIpHour;
  }
  if (billing === 'traffic') {
    if (!traffic_limit_gb || traffic_limit_gb <= 0) throw Object.assign(new Error('traffic_limit_gb required for billing=traffic'), { code: 'VALIDATION_ERROR' });
    // traffic mode: phí = quantity * perIpTrafficMode + traffic * perGb (hoặc chỉ tính traffic)
    // Ở đây tính: quantity * traffic_limit * perGb (đơn giản: trả theo GB sử dụng)
    // + phí cố định per IP
    return quantity * perIpTrafficMode + traffic_limit_gb * perGb;
  }
  throw Object.assign(new Error('billing must be time or traffic'), { code: 'VALIDATION_ERROR' });
}

function calcRenewPrice(quantity, extendHours) {
  const { perIpHour } = getPricing();
  return quantity * extendHours * perIpHour;
}

// Trừ balance + ghi transaction (gọi trong transaction của caller)
function charge(userId, amount, ref, type) {
  const user = db.prepare('SELECT balance FROM users WHERE id=?').get(userId);
  if (!user) throw Object.assign(new Error('User not found'), { code: 'NOT_FOUND' });
  if (user.balance < amount) {
    throw Object.assign(new Error(`Insufficient balance: need $${amount.toFixed(4)}, have $${user.balance.toFixed(4)}`), { code: 'INSUFFICIENT_BALANCE' });
  }
  db.prepare('UPDATE users SET balance = balance - ? WHERE id=?').run(amount, userId);
  db.prepare('INSERT INTO transactions (user_id, amount, type, ref) VALUES (?,?,?,?)').run(userId, -amount, type || 'charge', ref);
  logger.info({ userId, amount, ref }, 'Charged');
}

function deposit(userId, amount, ref) {
  db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(amount, userId);
  db.prepare('INSERT INTO transactions (user_id, amount, type, ref) VALUES (?,?,?,?)').run(userId, amount, 'deposit', ref);
  logger.info({ userId, amount, ref }, 'Deposit');
}

function refund(userId, amount, ref) {
  db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(amount, userId);
  db.prepare('INSERT INTO transactions (user_id, amount, type, ref) VALUES (?,?,?,?)').run(userId, amount, 'refund', ref);
  logger.info({ userId, amount, ref }, 'Refund');
}

// Cron: hết hạn time-based orders
function expireOrders(proxyManager) {
  const expired = db.prepare(
    "SELECT id FROM orders WHERE status='active' AND billing='time' AND expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now')"
  ).all();
  for (const o of expired) {
    try {
      db.transaction(() => {
        db.prepare("UPDATE orders SET status='expired' WHERE id=?").run(o.id);
        const proxies = db.prepare('SELECT port, ipv6 FROM proxies WHERE order_id=?').all(o.id);
        for (const p of proxies) {
          try { proxyManager.removeProxy(p.port, p.ipv6); } catch (_) {}
          try { require('./traffic-monitor').removeCounter(p.ipv6); } catch (_) {}
        }
        db.prepare('DELETE FROM proxies WHERE order_id=?').run(o.id);
        // release IPs
        const { releaseByOrder } = require('./ipv6-pool');
        releaseByOrder(o.id);
        logger.info({ orderId: o.id }, 'Order expired');
      })();
    } catch (e) {
      logger.error({ err: e, orderId: o.id }, 'Expire order failed');
    }
  }
  return expired.length;
}

// Cron: suspend traffic-based orders vượt limit
function suspendOverTrafficOrders(proxyManager) {
  try { require('./traffic-monitor').collectAndUpdate(); } catch (_) {}
  const orders = db.prepare(
    "SELECT id, traffic_limit_gb, traffic_used_bytes FROM orders WHERE status='active' AND billing='traffic' AND traffic_limit_gb IS NOT NULL"
  ).all();
  let count = 0;
  for (const o of orders) {
    const limitBytes = o.traffic_limit_gb * 1024 * 1024 * 1024;
    if (o.traffic_used_bytes >= limitBytes) {
      try {
        db.prepare("UPDATE orders SET status='suspended' WHERE id=?").run(o.id);
        const proxies = db.prepare('SELECT port, ipv6 FROM proxies WHERE order_id=?').all(o.id);
        for (const p of proxies) {
          try { proxyManager.removeProxy(p.port, p.ipv6); } catch (_) {}
          try { require('./traffic-monitor').removeCounter(p.ipv6); } catch (_) {}
        }
        db.prepare('DELETE FROM proxies WHERE order_id=?').run(o.id);
        const { releaseByOrder } = require('./ipv6-pool');
        releaseByOrder(o.id);
        logger.warn({ orderId: o.id, used: o.traffic_used_bytes, limit: limitBytes }, 'Order suspended: traffic exceeded');
        count++;
      } catch (e) {
        logger.error({ err: e, orderId: o.id }, 'Suspend order failed');
      }
    }
  }
  return count;
}

module.exports = { getPricing, calcPrice, calcRenewPrice, charge, deposit, refund, expireOrders, suspendOverTrafficOrders };
