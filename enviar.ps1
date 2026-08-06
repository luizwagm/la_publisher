<#
==========================================================================
  enviar.ps1 — manda o código daqui (Windows) para o servidor.

  Uso:
    .\enviar.ps1                  # só envia os arquivos
    .\enviar.ps1 -Reiniciar       # envia e reinicia o serviço
    .\enviar.ps1 -Instalar        # envia e roda a PRIMEIRA instalação

  NUNCA envia data/, midia/ nem backups/ — banco, chave do cofre e os
  arquivos publicados vivem SÓ no servidor. Como eles ficam de fora do
  pacote, o tar não tem como sobrescrevê-los.

  Duas armadilhas de Windows que este script cobre:

  1. CRLF em .sh — o bash do Linux falha com "bad interpreter" ou erros sem
     pé nem cabeça. O script CONFERE antes de enviar e para se achar.
  2. Cano binário no PowerShell — `tar -czf - | ssh` corrompe o pacote,
     porque o PowerShell trata o cano como TEXTO. Por isso gravamos um .tgz
     em disco, mandamos por scp e só então extraímos.
==========================================================================
#>
param(
  [string]$Servidor = "deploy@204.168.208.52",
  [string]$Destino  = "/var/www/projetos/LA-Publisher",
  [string]$Chave    = "$env:USERPROFILE\.ssh\hetzner_budget_new",
  [string]$Dominio  = "publisher.luizaugust.me",
  [switch]$Reiniciar,
  [switch]$Instalar
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Passo($t) { Write-Host "`n$t" -ForegroundColor Cyan }
function Ok($t)    { Write-Host "  ok   $t" -ForegroundColor Green }
function Ruim($t)  { Write-Host "  ✖ $t" -ForegroundColor Red }

# ------------------------------------------------------- 1. conferir CRLF
Passo "1/4  Conferindo os scripts de shell"
$problema = $false
foreach ($f in (Get-ChildItem -Filter *.sh)) {
  $b = [IO.File]::ReadAllBytes($f.FullName)
  $crlf = 0
  for ($i = 1; $i -lt $b.Length; $i++) { if ($b[$i] -eq 10 -and $b[$i-1] -eq 13) { $crlf++ } }
  if ($crlf -gt 0) {
    Ruim "$($f.Name) tem $crlf quebras CRLF — o bash do servidor vai engasgar"
    $problema = $true
  } else { Ok "$($f.Name) com quebras LF" }
}
if ($problema) {
  Write-Host "`n  Corrija com (aqui mesmo, no PowerShell):" -ForegroundColor Yellow
  Write-Host '    Get-ChildItem *.sh | ForEach-Object { $t=[IO.File]::ReadAllText($_.FullName); [IO.File]::WriteAllText($_.FullName, $t.Replace("`r`n","`n")) }'
  exit 1
}

if (-not (Test-Path $Chave)) { Ruim "chave SSH não encontrada em $Chave"; exit 1 }

# ------------------------------------------------------- 2. montar o pacote
Passo "2/4  Montando o pacote"
$pacote = Join-Path $env:TEMP "la-publisher-$(Get-Date -Format yyyyMMdd-HHmmss).tgz"
# --exclude precisa vir ANTES do diretório de origem no bsdtar do Windows
tar -czf $pacote `
  --exclude=./data --exclude=./midia --exclude=./backups `
  --exclude=./node_modules --exclude=./.git --exclude=./.claude `
  -C . .
if ($LASTEXITCODE -ne 0) { Ruim "tar falhou"; exit 1 }
$mb = [math]::Round((Get-Item $pacote).Length / 1MB, 2)
Ok "$pacote ($($mb) MB) — sem data/, midia/ e backups/"

# -------------------------------------------------------------- 3. enviar
Passo "3/4  Enviando para $Servidor"
& scp -i $Chave -o StrictHostKeyChecking=accept-new $pacote "${Servidor}:/tmp/la-publisher.tgz"
if ($LASTEXITCODE -ne 0) { Ruim "scp falhou"; exit 1 }
Ok "pacote no servidor"

$extrair = "mkdir -p '$Destino' && tar -xzf /tmp/la-publisher.tgz -C '$Destino' && rm -f /tmp/la-publisher.tgz && chmod +x '$Destino'/*.sh && ls -la '$Destino' | head -20"
& ssh -i $Chave $Servidor $extrair
if ($LASTEXITCODE -ne 0) { Ruim "falha ao extrair no servidor"; exit 1 }
Ok "extraído em $Destino"

# ------------------------------------------------------------- 4. acionar
Passo "4/4  No servidor"
if ($Instalar) {
  Write-Host "  rodando a primeira instalação…" -ForegroundColor Yellow
  & ssh -i $Chave -t $Servidor "cd '$Destino' && sudo ./instalar.sh $Dominio"
} elseif ($Reiniciar) {
  # git pull NÃO reinicia o Node: alterou .js e não reiniciou, o processo
  # segue com o código velho em memória. Por isso o reinício é explícito.
  & ssh -i $Chave -t $Servidor "sudo systemctl restart lapublisher && sleep 2 && curl -s http://127.0.0.1:5190/saude && echo"
} else {
  Write-Host "  Arquivos enviados. Para valer, rode no servidor:" -ForegroundColor Yellow
  Write-Host "    ssh -i `"$Chave`" $Servidor"
  Write-Host "    cd $Destino && sudo ./instalar.sh $Dominio     # primeira vez"
  Write-Host "    sudo systemctl restart lapublisher              # atualizações"
  Write-Host "`n  Ou repita com -Instalar / -Reiniciar." -ForegroundColor Yellow
}

Remove-Item $pacote -Force -ErrorAction SilentlyContinue
Write-Host ""
