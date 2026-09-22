@echo off
REM deploy-fix-remote.bat - Sửa nhanh VPS đã deploy mà port chưa mở / Nginx 404
REM Chạy: double-click file này, hoặc trong PowerShell: .\scripts\deploy-fix-remote.bat
cd /d "%~dp0.."
node -e "
const {Client}=require('ssh2');
const c=new Client();
c.on('ready',()=>{
  console.log('SSH connected, fixing...');
  c.exec('bash -lc \"bash /opt/ipv6-proxy/scripts/setup-nginx.sh 160.187.246.219 2>&1; echo ---ufw---; ufw allow 30000:40000/tcp; ufw allow 30000:40000/udp; ufw allow 443/tcp; ufw --force enable 2>&1 | tail -5; echo ---health---; curl -s http://127.0.0.1:8080/health; echo; curl -s http://160.187.246.219/health; echo; echo ---listen---; ss -tlnp | grep -E \"8080|3000\" | head\"', (e,s)=>{
    if(e) throw e;
    s.on('close',()=>c.end()).on('data',d=>process.stdout.write(d)).stderr.on('data',d=>process.stderr.write(d));
  });
}).on('error',e=>{console.error(e);process.exit(1)}).connect({host:'160.187.246.219',port:22,username:'root',password:'@5Dr6_#e2z'});
"
pause
