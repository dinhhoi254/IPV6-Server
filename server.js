'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');

const { db, logger } = require('./src/db');
const { authMiddleware, createRateLimiter } = require('./src/auth');

fs.mkdirSync(path.resolve('./logs'), { recursive: true });
fs.mkdirSync(path.resolve('./configs/3proxy'), { recursive: true });
fs.mkdirSync(path.resolve('./data'), { recursive: true });

const app = express();
app.set('trust proxy', 1);

app.use(helmet());
app.use(compression());
app.use(cors({
  origin: process.env.CORS_ORIGIN === '*' ? '*' : (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim()),
  allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization'],
  methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'],
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(createRateLimiter());

// Health không cần auth — đặt TRƯỚC authMiddleware
app.get('/health', (req, res) => {
  const proxiesActive = db.prepare("SELECT COUNT(*) as c FROM proxies WHERE status='active'").get().c;
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    proxies_active: proxiesActive,
    version: require('./package.json').version,
    timestamp: new Date().toISOString(),
  });
});

// Auth cho mọi route còn lại (bên trong auth.js đã exempt /health, /webhook, /register, /login)
app.use(authMiddleware);

app.use('/api/v1/user', require('./src/routes/user'));
app.use('/api/v1/proxy', require('./src/routes/proxy'));
app.use('/api/v1/admin', require('./src/routes/admin'));
app.use('/api/v1/webhook', require('./src/routes/webhook'));

app.use((req, res) => {
  res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  logger.error({ err: err.message, stack: err.stack, path: req.path }, 'Unhandled error');
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    status: 'error',
    code: err.code || 'INTERNAL_ERROR',
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = '127.0.0.1';

const server = app.listen(PORT, HOST, () => {
  logger.info(`API listening on http://${HOST}:${PORT}`);
  const { recycleCooldowns } = require('./src/ipv6-pool');
  const { expireOrders, suspendOverTrafficOrders } = require('./src/billing');
  const proxyManager = require('./src/proxy-manager');
  const trafficMonitor = require('./src/traffic-monitor');
  const rotation = require('./src/rotation');
  setInterval(() => { try { recycleCooldowns(); } catch (e) { logger.error({ err: e.message }, 'recycleCooldowns failed'); } }, 30_000);
  setInterval(() => {
    try { expireOrders(proxyManager); } catch (e) { logger.error({ err: e.message }, 'expireOrders failed'); }
    try { suspendOverTrafficOrders(proxyManager); } catch (e) { logger.error({ err: e.message }, 'suspendOverTrafficOrders failed'); }
  }, 5 * 60_000);
  try { trafficMonitor.start(60_000); } catch (e) { logger.warn({ err: e.message }, 'trafficMonitor start failed'); }
  try { rotation.start(60_000); } catch (e) { logger.warn({ err: e.message }, 'rotation start failed'); }
  logger.info('Background crons started');
});

function shutdown(signal) {
  logger.info(`${signal} received, shutting down...`);
  server.close(() => {
    try { require('./src/traffic-monitor').stop(); } catch (_) {}
    try { require('./src/rotation').stop(); } catch (_) {}
    try { db.close(); } catch (_) {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
