'use strict';
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { logger } = require('./db');

const CONFIG_DIR = path.resolve(process.env.CONFIG_DIR || './configs/3proxy');
const TEMPLATE_PATH = path.resolve(__dirname, '../templates/3proxy.cfg.tpl');
const PUBLIC_IP = process.env.PUBLIC_IP || '127.0.0.1';
const BIND_IP = process.env.BIND_IP || '0.0.0.0'; // bind all IPv6
const DRY_RUN = process.env.DRY_RUN === '1'; // khi dev/test không có systemd

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function loadTemplate() {
  return fs.readFileSync(TEMPLATE_PATH, 'utf8');
}

// Render config cho 1 proxy
function renderConfig({ port, ipv6, username, password, protocol }) {
  if (protocol === 'both') { const e=new Error('protocol both not supported'); e.code='VALIDATION_ERROR'; throw e; }
  let tpl = loadTemplate();
  let proxyLine = '';
  if (protocol === 'socks5') {
    proxyLine += `socks -6 -n -a -p${port} -i${BIND_IP} -e${ipv6}\n`;
  }
  if (protocol === 'http') {
    // http proxy thường chạy port+10000 để tránh trùng khi both
    const httpPort = port;
    proxyLine += `proxy -6 -n -a -p${httpPort} -i${BIND_IP} -e${ipv6}`;
  }
  if (!proxyLine) proxyLine = `socks -6 -n -a -p${port} -i${BIND_IP} -e${ipv6}`;
  return tpl
    .replaceAll('{{PORT}}', String(port))
    .replaceAll('{{USER}}', username)
    .replaceAll('{{PASSWORD}}', password)
    .replaceAll('{{PROXY_LINE}}', proxyLine.trim());
}

function configPath(port) {
  return path.join(CONFIG_DIR, `proxy-${port}.cfg`);
}

function execSafe(cmd) {
  if (DRY_RUN) {
    logger.info({ cmd }, '[DRY_RUN] skip exec');
    return;
  }
  try {
    execSync(cmd, { timeout: 10000, stdio: 'pipe' });
  } catch (e) {
    const out = e.stdout?.toString() + e.stderr?.toString();
    throw new Error(`Command failed: ${cmd} -> ${out || e.message}`);
  }
}

function createProxy({ port, ipv6, username, password, protocol }) {
  ensureConfigDir();
  const cfg = renderConfig({ port, ipv6, username, password, protocol });
  fs.writeFileSync(configPath(port), cfg, 'utf8');
  logger.info({ port, ipv6, protocol }, '3proxy config written');

  if (DRY_RUN) return;

  // Thử systemctl, fallback sang chạy trực tiếp nếu không có systemd
  try {
    execSafe(`systemctl start 3proxy@${port}`);
  } catch (e) {
    // Fallback: spawn trực tiếp (cho môi trường không có systemd template)
    logger.warn({ port, err: e.message }, 'systemctl start failed, fallback to direct spawn');
    try {
      const proc = spawn('/usr/local/bin/3proxy', [configPath(port)], { detached: true, stdio: 'ignore' });
      proc.unref();
    } catch (e2) {
      logger.error({ port, err: e2.message }, 'Direct 3proxy spawn failed');
      throw e2;
    }
  }
}

function removeProxy(port) {
  if (DRY_RUN) {
    try { fs.unlinkSync(configPath(port)); } catch (_) {}
    logger.info({ port }, '[DRY_RUN] proxy removed');
    return;
  }
  try { execSafe(`systemctl stop 3proxy@${port}`); } catch (_) {}
  try { fs.unlinkSync(configPath(port)); } catch (_) {}
  logger.info({ port }, 'Proxy removed');
}

function reloadProxy(port, newCfg) {
  // Ghi config mới rồi reload
  if (newCfg) fs.writeFileSync(configPath(port), newCfg, 'utf8');
  if (DRY_RUN) {
    logger.info({ port }, '[DRY_RUN] proxy reload');
    return;
  }
  try {
    execSafe(`systemctl reload 3proxy@${port}`);
  } catch (e) {
    // Nếu reload fail, restart
    try { execSafe(`systemctl restart 3proxy@${port}`); } catch (e2) {
      logger.error({ port, err: e2.message }, 'Reload/restart failed');
      throw e2;
    }
  }
}

// Dùng khi rotate: đổi IPv6 của port, giữ nguyên user/pass/protocol
function rotateProxy({ port, newIpv6, username, password, protocol }) {
  const cfg = renderConfig({ port, ipv6: newIpv6, username, password, protocol });
  reloadProxy(port, cfg);
  logger.info({ port, newIpv6 }, 'Proxy rotated');
}

module.exports = { createProxy, removeProxy, reloadProxy, rotateProxy, renderConfig, configPath, CONFIG_DIR };
