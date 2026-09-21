#!/usr/bin/env node
// auto-setup-ipv6.js — 1 click: SSH lay key + tu ghi vao DB web chinh (khong can vao admin)
// Dung: set VPS_PASS=matkhau && npm run setup:ipv6
//   hoac: set VPS_PASS=matkhau && node scripts/auto-setup-ipv6.js --api-url http://160.187.246.219:8080
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ROOT = path.resolve(__dirname, '..');
const HTDOCS = path.resolve(ROOT, '..');
const VPS_HOST = process.env.VPS_HOST || '160.187.246.219';
const VPS_USER = process.env.VPS_USER || 'root';
const VPS_PASS = process.env.VPS_PASS || '';
const VPS_PORT = process.env.VPS_PORT || '22';
let API_URL_OVERRIDE = '';
for (let i = 2; i < process.argv.length; i++) { if (process.argv[i]==='--api-url' && process.argv[i+1]) API_URL_OVERRIDE=process.argv[++i]; }
if (!VPS_PASS) { console.error('Thieu VPS_PASS. Chay: set VPS_PASS=matkhau && npm run setup:ipv6'); process.exit(1); }
function log(m){ console.log(m); }
async function getVpsEnv(){
  try{ require.resolve('ssh2'); }catch{ log('>> Cai ssh2...'); execSync('npm install --no-save ssh2',{stdio:'inherit',cwd:ROOT}); }
  const {Client}=require('ssh2');
  log('SSH '+VPS_USER+'@'+VPS_HOST+':'+VPS_PORT+' ...');
  const conn=new Client();
  const out=await new Promise((resolve,reject)=>{
    let buf='';
    conn.on('ready',()=>{
      conn.exec("cat /opt/ipv6-proxy/.env 2>&1", (err,stream)=>{
        if(err) return reject(err);
        stream.on('close',()=>resolve(buf)).on('data',d=>buf+=d);
        stream.stderr.on('data',d=>buf+=d);
      });
    }).on('error',reject).connect({host:VPS_HOST,port:parseInt(VPS_PORT,10),username:VPS_USER,password:VPS_PASS,readyTimeout:15000});
  });
  conn.end();
  const env={};
  for(const line of out.split('\n')){ const m=line.match(/^\s*([A-Z_]+)=(.*)\s*$/); if(m) env[m[1]]=m[2].trim(); }
  if(!env.ADMIN_API_KEY) throw new Error('Khong doc duoc ADMIN_API_KEY. Output: '+out.slice(0,500));
  return env;
}
function detectPhp(){
  const cands=[path.join(HTDOCS,'..','php','php.exe'), 'C:/xampp/php/php.exe', 'php'];
  for(const p of cands){ try{ if(fs.existsSync(p)) return '"'+p+'"'; }catch{} }
  return 'php';
}
function runPhp(env){
  const ADMIN_KEY=env.ADMIN_API_KEY||'';
  const WEBHOOK=env.WEBHOOK_SECRET||'';
  const PUBLIC_IP=env.PUBLIC_IP||VPS_HOST;
  const API_URL=API_URL_OVERRIDE || ('http://'+PUBLIC_IP+':8080');
  const phpBin=detectPhp();
  log('PHP: '+phpBin);
  log('Ghi DB: API_URL='+API_URL+' PUBLIC_IP='+PUBLIC_IP+' ADMIN_KEY='+ADMIN_KEY.slice(0,12)+'...');
  const tmpPhp=path.join(os.tmpdir(), 'setup_ipv6_'+Date.now()+'.php');
  const phpFile='<?php\n'
    +'require_once '+JSON.stringify(path.join(HTDOCS,'cmstdev.php'))+';\n'
    +'require_once '+JSON.stringify(path.join(HTDOCS,'classes','db.php'))+';\n'
    +'require_once '+JSON.stringify(path.join(HTDOCS,'classes','functions.php'))+';\n'
    +'$db = new DB();\n'
    +'function upsertOpt($db,$k,$v){\n'
    +'  $safeK=addslashes($k); $safeV=addslashes($v);\n'
    +'  $row=$db->getRow("SELECT `key` FROM `options` WHERE `key`=\'$safeK\' LIMIT 1");\n'
    +'  if($row) return $db->update("options",["value"=>$v]," `key`=\'$safeK\' ");\n'
    +'  return $db->query("INSERT INTO `options` (`key`,`value`) VALUES (\'$safeK\',\'$safeV\')");\n'
    +'}\n'
    +'$adminKey='+JSON.stringify(ADMIN_KEY)+';\n'
    +'$webhook='+JSON.stringify(WEBHOOK)+';\n'
    +'$apiUrl=rtrim('+JSON.stringify(API_URL)+',"/");\n'
    +'$publicIp='+JSON.stringify(PUBLIC_IP)+';\n'
    +'$encAdmin=encryptAES($adminKey);\n'
    +'$encWebhook=$webhook!==""?encryptAES($webhook):"";\n'
    +'$ok1=upsertOpt($db,"ipv6_proxy_api_url",$apiUrl);\n'
    +'$ok2=upsertOpt($db,"ipv6_proxy_public_ip",$publicIp);\n'
    +'$ok3=upsertOpt($db,"ipv6_proxy_admin_key",$encAdmin);\n'
    +'$ok4=$webhook!==""?upsertOpt($db,"ipv6_proxy_webhook_secret",$encWebhook):true;\n'
    +'$ok5=upsertOpt($db,"ipv6_proxy_enabled","1");\n'
    +'$ok6=upsertOpt($db,"ipv6_proxy_user_mode","service");\n'
    +'echo "OK api_url=".$db->site("ipv6_proxy_api_url")."\n";\n'
    +'echo "OK public_ip=".$db->site("ipv6_proxy_public_ip")."\n";\n'
    +'echo "OK admin_key_len=".strlen($db->site("ipv6_proxy_admin_key"))."\n";\n'
    +'echo "OK webhook_len=".strlen($db->site("ipv6_proxy_webhook_secret"))."\n";\n'
    +'echo "OK enabled=".$db->site("ipv6_proxy_enabled")."\n";\n'
    +'echo "DONE\n";\n';
  fs.writeFileSync(tmpPhp, phpFile, 'utf8');
  try{
    const out=execSync(phpBin+' '+JSON.stringify(tmpPhp), {encoding:'utf8', cwd: HTDOCS, timeout:15000});
    log(out);
    if(out.indexOf('DONE')===-1) throw new Error('PHP ghi DB khong thanh cong: '+out);
  } finally { try{fs.unlinkSync(tmpPhp);}catch{} }
  try{ const r=spawnSync('clip',[],{input:ADMIN_KEY, shell:true}); if(r.status===0) log('>> Da copy ADMIN_API_KEY vao clipboard.'); }catch{}
  log(''); log('XONG! Vao cpanel/proxy/config bam "Kiem tra ket noi" de verify.'); log('Test: curl '+API_URL+'/health');
}
(async()=>{ const env=await getVpsEnv(); log('VPS env: PUBLIC_IP='+(env.PUBLIC_IP||'')+' IPV6_PREFIX='+(env.IPV6_PREFIX||'').slice(0,30)+' ADMIN_API_KEY='+env.ADMIN_API_KEY.slice(0,12)+'...'); runPhp(env); })().catch(e=>{ console.error('[FAIL]',e.message); process.exit(1); });
