'use strict';
const { db, logger } = require('./db');

function listServers(opts) {
  opts = opts || {};
  if (opts.activeOnly) {
    return db.prepare("SELECT * FROM ipv6_servers WHERE status=1 ORDER BY sort_order ASC, id ASC").all();
  }
  return db.prepare("SELECT * FROM ipv6_servers ORDER BY sort_order ASC, id ASC").all();
}

function getServer(id) {
  return db.prepare("SELECT * FROM ipv6_servers WHERE id=?").get(id) || null;
}

function defaultServer() {
  return db.prepare("SELECT * FROM ipv6_servers WHERE status=1 ORDER BY sort_order ASC, id ASC LIMIT 1").get() || null;
}

function serverPublicFields(row) {
  if (!row) return null;
  const copy = Object.assign({}, row);
  delete copy.admin_key;
  delete copy.webhook_secret;
  return copy;
}

function serverClientInfo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    api_url: row.api_url,
    public_ip: row.public_ip,
    location: row.location,
    status: row.status,
    sort_order: row.sort_order,
  };
}

module.exports = { listServers, getServer, defaultServer, serverPublicFields, serverClientInfo };
