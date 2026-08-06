/* ==========================================================================
   painel.js — a área /restrito: telas, API e OAuth.

   Mesma arquitetura do /restrito da BemEstarClinic: um app.html só (SPA sem
   framework), tudo o mais em JSON, e a autorização checada NO SERVIDOR em
   toda rota — o front esconde o que o perfil não pode, mas quem manda é aqui.
   ========================================================================== */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { VERSAO } = require("./versao");
const { db, ROOT, getC, setC, cifrar, decifrar, agora, registrar, auditar } = require("./banco");
const S = require("./seguranca");
const { PLATAFORMAS, ORDEM, validarDestino, legendaPadrao } = require("./regras");
const fila = require("./fila");
const midiaUtil = require("./midia");
const meta = require("./plataformas/meta");
const tiktok = require("./plataformas/tiktok");
const youtube = require("./plataformas/youtube");
const siteAdapter = require("./plataformas/site");

const APP_DIR = path.join(ROOT, "restrito");
const MIDIA_DIR = fila.MIDIA_DIR;
fs.mkdirSync(MIDIA_DIR, { recursive: true });

/* CSP do painel. Sem 'unsafe-eval', sem script externo, sem enquadramento.
   'unsafe-inline' entra porque as telas são montadas em <script> inline —
   mesma decisão consciente do /restrito da clínica. connect-src 'self'
   impede que qualquer coisa injetada mande dados para fora. */
const CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; "
  + "form-action 'self'; img-src 'self' data: blob: https:; media-src 'self' blob:; "
  + "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; "
  + "script-src 'self' 'unsafe-inline'; connect-src 'self'";

const MIMES_IMAGEM = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MIMES_VIDEO = ["video/mp4", "video/quicktime", "video/webm"];
/* SVG está FORA de propósito: SVG é XML e executa <script> na origem de quem
   o serve. Foi exatamente o furo encontrado no /admin da BemEstarClinic. */
const MIMES_OK = [...MIMES_IMAGEM, ...MIMES_VIDEO];
const EXT_DE_MIME = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
  "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm",
};
const UPLOAD_MAX = 2 * 1024 * 1024 * 1024;   // 2 GB

/* ------------------------------ utilidades ------------------------------- */
function json(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow",
  });
  res.end(JSON.stringify(obj));
}
function lerCorpo(req, limite = 8e6) {
  return new Promise((ok, err) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > limite) req.destroy(); });
    req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch { ok({}); } });
    req.on("error", err);
  });
}
const jsonSeguro = (t, padrao = {}) => { try { return t ? JSON.parse(t) : padrao; } catch { return padrao; } };

/* ==========================================================================
   OAuth — pendências em memória
   Guarda plataforma, quem pediu e o verifier do PKCE por até 10 minutos. Em
   memória de propósito: é dado efêmero e não deve sobreviver a um restart
   (um "state" antigo válido é uma janela a menos de ataque).
   ========================================================================== */
const oauthPendentes = new Map();
setInterval(() => {
  const lim = Date.now() - 10 * 60_000;
  for (const [k, v] of oauthPendentes) if (v.ts < lim) oauthPendentes.delete(k);
}, 60_000).unref();

const redirectUri = (plataforma) => `${fila.urlPublica() || "http://localhost:" + (process.env.PORT || 5190)}/restrito/oauth/retorno/${plataforma}`;

/* ==========================================================================
   Handler principal
   ========================================================================== */
function handlePainel(req, res, pathname) {
  if (pathname !== "/restrito" && !pathname.startsWith("/restrito/")) return false;
  if (pathname === "/restrito") { res.writeHead(302, { Location: "/restrito/" }); res.end(); return true; }

  const rota = pathname.slice("/restrito".length) || "/";

  if (rota.startsWith("/api/")) {
    rotaApi(req, res, rota.slice(5)).catch((e) => {
      /* Erro detalhado só no log do servidor; o cliente recebe genérico —
         mensagem de erro é mapa para quem está sondando. */
      console.error("  ✖ /restrito/api:", e.stack || e.message);
      try { json(res, 500, { error: "Erro interno." }); } catch { }
    });
    return true;
  }

  if (rota.startsWith("/oauth/retorno/")) {
    oauthRetorno(req, res, rota.slice("/oauth/retorno/".length)).catch((e) => {
      console.error("  ✖ oauth:", e.stack || e.message);
      paginaSimples(res, 500, "Não foi possível concluir a conexão", e.message || "Erro interno.");
    });
    return true;
  }

  if (rota === "/" || rota === "/index.html") {
    let html;
    try { html = fs.readFileSync(path.join(APP_DIR, "app.html"), "utf8"); }
    catch { res.writeHead(500); return res.end("app.html não encontrado"), true; }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow", "Content-Security-Policy": CSP,
    });
    res.end(html.replace(/\{\{VERSAO\}\}/g, VERSAO));
    return true;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("404");
  return true;
}

function paginaSimples(res, code, titulo, texto) {
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": CSP });
  res.end(`<!doctype html><html lang="pt-BR"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${S.esc(titulo)}</title>
<body style="font:16px/1.6 system-ui,sans-serif;background:#0f1222;color:#e8ecff;display:grid;place-items:center;min-height:100vh;margin:0;padding:2rem">
<div style="max-width:520px;background:#191d38;border:1px solid #2b3160;border-radius:16px;padding:2rem;text-align:center">
<h1 style="margin:0 0 .6rem;font-size:1.3rem">${S.esc(titulo)}</h1>
<p style="margin:0 0 1.4rem;color:#a9b2e0">${S.esc(texto)}</p>
<a href="/restrito/" style="display:inline-block;background:#6c5cff;color:#fff;text-decoration:none;padding:.7rem 1.4rem;border-radius:999px;font-weight:700">Voltar ao painel</a>
</div></body></html>`);
}

/* ==========================================================================
   OAuth — retorno das plataformas
   ========================================================================== */
async function oauthRetorno(req, res, plataforma) {
  const u = new URL(req.url, "http://x");
  const state = u.searchParams.get("state") || "";
  const code = u.searchParams.get("code") || "";
  const erroProvedor = u.searchParams.get("error_description") || u.searchParams.get("error");

  const pend = oauthPendentes.get(state);
  oauthPendentes.delete(state);
  if (!pend || pend.plataforma !== plataforma)
    return paginaSimples(res, 400, "Conexão expirada", "O pedido de conexão não é válido ou passou de 10 minutos. Comece de novo pela tela Contas.");
  if (erroProvedor) return paginaSimples(res, 400, "A plataforma recusou", String(erroProvedor).slice(0, 300));
  if (!code) return paginaSimples(res, 400, "Retorno incompleto", "A plataforma não devolveu o código de autorização.");

  const app = fila.appDe(plataforma);
  if (!app?.client_id) return paginaSimples(res, 400, "App não configurado", "Cadastre as credenciais do app em Configurações → Aplicativos.");

  const args = {
    clientId: app.client_id, clientSecret: app.client_secret,
    redirectUri: redirectUri(plataforma), code,
    extra: { ...app.extra, verifier: pend.verifier },
  };

  let r;
  if (plataforma === "facebook") r = await meta.trocarCodigo(args);
  else if (plataforma === "tiktok") r = await tiktok.trocarCodigo(args);
  else if (plataforma === "youtube") r = await youtube.trocarCodigo(args);
  else return paginaSimples(res, 400, "Plataforma inválida", plataforma);

  const nomes = [];
  for (const c of r.contas) {
    const existente = db.prepare("SELECT id FROM contas WHERE plataforma=? AND externo_id=?").get(c.plataforma, c.externo_id);
    const campos = {
      plataforma: c.plataforma, nome: c.nome, externo_id: c.externo_id,
      token: cifrar(c.token), refresh: cifrar(c.refresh || ""), expira: c.expira || null,
      escopos: c.escopos || "", meta: JSON.stringify(c.meta || {}), ativo: 1,
      ultimo_erro: null, atualizado: agora(),
    };
    if (existente) {
      db.prepare(`UPDATE contas SET nome=?,token=?,refresh=?,expira=?,escopos=?,meta=?,ativo=1,ultimo_erro=NULL,atualizado=? WHERE id=?`)
        .run(campos.nome, campos.token, campos.refresh, campos.expira, campos.escopos, campos.meta, campos.atualizado, existente.id);
    } else {
      db.prepare(`INSERT INTO contas(plataforma,nome,externo_id,token,refresh,expira,escopos,meta,ativo,criado,atualizado)
                  VALUES(?,?,?,?,?,?,?,?,1,?,?)`)
        .run(campos.plataforma, campos.nome, campos.externo_id, campos.token, campos.refresh,
             campos.expira, campos.escopos, campos.meta, agora(), campos.atualizado);
    }
    nomes.push(`${PLATAFORMAS[c.plataforma]?.rotulo || c.plataforma}: ${c.nome}`);
  }
  auditar({ userId: pend.userId, nome: pend.nomeUsuario }, "conectar-conta", `${plataforma} → ${nomes.join(" | ")}`, S.clientIp(req));
  registrar("ok", `Conta(s) conectada(s): ${nomes.join(" | ")}`, { plataforma });
  return paginaSimples(res, 200, "Conta conectada", nomes.join(" · "));
}

/* ==========================================================================
   API
   ========================================================================== */
async function rotaApi(req, res, p) {
  const ip = S.clientIp(req);

  /* ------------------------------- login -------------------------------- */
  if (p === "login" && req.method === "POST") {
    if (S.bloqueado(ip)) return json(res, 429, { error: `Muitas tentativas. Aguarde ${S.BLOQ_MIN} minutos.` });
    const { usuario, senha } = await lerCorpo(req, 5000);
    const u = db.prepare("SELECT * FROM usuarios WHERE email=? AND ativo=1").get(String(usuario || "").trim().toLowerCase());
    /* Gasta o mesmo tempo quando o login não existe (anti-enumeração). */
    const ok = u ? S.confereSenha(senha, u.senha_hash) : (S.confereSenha(senha, S.HASH_ISCA), false);
    if (!ok) {
      S.erroLogin(ip);
      auditar(null, "login-falhou", String(usuario || "").slice(0, 60), ip);
      return json(res, 401, { error: "Usuário ou senha incorretos." });
    }
    S.limparTentativas(ip);
    const sid = S.novaSessao(u);
    res.setHeader("Set-Cookie", S.cookieSessao(sid, req.headers["x-forwarded-proto"] === "https"));
    auditar({ userId: u.id, nome: u.nome }, "login", "", ip);
    const s = S.sessoes.get(sid);
    return json(res, 200, { ok: true, nome: u.nome, perfil: u.perfil, csrf: s.csrf, versao: VERSAO });
  }

  /* -------------------------- daqui exige sessão ------------------------- */
  const s = S.sessao(req);
  if (!s) return json(res, 401, { error: "Não autenticado" });
  if (!S.exigeCsrf(req, s)) return json(res, 403, { error: "Requisição sem token de segurança." });

  if (p === "me") return json(res, 200, { nome: s.nome, perfil: s.perfil, csrf: s.csrf, versao: VERSAO });

  if (p === "logout" && req.method === "POST") {
    S.encerrarSessao(s.sid);
    res.setHeader("Set-Cookie", S.cookieMorto);
    auditar(s, "logout", "", ip);
    return json(res, 200, { ok: true });
  }

  if (p === "senha" && req.method === "POST") {
    const { atual, nova } = await lerCorpo(req, 5000);
    const u = db.prepare("SELECT * FROM usuarios WHERE id=?").get(s.userId);
    if (!S.confereSenha(atual, u.senha_hash)) return json(res, 400, { error: "Senha atual incorreta." });
    if (String(nova || "").length < 8) return json(res, 400, { error: "A nova senha precisa de ao menos 8 caracteres." });
    db.prepare("UPDATE usuarios SET senha_hash=? WHERE id=?").run(S.hashSenha(nova), s.userId);
    S.derrubarSessoesDoUsuario(s.userId, s.sid);   // troca de senha derruba as outras sessões
    auditar(s, "trocar-senha", "", ip);
    return json(res, 200, { ok: true });
  }

  /* Regras das plataformas — o painel monta os campos a partir daqui. */
  if (p === "regras") return json(res, 200, { plataformas: PLATAFORMAS, ordem: ORDEM, versao: VERSAO });

  /* ------------------------------- painel -------------------------------- */
  if (p === "painel") {
    const n = (sql, ...a) => db.prepare(sql).get(...a).c;
    return json(res, 200, {
      rascunhos: n("SELECT COUNT(*) c FROM posts WHERE status='rascunho'"),
      agendados: n("SELECT COUNT(*) c FROM destinos WHERE status='agendado' OR (status='pendente' AND agendado_para > ?)", agora()),
      publicados: n("SELECT COUNT(*) c FROM destinos WHERE status='publicado'"),
      comErro: n("SELECT COUNT(*) c FROM destinos WHERE status='erro'"),
      naFila: n("SELECT COUNT(*) c FROM destinos WHERE status IN ('pendente','processando')"),
      contas: db.prepare("SELECT plataforma, COUNT(*) c FROM contas WHERE ativo=1 GROUP BY plataforma").all(),
      urlPublica: fila.urlPublica(),
      proximos: db.prepare(`SELECT d.id,d.plataforma,d.agendado_para,p.titulo FROM destinos d
        JOIN posts p ON p.id=d.post_id
        WHERE d.status IN ('agendado','pendente') AND d.agendado_para IS NOT NULL AND d.agendado_para<>''
        ORDER BY d.agendado_para LIMIT 8`).all(),
      recentes: db.prepare(`SELECT d.id,d.plataforma,d.status,d.publicado_em,d.url_externa,p.titulo,p.id post_id
        FROM destinos d JOIN posts p ON p.id=d.post_id
        ORDER BY d.atualizado DESC, d.id DESC LIMIT 10`).all(),
    });
  }

  /* ============================== POSTS ================================== */
  if (p === "posts" && req.method === "GET") {
    const q = new URL(req.url, "http://x").searchParams;
    const busca = (q.get("q") || "").trim();
    const status = (q.get("status") || "").trim();
    const cond = [], args = [];
    if (busca) { cond.push("(titulo LIKE ? OR resumo_html LIKE ?)"); args.push("%" + busca + "%", "%" + busca + "%"); }
    if (status) { cond.push("status=?"); args.push(status); }
    const linhas = db.prepare(`SELECT id,titulo,slug,status,tipo,autor,fonte,data_publicacao,criado,atualizado
      FROM posts ${cond.length ? "WHERE " + cond.join(" AND ") : ""} ORDER BY id DESC LIMIT 200`).all(...args);
    for (const l of linhas) {
      l.destinos = db.prepare("SELECT plataforma,status FROM destinos WHERE post_id=?").all(l.id);
      l.capa = db.prepare("SELECT arquivo FROM midias WHERE post_id=? ORDER BY capa DESC, ordem, id LIMIT 1").get(l.id)?.arquivo || null;
    }
    return json(res, 200, linhas);
  }

  const mPost = p.match(/^posts\/(\d+)$/);
  if (mPost && req.method === "GET") {
    const post = db.prepare("SELECT * FROM posts WHERE id=?").get(mPost[1]);
    if (!post) return json(res, 404, { error: "Post não encontrado." });
    post.midias = db.prepare("SELECT * FROM midias WHERE post_id=? ORDER BY ordem, id").all(post.id);
    post.destinos = db.prepare("SELECT * FROM destinos WHERE post_id=? ORDER BY id").all(post.id)
      .map((d) => ({ ...d, opcoes: jsonSeguro(d.opcoes) }));
    post.logs = db.prepare("SELECT * FROM logs WHERE post_id=? ORDER BY id DESC LIMIT 60").all(post.id);
    return json(res, 200, post);
  }

  if (p === "posts" && req.method === "POST") {
    if (!S.pode(s.perfil, "posts")) return json(res, 403, { error: "Seu perfil não cria matérias." });
    const b = await lerCorpo(req, 2e6);
    const dados = camposDoPost(b);
    if (!dados.titulo) return json(res, 400, { error: "A matéria precisa de um título." });
    const info = db.prepare(`INSERT INTO posts(titulo,slug,resumo_html,texto_html,fonte,fonte_url,autor,errata,
      data_publicacao,tipo,status,usuario_id,criado,atualizado)
      VALUES(?,?,?,?,?,?,?,?,?,?,'rascunho',?,?,?)`)
      .run(dados.titulo, dados.slug, dados.resumo_html, dados.texto_html, dados.fonte, dados.fonte_url,
           dados.autor, dados.errata, dados.data_publicacao, dados.tipo, s.userId, agora(), agora());
    auditar(s, "criar-post", dados.titulo, ip);
    return json(res, 200, { ok: true, id: Number(info.lastInsertRowid) });
  }

  if (mPost && req.method === "PUT") {
    if (!S.pode(s.perfil, "posts")) return json(res, 403, { error: "Seu perfil não edita matérias." });
    const post = db.prepare("SELECT * FROM posts WHERE id=?").get(mPost[1]);
    if (!post) return json(res, 404, { error: "Post não encontrado." });
    const b = await lerCorpo(req, 2e6);
    const d = camposDoPost(b, post);
    db.prepare(`UPDATE posts SET titulo=?,slug=?,resumo_html=?,texto_html=?,fonte=?,fonte_url=?,autor=?,errata=?,
                data_publicacao=?,tipo=?,atualizado=? WHERE id=?`)
      .run(d.titulo, d.slug, d.resumo_html, d.texto_html, d.fonte, d.fonte_url, d.autor, d.errata,
           d.data_publicacao, d.tipo, agora(), post.id);
    auditar(s, "editar-post", `#${post.id} ${d.titulo}`, ip);
    return json(res, 200, { ok: true });
  }

  if (mPost && req.method === "DELETE") {
    if (!S.pode(s.perfil, "posts")) return json(res, 403, { error: "Sem permissão." });
    const post = db.prepare("SELECT * FROM posts WHERE id=?").get(mPost[1]);
    if (!post) return json(res, 404, { error: "Post não encontrado." });
    /* Matéria que já foi ao ar não se apaga do sistema: o registro é a prova
       do que foi publicado, quando e por quem. Some da lista, não do banco. */
    const publicados = db.prepare("SELECT COUNT(*) c FROM destinos WHERE post_id=? AND status='publicado'").get(post.id).c;
    if (publicados && s.perfil !== "admin")
      return json(res, 409, { error: "Esta matéria já foi publicada — só o administrador pode removê-la do sistema. (A publicação nas redes NÃO é apagada por aqui.)" });
    for (const m of db.prepare("SELECT arquivo FROM midias WHERE post_id=?").all(post.id)) {
      try { fs.unlinkSync(path.join(MIDIA_DIR, path.basename(m.arquivo))); } catch { }
    }
    db.prepare("DELETE FROM destinos WHERE post_id=?").run(post.id);
    db.prepare("DELETE FROM midias WHERE post_id=?").run(post.id);
    db.prepare("DELETE FROM posts WHERE id=?").run(post.id);
    auditar(s, "excluir-post", `#${post.id} ${post.titulo}`, ip);
    return json(res, 200, { ok: true });
  }

  /* ------------------------------ MÍDIA ---------------------------------- */
  const mUp = p.match(/^posts\/(\d+)\/midia$/);
  if (mUp && req.method === "POST") {
    if (!S.pode(s.perfil, "midias")) return json(res, 403, { error: "Sem permissão para enviar arquivos." });
    const post = db.prepare("SELECT id FROM posts WHERE id=?").get(mUp[1]);
    if (!post) return json(res, 404, { error: "Post não encontrado." });
    return receberArquivo(req, res, post.id, s, ip);
  }

  const mMid = p.match(/^midias\/(\d+)$/);
  if (mMid && req.method === "PUT") {
    if (!S.pode(s.perfil, "midias")) return json(res, 403, { error: "Sem permissão." });
    const b = await lerCorpo(req, 20000);
    const sets = [], args = [];
    if (b.ordem !== undefined) { sets.push("ordem=?"); args.push(Number(b.ordem) || 0); }
    if (b.alt !== undefined) { sets.push("alt=?"); args.push(String(b.alt).slice(0, 300)); }
    if (b.capa !== undefined) {
      const m = db.prepare("SELECT post_id FROM midias WHERE id=?").get(mMid[1]);
      if (m) db.prepare("UPDATE midias SET capa=0 WHERE post_id=?").run(m.post_id);
      sets.push("capa=?"); args.push(Number(b.capa) ? 1 : 0);
    }
    if (sets.length) db.prepare(`UPDATE midias SET ${sets.join(",")} WHERE id=?`).run(...args, mMid[1]);
    return json(res, 200, { ok: true });
  }
  if (mMid && req.method === "DELETE") {
    if (!S.pode(s.perfil, "midias")) return json(res, 403, { error: "Sem permissão." });
    const m = db.prepare("SELECT * FROM midias WHERE id=?").get(mMid[1]);
    if (!m) return json(res, 404, { error: "Arquivo não encontrado." });
    try { fs.unlinkSync(path.join(MIDIA_DIR, path.basename(m.arquivo))); } catch { }
    db.prepare("DELETE FROM midias WHERE id=?").run(m.id);
    return json(res, 200, { ok: true });
  }

  /* --------------------- checagem das regras (prévia) --------------------- */
  const mChk = p.match(/^posts\/(\d+)\/checar$/);
  if (mChk && req.method === "POST") {
    const post = db.prepare("SELECT * FROM posts WHERE id=?").get(mChk[1]);
    if (!post) return json(res, 404, { error: "Post não encontrado." });
    const midias = db.prepare("SELECT * FROM midias WHERE post_id=? ORDER BY ordem,id").all(post.id);
    const b = await lerCorpo(req, 1e6);
    const saida = {};
    for (const d of b.destinos || []) saida[d.plataforma] = validarDestino(d.plataforma, d.opcoes || {}, post, midias);
    return json(res, 200, saida);
  }

  /* Legenda sugerida a partir do resumo da matéria. */
  const mLeg = p.match(/^posts\/(\d+)\/legenda\/([a-z]+)$/);
  if (mLeg && req.method === "GET") {
    const post = db.prepare("SELECT * FROM posts WHERE id=?").get(mLeg[1]);
    if (!post) return json(res, 404, { error: "Post não encontrado." });
    return json(res, 200, { legenda: legendaPadrao(mLeg[2], post) });
  }

  /* ---------------------------- PUBLICAR --------------------------------- */
  const mPub = p.match(/^posts\/(\d+)\/publicar$/);
  if (mPub && req.method === "POST") {
    if (!S.pode(s.perfil, "publicar"))
      return json(res, 403, { error: "Seu perfil escreve, mas não publica. Peça a um editor." });
    const post = db.prepare("SELECT * FROM posts WHERE id=?").get(mPub[1]);
    if (!post) return json(res, 404, { error: "Post não encontrado." });
    const midias = db.prepare("SELECT * FROM midias WHERE post_id=? ORDER BY ordem,id").all(post.id);
    const b = await lerCorpo(req, 1e6);
    const pedidos = Array.isArray(b.destinos) ? b.destinos : [];
    if (!pedidos.length) return json(res, 400, { error: "Escolha ao menos uma plataforma." });

    const quando = String(b.agendado_para || "").trim();
    if (quando && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(quando))
      return json(res, 400, { error: "Data de agendamento inválida." });
    const agendadoIso = quando ? new Date(quando).toISOString() : null;
    if (agendadoIso && new Date(agendadoIso).getTime() < Date.now() - 60_000)
      return json(res, 400, { error: "A data de agendamento está no passado." });

    /* valida TUDO antes de enfileirar qualquer coisa — publicação parcial por
       erro de preenchimento seria pior que não publicar */
    const problemas = {};
    for (const d of pedidos) {
      if (!PLATAFORMAS[d.plataforma]) return json(res, 400, { error: `Plataforma inválida: ${d.plataforma}` });
      const conta = db.prepare("SELECT * FROM contas WHERE id=? AND plataforma=? AND ativo=1").get(d.conta_id, d.plataforma);
      if (!conta) { problemas[d.plataforma] = { erros: [`${PLATAFORMAS[d.plataforma].rotulo}: escolha uma conta conectada.`], avisos: [] }; continue; }
      const v = validarDestino(d.plataforma, d.opcoes || {}, post, midias);
      if (v.erros.length) problemas[d.plataforma] = v;
    }
    if (Object.keys(problemas).length) return json(res, 400, { error: "Há campos fora das regras da plataforma.", problemas });

    for (const d of pedidos) {
      const opcoes = JSON.stringify(d.opcoes || {});
      /* Um destino por plataforma+conta: reenviar substitui o que ainda não
         foi publicado, nunca duplica o que já foi. */
      const ja = db.prepare("SELECT * FROM destinos WHERE post_id=? AND plataforma=? AND conta_id=?")
        .get(post.id, d.plataforma, d.conta_id);
      /* Reenviar para uma REDE SOCIAL criaria um segundo post — por isso o que
         já foi publicado é pulado. No SITE é o contrário: reenviar ATUALIZA a
         matéria (o conector reconhece a origem e faz UPDATE), que é justamente
         como se publica uma correção. */
      if (ja && ja.status === "publicado" && d.plataforma !== "site") continue;
      if (ja) {
        db.prepare(`UPDATE destinos SET status=?, agendado_para=?, opcoes=?, tentativas=0,
                    proxima_tentativa=NULL, erro=NULL, atualizado=? WHERE id=?`)
          .run(agendadoIso ? "agendado" : "pendente", agendadoIso, opcoes, agora(), ja.id);
      } else {
        db.prepare(`INSERT INTO destinos(post_id,conta_id,plataforma,status,agendado_para,opcoes,criado,atualizado)
                    VALUES(?,?,?,?,?,?,?,?)`)
          .run(post.id, d.conta_id, d.plataforma, agendadoIso ? "agendado" : "pendente", agendadoIso, opcoes, agora(), agora());
      }
    }
    fila.atualizarStatusPost(post.id);
    auditar(s, agendadoIso ? "agendar" : "publicar",
      `#${post.id} ${post.titulo} → ${pedidos.map((d) => d.plataforma).join(",")}`, ip);
    registrar("info", agendadoIso ? `Agendado para ${agendadoIso}.` : "Enviado para a fila de publicação.", { postId: post.id });
    if (!agendadoIso) fila.acordar();
    return json(res, 200, { ok: true, agendado: !!agendadoIso });
  }

  /* --------------------------- destinos ---------------------------------- */
  const mDest = p.match(/^destinos\/(\d+)\/(retentar|cancelar)$/);
  if (mDest && req.method === "POST") {
    if (!S.pode(s.perfil, "publicar")) return json(res, 403, { error: "Sem permissão." });
    const d = db.prepare("SELECT * FROM destinos WHERE id=?").get(mDest[1]);
    if (!d) return json(res, 404, { error: "Destino não encontrado." });
    /* Reenviar ao site atualiza a matéria; reenviar a uma rede social criaria
       um post duplicado — daí a diferença de tratamento. */
    if (d.status === "publicado" && d.plataforma !== "site")
      return json(res, 400, { error: "Este destino já foi publicado. Reenviar criaria uma publicação duplicada na rede." });
    if (d.status === "publicado" && mDest[2] === "cancelar")
      return json(res, 400, { error: "A matéria já está no ar no site." });
    if (mDest[2] === "retentar") {
      db.prepare("UPDATE destinos SET status='pendente', tentativas=0, proxima_tentativa=NULL, erro=NULL, agendado_para=NULL, atualizado=? WHERE id=?").run(agora(), d.id);
      fila.acordar();
    } else {
      db.prepare("UPDATE destinos SET status='cancelado', atualizado=? WHERE id=?").run(agora(), d.id);
    }
    fila.atualizarStatusPost(d.post_id);
    auditar(s, mDest[2], `destino #${d.id} (${d.plataforma})`, ip);
    return json(res, 200, { ok: true });
  }

  if (p === "fila" && req.method === "GET") {
    return json(res, 200, db.prepare(`SELECT d.*, p.titulo FROM destinos d JOIN posts p ON p.id=d.post_id
      WHERE d.status IN ('pendente','agendado','processando','erro')
      ORDER BY CASE d.status WHEN 'processando' THEN 0 WHEN 'erro' THEN 1 ELSE 2 END,
               COALESCE(NULLIF(d.agendado_para,''), d.criado) LIMIT 200`).all());
  }
  if (p === "fila/rodar" && req.method === "POST") {
    if (!S.pode(s.perfil, "publicar")) return json(res, 403, { error: "Sem permissão." });
    const n = await fila.processarUmaVez();
    return json(res, 200, { ok: true, processados: n });
  }

  /* ------------------------------ CONTAS --------------------------------- */
  if (p === "contas" && req.method === "GET") {
    const linhas = db.prepare("SELECT id,plataforma,nome,apelido,externo_id,expira,escopos,meta,ativo,ultimo_erro,criado FROM contas ORDER BY plataforma, id").all();
    /* NUNCA devolvemos token nem segredo — nem mascarado. O painel só precisa
       saber que existe. */
    return json(res, 200, linhas.map((c) => {
      const m = jsonSeguro(c.meta);
      delete m.segredo;
      return { ...c, meta: m, vence_em: c.expira || null };
    }));
  }

  if (p === "contas" && req.method === "POST") {
    if (s.perfil !== "admin") return json(res, 403, { error: "Só o administrador conecta contas." });
    const b = await lerCorpo(req, 20000);
    if (b.plataforma !== "site") return json(res, 400, { error: "Contas de rede social entram pelo botão Conectar (OAuth)." });
    const url = String(b.url || "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return json(res, 400, { error: "Informe a URL do site (https://…)." });
    const segredo = String(b.segredo || "").trim();
    if (segredo.length < 32) return json(res, 400, { error: "O segredo do site precisa ter ao menos 32 caracteres (o conector gera um no primeiro boot)." });
    db.prepare(`INSERT INTO contas(plataforma,nome,apelido,externo_id,token,meta,ativo,criado,atualizado)
                VALUES('site',?,?,?,?,?,1,?,?)`)
      .run(String(b.nome || url).slice(0, 120), String(b.apelido || "").slice(0, 60), url,
           cifrar(segredo), JSON.stringify({ url }), agora(), agora());
    auditar(s, "conectar-site", url, ip);
    return json(res, 200, { ok: true });
  }

  const mConta = p.match(/^contas\/(\d+)$/);
  if (mConta && req.method === "PUT") {
    if (s.perfil !== "admin") return json(res, 403, { error: "Sem permissão." });
    const c = db.prepare("SELECT * FROM contas WHERE id=?").get(mConta[1]);
    if (!c) return json(res, 404, { error: "Conta não encontrada." });
    const b = await lerCorpo(req, 20000);
    const sets = [], args = [];
    if (b.apelido !== undefined) { sets.push("apelido=?"); args.push(String(b.apelido).slice(0, 60)); }
    if (b.ativo !== undefined) { sets.push("ativo=?"); args.push(Number(b.ativo) ? 1 : 0); }
    if (c.plataforma === "site") {
      const m = jsonSeguro(c.meta);
      if (b.url) { m.url = String(b.url).replace(/\/+$/, ""); sets.push("meta=?"); args.push(JSON.stringify(m)); }
      if (b.segredo) {
        if (String(b.segredo).length < 32) return json(res, 400, { error: "Segredo curto demais." });
        sets.push("token=?"); args.push(cifrar(String(b.segredo)));
      }
    }
    sets.push("atualizado=?"); args.push(agora());
    db.prepare(`UPDATE contas SET ${sets.join(",")} WHERE id=?`).run(...args, c.id);
    auditar(s, "editar-conta", `#${c.id} ${c.plataforma}`, ip);
    return json(res, 200, { ok: true });
  }

  if (mConta && req.method === "DELETE") {
    if (s.perfil !== "admin") return json(res, 403, { error: "Sem permissão." });
    const usos = db.prepare("SELECT COUNT(*) c FROM destinos WHERE conta_id=? AND status='publicado'").get(mConta[1]).c;
    if (usos) return json(res, 409, { error: `Esta conta já publicou ${usos} vez(es) — desative em vez de excluir, para o histórico continuar legível.` });
    db.prepare("DELETE FROM contas WHERE id=?").run(mConta[1]);
    auditar(s, "excluir-conta", `#${mConta[1]}`, ip);
    return json(res, 200, { ok: true });
  }

  const mVer = p.match(/^contas\/(\d+)\/verificar$/);
  if (mVer && req.method === "POST") {
    const c = fila.carregarConta(mVer[1]);
    if (!c) return json(res, 404, { error: "Conta não encontrada." });
    try {
      const conta = await fila.garantirToken(c);
      let r;
      if (conta.plataforma === "youtube") r = await youtube.verificar({ conta });
      else if (conta.plataforma === "tiktok") r = await tiktok.verificar({ conta });
      else if (conta.plataforma === "site") r = await siteAdapter.verificar({ conta });
      else r = await meta.verificar({ conta });
      db.prepare("UPDATE contas SET ultimo_erro=NULL, atualizado=? WHERE id=?").run(agora(), c.id);
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      db.prepare("UPDATE contas SET ultimo_erro=?, atualizado=? WHERE id=?").run(String(e.message).slice(0, 300), agora(), c.id);
      return json(res, 200, { ok: false, error: e.message });
    }
  }

  /* Início do OAuth: devolve a URL para o painel abrir em outra aba. */
  const mCon = p.match(/^conectar\/(facebook|tiktok|youtube)$/);
  if (mCon && req.method === "POST") {
    if (s.perfil !== "admin") return json(res, 403, { error: "Só o administrador conecta contas." });
    const plataforma = mCon[1];
    const app = fila.appDe(plataforma);
    if (!app?.client_id || !app.client_secret)
      return json(res, 400, { error: `Cadastre antes as credenciais do app em Configurações → Aplicativos (${PLATAFORMAS[plataforma === "facebook" ? "facebook" : plataforma].rotulo}).` });
    if (!fila.urlPublica())
      return json(res, 400, { error: "Configure o Endereço público antes de conectar — as plataformas exigem um redirect_uri acessível pela internet." });

    const state = crypto.randomBytes(24).toString("hex");
    const pend = { plataforma, userId: s.userId, nomeUsuario: s.nome, ts: Date.now() };
    let url;
    if (plataforma === "tiktok") {
      const pkce = tiktok.novoPkce();
      pend.verifier = pkce.verifier;
      url = tiktok.autorizarUrl({ clientId: app.client_id, redirectUri: redirectUri(plataforma), state, extra: { challenge: pkce.challenge } });
    } else if (plataforma === "youtube") {
      url = youtube.autorizarUrl({ clientId: app.client_id, redirectUri: redirectUri(plataforma), state });
    } else {
      url = meta.autorizarUrl({ clientId: app.client_id, redirectUri: redirectUri(plataforma), state, extra: app.extra });
    }
    oauthPendentes.set(state, pend);
    return json(res, 200, { url });
  }

  /* ---------------------------- APLICATIVOS ------------------------------ */
  if (p === "apps" && req.method === "GET") {
    if (s.perfil !== "admin") return json(res, 403, { error: "Sem permissão." });
    const linhas = db.prepare("SELECT plataforma, client_id, client_secret, extra, ativo, atualizado FROM apps").all();
    const mapa = {};
    for (const a of linhas) mapa[a.plataforma] = {
      client_id: a.client_id || "",
      tem_secret: !!decifrar(a.client_secret),     // o segredo nunca volta para a tela
      extra: jsonSeguro(a.extra), ativo: a.ativo, atualizado: a.atualizado,
    };
    return json(res, 200, {
      apps: mapa,
      redirect: { facebook: redirectUri("facebook"), tiktok: redirectUri("tiktok"), youtube: redirectUri("youtube") },
    });
  }
  const mApp = p.match(/^apps\/(facebook|tiktok|youtube)$/);
  if (mApp && req.method === "PUT") {
    if (s.perfil !== "admin") return json(res, 403, { error: "Sem permissão." });
    const b = await lerCorpo(req, 50000);
    const atual = db.prepare("SELECT * FROM apps WHERE plataforma=?").get(mApp[1]);
    const secret = b.client_secret ? cifrar(String(b.client_secret).trim()) : (atual?.client_secret || "");
    /* extra é MESCLADO, não substituído: salvar só o client_id não pode apagar
       a versão da API nem o config_id que já estavam lá. */
    const extraNovo = { ...jsonSeguro(atual?.extra) };
    if (b.extra?.versao !== undefined) {
      const v = String(b.extra.versao).trim().toLowerCase();
      if (v && !/^v\d{1,3}\.\d{1,3}$/.test(v))
        return json(res, 400, { error: "Versão da API inválida — use o formato v21.0." });
      if (v) extraNovo.versao = v; else delete extraNovo.versao;
    }
    if (b.extra?.config_id !== undefined) {
      const c = String(b.extra.config_id).trim();
      if (c && !/^\d{5,25}$/.test(c))
        return json(res, 400, { error: "O ID da configuração do Login para Empresas é só números." });
      if (c) extraNovo.config_id = c; else delete extraNovo.config_id;
    }
    const extra = JSON.stringify(extraNovo);
    if (atual) {
      db.prepare("UPDATE apps SET client_id=?, client_secret=?, extra=?, atualizado=? WHERE plataforma=?")
        .run(String(b.client_id || "").trim(), secret, extra, agora(), mApp[1]);
    } else {
      db.prepare("INSERT INTO apps(plataforma,client_id,client_secret,extra,ativo,atualizado) VALUES(?,?,?,?,1,?)")
        .run(mApp[1], String(b.client_id || "").trim(), secret, extra, agora());
    }
    auditar(s, "salvar-app", mApp[1], ip);
    return json(res, 200, { ok: true });
  }

  /* ---------------------------- CONFIGURAÇÕES ---------------------------- */
  if (p === "config" && req.method === "GET") {
    return json(res, 200, {
      url_publica: getC("url_publica") || "",
      nome_sistema: getC("nome_sistema") || "LA Publisher",
      /* Identificação do responsável — sai nas páginas públicas de
         privacidade e exclusão de dados, que a Meta exige para liberar o app. */
      empresa: getC("empresa") || "",
      cnpj: getC("cnpj") || "",
      email_privacidade: getC("email_privacidade") || "",
      versao: VERSAO,
      pode_admin: s.perfil === "admin",
    });
  }
  if (p === "config" && req.method === "PUT") {
    if (s.perfil !== "admin") return json(res, 403, { error: "Sem permissão." });
    const b = await lerCorpo(req, 20000);
    if (b.url_publica !== undefined) {
      const u = String(b.url_publica).trim().replace(/\/+$/, "");
      if (u && !/^https?:\/\/[^\s/]+/i.test(u)) return json(res, 400, { error: "Endereço público inválido." });
      setC("url_publica", u);
    }
    if (b.nome_sistema !== undefined) setC("nome_sistema", S.soTexto(b.nome_sistema).slice(0, 60));
    if (b.empresa !== undefined) setC("empresa", S.soTexto(b.empresa).slice(0, 120));
    if (b.cnpj !== undefined) setC("cnpj", S.soTexto(b.cnpj).slice(0, 24));
    if (b.email_privacidade !== undefined) {
      const e = S.soTexto(b.email_privacidade).slice(0, 120);
      if (e && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(e)) return json(res, 400, { error: "E-mail inválido." });
      setC("email_privacidade", e);
    }
    auditar(s, "salvar-config", "", ip);
    return json(res, 200, { ok: true });
  }

  /* -------------------------------- LOGS --------------------------------- */
  if (p === "logs" && req.method === "GET") {
    const q = new URL(req.url, "http://x").searchParams;
    const postId = q.get("post_id");
    return json(res, 200, postId
      ? db.prepare("SELECT * FROM logs WHERE post_id=? ORDER BY id DESC LIMIT 200").all(postId)
      : db.prepare("SELECT * FROM logs ORDER BY id DESC LIMIT 200").all());
  }
  if (p === "auditoria" && req.method === "GET") {
    if (s.perfil !== "admin") return json(res, 403, { error: "Sem permissão." });
    return json(res, 200, db.prepare("SELECT * FROM auditoria ORDER BY id DESC LIMIT 300").all());
  }

  /* ------------------------------ USUÁRIOS -------------------------------- */
  if (p === "usuarios" || /^usuarios\/\d+$/.test(p)) {
    if (s.perfil !== "admin") return json(res, 403, { error: "Apenas o administrador gerencia usuários." });
    const id = p.match(/^usuarios\/(\d+)$/)?.[1];
    if (req.method === "GET" && !id)
      return json(res, 200, db.prepare("SELECT id,nome,email,perfil,ativo,criado FROM usuarios ORDER BY id").all());
    if (req.method === "POST" && !id) {
      const b = await lerCorpo(req, 20000);
      const nome = String(b.nome || "").trim(), email = String(b.email || "").trim().toLowerCase();
      const perfil = String(b.perfil || "redator");
      if (!nome || !email) return json(res, 400, { error: "Nome e login são obrigatórios." });
      if (!S.PERFIS.includes(perfil)) return json(res, 400, { error: "Perfil inválido." });
      if (String(b.senha || "").length < 8) return json(res, 400, { error: "A senha precisa de ao menos 8 caracteres." });
      try {
        db.prepare("INSERT INTO usuarios(nome,email,senha_hash,perfil,ativo,criado) VALUES(?,?,?,?,?,?)")
          .run(nome, email, S.hashSenha(b.senha), perfil, b.ativo === undefined ? 1 : (Number(b.ativo) ? 1 : 0), agora());
      } catch (e) { return json(res, 400, { error: /UNIQUE/.test(e.message) ? "Já existe usuário com esse login." : "Erro ao criar usuário." }); }
      auditar(s, "criar-usuario", email, ip);
      return json(res, 200, { ok: true });
    }
    if (req.method === "PUT" && id) {
      const b = await lerCorpo(req, 20000);
      const alvo = db.prepare("SELECT perfil,ativo FROM usuarios WHERE id=?").get(id);
      if (!alvo) return json(res, 404, { error: "Usuário não encontrado." });
      const viraNaoAdmin = b.perfil !== undefined && b.perfil !== "admin";
      const viraInativo = b.ativo !== undefined && !Number(b.ativo);
      if (alvo.perfil === "admin" && alvo.ativo && (viraNaoAdmin || viraInativo) && S.adminsAtivos() <= 1)
        return json(res, 400, { error: "Não dá para rebaixar ou desativar o único administrador." });
      const sets = [], args = [];
      if (b.nome !== undefined) { sets.push("nome=?"); args.push(String(b.nome).trim()); }
      if (b.email !== undefined) { sets.push("email=?"); args.push(String(b.email).trim().toLowerCase()); }
      if (b.perfil !== undefined) { if (!S.PERFIS.includes(b.perfil)) return json(res, 400, { error: "Perfil inválido." }); sets.push("perfil=?"); args.push(b.perfil); }
      if (b.ativo !== undefined) { sets.push("ativo=?"); args.push(Number(b.ativo) ? 1 : 0); if (!Number(b.ativo)) S.derrubarSessoesDoUsuario(Number(id)); }
      if (b.senha) { if (String(b.senha).length < 8) return json(res, 400, { error: "Senha curta demais." }); sets.push("senha_hash=?"); args.push(S.hashSenha(b.senha)); S.derrubarSessoesDoUsuario(Number(id)); }
      if (sets.length) {
        try { db.prepare(`UPDATE usuarios SET ${sets.join(",")} WHERE id=?`).run(...args, id); }
        catch (e) { return json(res, 400, { error: /UNIQUE/.test(e.message) ? "Login já em uso." : "Erro ao salvar." }); }
      }
      auditar(s, "editar-usuario", `#${id}`, ip);
      return json(res, 200, { ok: true });
    }
    if (req.method === "DELETE" && id) {
      if (Number(id) === s.userId) return json(res, 400, { error: "Você não pode excluir o próprio usuário." });
      const alvo = db.prepare("SELECT perfil,ativo FROM usuarios WHERE id=?").get(id);
      if (alvo?.perfil === "admin" && alvo.ativo && S.adminsAtivos() <= 1)
        return json(res, 400, { error: "Não dá para excluir o único administrador." });
      db.prepare("DELETE FROM usuarios WHERE id=?").run(id);
      S.derrubarSessoesDoUsuario(Number(id));
      auditar(s, "excluir-usuario", `#${id}`, ip);
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { error: "Rota não encontrada" });
}

/* ==========================================================================
   Campos do post — higienização centralizada
   ========================================================================== */
function camposDoPost(b, atual = {}) {
  /* Título, autor, fonte e errata são TEXTO — passam por soTexto(), que tira
     qualquer tag. Só resumo e texto são HTML, e esses vão pelo higienizador. */
  const titulo = S.soTexto(b.titulo ?? atual.titulo ?? "").slice(0, 300);
  return {
    titulo,
    slug: S.slugify(b.slug ?? atual.slug ?? titulo),
    resumo_html: S.sanitizarHtml(b.resumo_html ?? atual.resumo_html ?? ""),
    texto_html: S.sanitizarHtml(b.texto_html ?? atual.texto_html ?? ""),
    fonte: S.soTexto(b.fonte ?? atual.fonte ?? "").slice(0, 200),
    fonte_url: S.urlSegura(b.fonte_url ?? atual.fonte_url ?? "") || "",
    autor: S.soTexto(b.autor ?? atual.autor ?? "").slice(0, 120),
    errata: S.soTexto(b.errata ?? atual.errata ?? "").slice(0, 2000),
    data_publicacao: /^\d{4}-\d{2}-\d{2}/.test(String(b.data_publicacao ?? atual.data_publicacao ?? ""))
      ? String(b.data_publicacao ?? atual.data_publicacao).slice(0, 10)
      : new Date().toISOString().slice(0, 10),
    tipo: ["foto", "video", "texto"].includes(b.tipo ?? atual.tipo) ? (b.tipo ?? atual.tipo) : "foto",
  };
}

/* ==========================================================================
   Upload em fluxo (stream)

   Vídeo não cabe em base64 num JSON: um arquivo de 500 MB viraria ~670 MB de
   texto na memória. Aqui o corpo vai direto para o disco em pedaços, com teto
   de tamanho, e só DEPOIS o arquivo é conferido — pelo CONTEÚDO, não pelo que
   o navegador disse ser. Se o cabeçalho não bater com um tipo permitido, o
   arquivo é apagado.
   ========================================================================== */
function receberArquivo(req, res, postId, s, ip) {
  return new Promise((resolver) => {
    const declarado = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!MIMES_OK.includes(declarado)) {
      json(res, 415, { error: `Tipo não aceito (${declarado || "desconhecido"}). Envie JPG, PNG, WEBP, GIF, MP4, MOV ou WEBM.` });
      req.destroy();
      return resolver();
    }
    const nomeOriginal = decodeURIComponent(String(req.headers["x-nome"] || "arquivo"));
    const temporario = path.join(MIDIA_DIR, `.tmp-${crypto.randomBytes(8).toString("hex")}`);
    const saida = fs.createWriteStream(temporario);
    let bytes = 0, estourou = false;

    const limpar = () => { try { fs.unlinkSync(temporario); } catch { } };

    req.on("data", (c) => {
      bytes += c.length;
      if (bytes > UPLOAD_MAX && !estourou) { estourou = true; saida.destroy(); req.destroy(); }
    });
    req.pipe(saida);

    req.on("error", () => { limpar(); resolver(); });
    saida.on("error", () => { limpar(); if (!res.headersSent) json(res, 500, { error: "Falha ao gravar o arquivo." }); resolver(); });

    saida.on("close", () => {
      if (estourou) {
        limpar();
        if (!res.headersSent) json(res, 413, { error: `Arquivo maior que o limite de ${(UPLOAD_MAX / 1073741824).toFixed(0)} GB.` });
        return resolver();
      }
      if (!bytes) { limpar(); json(res, 400, { error: "Arquivo vazio." }); return resolver(); }

      /* O tipo REAL vem do cabeçalho binário. Um .php renomeado para .jpg, ou
         um SVG dizendo-se PNG, morre aqui. */
      const real = midiaUtil.mimeReal(temporario);
      if (!real || !MIMES_OK.includes(real)) {
        limpar();
        json(res, 415, { error: "O conteúdo do arquivo não é uma imagem ou vídeo válido." });
        return resolver();
      }
      const tipo = real.startsWith("video/") ? "video" : "imagem";
      const arquivo = S.nomeArquivoSeguro(nomeOriginal, EXT_DE_MIME[real]);
      try { fs.renameSync(temporario, path.join(MIDIA_DIR, arquivo)); }
      catch (e) { limpar(); json(res, 500, { error: "Falha ao salvar." }); return resolver(); }

      const med = midiaUtil.medir(path.join(MIDIA_DIR, arquivo), real);
      const ordem = (db.prepare("SELECT COALESCE(MAX(ordem),-1) o FROM midias WHERE post_id=?").get(postId).o) + 1;
      const primeira = db.prepare("SELECT COUNT(*) c FROM midias WHERE post_id=?").get(postId).c === 0;
      const info = db.prepare(`INSERT INTO midias(post_id,arquivo,tipo,mime,bytes,largura,altura,duracao,ordem,capa,criado)
                               VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(postId, arquivo, tipo, real, bytes, med.largura, med.altura, med.duracao, ordem, primeira && tipo === "imagem" ? 1 : 0, agora());

      /* O tipo do POST acompanha o que foi enviado — é o que decide quais
         plataformas ficam disponíveis na tela. */
      if (tipo === "video") db.prepare("UPDATE posts SET tipo='video', atualizado=? WHERE id=?").run(agora(), postId);

      auditar(s, "enviar-midia", `#${postId} ${arquivo} (${(bytes / 1048576).toFixed(1)} MB)`, ip);
      json(res, 200, {
        ok: true,
        midia: { id: Number(info.lastInsertRowid), arquivo, tipo, mime: real, bytes, ...med, ordem, capa: primeira && tipo === "imagem" ? 1 : 0 },
      });
      resolver();
    });
  });
}

module.exports = { handlePainel, CSP, MIDIA_DIR, MIMES_OK };
