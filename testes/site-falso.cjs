/* ==========================================================================
   testes/site-falso.cjs — um site do "gerador" de mentirinha.

   Tem a MESMA tabela `posts` dos sites reais e o conector instalado do jeito
   que o INSTALAR.md manda. Serve para provar o caminho inteiro — assinatura,
   publicação, atualização, download da imagem — sem encostar em site de
   cliente.

     node testes/site-falso.cjs        # sobe em 127.0.0.1:5192 e imprime o segredo

   Rotas extras só para o teste:  GET /espiar  → o que foi gravado
   ========================================================================== */
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { conectorLaPublisher } = require("../conector/lapublisher.js");

const ROOT = path.join(os.tmpdir(), "lap-site-falso");
fs.rmSync(ROOT, { recursive: true, force: true });          // sempre do zero
fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });

const db = new DatabaseSync(path.join(ROOT, "data", "site.db"));
/* Exatamente o esquema dos sites reais — conferido nos 5 projetos. */
db.exec(`CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE, excerpt TEXT, content TEXT, image TEXT, date TEXT, sort INTEGER DEFAULT 0);`);

let publicou = 0;
const lap = conectorLaPublisher({ db, root: ROOT, site: "Site Falso", publish: () => { publicou++; } });

http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (lap(req, res, p)) return;
  if (p === "/espiar") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ publicou, posts: db.prepare("SELECT * FROM posts").all() }));
  }
  res.writeHead(404); res.end("404");
}).listen(5192, "127.0.0.1", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "lapublisher.json"), "utf8"));
  console.log("SEGREDO=" + cfg.segredo);
});
