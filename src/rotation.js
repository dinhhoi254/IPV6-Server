'use strict';
const { db, logger } = require('./db');
const { allocate, release } = require('./ipv6-pool');
const proxyManager = require('./proxy-manager');

function overTrafficLimit(order) {
  if (!order || order.billing !== 'traffic' || !order.traffic_limit_gb) return false;
  const limitBytes = Number(order.traffic_limit_gb) * 1024 * 1024 * 1024;
  return limitBytes > 0 && Number(order.traffic_used_bytes || 0) >= limitBytes;
}

function rotateSingleProxy(proxyId, opts = {}) {
  const proxy = db.prepare('SELECT * FROM proxies WHERE id=?').get(proxyId);
  if (!proxy) throw Object.assign(new Error('Proxy not found'), { code: 'NOT_FOUND' });
  if (!opts.skipTrafficCollect) {
    try { require('./traffic-monitor').collectAndUpdate(); } catch (_) {}
  }

  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(proxy.order_id);
  if (!order) throw Object.assign(new Error('Order not found'), { code: 'NOT_FOUND' });
  if (order.status !== 'active') throw Object.assign(new Error(`Order is ${order.status}`), { code: 'INVALID_STATUS' });
  if (overTrafficLimit(order)) {
    try { require('./billing').suspendOverTrafficOrders(proxyManager); } catch (_) {}
    throw Object.assign(new Error('Traffic limit exceeded'), { code: 'TRAFFIC_LIMIT_EXCEEDED' });
  }

  if (order.type === 'rotating') {
    proxyManager.rotateProxy({
      port: proxy.port,
      proxyId: proxy.id,
      newIpv6: proxy.ipv6,
      username: proxy.username,
      password: proxy.password,
      protocol: proxy.protocol,
      poolMode: true,
      poolSize: parseInt(process.env.ROTATING_POOL_SIZE || '5000', 10),
    });
    return proxy;
  }

  const [newIp] = allocate(1, order.id);
  const oldIp = proxy.ipv6;

  release(oldIp);
  db.prepare("UPDATE proxies SET ipv6=?, last_rotation=datetime('now') WHERE id=?").run(newIp, proxy.id);

  proxyManager.rotateProxy({
    port: proxy.port,
    newIpv6: newIp,
    oldIpv6: oldIp,
    username: proxy.username,
    password: proxy.password,
    protocol: proxy.protocol,
  });

  try {
    const tm = require('./traffic-monitor');
    tm.removeCounter(oldIp);
    tm.addCounter(newIp);
  } catch (_) {}

  logger.info({ proxyId, oldIp, newIp }, 'Proxy rotated');
  return { ...proxy, ipv6: newIp };
}

function rotateAllDue() {
  try { require('./traffic-monitor').collectAndUpdate(); } catch (_) {}
  // Rotating orders are handled by the shared 5k IPv6 pool per connection.
  // Static orders must keep their assigned IPv6 unless the user manually rotates.
  return 0;
}

let intervalId = null;
function start(intervalMs) {
  const ms = intervalMs || 60_000;
  intervalId = setInterval(rotateAllDue, ms);
  logger.info({ intervalMs: ms }, 'Rotation cron started');
}

function stop() {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
}

module.exports = { rotateSingleProxy, rotateAllDue, start, stop };
