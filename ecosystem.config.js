module.exports = {
  apps: [{
    name: 'ipv6-proxy-api',
    script: 'server.js',
    cwd: '/opt/ipv6-proxy',
    instances: 1,
    exec_mode: 'fork',
    env: { NODE_ENV: 'production' },
    env_production: { NODE_ENV: 'production' },
    max_memory_restart: '500M',
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    autorestart: true,
    watch: false,
    kill_timeout: 5000,
  }],
};
