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

module.exports = router;
