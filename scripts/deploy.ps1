# deploy.ps1 — Deploy từ máy Windows (PowerShell) tới VPS qua SSH, tự login + setup full
# Yêu cầu: OpenSSH (ssh/scp có sẵn trên Windows 10+), hoặc Git Bash
#
# Ví dụ:
#   .\scripts\deploy.ps1 -Vps "root@160.187.246.219" -Password '?BG8a$s7D-'
#   .\scripts\deploy.ps1 -Vps "root@1.2.3.4" -Prefix "2001:db8:abcd::/64" -Pool 7000
#   .\scripts\deploy.ps1 -Vps "root@1.2.3.4" -Key "$env:USERPROFILE\.ssh\id_rsa"
#   .\scripts\deploy.ps1 -Vps "root@1.2.3.4" -Domain "proxy.example.com" -Email "admin@example.com"
#
# Deploy nhiều VPS:
#   .\scripts\deploy.ps1 -Vps "root@1.1.1.1,root@2.2.2.2" -Password 'mypass'

param(
  [Parameter(Mandatory=$true)][string]$Vps,
  [string]$Password = "",
  [string]$Key = "",
  [string]$Port = "22",
  [string]$Prefix = "",
  [string]$Pool = "7000",
  [string]$Domain = "",
  [string]$Email = "",
  [string]$Repo = "",
  [string]$InstallDir = "/opt/ipv6-proxy"
)

$ErrorActionPreference = "Stop"

# Thư mục local (chứa package.json)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LocalDir = Resolve-Path (Join-Path $ScriptDir "..")
Write-Host "======================================================"
Write-Host "  Deploy to $Vps"
Write-Host "  Local dir: $LocalDir"
Write-Host "  Remote dir: $InstallDir"
if ($Prefix) { Write-Host "  Prefix: $Prefix" } else { Write-Host "  Prefix: (tu dong do tren VPS)" }
Write-Host "  Pool: $Pool"
if ($Domain) { Write-Host "  Domain: $Domain" }
Write-Host "======================================================"

# Tách nhiều VPS nếu truyền dạng "a,b,c" hoặc "a b c"
$VpsList = $Vps -split '[,\s]+' | Where-Object { $_ -ne "" }

# Kiểm tra ssh có sẵn không
$sshCmd = Get-Command ssh -ErrorAction SilentlyContinue
if (-not $sshCmd) {
  Write-Error "Không tìm thấy 'ssh'. Cài OpenSSH: Settings > Apps > Optional Features > OpenSSH Client"
  exit 1
}

# Kiểm tra sshpass/key: trên Windows thường dùng key hoặc password qua plink/sshpass (Git Bash)
# Với password trên PowerShell native, dùng plink nếu có, hoặc hướng dẫn dùng Git Bash
function Test-SshConnection {
  param([string]$Target)
  $sshArgs = @("-p", $Port, "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=15")
  if ($Key) { $sshArgs += @("-i", $Key) }
  $sshArgs += @($Target, "echo 'SSH OK:'; hostname; ip -6 addr show scope global 2>/dev/null | head -5")
  if ($Password -and (Get-Command sshpass -ErrorAction SilentlyContinue)) {
    $env:SSHPASS = $Password
    & sshpass -e ssh @sshArgs
  } elseif ($Password) {
    Write-Warning "Không có 'sshpass' — trên Windows hãy dùng Git Bash để truyền --password, hoặc dùng --key"
    Write-Host "Thử kết nối không password (dùng key/agent) ..."
    & ssh @sshArgs
  } else {
    & ssh @sshArgs
  }
  return $LASTEXITCODE -eq 0
}

# Tạo tar.gz local (dùng tar có sẵn trên Windows 10+ hoặc git tar)
function New-DeployTar {
  param([string]$Output)
  $tar = Get-Command tar -ErrorAction SilentlyContinue
  if (-not $tar) { $tar = Get-Command bsdtar -ErrorAction SilentlyContinue }
  if ($tar) {
    # Dùng tar native — exclude node_modules, .git, data, logs, .env
    $excludeArgs = @("--exclude=node_modules", "--exclude=.git", "--exclude=data", "--exclude=logs", "--exclude=.env")
    & tar @excludeArgs -czf $Output -C $LocalDir package.json package-lock.json server.js ecosystem.config.js .env.example src templates scripts configs 2>$null
    if ($LASTEXITCODE -ne 0) {
      # fallback: tar toàn bộ trừ exclude
      & tar @excludeArgs -czf $Output -C $LocalDir . 2>$null
    }
    return (Test-Path $Output)
  } else {
    Write-Error "Không tìm thấy 'tar'. Cài Git for Windows hoặc dùng WSL."
    return $false
  }
}

foreach ($Target in $VpsList) {
  Write-Host ""
  Write-Host ">>> Deploying to $Target ..."

  # 1. Test SSH
  Write-Host ">>> [1/4] Kiem tra SSH ..."
  # Dùng ssh trực tiếp
  $sshArgs = @("-p", $Port, "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=15")
  if ($Key) { $sshArgs += @("-i", $Key) }

  # Nếu có password và sshpass không có, thử plink
  $useSshpass = $false
  if ($Password -and (Get-Command sshpass -ErrorAction SilentlyContinue)) { $useSshpass = $true }

  # Helper để chạy ssh
  function Invoke-RemoteSsh {
    param([string[]]$RemoteArgs)
    $a = $sshArgs + $RemoteArgs
    if ($useSshpass) { $env:SSHPASS = $Password; & sshpass -e ssh @a }
    else { & ssh @a }
  }
  function Invoke-RemoteScp {
    param([string]$From, [string]$To)
    $a = @("-P", $Port, "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=15")
    if ($Key) { $a += @("-i", $Key) }
    $a += @($From, $To)
    if ($useSshpass) { $env:SSHPASS = $Password; & sshpass -e scp @a }
    else { & scp @a }
  }

  # Nếu có password nhưng không có sshpass/plink trên PowerShell native, cảnh báo và gợi ý
  if ($Password -and -not $useSshpass) {
    $plink = Get-Command plink -ErrorAction SilentlyContinue
    if ($plink) {
      Write-Host "  Dung plink de login bang password ..."
      # plink tự xử lý
    } else {
      Write-Host ""
      Write-Host "  [Luu y] Tren PowerShell native khong co sshpass/plink," -ForegroundColor Yellow
      Write-Host "  Hay chay lenh nay trong Git Bash:" -ForegroundColor Yellow
      Write-Host "    bash scripts/deploy.sh $Target --password '$Password' --pool $Pool" -ForegroundColor Cyan
      if ($Prefix) { Write-Host "      --prefix $Prefix \" -ForegroundColor Cyan }
      Write-Host "  Hoac dung key: .\scripts\deploy.ps1 -Vps $Target -Key C:\path\to\key" -ForegroundColor Yellow
      Write-Host ""
      Write-Host "  Thu ket noi bang key/agent hien tai ..."
    }
  }

  Invoke-RemoteSsh @($Target, "echo 'SSH OK'; hostname; cat /etc/os-release 2>/dev/null | head -3")
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  [FAIL] Khong ket noi duoc $Target — bo qua" -ForegroundColor Red
    continue
  }

  # 2. Upload
  Write-Host ">>> [2/4] Upload code ..."
  if ($Repo) {
    Write-Host "  Git clone: $Repo"
    Invoke-RemoteSsh @($Target, "if [ ! -d $InstallDir/.git ]; then rm -rf $InstallDir; git clone $Repo $InstallDir; else cd $InstallDir && git fetch --all && git reset --hard origin/main 2>/dev/null || git reset --hard origin/master 2>/dev/null || git pull; fi")
  } else {
    $tmpTar = Join-Path $env:TEMP "ipv6-proxy-$([Guid]::NewGuid().ToString('N').Substring(0,8)).tar.gz"
    Write-Host "  Nen: $LocalDir -> $tmpTar"
    if (-not (New-DeployTar -Output $tmpTar)) {
      Write-Host "  [FAIL] Khong tao duoc tar" -ForegroundColor Red
      continue
    }
    Write-Host "  Upload ..."
    Invoke-RemoteSsh @($Target, "mkdir -p $InstallDir")
    Invoke-RemoteScp -From $tmpTar -To "${Target}:/tmp/ipv6-proxy.tar.gz"
    Remove-Item $tmpTar -Force -ErrorAction SilentlyContinue
    Invoke-RemoteSsh @($Target, "tar -xzf /tmp/ipv6-proxy.tar.gz -C $InstallDir && rm -f /tmp/ipv6-proxy.tar.gz && chmod +x $InstallDir/scripts/*.sh && ls -la $InstallDir/scripts/ | head -20")
  }

  if ($LASTEXITCODE -ne 0) {
    Write-Host "  [FAIL] Upload that bai" -ForegroundColor Red
    continue
  }

  # 3. Bootstrap
  Write-Host ">>> [3/4] Chay bootstrap tren VPS ..."
  $bootArgs = "--pool $Pool --dir $InstallDir"
  if ($Prefix) { $bootArgs += " --prefix $Prefix" }
  if ($Domain) { $bootArgs += " --domain $Domain" }
  if ($Email)  { $bootArgs += " --email $Email" }
  if ($Repo)   { $bootArgs += " --repo $Repo" }
  Invoke-RemoteSsh @($Target, "chmod +x $InstallDir/scripts/*.sh && bash $InstallDir/scripts/bootstrap.sh $bootArgs 2>&1")
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  [WARN] bootstrap loi — kiem tra log tren VPS" -ForegroundColor Yellow
    Invoke-RemoteSsh @($Target, "cat $InstallDir/logs/pm2-error.log 2>/dev/null | tail -50; cat $InstallDir/logs/app.log 2>/dev/null | tail -50")
    continue
  }

  # 4. Verify
  Write-Host ">>> [4/4] Kiem tra health ..."
  Invoke-RemoteSsh @($Target, "curl -s http://127.0.0.1:8080/health 2>/dev/null | python3 -m json.tool 2>/dev/null || curl -s http://127.0.0.1:8080/health; echo ''; echo '--- PM2 ---'; pm2 list 2>/dev/null | head -20; echo ''; echo '--- Pool ---'; sqlite3 $InstallDir/data/app.db 'SELECT status, COUNT(*) FROM ipv6_pool GROUP BY status;' 2>/dev/null || echo '(pool check skipped)'; echo ''; echo '--- .env ---'; grep -E '^(ADMIN_API_KEY|PUBLIC_IP|IPV6_PREFIX)=' $InstallDir/.env 2>/dev/null | sed 's/^/  /'")

  Write-Host ""
  Write-Host "  [OK] Deploy xong: $Target" -ForegroundColor Green
}

Write-Host ""
Write-Host "======================================================"
Write-Host "  Hoan tat!"
Write-Host "======================================================"
