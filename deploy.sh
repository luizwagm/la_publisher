#!/usr/bin/env bash
# ==========================================================================
#  deploy.sh — atualiza o LA Publisher em produção sem arriscar nada
#
#  Uso:  sudo ./deploy.sh
#
#  O que NÃO está no repositório e não pode se perder:
#    data/publisher.db  → matérias, contas conectadas, fila, histórico
#    data/.chave        → chave do cofre. SEM ELA, os tokens das redes viram
#                         lixo ilegível e todas as contas precisam reconectar
#    midia/             → as fotos e vídeos publicados
#
#  Por isso tudo isso sai do caminho ANTES do git pull e volta depois: nem um
#  pull mal resolvido nem um commit antigo que apaga o arquivo encostam neles.
#
#  Sequência: backup → inventário → parar → proteger → pull → devolver →
#             subir → conferir. Falhou, restaura sozinho.
# ==========================================================================
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$(readlink -f "$0")")" && pwd)}"
SERVICO="${SERVICO:-lapublisher.service}"
PORTA="${PORTA:-5190}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
MANTER_BACKUPS=20
COFRE="/tmp/lapublisher-deploy-$$"

cd "$APP_DIR" || { echo "Diretório $APP_DIR não existe"; exit 1; }

azul()    { printf "\033[1;34m%s\033[0m\n" "$1"; }
verde()   { printf "\033[1;32m%s\033[0m\n" "$1"; }
amarelo() { printf "\033[1;33m%s\033[0m\n" "$1"; }
vermelho(){ printf "\033[1;31m%s\033[0m\n" "$1"; }

inventario() {
  [ -f data/publisher.db ] || { echo "SEM BANCO"; return; }
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    try {
      const db = new DatabaseSync("data/publisher.db");
      const n = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
      const pub = db.prepare("SELECT COUNT(*) c FROM destinos WHERE status=?").get("publicado").c;
      console.log(`${n("posts")} matérias · ${n("contas")} contas · ${n("midias")} arquivos · ${pub} publicações · ${n("usuarios")} usuários`);
    } catch (e) { console.log("BANCO ILEGÍVEL: " + e.message); }
  ' 2>/dev/null
}

restaurar_e_sair() {
  vermelho "$1"
  if [ -f "$COFRE/publisher.db" ]; then
    mkdir -p data && cp "$COFRE/publisher.db" data/publisher.db
    [ -f "$COFRE/.chave" ] && cp "$COFRE/.chave" data/.chave
    amarelo "Banco e chave devolvidos do cofre temporário."
  elif [ -f "${BACKUP:-}" ]; then
    mkdir -p data && cp "$BACKUP" data/publisher.db
    amarelo "Banco restaurado do backup: $BACKUP"
  fi
  systemctl start "$SERVICO" 2>/dev/null
  rm -rf "$COFRE"
  exit 1
}

# ----------------------------------------------------------- 1. backup
azul "1/7  Backup"
mkdir -p "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/publisher.db.$(date +%Y-%m-%d_%H%M%S)"
if [ -f data/publisher.db ]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 data/publisher.db ".backup '$BACKUP'" || cp data/publisher.db "$BACKUP"
  else
    cp data/publisher.db "$BACKUP"
  fi
  verde "     $BACKUP ($(du -h "$BACKUP" | cut -f1))"
  ls -1t "$BACKUP_DIR"/publisher.db.* 2>/dev/null | tail -n +$((MANTER_BACKUPS + 1)) | xargs -r rm --
else
  amarelo "     ainda não existe banco (primeira instalação)"
fi
# A chave do cofre vai junto do backup, mas com permissão fechada: quem tiver
# banco + chave tem os tokens das redes sociais do cliente.
if [ -f data/.chave ]; then
  cp data/.chave "$BACKUP_DIR/chave.$(date +%Y-%m-%d_%H%M%S)"
  chmod 600 "$BACKUP_DIR"/chave.* 2>/dev/null
  verde "     chave do cofre copiada (permissão 600)"
fi

# -------------------------------------------------------- 2. inventário
azul "2/7  Conteúdo atual"
ANTES=$(inventario)
echo "     $ANTES"

# ------------------------------------------------------------ 3. parar
azul "3/7  Parando o serviço"
systemctl stop "$SERVICO" 2>/dev/null
sleep 1
verde "     parado (o SQLite solta o arquivo antes de mexermos nele)"

# --------------------------------------------------------- 4. proteger
azul "4/7  Tirando banco, chave e mídia do caminho do git"
mkdir -p "$COFRE"
[ -f data/publisher.db ] && mv data/publisher.db "$COFRE/publisher.db"
[ -f data/.chave ] && mv data/.chave "$COFRE/.chave"
for wal in data/publisher.db-wal data/publisher.db-shm; do
  [ -f "$wal" ] && mv "$wal" "$COFRE/$(basename "$wal")"
done
[ -d midia ] && cp -r midia "$COFRE/midia"
verde "     guardados em $COFRE"

# ------------------------------------------------------------- 5. pull
azul "5/7  Baixando a versão nova"
DE=$(git rev-parse --short HEAD)
if ! git pull --ff-only; then
  restaurar_e_sair "     git pull falhou — nada foi alterado."
fi
PARA=$(git rev-parse --short HEAD)
if [ "$DE" = "$PARA" ]; then
  amarelo "     já estava atualizado ($PARA)"
else
  verde "     $DE → $PARA"
  git log --oneline "$DE..$PARA" | sed 's/^/       /'
fi

# --------------------------------------------------------- 6. devolver
azul "6/7  Devolvendo banco, chave e mídia"
mkdir -p data midia
[ -f "$COFRE/publisher.db" ] && mv "$COFRE/publisher.db" data/publisher.db
[ -f "$COFRE/.chave" ] && mv "$COFRE/.chave" data/.chave
for wal in publisher.db-wal publisher.db-shm; do
  [ -f "$COFRE/$wal" ] && mv "$COFRE/$wal" "data/$wal"
done
[ -d "$COFRE/midia" ] && cp -rn "$COFRE/midia/." midia/ 2>/dev/null

# O dono precisa ser o usuário do serviço, não um palpite: com o dono errado o
# SQLite responde "attempt to write a readonly database" e nada é salvo.
DONO=$(systemctl show "$SERVICO" -p User --value 2>/dev/null)
[ -z "$DONO" ] && DONO="root"
GRUPO=$(systemctl show "$SERVICO" -p Group --value 2>/dev/null)
[ -z "$GRUPO" ] && GRUPO="$DONO"
chown -R "$DONO:$GRUPO" data midia 2>/dev/null
# a PASTA precisa ser gravável: o SQLite cria o -wal ao lado do banco
chmod 755 data midia 2>/dev/null
[ -f data/publisher.db ] && chmod 644 data/publisher.db
[ -f data/.chave ] && chmod 600 data/.chave
verde "     de volta no lugar (dono: $DONO:$GRUPO)"

systemctl start "$SERVICO"
sleep 3

# ----------------------------------------------------------- 7. conferir
azul "7/7  Conferindo"
DEPOIS=$(inventario)
echo "     antes : $ANTES"
echo "     depois: $DEPOIS"
if [ "$ANTES" != "$DEPOIS" ] && [ "$ANTES" != "SEM BANCO" ]; then
  restaurar_e_sair "     O CONTEÚDO MUDOU. Restaurando por segurança."
fi

OK=0
for _ in $(seq 1 10); do
  CODIGO=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORTA/saude" || echo 000)
  [ "$CODIGO" = "200" ] && { OK=1; break; }
  sleep 2
done

rm -rf "$COFRE"

if [ "$OK" = "1" ]; then
  VERSAO=$(curl -s "http://127.0.0.1:$PORTA/saude" | grep -o '"versao":"[^"]*"' | cut -d'"' -f4)
  echo
  verde "Deploy concluído — LA Publisher v$VERSAO no ar"
  echo "  Backup desta atualização: $BACKUP"
  echo "  Confira em /restrito → Contas se algum token venceu."
else
  echo
  vermelho "O sistema não respondeu (HTTP $CODIGO). Últimas linhas do log:"
  journalctl -u "$SERVICO" -n 25 --no-pager | sed 's/^/  /'
  echo
  amarelo "O banco está intacto em data/publisher.db e no backup:"
  amarelo "  $BACKUP"
  exit 1
fi
