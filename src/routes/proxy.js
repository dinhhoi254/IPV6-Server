'use strict';
const express = require('express');
const Joi = require('joi');
const crypto = require('crypto');
const { db, logger } = require('../db');
const { generateProxyCreds } = require('../auth');
const { allocate, release, releaseByOrder } = require('../ipv6-pool');
const { calcPrice, charge, calcRenewPrice } = require('../billing');
const proxyManager = require('../proxy-manager');

const router = express.Router();

function nextAvailablePort() {
  const start = parseInt(process.env.PROXY_PORT_START || '30000', 10);
  const end = parseInt(process.env.PROXY_PORT_END || '40000', 10);
  // Tìm port chưa dùng (từ proxies + tìm hole)
  const used = new Set(db.prepare('SELECT port FROM proxies').all().map((r) => r.port));
  // Cũng check file config tồn tại (phòng DB lệch)
  for (let p = start; p <= end; p++) {
    if (!used.has(p)) return p;
  }
  throw Object.assign(new Error('No available ports'), { code: 'NO_PORTS' });
}

function findPorts(n) {
  const start = parseInt(process.env.PROXY_PORT_START || '30000', 10);
  const end = parseInt(process.env.PROXY_PORT_END || '40000', 10);
  const used = new Set(db.prepare('SELECT port FROM proxies').all().map((r) => r.port));
  const ports = [];
  for (let p = start; p <= end && ports.length < n; p++) {
    if (!used.has(p)) ports.push(p);
  }
  if (ports.length < n) throw Object.assign(new Error(`Not enough ports: need ${n}, available ${ports.length}`), { code: 'NO_PORTS' });
  return ports;
}

// POST /api/v1/proxy/create
router.post('/create', async (req, res) => {
  const schema = Joi.object({
    quantity: Joi.number().integer().min(1).max(1000).required(),
    type: Joi.string().valid('static', 'rotating').default('static'),
    billing: Joi.string().valid('time', 'traffic').default('time'),
    duration_hours: Joi.number().integer().min(1).max(8760).when('billing', { is: 'time', then: Joi.required(), otherwise: Joi.optional() }),
    traffic_limit_gb: Joi.number().min(0.1).max(10000).when('billing', { is: 'traffic', then: Joi.required(), otherwise: Joi.optional() }),
    rotation_interval: Joi.number().integer().min(10).max(86400).when('type', { is: 'rotating', then: Joi.required(), otherwise: Joi.optional().default(60) }),
    protocol: Joi.string().valid('http', 'socks5', 'both').default('socks5'),
    auth_mode: Joi.string().valid('auto', 'custom').default('auto'),
    username: Joi.string().when('auth_mode', { is: 'custom', then: Joi.required(), otherwise: Joi.optional() }),
    password: Joi.string().when('auth_mode', { is: 'custom', then: Joi.required(), otherwise: Joi.optional() }),
    request_id: Joi.string().max(64).optional(), // idempotency key
  });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ status: 'error', code: 'VALIDATION_ERROR', message: error.details[0].message });

  const { quantity, type, billing, duration_hours, traffic_limit_gb, rotation_interval, protocol, auth_mode, request_id } = value;

  // Idempotency check
  if (request_id) {
    const prev = db.prepare('SELECT response FROM idempotency_keys WHERE key=? AND user_id=?').get(request_id, req.user.id);
    if (prev) {
      logger.info({ request_id }, 'Idempotent replay');
      return res.json(JSON.parse(prev.response));
    }
  }

  // Tính giá + check balance
  let price;
  try {
    price = calcPrice({ quantity, billing, duration_hours, traffic_limit_gb });
  } catch (e) {
    return res.status(400).json({ status: 'error', code: e.code || 'VALIDATION_ERROR', message: e.message });
  }

  const user = db.prepare('SELECT balance FROM users WHERE id=?').get(req.user.id);
  if (user.balance < price) {
    return res.status(400).json({ status: 'error', code: 'INSUFFICIENT_BALANCE', message: `Need $${price.toFixed(4)}, have $${user.balance.toFixed(4)}` });
  }

  const orderId = 'ord_' + crypto.randomBytes(4).toString('hex');
  const PUBLIC_IP = process.env.PUBLIC_IP || '127.0.0.1';

  let expiresAt = null;
  if (billing === 'time') {
    expiresAt = new Date(Date.now() + duration_hours * 3600 * 1000).toISOString();
  }

  // Transaction: tạo order + proxies + trừ tiền
  let proxiesData = [];
  try {
    const tx = db.transaction(() => {
      // Charge
      charge(req.user.id, price, orderId, 'charge');

      // Tạo order
      db.prepare(`
        INSERT INTO orders (id, user_id, quantity, type, billing, duration_hours, traffic_limit_gb, rotation_interval, protocol, status, expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(orderId, req.user.id, quantity, type, billing, duration_hours || null, traffic_limit_gb || null, rotation_interval || 60, protocol, 'active', expiresAt);

      // Cấp IP
      const ips = allocate(quantity, orderId);
      const ports = findPorts(quantity);

      const insProxy = db.prepare(`
        INSERT INTO proxies (order_id, ipv6, port, protocol, username, password, last_rotation, status)
        VALUES (?,?,?,?,?,?,datetime('now'),'active')
      `);

      for (let i = 0; i < quantity; i++) {
        let creds;
        if (auth_mode === 'custom' && i === 0) {
          creds = { username: value.username, password: value.password };
        } else if (auth_mode === 'custom') {
          // custom chỉ áp dụng cho proxy đầu? Hoặc mỗi proxy 1 user khác suffix
          creds = { username: `${value.username}_${i}`, password: value.password };
        } else {
          creds = generateProxyCreds();
        }
        insProxy.run(orderId, ips[i], ports[i], protocol, creds.username, creds.password);
        proxiesData.push({ ipv6: ips[i], port: ports[i], username: creds.username, password: creds.password, protocol });
      }
    });
    tx();
  } catch (e) {
    logger.error({ err: e.message, code: e.code }, 'Create proxy transaction failed');
    const status = e.code === 'INSUFFICIENT_BALANCE' ? 400 : e.code === 'INSUFFICIENT_POOL' ? 503 : e.code === 'NO_PORTS' ? 503 : 500;
    return res.status(status).json({ status: 'error', code: e.code || 'INTERNAL_ERROR', message: e.message });
  }

  // Tạo 3proxy configs (ngoài transaction để không block DB)
  const createdProxies = [];
  const proxyRows = db.prepare('SELECT * FROM proxies WHERE order_id=? ORDER BY port').all(orderId);
  for (const row of proxyRows) {
    try {
      proxyManager.createProxy({ port: row.port, ipv6: row.ipv6, username: row.username, password: row.password, protocol: row.protocol });
      try { require('../traffic-monitor').addCounter(row.ipv6); } catch (_) {}
    } catch (e) {
      logger.error({ port: row.port, err: e.message }, '3proxy create failed (proxy vẫn trong DB, cần manual fix)');
    }
    createdProxies.push({
      id: row.id,
      ip: row.ipv6,
      port: row.port,
      protocol: row.protocol,
      username: row.username,
      password: row.password,
      type,
    });
  }

  const responseBody = {
    status: 'success',
    order_id: orderId,
    type,
    billing,
    expires_at: expiresAt,
    price_charged: price,
    proxies: createdProxies.map((p) => ({
      ...p,
      // Chuỗi proxy URL tiện dụng
      socks5_url: `socks5://${p.username}:${p.password}@${PUBLIC_IP}:${p.port}`,
      http_url: `http://${p.username}:${p.password}@${PUBLIC_IP}:${p.port}`,
    })),
  };

  // Lưu idempotency
  if (request_id) {
    try { db.prepare('INSERT INTO idempotency_keys (key, user_id, response) VALUES (?,?,?)').run(request_id, req.user.id, JSON.stringify(responseBody)); } catch (_) {}
  }

  logger.info({ orderId, userId: req.user.id, quantity, price }, 'Order created');
  res.status(201).json(responseBody);
});

// GET /api/v1/proxy/list
router.get('/list', (req, res) => {
  const schema = Joi.object({
    status: Joi.string().valid('active', 'expired', 'cancelled', 'suspended').optional(),
    order_id: Joi.string().optional(),
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(200).default(50),
  });
  const { error, value } = schema.validate(req.query);
  if (error) return res.status(400).json({ status: 'error', code: 'VALIDATION_ERROR', message: error.details[0].message });

  const { status, order_id, page, limit } = value;
  const offset = (page - 1) * limit;
  const PUBLIC_IP = process.env.PUBLIC_IP || '127.0.0.1';

  // Nếu filter theo order_id, check quyền sở hữu
  let where = 'WHERE o.user_id = ?';
  const params = [req.user.id];
  if (status) { where += ' AND p.status = ?'; params.push(status); }
  if (order_id) { where += ' AND p.order_id = ?'; params.push(order_id); }

  const total = db.prepare(`SELECT COUNT(*) as c FROM proxies p JOIN orders o ON o.id=p.order_id ${where}`).get(...params).c;
  const rows = db.prepare(`
    SELECT p.*, o.type as order_type, o.billing, o.expires_at, o.status as order_status
    FROM proxies p JOIN orders o ON o.id=p.order_id
    ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const data = rows.map((r) => ({
    id: r.id,
    order_id: r.order_id,
    ip: r.ipv6,
    port: r.port,
    protocol: r.protocol,
    username: r.username,
    password: r.password,
    type: r.order_type,
    status: r.status,
    bytes_in: r.bytes_in,
    bytes_out: r.bytes_out,
    last_rotation: r.last_rotation,
    socks5_url: `socks5://${r.username}:${r.password}@${PUBLIC_IP}:${r.port}`,
    http_url: `http://${r.username}:${r.password}@${PUBLIC_IP}:${r.port}`,
  }));

  res.json({ status: 'success', total, page, limit, data });
});

// POST /api/v1/proxy/renew
router.post('/renew', (req, res) => {
  const schema = Joi.object({
    order_id: Joi.string().required(),
    extend_hours: Joi.number().integer().min(1).max(8760).required(),
  });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ status: 'error', code: 'VALIDATION_ERROR', message: error.details[0].message });

  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(value.order_id);
  if (!order) return res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'Order not found' });
  if (order.user_id !== req.user.id) return res.status(403).json({ status: 'error', code: 'FORBIDDEN', message: 'Not your order' });
  if (order.billing !== 'time') return res.status(400).json({ status: 'error', code: 'INVALID_BILLING', message: 'Only time-based orders can be renewed' });
  if (order.status !== 'active') return res.status(400).json({ status: 'error', code: 'INVALID_STATUS', message: `Order status is ${order.status}` });

  const price = calcRenewPrice(order.quantity, value.extend_hours);
  const user = db.prepare('SELECT balance FROM users WHERE id=?').get(req.user.id);
  if (user.balance < price) return res.status(400).json({ status: 'error', code: 'INSUFFICIENT_BALANCE', message: `Need $${price.toFixed(4)}, have $${user.balance.toFixed(4)}` });

  try {
    db.transaction(() => {
      charge(req.user.id, price, order.id, 'renew');
      const currentExpiry = order.expires_at ? new Date(order.expires_at) : new Date();
      const base = currentExpiry > new Date() ? currentExpiry : new Date();
      const newExpiry = new Date(base.getTime() + value.extend_hours * 3600 * 1000).toISOString();
      db.prepare("UPDATE orders SET expires_at=?, duration_hours = duration_hours + ? WHERE id=?").run(newExpiry, value.extend_hours, order.id);
    })();
  } catch (e) {
    return res.status(400).json({ status: 'error', code: e.code || 'INTERNAL_ERROR', message: e.message });
  }

  const updated = db.prepare('SELECT expires_at FROM orders WHERE id=?').get(order.id);
  res.json({ status: 'success', order_id: order.id, expires_at: updated.expires_at, charged: price });
});

// DELETE /api/v1/proxy/delete
router.delete('/delete', (req, res) => {
  const schema = Joi.object({
    order_id: Joi.string().optional(),
    proxy_ids: Joi.array().items(Joi.number().integer()).min(1).optional(),
  }).or('order_id', 'proxy_ids');
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ status: 'error', code: 'VALIDATION_ERROR', message: error.details[0].message });

  if (value.order_id) {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(value.order_id);
    if (!order) return res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'Order not found' });
    if (order.user_id !== req.user.id) return res.status(403).json({ status: 'error', code: 'FORBIDDEN', message: 'Not your order' });

    const proxies = db.prepare('SELECT port, ipv6 FROM proxies WHERE order_id=?').all(order.id);
    for (const p of proxies) {
      try { proxyManager.removeProxy(p.port); } catch (_) {}
      try { require('../traffic-monitor').removeCounter(p.ipv6); } catch (_) {}
    }
    db.transaction(() => {
      db.prepare('DELETE FROM proxies WHERE order_id=?').run(order.id);
      db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(order.id);
      releaseByOrder(order.id);
    })();
    logger.info({ orderId: order.id }, 'Order deleted');
    return res.json({ status: 'success', message: `Order ${order.id} cancelled, ${proxies.length} proxies removed` });
  }

  // Delete selected proxy_ids
  const placeholders = value.proxy_ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM proxies WHERE id IN (${placeholders})`).all(...value.proxy_ids);
  if (rows.length === 0) return res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'No proxies found' });
  // Check ownership
  for (const r of rows) {
    const o = db.prepare('SELECT user_id FROM orders WHERE id=?').get(r.order_id);
    if (!o || o.user_id !== req.user.id) return res.status(403).json({ status: 'error', code: 'FORBIDDEN', message: `Proxy ${r.id} not yours` });
  }
  for (const r of rows) {
    try { proxyManager.removeProxy(r.port); } catch (_) {}
    try { require('../traffic-monitor').removeCounter(r.ipv6); } catch (_) {}
    release(r.ipv6);
  }
  db.prepare(`DELETE FROM proxies WHERE id IN (${placeholders})`).run(...value.proxy_ids);
  // Nếu order không còn proxy nào -> cancel order
  const orderIds = [...new Set(rows.map((r) => r.order_id))];
  for (const oid of orderIds) {
    const cnt = db.prepare('SELECT COUNT(*) as c FROM proxies WHERE order_id=?').get(oid).c;
    if (cnt === 0) db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(oid);
  }
  res.json({ status: 'success', message: `${rows.length} proxies removed` });
});

// POST /api/v1/proxy/rotate
router.post('/rotate', (req, res) => {
  const schema = Joi.object({
    proxy_id: Joi.number().integer().required(),
  });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ status: 'error', code: 'VALIDATION_ERROR', message: error.details[0].message });

  const proxy = db.prepare('SELECT * FROM proxies WHERE id=?').get(value.proxy_id);
  if (!proxy) return res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'Proxy not found' });
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(proxy.order_id);
  if (!order || order.user_id !== req.user.id) return res.status(403).json({ status: 'error', code: 'FORBIDDEN', message: 'Not your proxy' });
  if (order.status !== 'active') return res.status(400).json({ status: 'error', code: 'INVALID_STATUS', message: `Order is ${order.status}` });

  try {
    const { rotateSingleProxy } = require('../rotation');
    const updated = rotateSingleProxy(proxy.id);
    const PUBLIC_IP = process.env.PUBLIC_IP || '127.0.0.1';
    res.json({
      status: 'success',
      proxy: {
        id: updated.id,
        ip: updated.ipv6,
        port: updated.port,
        protocol: updated.protocol,
        username: updated.username,
        socks5_url: `socks5://${updated.username}:${updated.password}@${PUBLIC_IP}:${updated.port}`,
      },
    });
  } catch (e) {
    const code = e.code || 'INTERNAL_ERROR';
    const status = code === 'INSUFFICIENT_POOL' ? 503 : 500;
    res.status(status).json({ status: 'error', code, message: e.message });
  }
});

// GET /api/v1/proxy/usage
router.get('/usage', (req, res) => {
  const orderId = req.query.order_id;
  if (!orderId) return res.status(400).json({ status: 'error', code: 'VALIDATION_ERROR', message: 'order_id query required' });
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order) return res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'Order not found' });
  if (order.user_id !== req.user.id) return res.status(403).json({ status: 'error', code: 'FORBIDDEN', message: 'Not your order' });

  const proxies = db.prepare('SELECT id, ipv6, port, bytes_in, bytes_out, status FROM proxies WHERE order_id=?').all(orderId);
  const totalBytes = proxies.reduce((s, p) => s + (p.bytes_out || 0) + (p.bytes_in || 0), 0);
  res.json({
    status: 'success',
    order_id: orderId,
    traffic_used_bytes: order.traffic_used_bytes || totalBytes,
    traffic_limit_gb: order.traffic_limit_gb,
    traffic_limit_bytes: order.traffic_limit_gb ? order.traffic_limit_gb * 1024 * 1024 * 1024 : null,
    billing: order.billing,
    expires_at: order.expires_at,
    proxies: proxies.map((p) => ({ id: p.id, ip: p.ipv6, port: p.port, bytes_in: p.bytes_in, bytes_out: p.bytes_out, status: p.status })),
  });
});

module.exports = router;
