/* ==========================================================================
   LA Publisher — publicação automática de postagens
   Instagram · Facebook · TikTok · YouTube · Site/Blog

   server.js — porta de entrada HTTP.
     · cabeçalhos de segurança em TODA resposta
     · /midia/…   → arquivos públicos (as APIs das redes baixam daqui)
     · /restrito/ → painel (painel.js)
     · o resto    → 404 seco

   Escuta só em 127.0.0.1: quem fala com o mundo é o nginx. Sem isso o painel
   ficaria acessível por http://IP:5190/restrito/, sem HTTPS e sem cookie
   Secure. Para expor direto (ambiente sem proxy), rode com HOST=0.0.0.0.
   ========================================================================== */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const { VERSAO } = require("./versao");
const { db, getC } = require("./banco");
const S = require("./seguranca");
const { handlePainel } = require("./painel");
const { handlePublico } = require("./publico");
const { handleApi } = require("./api");
const fila = require("./fila");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5190;
const MIDIA_DIR = path.join(ROOT, "midia");

S.semearAdmin();

const MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".gif": "image/gif", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
};

const servidor = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, `http://localhost:${PORT}`).pathname); }
  catch { res.writeHead(400); return res.end("400"); }

  /* --------------------- cabeçalhos de segurança ------------------------- */
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  /* HSTS só sob HTTPS: emitir em ambiente sem certificado travaria o acesso. */
  if (req.headers["x-forwarded-proto"] === "https")
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

  /* Nenhuma origem externa fala com esta API. Sem CORS liberado, o navegador
     de outro site não consegue nem ler a resposta nem mandar cabeçalho
     próprio — é o que faz a trava de CSRF valer. */
  if (req.method === "OPTIONS") { res.writeHead(405); return res.end(); }

  /* --------------------- API pública dos sites (/api/v1) -----------------
     Vem ANTES do painel: é o caminho mais quente do sistema e não depende de
     sessão. Também responde /conectar/{token}, a página de autoatendimento. */
  if (handleApi(req, res, p)) return;

  /* ------------------------------- painel -------------------------------- */
  if (handlePainel(req, res, p)) return;

  /* --------------- páginas públicas exigidas pelas plataformas -----------
     Política de privacidade e instruções de exclusão de dados. A Meta, o
     Google e o TikTok conferem se essas URLs abrem antes de liberar o app. */
  if (handlePublico(req, res, p)) return;

  /* -------------------------- mídia pública ------------------------------
     Instagram, Facebook, TikTok e os sites BAIXAM o arquivo daqui — por isso
     é público. Só GET/HEAD, só os tipos permitidos, e o caminho é resolvido e
     conferido contra a pasta (nada de ../). */
  if (p.startsWith("/midia/")) {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    const nome = path.basename(p.slice("/midia/".length));
    const arq = path.normalize(path.join(MIDIA_DIR, nome));
    const ext = path.extname(arq).toLowerCase();
    if (!arq.startsWith(MIDIA_DIR) || !MIME[ext] || nome.startsWith(".") || !fs.existsSync(arq)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("404");
    }
    const st = fs.statSync(arq);
    const cab = {
      "Content-Type": MIME[ext],
      "Content-Length": st.size,
      "Cache-Control": "public, max-age=604800, immutable",
      "Accept-Ranges": "bytes",
      "X-Robots-Tag": "noindex",
    };
    /* Range: o YouTube/TikTok e os players pedem pedaços do vídeo. */
    const range = req.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const [ini, fim] = range.replace("bytes=", "").split("-");
      const inicio = ini ? Number(ini) : 0;
      const final = fim ? Math.min(Number(fim), st.size - 1) : st.size - 1;
      if (inicio >= st.size || final < inicio) {
        res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, { ...cab, "Content-Length": final - inicio + 1, "Content-Range": `bytes ${inicio}-${final}/${st.size}` });
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(arq, { start: inicio, end: final }).pipe(res);
    }
    res.writeHead(200, cab);
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(arq).pipe(res);
  }

  /* ------------------------------ diversos -------------------------------- */
  if (p === "/robots.txt") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    /* Tudo fechado, menos as duas páginas legais: elas precisam ser
       alcançáveis (e verificáveis) pelas plataformas. */
    return res.end("User-agent: *\nAllow: /privacidade\nAllow: /exclusao-de-dados\nDisallow: /\n");
  }
  if (p === "/saude") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, versao: VERSAO }));
  }
  if (p === "/" || p === "/index.html") {
    res.writeHead(302, { Location: "/restrito/" });
    return res.end();
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("404");
});

servidor.headersTimeout = 0;          // upload de vídeo longo não pode morrer no meio
servidor.requestTimeout = 0;
servidor.timeout = 0;

servidor.listen(PORT, process.env.HOST || "127.0.0.1", () => {
  const posts = db.prepare("SELECT COUNT(*) c FROM posts").get().c;
  const contas = db.prepare("SELECT COUNT(*) c FROM contas WHERE ativo=1").get().c;
  console.log(`\n  LA Publisher v${VERSAO} — publicação automática de postagens`);
  console.log(`  · Painel: http://localhost:${PORT}/restrito/`);
  console.log(`  · Banco:  ${posts} matéria(s) · ${contas} conta(s) conectada(s)`);
  const pub = fila.urlPublica();
  console.log(pub
    ? `  · Endereço público: ${pub}`
    : `  ⚠ Endereço público NÃO configurado — Instagram, Facebook e os sites precisam
    baixar a mídia por URL. Configure em /restrito → Configurações.`);
  const clientes = db.prepare("SELECT COUNT(*) c FROM clientes_api WHERE ativo=1").get().c;
  if (clientes) console.log(`  · API: ${clientes} site(s) autorizado(s) em /api/v1`);
  if (process.env.LAP_MIDIA_LOCAL === "1") {
    console.log(`\n  ⚠⚠ LAP_MIDIA_LOCAL=1 — a trava de SSRF na busca de mídia está DESLIGADA.`);
    console.log(`     Isso existe só para a bateria de testes. NUNCA em produção:`);
    console.log(`     um cliente poderia mandar o sistema buscar endereços internos.\n`);
  }
  fila.iniciar({ intervaloSegundos: 30 });
  console.log(`  · Fila de publicação rodando a cada 30s\n`);
});

/* Encerramento limpo: para a fila e fecha o banco. */
for (const sinal of ["SIGINT", "SIGTERM"]) {
  process.on(sinal, () => {
    console.log("\n  · encerrando…");
    fila.parar();
    try { db.close(); } catch { }
    process.exit(0);
  });
}
