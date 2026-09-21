'use strict';
const crypto = require('crypto');
const Joi = require('joi');
const express = require('express');
const { db, logger } = require('../db');

const router = express.Router();

// POST /api/v1/webhook/payment — không cần X-API-Key, verify HMAC
router.post('/payment', (req, res) => {
  const schema = Joi.object({
    user_email: Joi.string().email().required(),
    amount: Joi.number().positive().required(),
    ref: Joi.string().required(),
    signature: Joi.string().required(),
  });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ status: 'error', code: 'VALIDATION_ERROR', message: error.details[0].message });

  const secret = process.env.WEBHOOK_SECRET;
  if (secret && secret !== 'change_me_strong_secret_min32chars') {
    const expected = crypto.createHmac('sha256', secret).update(`${value.user_email}:${value.amount}:${value.ref}`).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(value.signature, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ status: 'error', code: 'INVALID_SIGNATURE', message: 'Invalid webhook signature' });
    }
  }

  const user = db.prepare('SELECT id FROM users WHERE email=?').get(value.user_email);
  if (!user) return res.status(404).json({ status: 'error', code: 'USER_NOT_FOUND', message: 'User not found' });

  const dup = db.prepare("SELECT id FROM transactions WHERE ref=? AND type='deposit'").get(value.ref);
  if (dup) return res.json({ status: 'success', message: 'Already processed', ref: value.ref });

  const { deposit } = require('../billing');
  db.transaction(() => deposit(user.id, value.amount, value.ref))();
  logger.info({ userId: user.id, amount: value.amount, ref: value.ref }, 'Webhook deposit');
  res.json({ status: 'success', message: 'Deposit credited', ref: value.ref });
});

module.exports = router;
