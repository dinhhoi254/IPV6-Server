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

    CREATE TABLE IF NOT EXISTS traffic_state (
      ipv6 TEXT PRIMARY KEY,
      bytes_in INTEGER DEFAULT 0,
      bytes_out INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS proxy_log_state (
      proxy_id INTEGER PRIMARY KEY,
      offset INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS proxy_pool_children (
      proxy_id INTEGER NOT NULL,
      child_index INTEGER NOT NULL,
      port INTEGER NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (proxy_id, child_index),
      FOREIGN KEY(proxy_id) REFERENCES proxies(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      amount REAL,
      type TEXT,
      ref TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ipv6_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      api_url TEXT NOT NULL,
      public_ip TEXT DEFAULT '',
      admin_key TEXT DEFAULT '',
      webhook_secret TEXT DEFAULT '',
      location TEXT DEFAULT '',
      status INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_servers_status ON ipv6_servers(status);

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


function ensureServiceUser(){
  try{
    const ak=(process.env.ADMIN_API_KEY||'').trim();
    if(!ak) return;
    let u=db.prepare('SELECT id FROM users WHERE api_key=?').get(ak);
    if(u) return;
    let z=db.prepare('SELECT id FROM users WHERE id=0').get();
    if(z){ try{ db.prepare("UPDATE users SET api_key=?, email='service@local', is_active=1 WHERE id=0").run(ak); logger.info('Updated service user 0'); }catch(_){} return; }
    try{ db.prepare("INSERT INTO users (id, api_key, email, is_active) VALUES (0, ?, 'service@local', 1)").run(ak); }catch(e){ if(!db.prepare('SELECT id FROM users WHERE api_key=?').get(ak)) throw e; }
  }catch(e){ try{ logger.warn({err:e.message},'ensureServiceUser failed'); }catch(_){} }
}

function ensureServerColumns() {
  try {
    const colsOrders = db.prepare("PRAGMA table_info(orders)").all().map(c=>c.name);
    if (!colsOrders.includes('server_id')) {
      db.exec("ALTER TABLE orders ADD COLUMN server_id INTEGER REFERENCES ipv6_servers(id) ON DELETE SET NULL");
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_orders_server ON orders(server_id)"); } catch(_){ }
      logger.info('Added orders.server_id');
    }
    const colsProxies = db.prepare("PRAGMA table_info(proxies)").all().map(c=>c.name);
    if (!colsProxies.includes('server_id')) {
      db.exec("ALTER TABLE proxies ADD COLUMN server_id INTEGER REFERENCES ipv6_servers(id) ON DELETE SET NULL");
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_proxies_server ON proxies(server_id)"); } catch(_){ }
      logger.info('Added proxies.server_id');
    }
    // Seed 1 server mặc định từ ENV nếu bảng rỗng
    const cnt = db.prepare("SELECT COUNT(*) as c FROM ipv6_servers").get().c;
    if (cnt === 0) {
      const apiUrl = process.env.PUBLIC_IP ? ('http://' + process.env.PUBLIC_IP + ':' + (process.env.PORT||'8080')) : '';
      const pubIp = process.env.PUBLIC_IP || '';
      const adminKey = process.env.ADMIN_API_KEY || '';
      if (apiUrl || pubIp) {
        db.prepare("INSERT INTO ipv6_servers (name, api_url, public_ip, admin_key, location, status, sort_order) VALUES (?,?,?,?,?,?,?)")
          .run('Default', apiUrl, pubIp, adminKey, 'Default', 1, 0);
        logger.info('Seeded default ipv6_server');
      }
    }
  } catch(e) { logger.warn({err:e.message}, 'ensureServerColumns failed'); }
}

function ensureTrafficColumns() {
  try {
    const colsOrders = db.prepare("PRAGMA table_info(orders)").all().map(c => c.name);
    if (!colsOrders.includes('traffic_used_bytes')) {
      db.exec("ALTER TABLE orders ADD COLUMN traffic_used_bytes INTEGER DEFAULT 0");
      logger.info('Added orders.traffic_used_bytes');
    }
    if (!colsOrders.includes('traffic_limit_gb')) {
      db.exec("ALTER TABLE orders ADD COLUMN traffic_limit_gb REAL");
      logger.info('Added orders.traffic_limit_gb');
    }
    if (!colsOrders.includes('billing')) {
      db.exec("ALTER TABLE orders ADD COLUMN billing TEXT NOT NULL DEFAULT 'time'");
      logger.info('Added orders.billing');
    }
    if (!colsOrders.includes('rotation_interval')) {
      db.exec("ALTER TABLE orders ADD COLUMN rotation_interval INTEGER DEFAULT 60");
      logger.info('Added orders.rotation_interval');
    }

    const colsProxies = db.prepare("PRAGMA table_info(proxies)").all().map(c => c.name);
    if (!colsProxies.includes('bytes_in')) {
      db.exec("ALTER TABLE proxies ADD COLUMN bytes_in INTEGER DEFAULT 0");
      logger.info('Added proxies.bytes_in');
    }
    if (!colsProxies.includes('bytes_out')) {
      db.exec("ALTER TABLE proxies ADD COLUMN bytes_out INTEGER DEFAULT 0");
      logger.info('Added proxies.bytes_out');
    }
    if (!colsProxies.includes('last_rotation')) {
      db.exec("ALTER TABLE proxies ADD COLUMN last_rotation DATETIME");
      logger.info('Added proxies.last_rotation');
    }

    const colsPool = db.prepare("PRAGMA table_info(ipv6_pool)").all().map(c => c.name);
    if (!colsPool.includes('health_status')) {
      db.exec("ALTER TABLE ipv6_pool ADD COLUMN health_status TEXT DEFAULT 'unknown'");
      logger.info('Added ipv6_pool.health_status');
    }
    if (!colsPool.includes('health_latency_ms')) {
      db.exec("ALTER TABLE ipv6_pool ADD COLUMN health_latency_ms INTEGER");
      logger.info('Added ipv6_pool.health_latency_ms');
    }
    if (!colsPool.includes('health_checked_at')) {
      db.exec("ALTER TABLE ipv6_pool ADD COLUMN health_checked_at DATETIME");
      logger.info('Added ipv6_pool.health_checked_at');
    }
    if (!colsPool.includes('health_fail_count')) {
      db.exec("ALTER TABLE ipv6_pool ADD COLUMN health_fail_count INTEGER DEFAULT 0");
      logger.info('Added ipv6_pool.health_fail_count');
    }
    try { db.exec("CREATE INDEX IF NOT EXISTS idx_pool_health ON ipv6_pool(status, health_status)"); } catch (_) {}

    db.exec(`
      CREATE TABLE IF NOT EXISTS traffic_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proxy_id INTEGER,
        bytes_in INTEGER,
        bytes_out INTEGER,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS traffic_state (
        ipv6 TEXT PRIMARY KEY,
        bytes_in INTEGER DEFAULT 0,
        bytes_out INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS proxy_log_state (
        proxy_id INTEGER PRIMARY KEY,
        offset INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS proxy_pool_children (
        proxy_id INTEGER NOT NULL,
        child_index INTEGER NOT NULL,
        port INTEGER NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (proxy_id, child_index),
        FOREIGN KEY(proxy_id) REFERENCES proxies(id) ON DELETE CASCADE
      );
    `);
  } catch (e) {
    logger.warn({ err: e.message }, 'ensureTrafficColumns failed');
  }
}
initSchema();
ensureServiceUser();
ensureServerColumns();
ensureTrafficColumns();

// Wrapper transaction an toàn
function transaction(fn) {
  return db.transaction(fn);
}

module.exports = { db, transaction, logger, DB_PATH };
