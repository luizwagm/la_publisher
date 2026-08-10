#!/usr/bin/env bash
# ==========================================================================
#  verificar.sh — só LÊ. Não muda nada. Rode antes e depois do deploy.
#  Uso:  ./verificar.sh
# ==========================================================================
set -uo pipefail
APP_DIR="${APP_DIR:-$(cd "$(dirname "$(readlink -f "$0")")" && pwd)}"
SERVICO="${SERVICO:-lapublisher.service}"
PORTA="${PORTA:-5190}"
cd "$APP_DIR" || exit 1

azul(){ printf "\033[1;34m%s\033[0m\n" "$1"; }
verde(){ printf "\033[1;32m  ✓ %s\033[0m\n" "$1"; }
amarelo(){ printf "\033[1;33m  ! %s\033[0m\n" "$1"; }
vermelho(){ printf "\033[1;31m  ✖ %s\033[0m\n" "$1"; }

azul "Código"
echo "     commit: $(git rev-parse --short HEAD 2>/dev/null || echo '(sem git)') · $(git log -1 --format=%s 2>/dev/null | head -c 60)"
[ -n "$(git status --porcelain 2>/dev/null)" ] && amarelo "há alterações não commitadas" || verde "árvore limpa"

azul "Serviço"
if systemctl is-active --quiet "$SERVICO"; then verde "$SERVICO ativo"; else vermelho "$SERVICO PARADO"; fi
CODIGO=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORTA/saude" || echo 000)
[ "$CODIGO" = "200" ] && verde "responde em 127.0.0.1:$PORTA" || vermelho "não responde (HTTP $CODIGO)"

azul "Arquivos que não podem faltar"
[ -f data/publisher.db ] && verde "banco ($(du -h data/publisher.db | cut -f1))" || vermelho "data/publisher.db AUSENTE"
[ -f data/.chave ] && verde "chave do cofre presente" || vermelho "data/.chave AUSENTE — os tokens das redes ficarão ilegíveis"
[ -d midia ] && verde "midia/ com $(find midia -type f 2>/dev/null | wc -l) arquivo(s)" || amarelo "pasta midia/ não existe"

azul "Permissões (o SQLite grava o -wal na PASTA)"
DONO=$(systemctl show "$SERVICO" -p User --value 2>/dev/null); [ -z "$DONO" ] && DONO="root"
for d in data midia; do
  [ -d "$d" ] || continue
  ATUAL=$(stat -c '%U' "$d")
  [ "$ATUAL" = "$DONO" ] && verde "$d pertence a $ATUAL" || vermelho "$d pertence a $ATUAL, mas o serviço roda como $DONO"
done
[ -f data/.chave ] && { P=$(stat -c '%a' data/.chave); [ "$P" = "600" ] && verde "chave com permissão 600" || amarelo "chave com permissão $P (o certo é 600)"; }

azul "Conteúdo"
node -e '
  const { DatabaseSync } = require("node:sqlite");
  try {
    const db = new DatabaseSync("data/publisher.db");
    const n = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    console.log(`     ${n("posts")} matérias · ${n("midias")} arquivos · ${n("usuarios")} usuários`);
    for (const c of db.prepare("SELECT plataforma,nome,ativo,expira,ultimo_erro FROM contas").all()) {
      const venceu = c.expira && new Date(c.expira) < new Date();
      console.log(`     ${venceu ? "✖" : c.ultimo_erro ? "!" : "✓"} ${c.plataforma}: ${c.nome}` +
        (c.ativo ? "" : " (desativada)") + (venceu ? " — TOKEN VENCIDO, reconecte" : "") +
        (c.ultimo_erro ? ` — ${c.ultimo_erro}` : ""));
    }
    const f = db.prepare("SELECT status, COUNT(*) c FROM destinos GROUP BY status").all();
    console.log("     fila: " + (f.map((x) => `${x.c} ${x.status}`).join(" · ") || "vazia"));
    const erros = db.prepare("SELECT plataforma, erro FROM destinos WHERE status=? ORDER BY id DESC LIMIT 5").all("erro");
    for (const e of erros) console.log(`       ✖ ${e.plataforma}: ${e.erro}`);
  } catch (e) { console.log("     BANCO ILEGÍVEL: " + e.message); }
' 2>/dev/null

azul "Exposição"
for rota in /server.js /data/publisher.db /data/.chave /package.json /conector/lapublisher.js; do
  C=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORTA$rota" || echo 000)
  [ "$C" = "404" ] && verde "$rota → 404" || vermelho "$rota → $C (NÃO deveria ser servido)"
done
echo
