daemon
pidfile /var/run/3proxy-{{PORT}}.pid
maxconn 100
nserver 1.1.1.1
nserver 8.8.8.8
nscache 65536
timeouts 1 5 30 60 180 1800 15 60
auth strong
users {{USER}}:CL:{{PASSWORD}}
allow {{USER}}
{{PROXY_LINE}}
flush
