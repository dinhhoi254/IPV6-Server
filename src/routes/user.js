'use strict';
const express = require('express');
const Joi = require('joi');
const bcrypt = require('bcryptjs');
const { db, logger } = require('../db');
const { generateApiKey, hashPassword, verifyPassword } = require('../auth');

const router = express.Router();

// POST /api/v1/user/register
router.post('/register', async (req, res) => {
  const schema = Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().min(6).max(128).required(),
  });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ status: 'error', code: 'VALIDATION_ERROR', message: error.details[0].message });

  const { email, password } = value;
  const exists = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (exists) return res.status(400).json({ status: 'error', code: 'EMAIL_EXISTS', message: 'Email already registered' });

  const apiKey = generateApiKey();
  const passwordHash = await hashPassword(password);
  const result = db.prepare('INSERT INTO users (email, password_hash, api_key, balance) VALUES (?,?,?,0)').run(email, passwordHash, apiKey);
  logger.info({ userId: result.lastInsertRowid, email }, 'User registered');
  res.status(201).json({ status: 'success', api_key: apiKey, balance: 0, user_id: result.lastInsertRowid });
});

// GET /api/v1/user/me
router.get('/me', (req, res) => {
  const user = req.user;
  const totalProxies = db.prepare("SELECT COUNT(*) as c FROM proxies p JOIN orders o ON o.id=p.order_id WHERE o.user_id=? AND p.status='active'").get(user.id).c;
  const totalOrders = db.prepare('SELECT COUNT(*) as c FROM orders WHERE user_id=?').get(user.id).c;
  res.json({
    status: 'success',
    data: {
      id: user.id,
      email: user.email,
      balance: user.balance,
      total_proxies: totalProxies,
      total_orders: totalOrders,
      created_at: user.created_at,
    },
  });
});

// GET /api/v1/user/balance
router.get('/balance', (req, res) => {
  res.json({ status: 'success', balance: req.user.balance });
});

// POST /api/v1/user/login (optional: lấy lại api_key bằng email/pass)
router.post('/login', async (req, res) => {
  const schema = Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required(),
  });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ status: 'error', code: 'VALIDATION_ERROR', message: error.details[0].message });

  const user = db.prepare('SELECT * FROM users WHERE email=?').get(value.email);
  if (!user) return res.status(401).json({ status: 'error', code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
  const ok = await verifyPassword(value.password, user.password_hash);
  if (!ok) return res.status(401).json({ status: 'error', code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
  // Cấp lại api_key mới nếu user yêu cầu xoay key? Ở đây chỉ trả về key hiện tại
  res.json({ status: 'success', api_key: user.api_key, balance: user.balance });
});

// POST /api/v1/user/regenerate-key
router.post('/regenerate-key', (req, res) => {
  const newKey = generateApiKey();
  db.prepare('UPDATE users SET api_key=? WHERE id=?').run(newKey, req.user.id);
  logger.info({ userId: req.user.id }, 'API key regenerated');
  res.json({ status: 'success', api_key: newKey });
});

module.exports = router;
