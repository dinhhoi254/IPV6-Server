'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const pino = require('pino');

const LOG_FILE = process.env.LOG_FILE || './logs/app.log';
let logger;
try {
  const dest = pino.destination({ dest: LOG_FILE, sync: false, mkdir: true });
  logger = pino({ level: process.env.LOG_LEVEL || 'info' }, dest);
} catch (_) {
  logger = pino({ level: process.env.LOG_LEVEL || 'info' });
}

const DB_PATH = path.resolve(process.env.DB_PATH || './data/app.db');

// Đảm bảo thư mục chứa DB tồn tại
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// WAL mode giúp đọc/ghi đồng thời, chống lock khi nhiều request
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

// Khởi tạo schema
function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      password_hash TEXT,
      balance REAL DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ipv6_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ipv6 TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'available',
      assigned_order_id TEXT,
      assigned_at DATETIME,
      cooldown_until DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_pool_status ON ipv6_pool(status);

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      type TEXT NOT NULL,
      billing TEXT NOT NULL,
      duration_hours INTEGER,
      traffic_limit_gb REAL,
      rotation_interval INTEGER DEFAULT 60,
      protocol TEXT DEFAULT 'socks5',
      status TEXT DEFAULT 'active',
      expires_at DATETIME,
      traffic_used_bytes INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, expires_at);

    CREATE TABLE IF NOT EXISTS proxies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      ipv6 TEXT NOT NULL,
      port INTEGER NOT NULL,
      protocol TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      bytes_in INTEGER DEFAULT 0,
      bytes_out INTEGER DEFAULT 0,
      last_rotation DATETIME,
      status TEXT DEFAULT 'active',
      UNIQUE(ipv6, port),
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_proxies_order ON proxies(order_id);
    CREATE INDEX IF NOT EXISTS idx_proxies_port ON proxies(port);

    CREATE TABLE IF NOT EXISTS traffic_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proxy_id INTEGER,
      bytes_in INTEGER,
      bytes_out INTEGER,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      amount REAL,
      type TEXT,
      ref TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Bảng idempotency cho create-proxy (tránh double charge khi retry)
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      response TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  logger.info('Database schema initialized');
}

initSchema();

// Wrapper transaction an toàn
function transaction(fn) {
  return db.transaction(fn);
}

module.exports = { db, transaction, logger, DB_PATH };
