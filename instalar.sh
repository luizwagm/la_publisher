#!/usr/bin/env bash
# ==========================================================================
#  instalar.sh — primeira instalação do LA Publisher no servidor
#
#  Uso:  sudo ./instalar.sh [dominio]
#  Ex.:  sudo ./instalar.sh publisher.luizaugust.me
#
#  Roda UMA vez. Para atualizar depois, use ./deploy.sh (ou enviar.ps1 do
#  Windows), que preserva banco, chave e mídia.
#
#  O que ele faz:
#    1. confere Node ≥ 22.5 (o `node:sqlite` não existe antes disso)
#    2. cria as pastas e acerta o dono
#    3. instala e sobe o serviço
#    4. cria o vhost do nginx
#    5. emite o certificado (só se o DNS já apontar para cá)
#    6. confere de fora e mostra a senha inicial
#
#  ATENÇÃO ao rodar isto vindo do Windows: se o arquivo tiver quebra de linha
#  CRLF, o bash falha com "bad interpreter" ou erros sem sentido. O script se
#  autocorrige na primeira linha útil, mas se der problema:  dos2unix *.sh
# ==========================================================================
set -uo pipefail

DOMINIO="${1:-publisher.luizaugust.me}"
APP_DIR="${APP_DIR:-$(cd "$(dirname "$(readlink -f "$0")")" && pwd)}"
SERVICO="lapublisher.service"
PORTA="${PORTA:-5190}"
DONO="${DONO:-deploy}"
EMAIL="${EMAIL:-luizwagm@gmail.com}"

cd "$APP_DIR" || { echo "Diretório $APP_DIR não existe"; exit 1; }

azul()    { printf "\033[1;34m%s\033[0m\n" "$1"; }
verde()   { printf "\033[1;32m  ✓ %s\033[0m\n" "$1"; }
amarelo() { printf "\033[1;33m  ! %s\033[0m\n" "$1"; }
vermelho(){ printf "\033[1;31m  ✖ %s\033[0m\n" "$1"; }

[ "$(id -u)" = "0" ] || { vermelho "Rode com sudo."; exit 1; }

# --------------------------------------------------------------- 1. Node
azul "1/6  Node"
if ! command -v node >/dev/null 2>&1; then
  vermelho "node não encontrado. Instale o Node 22 ou mais novo antes."
  exit 1
fi
NODE_V=$(node -p "process.versions.node")
NODE_MAJ=${NODE_V%%.*}
NODE_MIN=$(echo "$NODE_V" | cut -d. -f2)
if [ "$NODE_MAJ" -lt 22 ] || { [ "$NODE_MAJ" = "22" ] && [ "$NODE_MIN" -lt 5 ]; }; then
  vermelho "Node $NODE_V é antigo demais. O sistema usa o node:sqlite nativo, que exige 22.5+."
  exit 1
fi
verde "node $NODE_V"

# ------------------------------------------------------------ 2. pastas
azul "2/6  Pastas e permissões"
id "$DONO" >/dev/null 2>&1 || { vermelho "usuário $DONO não existe"; exit 1; }
mkdir -p data midia backups
# A PASTA precisa ser gravável, não só o arquivo: o SQLite cria o -wal ao lado
# do banco. Dono errado responde "attempt to write a readonly database" e nada
# é salvo — armadilha já paga em outro projeto.
chown -R "$DONO:$DONO" "$APP_DIR"
chmod 755 data midia backups
[ -f data/.chave ] && chmod 600 data/.chave
verde "dono $DONO · data/ e midia/ graváveis"

# ------------------------------------------------------------ 3. serviço
azul "3/6  Serviço systemd"
sed "s|/var/www/projetos/LA-Publisher|$APP_DIR|g; s|^User=.*|User=$DONO|; s|^Group=.*|Group=$DONO|; s|^Environment=PORT=.*|Environment=PORT=$PORTA|" \
  nginx/lapublisher.service > /etc/systemd/system/$SERVICO
systemctl daemon-reload
systemctl enable "$SERVICO" >/dev/null 2>&1
systemctl restart "$SERVICO"
sleep 3
if systemctl is-active --quiet "$SERVICO"; then
  verde "$SERVICO no ar"
else
  vermelho "o serviço não subiu. Últimas linhas:"
  journalctl -u "$SERVICO" -n 20 --no-pager | sed 's/^/     /'
  exit 1
fi

SAUDE=$(curl -s --max-time 5 "http://127.0.0.1:$PORTA/saude" || echo "")
if echo "$SAUDE" | grep -q '"ok":true'; then
  verde "responde em 127.0.0.1:$PORTA — $SAUDE"
else
  vermelho "a aplicação não respondeu em 127.0.0.1:$PORTA"
  journalctl -u "$SERVICO" -n 20 --no-pager | sed 's/^/     /'
  exit 1
fi

# -------------------------------------------------------------- 4. nginx
azul "4/6  Vhost do nginx"
ARQ="/etc/nginx/sites-available/$DOMINIO"
# O certbot REESCREVE este arquivo ao emitir o certificado: acrescenta o bloco
# 443 e o redirecionamento. Sobrescrever depois disso apagaria o HTTPS e
# deixaria o site em HTTP puro — com a agravante de que o certificado continua
# existindo, então ninguém desconfia. Por isso: se o certbot já mexeu aqui,
# NÃO tocamos no arquivo. Para forçar (mudou porta, mudou limite de upload),
# rode com RECRIAR_VHOST=1 — e depois passe o certbot de novo.
if [ -f "$ARQ" ] && grep -q "managed by Certbot" "$ARQ" && [ "${RECRIAR_VHOST:-0}" != "1" ]; then
  amarelo "o vhost já foi ajustado pelo certbot — mantido como está (use RECRIAR_VHOST=1 para refazer)"
else
  [ -f "$ARQ" ] && cp "$ARQ" "$ARQ.bak-$(date +%F-%H%M%S)" && amarelo "já existia — copiei para $ARQ.bak-*"
  sed "s|publisher.luizaugust.me|$DOMINIO|g; s|127.0.0.1:5190|127.0.0.1:$PORTA|g; s|/var/www/projetos/LA-Publisher|$APP_DIR|g" \
    nginx/publisher.luizaugust.me.conf > "$ARQ"
fi
ln -sf "$ARQ" "/etc/nginx/sites-enabled/$DOMINIO"
if ! nginx -t 2>&1 | sed 's/^/     /'; then
  vermelho "configuração inválida — nada foi recarregado"
  exit 1
fi
systemctl reload nginx
# `nginx -t` valida a SINTAXE e aprova até bloco que o nginx não carrega.
# Quem prova que o vhost está mesmo ativo é o -T (a configuração em uso).
if nginx -T 2>/dev/null | grep -q "server_name $DOMINIO"; then
  verde "vhost ATIVO (confirmado no nginx -T)"
else
  vermelho "o nginx aceitou a sintaxe mas NÃO carregou este vhost. Confira o link em sites-enabled."
  exit 1
fi

# --------------------------------------------------------- 5. certificado
azul "5/6  Certificado"
IPS=$( { ip -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1
         curl -4 -s --max-time 8 https://ifconfig.me 2>/dev/null; } | sort -u | grep -v '^$' )
ALVO=$(dig +short A "$DOMINIO" 2>/dev/null | grep -E '^[0-9.]+$' | tail -1)
echo "     IPs deste servidor: $(echo "$IPS" | tr '\n' ' ')"
echo "     $DOMINIO → ${ALVO:-—}"

emitir_certificado() {
  # O certbot.timer roda a renovação automática todo dia. Se ele disparar no
  # mesmo minuto que este script, o certbot recusa com "Another instance of
  # Certbot is already running" — não é erro nosso nem lock preso, é colisão.
  # Já aconteceu: 3 segundos de diferença. Por isso uma segunda tentativa.
  local saida
  for tentativa in 1 2; do
    saida=$(certbot --nginx -d "$DOMINIO" --redirect --agree-tos --no-eff-email \
              -m "$EMAIL" --non-interactive 2>&1)
    if [ $? -eq 0 ]; then echo "$saida" | tail -3 | sed 's/^/     /'; return 0; fi
    if echo "$saida" | grep -qi "Another instance of Certbot"; then
      amarelo "a renovação automática estava rodando — esperando 90s e tentando de novo"
      sleep 90
    else
      echo "$saida" | tail -6 | sed 's/^/     /'
      return 1
    fi
  done
  vermelho "o certbot continuou ocupado. Rode à mão daqui a alguns minutos."
  return 1
}

ESQUEMA="http"
if [ -z "$ALVO" ] || ! echo "$IPS" | grep -qxF "$ALVO"; then
  amarelo "o DNS de $DOMINIO ainda não aponta para cá — PULANDO o certificado."
  amarelo "Crie o registro A e depois rode:"
  amarelo "  sudo certbot --nginx -d $DOMINIO --redirect --agree-tos --no-eff-email -m $EMAIL"
  amarelo "O Let's Encrypt limita 5 falhas por hora no mesmo domínio — por isso não insistimos aqui."
elif emitir_certificado; then
  ESQUEMA="https"
  verde "certificado emitido e HTTPS ativo"
  certbot renew --dry-run >/dev/null 2>&1 \
    && verde "renovação automática testada" \
    || amarelo "o teste de renovação falhou — rode 'certbot renew --dry-run'"
else
  vermelho "o certbot falhou. O sistema segue em HTTP. Veja /var/log/letsencrypt/letsencrypt.log"
  vermelho "Repita só o certificado com:"
  vermelho "  sudo certbot --nginx -d $DOMINIO --redirect --agree-tos --no-eff-email -m $EMAIL"
fi

# ------------------------------------------------------------ 6. conferir
# Testamos no esquema que EXISTE. Conferir https sem certificado devolve 000
# em tudo — e 000 não significa "está exposto", significa "não deu para
# testar". Dizer o contrário é alarme falso na cara do operador.
azul "6/6  Conferindo de fora ($ESQUEMA)"
[ "$ESQUEMA" = "http" ] && amarelo "sem certificado ainda — conferindo por HTTP"

for rota in /saude /privacidade /exclusao-de-dados /restrito/; do
  C=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$ESQUEMA://$DOMINIO$rota" || echo 000)
  case "$C" in
    200) verde "$ESQUEMA://$DOMINIO$rota → 200" ;;
    000) amarelo "$rota → não respondeu (não deu para testar)" ;;
    *)   amarelo "$rota → $C" ;;
  esac
done
for rota in /server.js /data/publisher.db /data/.chave /conector/lapublisher.js /testes/seguranca.cjs; do
  C=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$ESQUEMA://$DOMINIO$rota" || echo 000)
  case "$C" in
    404) verde "$rota → 404 (correto)" ;;
    000) amarelo "$rota → não deu para testar (sem resposta)" ;;
    *)   vermelho "$rota → $C — NÃO deveria ser servido" ;;
  esac
done

echo
azul "Pronto."
echo "  Painel:  $ESQUEMA://$DOMINIO/restrito/"
echo "  Login:   admin"
journalctl -u "$SERVICO" --no-pager | grep -m1 "senha:" | sed 's/^.*senha:/  Senha:  /' || \
  echo "  Senha:   publisher-2026  (se este for o primeiro boot)"
echo
echo "  Faça AGORA, nesta ordem:"
echo "   1. entre no painel e TROQUE A SENHA"
echo "   2. Configurações → Endereço público → $ESQUEMA://$DOMINIO"
echo "   3. Configurações → Identificação → empresa, CNPJ e e-mail"
echo "   4. copie as URLs de privacidade/exclusão para o painel da Meta"
echo "   5. GUARDE UM BACKUP de $APP_DIR/data/.chave — sem ela os tokens viram lixo"
echo
