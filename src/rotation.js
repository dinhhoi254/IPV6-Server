'use strict';
const { db, logger } = require('./db');
const { allocate, release } = require('./ipv6-pool');
const proxyManager = require('./proxy-manager');

// Xoay 1 proxy cụ thể (đổi IPv6, giữ port/user/pass)
function rotateSingleProxy(proxyId) {
  const proxy = db.prepare('SELECT * FROM proxies WHERE id=?').get(proxyId);
  if (!proxy) throw Object.assign(new Error('Proxy not found'), { code: 'NOT_FOUND' });
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(proxy.order_id);
  if (!order) throw Object.assign(new Error('Order not found'), { code: 'NOT_FOUND' });

  // Cấp IP mới
  const [newIp] = allocate(1, order.id);
  const oldIp = proxy.ipv6;
  // Release IP cũ về cooldown (sau khi đã có IP mới để tránh race)
  release(oldIp);

  // Cập nhật DB
  db.prepare("UPDATE proxies SET ipv6=?, last_rotation=datetime('now') WHERE id=?").run(newIp, proxy.id);

  // Reload 3proxy
  proxyManager.rotateProxy({
    port: proxy.port,
    newIpv6: newIp,
    username: proxy.username,
    password: proxy.password,
    protocol: proxy.protocol,
  });

  // nftables counter: xoá cũ, tạo mới
  try {
    const tm = require('./traffic-monitor');
    tm.removeCounter(oldIp);
    tm.addCounter(newIp);
  } catch (_) {}

  logger.info({ proxyId, oldIp, newIp }, 'Proxy rotated');
  return { ...proxy, ipv6: newIp };
}

// Cron xoay tất cả rotating orders (chạy mỗi phút, check last_rotation)
function rotateAllDue() {
  const now = Date.now();
  // Lấy các proxy thuộc rotating orders còn active
  const rows = db.prepare(`
    SELECT p.id, p.port, p.ipv6, p.username, p.password, p.protocol, p.last_rotation,
           o.rotation_interval, o.id as order_id
    FROM proxies p
    JOIN orders o ON o.id = p.order_id
    WHERE o.type='rotating' AND o.status='active' AND p.status='active'
  `).all();

  let rotated = 0;
  for (const r of rows) {
    const intervalMs = (r.rotation_interval || 60) * 1000;
    const lastMs = r.last_rotation ? new Date(r.last_rotation).getTime() : 0;
    if (now - lastMs < intervalMs) continue;
    try {
      rotateSingleProxy(r.id);
      rotated++;
    } catch (e) {
      logger.error({ err: e.message, proxyId: r.id }, 'Auto-rotate failed');
    }
  }
  if (rotated > 0) logger.info({ rotated }, 'Auto-rotation cycle done');
  return rotated;
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
