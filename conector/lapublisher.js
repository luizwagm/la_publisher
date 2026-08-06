/* ==========================================================================
   lapublisher.js — CONECTOR do LA Publisher para os sites do gerador
   (copie este arquivo para a raiz do site: BemEstarClinic, Forms Fitness,
    Daniel's Barbearia, Imobiliária, Instituto Kenósis…)

   O que ele faz: recebe uma matéria vinda do LA Publisher, grava na tabela
   `posts` do site e (opcionalmente) roda o Publicar para regenerar as páginas.

   INSTALAÇÃO — 3 linhas no server.js do site. Veja INSTALAR.md.

   SEGURANÇA — este endpoint escreve conteúdo que vai para a home do cliente,
   então ele é tratado como porta de entrada hostil:
     · assinatura HMAC-SHA256 sobre (timestamp + corpo), comparada em tempo
       constante — token estático não serve, porque vaza em log de proxy;
     · janela de 5 minutos: assinatura antiga não vale (anti-replay);
     · corpo limitado a 2 MB;
     · HTML higienizado de novo AQUI (o site não confia no que chega, mesmo
       vindo de um sistema nosso — é a última porta antes do navegador do
       visitante);
     · a imagem é BAIXADA e servida pelo próprio site (nada de hotlink: se o
       Publisher sair do ar, a matéria continua ilustrada), com limite de
       tamanho e só png/jpg/webp/gif — SVG não, porque SVG é XML e executa
       script na origem do site;
     · trava de 30 requisições por minuto por IP.

   O segredo fica em data/lapublisher.json (criado no primeiro boot) ou na
   variável de ambiente LAP_SEGREDO. Nunca versione esse arquivo.
   ========================================================================== */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const JANELA_SEGUNDOS = 300;
const CORPO_MAX = 2 * 1024 * 1024;
const IMAGEM_MAX = 12 * 1024 * 1024;
const LIMITE_MIN = 30;

function conectorLaPublisher({ db, root, publish, site = "site", uploadDir }) {
  const ROOT = root;
  const DIR_UP = uploadDir || path.join(ROOT, "assets", "img", "uploads");
  fs.mkdirSync(DIR_UP, { recursive: true });

  /* -------- segredo compartilhado -------- */
  const arqCfg = path.join(ROOT, "data", "lapublisher.json");
  let cfg = { segredo: "", ativo: true };
  if (process.env.LAP_SEGREDO) {
    cfg.segredo = process.env.LAP_SEGREDO;
  } else if (fs.existsSync(arqCfg)) {
    try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(arqCfg, "utf8")) }; } catch { }
  }
  if (!cfg.segredo) {
    cfg.segredo = crypto.randomBytes(32).toString("hex");
    try {
      fs.mkdirSync(path.dirname(arqCfg), { recursive: true });
      fs.writeFileSync(arqCfg, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      console.log("\n  · LA Publisher: segredo criado em data/lapublisher.json");
      console.log(`    Cadastre no Publisher → Contas → Site:\n    ${cfg.segredo}\n`);
    } catch (e) { console.error("  ✖ LA Publisher: não consegui gravar o segredo:", e.message); }
  }

  /* -------- coluna de origem (idempotência) --------
     Sem ela, reenviar a mesma matéria criaria post duplicado. */
  try { db.exec("ALTER TABLE posts ADD COLUMN lap_id INTEGER"); } catch { }
  try { db.exec("ALTER TABLE posts ADD COLUMN autor TEXT"); } catch { }
  try { db.exec("ALTER TABLE posts ADD COLUMN fonte TEXT"); } catch { }
  try { db.exec("ALTER TABLE posts ADD COLUMN errata TEXT"); } catch { }

  const colunas = new Set(db.prepare("PRAGMA table_info(posts)").all().map((c) => c.name));

  /* -------- trava por IP --------
     O nginx ACRESCENTA o IP real no fim do X-Forwarded-For; o primeiro item é
     texto do próprio cliente. Ler `[0]` deixaria a trava sem valor — basta
     variar o cabeçalho a cada requisição. Preferimos o X-Real-IP (que o nginx
     sobrescreve) e, na falta dele, o ÚLTIMO item da lista. */
  const DO_PROXY = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
  function ipDe(req) {
    const socket = req.socket?.remoteAddress || "";
    if (!DO_PROXY.has(socket)) return socket;
    const real = String(req.headers["x-real-ip"] || "").trim();
    if (real) return real;
    const lista = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    return lista.length ? lista[lista.length - 1] : socket;
  }

  const batidas = new Map();
  function demais(ip) {
    const agora = Date.now();
    const b = batidas.get(ip) || { n: 0, ts: agora };
    if (agora - b.ts > 60_000) { b.n = 0; b.ts = agora; }
    b.n++; batidas.set(ip, b);
    return b.n > LIMITE_MIN;
  }

  /* -------- higienização (mesma lista do Publisher) -------- */
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const TAGS_OK = new Set(["p", "br", "hr", "strong", "b", "em", "i", "u", "s", "sub", "sup", "h2", "h3", "h4",
    "h5", "h6", "ul", "ol", "li", "blockquote", "a", "img", "figure", "figcaption", "span", "div",
    "code", "pre", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "small"]);
  const VAZIAS = new Set(["br", "hr", "img"]);
  const ATRIB = { a: ["href", "title", "target", "rel"], img: ["src", "alt", "title", "width", "height", "loading"],
    th: ["colspan", "rowspan"], td: ["colspan", "rowspan"], "*": ["class"] };
  function urlOk(u) {
    const v = String(u || "").trim().replace(/[\u0000-\u0020]/g, "");
    if (/^(https?:)?\/\//i.test(v) || /^\/[^/]/.test(v) || /^(mailto|tel):[^\s<>"']+$/i.test(v)) return v;
    return null;
  }
  function limpar(entrada) {
    if (!entrada) return "";
    let html = String(entrada).slice(0, 500_000)
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|iframe|object|embed|svg|math|noscript|template|form|input|button|link|meta|base)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, "");
    const out = [], pilha = [];
    const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>?/g;
    let pos = 0, m;
    while ((m = re.exec(html)) !== null) {
      if (m.index > pos) out.push(esc(html.slice(pos, m.index)));
      pos = re.lastIndex;
      const fechando = m[0][1] === "/", tag = m[1].toLowerCase();
      if (!TAGS_OK.has(tag)) continue;
      if (fechando) {
        const i = pilha.lastIndexOf(tag);
        if (i === -1) continue;
        while (pilha.length > i) out.push(`</${pilha.pop()}>`);
        continue;
      }
      const permitidos = new Set([...(ATRIB[tag] || []), ...ATRIB["*"]]);
      const attrs = [];
      const rea = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
      let a;
      while ((a = rea.exec(m[2] || "")) !== null) {
        const nome = a[1].toLowerCase();
        if (!permitidos.has(nome)) continue;
        let valor = a[2] ?? a[3] ?? a[4] ?? "";
        if (nome === "href" || nome === "src") { const u = urlOk(valor); if (!u) continue; valor = u; }
        else if (nome === "class") { valor = valor.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 120); if (!valor) continue; }
        else if (nome === "target") valor = valor === "_blank" ? "_blank" : "_self";
        else if (["width", "height", "colspan", "rowspan"].includes(nome)) { if (!/^\d{1,5}$/.test(valor)) continue; }
        else valor = valor.slice(0, 300);
        attrs.push(` ${nome}="${esc(valor)}"`);
      }
      if (tag === "a" && attrs.some((x) => x.includes('_blank')) && !attrs.some((x) => x.startsWith(" rel=")))
        attrs.push(' rel="noopener noreferrer"');
      out.push(`<${tag}${attrs.join("")}>`);
      if (!VAZIAS.has(tag) && !/\/\s*>$/.test(m[0])) pilha.push(tag);
    }
    if (pos < html.length) out.push(esc(html.slice(pos)));
    while (pilha.length) out.push(`</${pilha.pop()}>`);
    return out.join("");
  }

  const slugify = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "materia";

  /* -------- baixa a imagem para o próprio site -------- */
  async function baixarImagem(url) {
    if (!/^https?:\/\//i.test(url)) return "";
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 30_000);
    try {
      const r = await fetch(url, { signal: ac.signal, headers: { "User-Agent": "LA-Publisher-Conector" } });
      if (!r.ok) return "";
      const mime = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const ext = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" }[mime];
      if (!ext) return "";                                  // SVG e afins ficam de fora de propósito
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > IMAGEM_MAX) return "";
      const nome = `lap-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}${ext}`;
      fs.writeFileSync(path.join(DIR_UP, nome), buf);
      return `/assets/img/uploads/${nome}`;
    } catch { return ""; }
    finally { clearTimeout(t); }
  }

  function lerCorpo(req) {
    return new Promise((ok) => {
      let b = "";
      req.on("data", (c) => { b += c; if (b.length > CORPO_MAX) { req.destroy(); ok(null); } });
      req.on("end", () => ok(b));
      req.on("error", () => ok(null));
    });
  }
  function json(res, code, obj) {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    res.end(JSON.stringify(obj));
  }

  /* ---------------------------- handler ---------------------------------- */
  return function handleLaPublisher(req, res, pathname) {
    if (!pathname.startsWith("/api/lapublisher/")) return false;
    (async () => {
      const ip = ipDe(req);
      if (req.method !== "POST") return json(res, 405, { error: "Método não permitido" });
      if (demais(ip)) return json(res, 429, { error: "Muitas requisições." });
      if (!cfg.ativo) return json(res, 403, { error: "Conector desativado." });

      const corpo = await lerCorpo(req);
      if (corpo === null) return json(res, 413, { error: "Corpo grande demais." });

      /* assinatura */
      const ts = Number(req.headers["x-lap-timestamp"] || 0);
      const assinatura = String(req.headers["x-lap-assinatura"] || "");
      if (!ts || Math.abs(Math.floor(Date.now() / 1000) - ts) > JANELA_SEGUNDOS)
        return json(res, 401, { error: "Assinatura fora da janela de tempo." });
      const esperada = "sha256=" + crypto.createHmac("sha256", cfg.segredo).update(`${ts}.${corpo}`).digest("hex");
      const a = Buffer.from(assinatura), b = Buffer.from(esperada);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
        return json(res, 401, { error: "Assinatura inválida." });

      let d; try { d = JSON.parse(corpo); } catch { return json(res, 400, { error: "JSON inválido." }); }

      /* ping da tela de Contas */
      if (pathname === "/api/lapublisher/ping") {
        return json(res, 200, { ok: true, site, posts: db.prepare("SELECT COUNT(*) c FROM posts").get().c });
      }
      if (pathname !== "/api/lapublisher/receber") return json(res, 404, { error: "Rota não encontrada." });

      const titulo = String(d.titulo || "").trim().slice(0, 300);
      if (!titulo) return json(res, 400, { error: "Matéria sem título." });

      let slug = slugify(d.slug || titulo);
      const jaLap = d.origem_id ? db.prepare("SELECT id,slug FROM posts WHERE lap_id=?").get(Number(d.origem_id)) : null;
      if (!jaLap) {
        /* slug único: se já existe outro post com esse endereço, numera. */
        let base = slug, n = 2;
        while (db.prepare("SELECT id FROM posts WHERE slug=?").get(slug)) slug = `${base}-${n++}`;
      } else slug = jaLap.slug;

      const imagem = d.imagem_url ? await baixarImagem(d.imagem_url) : "";
      let conteudo = limpar(d.texto_html);
      /* errata entra no fim da matéria, marcada — jornalisticamente é o certo:
         não se apaga o que foi publicado, corrige-se à vista. */
      if (String(d.errata || "").trim())
        conteudo += `<p class="post-errata"><strong>Errata:</strong> ${esc(String(d.errata).trim())}</p>`;
      if (String(d.fonte || "").trim()) {
        const f = esc(String(d.fonte).trim());
        const u = urlOk(d.fonte_url);
        conteudo += `<p class="post-fonte">Fonte: ${u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${f}</a>` : f}</p>`;
      }
      if (d.video_youtube)
        conteudo += `<p class="post-video"><a href="https://www.youtube.com/watch?v=${esc(String(d.video_youtube).replace(/[^\w-]/g, ""))}" target="_blank" rel="noopener noreferrer">Assista ao vídeo no YouTube</a></p>`;

      const linha = {
        title: titulo,
        slug,
        /* A listagem do blog usa texto puro. Tag de BLOCO vira espaço (senão
           dois parágrafos grudariam); tag inline some sem deixar espaço
           sobrando antes da pontuação. */
        excerpt: limpar(d.resumo_html)
          .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, " ")
          .replace(/<br\s*\/?>/gi, " ")
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ").trim().slice(0, 600),
        content: conteudo,
        image: imagem || (jaLap ? undefined : ""),
        date: /^\d{4}-\d{2}-\d{2}/.test(String(d.data || "")) ? String(d.data).slice(0, 10) : new Date().toISOString().slice(0, 10),
      };
      if (colunas.has("autor")) linha.autor = String(d.autor || "").slice(0, 120);
      if (colunas.has("fonte")) linha.fonte = String(d.fonte || "").slice(0, 200);
      if (colunas.has("errata")) linha.errata = String(d.errata || "").slice(0, 2000);

      let id;
      if (jaLap) {
        const campos = Object.entries(linha).filter(([, v]) => v !== undefined);
        db.prepare(`UPDATE posts SET ${campos.map(([k]) => k + "=?").join(",")} WHERE id=?`)
          .run(...campos.map(([, v]) => v), jaLap.id);
        id = jaLap.id;
      } else {
        const campos = Object.entries(linha).filter(([, v]) => v !== undefined);
        campos.push(["lap_id", d.origem_id ? Number(d.origem_id) : null]);
        if (colunas.has("sort")) campos.push(["sort", d.destaque ? -1 : 0]);
        const info = db.prepare(`INSERT INTO posts(${campos.map(([k]) => k).join(",")}) VALUES(${campos.map(() => "?").join(",")})`)
          .run(...campos.map(([, v]) => v));
        id = Number(info.lastInsertRowid);
      }

      let aviso = null;
      if (d.publicar !== false && typeof publish === "function") {
        try { publish(); } catch (e) { aviso = "Matéria gravada, mas o Publicar do site falhou: " + e.message; }
      }
      console.log(`  · LA Publisher: matéria "${titulo}" ${jaLap ? "atualizada" : "recebida"} (/blog/${slug}/)`);
      return json(res, 200, { ok: true, id, slug, url: `/blog/${slug}/`, aviso });
    })().catch((e) => {
      console.error("  ✖ LA Publisher conector:", e.message);
      try { json(res, 500, { error: "Erro interno no conector." }); } catch { }
    });
    return true;
  };
}

module.exports = { conectorLaPublisher };
