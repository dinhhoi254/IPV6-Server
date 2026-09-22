{{DAEMON_LINE}}
pidfile {{PIDFILE}}
maxconn 100
nserver 1.1.1.1
nserver 8.8.8.8
nscache 65536
timeouts 1 5 30 60 180 1800 15 60
{{LOG_BLOCK}}
{{AUTH_BLOCK}}
{{EXTRA_LINES}}
{{PROXY_LINE}}
flush
