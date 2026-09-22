'use strict';
const express = require('express');
const Joi = require('joi');
const { db, logger } = require('../db');
const { getPoolStats } = require('../ipv6-pool');
const proxyManager = require('../proxy-manager');

const router = express.Router();

// Tất cả route admin yêu cầu admin key (đã check ở authMiddleware + adminMiddleware gắn ngoài)
// Nhưng cũng check lại ở đây để an toàn khi mount độc lập

function requireAdmin(req, res, next) {
  if (req.headers['x-api-key'] !== process.env.ADMIN_API_KEY) {
    return res.status(403).json({ status: 'error', code: 'FORBIDDEN', message: 'Admin access required' });
  }
  next();
}

router.use(requireAdmin);

// GET /api/v1/admin/stats
router.get('/stats', (req, res) => {
  const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const ordersActive = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='active'").get().c;
  const proxiesActive = db.prepare("SELECT COUNT(*) as c FROM proxies WHERE status='active'").get().c;
  const pool = getPoolStats();
  const revenue = db.prepare("SELECT COALESCE(SUM(CASE WHEN amount<0 THEN -amount ELSE 0 END),0) as total FROM transactions WHERE type IN ('charge','renew')").get().total;
  res.json({ status: 'success', data: { users, orders_active: ordersActive, proxies_active: proxiesActive, pool, revenue } });
});

// GET /api/v1/admin/users
router.get('/users', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
  const offset = (page - 1) * limit;
  const total = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const data = db.prepare('SELECT id, email, balance, is_active, created_at FROM users ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
  res.json({ status: 'success', total, page, limit, data });
});

// GET /api/v1/admin/orders
router.get('/orders', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
  const offset = (page - 1) * limit;
  const where = req.query.status ? "WHERE status=?" : "";
  const params = req.query.status ? [req.query.status] : [];
  const total = db.prepare(`SELECT COUNT(*) as c FROM orders ${where}`).get(...params).c;
  const data = db.prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ status: 'success', total, page, limit, data });
});

// POST /api/v1/admin/user/:id/topup
router.post('/user/:id/topup', (req, res) => {
  const schema = Joi.object({ amount: Joi.number().positive().required(), ref: Joi.string().optional() });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ status: 'error', code: 'VALIDATION_ERROR', message: error.details[0].message });
  const user = db.prepare('SELECT id FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'User not found' });
  const { deposit } = require('../billing');
  db.transaction(() => deposit(user.id, value.amount, value.ref || `admin_topup_${Date.now()}`))();
  const updated = db.prepare('SELECT balance FROM users WHERE id=?').get(user.id);
  logger.info({ userId: user.id, amount: value.amount }, 'Admin topup');
  res.json({ status: 'success', balance: updated.balance });
});

// POST /api/v1/admin/user/:id/ban
router.post('/user/:id/ban', (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'User not found' });
  db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(user.id);
  res.json({ status: 'success', message: 'User banned' });
});

router.post('/user/:id/unban', (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'User not found' });
  db.prepare('UPDATE users SET is_active=1 WHERE id=?').run(user.id);
  res.json({ status: 'success', message: 'User unbanned' });
});

// POST /api/v1/admin/pool/add — thêm IP vào pool thủ công
router.post('/pool/add', (req, res) => {
  const schema = Joi.object({ ipv6: Joi.string().required(), count: Joi.number().integer().min(1).max(7000).optional() });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ status: 'error', code: 'VALIDATION_ERROR', message: error.details[0].message });
  if (value.count) {
    const { initPool } = require('../ipv6-pool');
    // value.ipv6 ở đây là prefix
    const total = initPool(value.ipv6, value.count);
    return res.json({ status: 'success', message: `Added ${value.count} IPs`, pool_total: total });
  }
  try {
    db.prepare("INSERT OR IGNORE INTO ipv6_pool (ipv6, status) VALUES (?, 'available')").run(value.ipv6);
    res.json({ status: 'success', message: 'IP added', pool: getPoolStats() });
  } catch (e) {
    res.status(400).json({ status: 'error', code: 'INSERT_FAILED', message: e.message });
  }
});

// ============ IPv6 Servers CRUD (quản lý nhiều VPS) ============

// GET /api/v1/admin/servers
router.get('/servers', (req, res) => {
  const servers = db.prepare('SELECT * FROM ipv6_servers ORDER BY sort_order ASC, id ASC').all();
  let hasCol = false;
  try { hasCol = db.prepare("PRAGMA table_info(orders)").all().map(c=>c.name).includes('server_id'); } catch(_){}
  const data = servers.map(sv => {
    let ordersActive = null, proxiesActive = null;
    if (hasCol) {
      try {
        ordersActive = db.prepare("SELECT COUNT(*) as c FROM orders WHERE server_id=? AND status='active'").get(sv.id).c;
        proxiesActive = db.prepare("SELECT COUNT(*) as c FROM proxies WHERE server_id=? AND status='active'").get(sv.id).c;
      } catch(_){}
    }
    return Object.assign({}, sv, { orders_active: ordersActive, proxies_active: proxiesActive });
  });
  res.json({ status: 'success', total: data.length, data });
});

router.get('/servers/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM ipv6_servers WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'Server not found' });
  res.json({ status: 'success', data: row });
});

router.post('/servers', (req, res) => {
  const schema = Joi.object({
    name: Joi.string().max(100).required(),
    api_url: Joi.string().uri({ scheme: ['http','https'] }).max(255).required(),
    public_ip: Joi.string().max(64).allow('', null).default(''),
    admin_key: Joi.string().max(512).allow('', null).default(''),
    webhook_secret: Joi.string().max(512).allow('', null).default(''),
    location: Joi.string().max(100).allow('', null).default(''),
    status: Joi.number().integer().valid(0,1).default(1),
    sort_order: Joi.number().integer().default(0),
  });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ status: 'error', code: 'VALIDATION_ERROR', message: error.details[0].message });
  const r = db.prepare("INSERT INTO ipv6_servers (name, api_url, public_ip, admin_key, webhook_secret, location, status, sort_order, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))").run(value.name, value.api_url, value.public_ip||'', value.admin_key||'', value.webhook_secret||'', value.location||'', value.status, value.sort_order);
  const created = db.prepare('SELECT * FROM ipv6_servers WHERE id=?').get(r.lastInsertRowid);
  logger.info({ serverId: created.id }, 'Server created');
  res.status(201).json({ status: 'success', data: created });
});

router.put('/servers/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM ipv6_servers WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'Server not found' });
  const schema = Joi.object({
    name: Joi.string().max(100).optional(),
    api_url: Joi.string().uri({ scheme: ['http','https'] }).max(255).optional(),
    public_ip: Joi.string().max(64).allow('', null).optional(),
    admin_key: Joi.string().max(512).allow('', null).optional(),
    webhook_secret: Joi.string().max(512).allow('', null).optional(),
    location: Joi.string().max(100).allow('', null).optional(),
    status: Joi.number().integer().valid(0,1).optional(),
    sort_order: Joi.number().integer().optional(),
  });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ status: 'error', code: 'VALIDATION_ERROR', message: error.details[0].message });
  const fields = Object.keys(value);
  if (fields.length === 0) return res.status(400).json({ status: 'error', code: 'NO_FIELDS', message: 'No fields to update' });
  const sets = fields.map(k => k+'=?').join(', ');
  const vals = fields.map(k => value[k]);
  db.prepare("UPDATE ipv6_servers SET "+sets+", updated_at=datetime('now') WHERE id=?").run(...vals, cur.id);
  const updated = db.prepare('SELECT * FROM ipv6_servers WHERE id=?').get(cur.id);
  logger.info({ serverId: cur.id }, 'Server updated');
  res.json({ status: 'success', data: updated });
});

router.delete('/servers/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM ipv6_servers WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'Server not found' });
  db.prepare('DELETE FROM ipv6_servers WHERE id=?').run(cur.id);
  logger.info({ serverId: cur.id }, 'Server deleted');
  res.json({ status: 'success', message: 'Server deleted' });
});

module.exports = router;
