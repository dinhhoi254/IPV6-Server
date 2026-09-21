'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { db, logger } = require('./db');

// Sinh API key dạng ipx_<32 hex>
function generateApiKey() {
  return 'ipx_' + crypto.randomBytes(16).toString('hex');
}

// Sinh username/password cho proxy
function generateProxyCreds() {
  const user = 'u_' + crypto.randomBytes(4).toString('hex');
  const pass = 'p_' + crypto.randomBytes(6).toString('hex');
  return { username: user, password: pass };
}

// Những path không cần auth (public)
const PUBLIC_PATHS = [
  '/health',
  '/api/v1/webhook/payment',
  '/api/v1/proxy/webhook/payment',
  '/api/v1/user/register',
  '/api/v1/user/login',
];
function isPublicPath(p) {
  return PUBLIC_PATHS.some((pub) => p === pub || p.startsWith(pub + '?'));
}

// Middleware xác thực X-API-Key
function authMiddleware(req, res, next) {
  if (isPublicPath(req.path)) return next();

  const apiKey = req.headers['x-api-key'];
  // Cho phép admin key truy cập mọi endpoint admin
  if (!apiKey) {
    return res.status(401).json({ status: 'error', code: 'UNAUTHORIZED', message: 'Missing X-API-Key header' });
  }

  // Kiểm tra admin key trước
  if (apiKey === process.env.ADMIN_API_KEY) {
    req.user = { id: 0, is_admin: true, api_key: apiKey };
    return next();
  }

  const user = db.prepare('SELECT * FROM users WHERE api_key = ? AND is_active = 1').get(apiKey);
  if (!user) {
    return res.status(401).json({ status: 'error', code: 'INVALID_API_KEY', message: 'Invalid or inactive API key' });
  }
  req.user = user;
  next();
}

// Middleware yêu cầu admin
function adminMiddleware(req, res, next) {
  if (!req.user || (!req.user.is_admin && req.headers['x-api-key'] !== process.env.ADMIN_API_KEY)) {
    // Kiểm tra thêm: user có email admin hoặc flag
    if (req.user && req.user.is_admin) return next();
    return res.status(403).json({ status: 'error', code: 'FORBIDDEN', message: 'Admin access required' });
  }
  next();
}

// Rate limiter per API key (dùng memory store - đủ cho single instance)
function createRateLimiter() {
  return rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    keyGenerator: (req) => req.headers['x-api-key'] || req.ip,
    handler: (req, res) => {
      res.status(429).json({ status: 'error', code: 'RATE_LIMITED', message: 'Too many requests, please try again later' });
    },
    standardHeaders: true,
    legacyHeaders: false,
  });
}

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

module.exports = {
  generateApiKey,
  generateProxyCreds,
  authMiddleware,
  adminMiddleware,
  createRateLimiter,
  hashPassword,
  verifyPassword,
};
