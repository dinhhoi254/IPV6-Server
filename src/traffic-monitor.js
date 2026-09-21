'use strict';
const { execSync } = require('child_process');
const { db, logger } = require('./db');

// Khởi tạo nftables accounting table (gọi 1 lần khi boot)
function initNftables() {
  if (process.env.DRY_RUN === '1') {
    logger.info('[DRY_RUN] skip nftables init');
    return;
  }
  try {
    // Tạo table/chain nếu chưa có (ignore error nếu đã tồn tại)
    try { execSync('nft add table ip6 proxyacct', { stdio: 'pipe' }); } catch (_) {}
    try { execSync('nft add chain ip6 proxyacct output { type filter hook output priority 0 \\; }', { stdio: 'pipe' }); } catch (_) {}
    logger.info('nftables proxyacct initialized');
  } catch (e) {
    logger.warn({ err: e.message }, 'nftables init failed (may not have nft or permission)');
  }
}

// Thêm rule counter cho 1 IPv6 (khi tạo proxy mới)
function addCounter(ipv6) {
  if (process.env.DRY_RUN === '1') return;
  try {
    execSync(`nft add rule ip6 proxyacct output ip6 saddr ${ipv6} counter`, { stdio: 'pipe' });
  } catch (e) {
    // Rule đã tồn tại thì bỏ qua
    if (!e.message.includes('File exists')) logger.warn({ ipv6, err: e.message }, 'addCounter failed');
  }
}

function removeCounter(ipv6) {
  if (process.env.DRY_RUN === '1') return;
  try {
    // Liệt kê và xóa rule chứa IP này (nft không hỗ trợ delete by saddr trực tiếp, dùng handle)
    const out = execSync('nft --handle -nn list chain ip6 proxyacct output', { encoding: 'utf8', stdio: 'pipe' });
    for (const line of out.split('\n')) {
      if (line.includes(ipv6)) {
        const m = line.match(/handle\s+(\d+)/);
        if (m) {
          try { execSync(`nft delete rule ip6 proxyacct output handle ${m[1]}`, { stdio: 'pipe' }); } catch (_) {}
        }
      }
    }
  } catch (_) {}
}

// Thu thập bytes từ nft -j và cập nhật DB
function collectAndUpdate() {
  if (process.env.DRY_RUN === '1') return { updated: 0 };
  let json;
  try {
    const out = execSync('nft -j list table ip6 proxyacct', { encoding: 'utf8', stdio: 'pipe', timeout: 10000 });
    json = JSON.parse(out);
  } catch (e) {
    logger.warn({ err: e.message }, 'nft list failed');
    return { updated: 0 };
  }

  // Parse nft JSON: tìm các rule có counter + saddr
  const counters = new Map(); // ipv6 -> bytes
  try {
    const rules = json?.nftables?.filter((x) => x.rule) || [];
    for (const entry of rules) {
      const rule = entry.rule;
      const exprs = rule.expr || [];
      let saddr = null;
      let bytes = 0;
      for (const ex of exprs) {
        if (ex.match && ex.match.left?.payload?.field === 'saddr') saddr = ex.match.right;
        if (ex.counter) bytes = ex.counter.bytes || 0;
      }
      if (saddr && bytes) counters.set(saddr, bytes);
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'Parse nft JSON failed');
    return { updated: 0 };
  }

  if (counters.size === 0) return { updated: 0 };

  // Cập nhật proxies.bytes_out và orders.traffic_used_bytes (tính delta)
  // Lưu last_bytes vào memory để tính delta; đơn giản: dùng bytes hiện tại làm total
  let updated = 0;
  const tx = db.transaction(() => {
    for (const [ipv6, bytes] of counters) {
      const proxy = db.prepare('SELECT id, order_id, bytes_out FROM proxies WHERE ipv6=?').get(ipv6);
      if (!proxy) continue;
      const delta = bytes - (proxy.bytes_out || 0);
      if (delta <= 0) continue;
      db.prepare('UPDATE proxies SET bytes_out = ? WHERE id=?').run(bytes, proxy.id);
      db.prepare('UPDATE orders SET traffic_used_bytes = traffic_used_bytes + ? WHERE id=?').run(delta, proxy.order_id);
      db.prepare('INSERT INTO traffic_log (proxy_id, bytes_in, bytes_out) VALUES (?,?,?)').run(proxy.id, 0, delta);
      updated++;
    }
  });
  tx();
  if (updated > 0) logger.info({ updated }, 'Traffic counters synced');
  return { updated };
}

let intervalId = null;
function start(intervalMs) {
  const ms = intervalMs || 60_000;
  initNftables();
  intervalId = setInterval(collectAndUpdate, ms);
  logger.info({ intervalMs: ms }, 'Traffic monitor started');
}

function stop() {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
}

module.exports = { initNftables, addCounter, removeCounter, collectAndUpdate, start, stop };
