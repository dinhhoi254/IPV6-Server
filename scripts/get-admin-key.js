#!/usr/bin/env node
// get-admin-key.js — SSH lay ADMIN_API_KEY/WEBHOOK_SECRET va copy vao clipboard
// Dung: set VPS_PASS=... & node scripts/get-admin-key.js  (hoac chay .bat se hoi pass)
const { execSync, spawnSync } = require('child_process');
const VPS_HOST = process.env.VPS_HOST || '160.187.246.219';
const VPS_USER = process.env.VPS_USER || 'root';
const VPS_PASS = process.env.VPS_PASS || '';
const VPS_PORT = process.env.VPS_PORT || '22';
if (!VPS_PASS) { console.error('Thieu VPS_PASS. Chay: set VPS_PASS=matkhau && node scripts/get-admin-key.js'); process.exit(1); }
async function main(){
  try{ require.resolve('ssh2'); }catch{ console.log('>> Cai ssh2...'); execSync('npm install --no-save ssh2',{stdio:'inherit'}); }
  const {Client}=require('ssh2');
  console.log('SSH '+VPS_USER+'@'+VPS_HOST+':'+VPS_PORT+' ...');
  const conn=new Client();
  const result=await new Promise((resolve,reject)=>{
    let out='';
    conn.on('ready',()=>{
      conn.exec("grep -E '^(ADMIN_API_KEY|WEBHOOK_SECRET|PUBLIC_IP|IPV6_PREFIX)=' /opt/ipv6-proxy/.env 2>&1; echo \"---\"; grep -E '^(ADMIN_API_KEY|WEBHOOK_SECRET)=' /opt/ipv6-proxy/.env 2>/dev/null | head -5",(err,stream)=>{
        if(err) return reject(err);
        stream.on('close',()=>resolve(out)).on('data',d=>out+=d);
        stream.stderr.on('data',d=>out+=d);
      });
    }).on('error',reject).connect({host:VPS_HOST,port:parseInt(VPS_PORT,10),username:VPS_USER,password:VPS_PASS,readyTimeout:15000});
  });
  conn.end();
  console.log(result);
  const m=result.match(/ADMIN_API_KEY=([^\r\n]+)/);
  const key=m?m[1].trim():'';
  if(!key){ console.log('!! Khong tim thay ADMIN_API_KEY'); return; }
  console.log('ADMIN_API_KEY='+key);
  try{
    const proc=spawnSync('clip',[],{input:key, shell:true});
    if(proc.status===0) console.log('>> Da copy ADMIN_API_KEY vao clipboard (Ctrl+V de dan vao admin).');
    else throw new Error('clip fail');
  }catch{
    try{ execSync('powershell -command "Set-Clipboard -Value \''+key.replace(/'/g,"''")+'\'"',{stdio:'inherit'}); console.log('>> Da copy vao clipboard (PowerShell).'); }catch{ console.log('>> Copy thu cong: '+key); }
  }
  console.log('\nDan vao: cpanel/proxy/config -> o ADMIN_API_KEY -> Luu cau hinh -> Kiem tra ket noi');
}
main().catch(e=>{ console.error('[FAIL]',e.message); process.exit(1); });
