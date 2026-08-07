/* ==========================================================================
   api.js — API pública do LA Publisher (/api/v1)

   Inverte o sentido do conector: lá, nós empurramos a matéria para o site;
   aqui, o SITE manda publicar nas redes. O caso de uso é o do BemEstar — a
   pessoa escreve a notícia no painel do site dela, marca Instagram e
   Facebook, e o site aciona esta API.

   TRÊS REGRAS QUE SUSTENTAM TUDO

   1. Cada chave só enxerga as contas dela (`clientes_contas`). Sem esse
      recorte, a chave de um cliente publicaria no Instagram de outro — o
      pior acidente possível neste sistema. Vale para listar, publicar e
      consultar.
   2. Assinatura HMAC sobre método + caminho + corpo + timestamp. Token
      estático em cabeçalho vaza em log de proxy e vale para sempre; a
      assinatura muda a cada chamada e expira em 5 minutos.
   3. Idempotência por `origem_ref`. O site repete a chamada por timeout ou
      clique dobrado — e repetir NÃO pode gerar um segundo post no Instagram.

   AUTENTICAÇÃO (cabeçalhos)
     X-LAP-Chave       lap_a1b2c3…              (identificador público)
     X-LAP-Timestamp   1754500000               (segundos)
     X-LAP-Assinatura  sha256=<hmac hex>
   onde o HMAC é sobre  `${ts}.${MÉTODO}.${caminho}.${corpo}`.
   ========================================================================== */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const net = require("node:net");

const { VERSAO } = require("./versao");
const { db, getC, cifrar, decifrar, agora, registrar, auditar } = require("./banco");
const S = require("./seguranca");
const { PLATAFORMAS, ORDEM, validarDestino, legendaPadrao } = require("./regras");
const fila = require("./fila");
const midiaUtil = require("./midia");
const painel = require("./painel");
const meta = require("./plataformas/meta");
const tiktok = require("./plataformas/tiktok");
const youtube = require("./plataformas/youtube");

const MIDIA_DIR = fila.MIDIA_DIR;
const JANELA_SEGUNDOS = 300;
const CORPO_MAX = 4 * 1024 * 1024;         // JSON; a mídia vem por URL
const MIDIA_MAX = 512 * 1024 * 1024;       // teto do arquivo baixado
const LIMITE_MIN = 120;                    // chamadas por minuto por chave
const CONEXAO_MINUTOS = 30;

/* ------------------------------- respostas -------------------------------- */
function json(res, code, obj) {
  const corpo = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Content-Length": Buffer.byteLength(corpo),
  });
  res.end(corpo);
}
const erro = (res, code, mensagem, extra = {}) => json(res, code, { erro: mensagem, ...extra });

function lerCorpoCru(req) {
  return new Promise((ok) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > CORPO_MAX) { req.destroy(); ok(null); } });
    req.on("end", () => ok(b));
    req.on("error", () => ok(null));
  });
}

/* ------------------------- trava por chave e por IP ----------------------- */
const batidas = new Map();
function demais(id) {
  const t = Date.now();
  const b = batidas.get(id) || { n: 0, ts: t };
  if (t - b.ts > 60_000) { b.n = 0; b.ts = t; }
  b.n++; batidas.set(id, b);
  return b.n > LIMITE_MIN;
}
setInterval(() => {
  const lim = Date.now() - 120_000;
  for (const [k, v] of batidas) if (v.ts < lim) batidas.delete(k);
}, 120_000).unref();

/* ============================== AUTENTICAÇÃO ==============================
   Devolve { cliente } ou { erro: [codigo, mensagem] }.
   ========================================================================== */
function autenticar(req, caminho, corpoCru) {
  const chave = String(req.headers["x-lap-chave"] || "").trim();
  const ts = Number(req.headers["x-lap-timestamp"] || 0);
  const assinatura = String(req.headers["x-lap-assinatura"] || "");
  if (!chave) return { erro: [401, "Falta o cabeçalho X-LAP-Chave."] };

  const cliente = db.prepare("SELECT * FROM clientes_api WHERE chave=?").get(chave);
  /* Mesmo com a chave inexistente gastamos o HMAC, para o tempo de resposta
     não denunciar quais chaves existem. */
  const segredo = cliente ? decifrar(cliente.segredo) : "isca-" + chave;

  if (!ts || Math.abs(Math.floor(Date.now() / 1000) - ts) > JANELA_SEGUNDOS)
    return { erro: [401, "Assinatura fora da janela de tempo (5 minutos). Confira o relógio do servidor."] };

  const base = `${ts}.${req.method}.${caminho}.${corpoCru || ""}`;
  const esperada = "sha256=" + crypto.createHmac("sha256", segredo).update(base).digest("hex");
  const a = Buffer.from(assinatura), b = Buffer.from(esperada);
  const bate = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!cliente || !bate) return { erro: [401, "Chave ou assinatura inválida."] };
  if (!cliente.ativo) return { erro: [403, "Esta chave está desativada."] };
  if (demais("k" + cliente.id)) return { erro: [429, `Mais de ${LIMITE_MIN} chamadas por minuto.`] };

  db.prepare("UPDATE clientes_api SET ultimo_uso=?, chamadas=chamadas+1 WHERE id=?").run(agora(), cliente.id);
  return { cliente };
}

/* --------------------- contas que o cliente pode usar --------------------- */
const contasDoCliente = (clienteId) => db.prepare(`
  SELECT c.* FROM contas c
  JOIN clientes_contas cc ON cc.conta_id = c.id
  WHERE cc.cliente_id = ? ORDER BY c.plataforma, c.id`).all(clienteId);

const contaPermitida = (clienteId, contaId) => !!db.prepare(
  "SELECT 1 x FROM clientes_contas WHERE cliente_id=? AND conta_id=?").get(clienteId, contaId);

/* ==========================================================================
   MÍDIA POR URL

   O site manda a URL da imagem que já está hospedada nele e nós baixamos.
   Isso é um pedido de requisição feito por terceiro — ou seja, SSRF em
   potencial: uma URL apontando para 127.0.0.1 faria o LA Publisher buscar a
   si mesmo, e uma apontando para 169.254.169.254 buscaria as credenciais da
   nuvem. Por isso o endereço é RESOLVIDO e conferido contra faixas privadas
   antes de qualquer conexão — e de novo a cada redirecionamento.
   ========================================================================== */
function ipPrivado(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)          // metadados de nuvem
      || (a === 100 && b >= 64 && b <= 127)
      || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd")
    || v.startsWith("fe80") || v.startsWith("::ffff:");
}

/* Válvula EXCLUSIVA para a bateria de testes, que sobe um site falso em
   127.0.0.1. Fora dela isto fica desligado, e o server.js grita no boot se
   alguém subir a produção com a variável ligada. */
const PERMITIR_MIDIA_LOCAL = process.env.LAP_MIDIA_LOCAL === "1";

async function conferirDestinoPublico(u) {
  if (!/^https?:$/.test(u.protocol)) throw new Error("A URL da mídia precisa ser http ou https.");
  const enderecos = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!enderecos.length) throw new Error(`Não consegui resolver o endereço ${u.hostname}.`);
  for (const e of enderecos) {
    if (ipPrivado(e.address) && !PERMITIR_MIDIA_LOCAL)
      throw new Error(`A URL da mídia aponta para um endereço interno (${e.address}) — recusado.`);
  }
}

async function baixarMidia(urlBruta) {
  let u;
  try { u = new URL(String(urlBruta)); } catch { throw new Error("URL de mídia inválida."); }

  let resposta = null;
  for (let salto = 0; salto < 4; salto++) {
    await conferirDestinoPublico(u);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 60_000);
    let r;
    try {
      r = await fetch(u.href, { signal: ac.signal, redirect: "manual", headers: { "User-Agent": "LA-Publisher" } });
    } catch (e) {
      clearTimeout(t);
      throw new Error(`Não consegui baixar a mídia: ${e.name === "AbortError" ? "tempo esgotado" : e.message}`);
    }
    clearTimeout(t);
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const destino = r.headers.get("location");
      if (!destino) throw new Error("Redirecionamento sem destino ao baixar a mídia.");
      u = new URL(destino, u);            // e o laço confere o novo endereço
      continue;
    }
    if (!r.ok) throw new Error(`A mídia respondeu HTTP ${r.status}.`);
    resposta = r;
    break;
  }
  if (!resposta) throw new Error("Redirecionamentos demais ao baixar a mídia.");

  const declarado = Number(resposta.headers.get("content-length") || 0);
  if (declarado > MIDIA_MAX) throw new Error(`A mídia tem ${(declarado / 1048576).toFixed(0)} MB (máximo ${MIDIA_MAX / 1048576} MB).`);

  const buf = Buffer.from(await resposta.arrayBuffer());
  if (!buf.length) throw new Error("A mídia veio vazia.");
  if (buf.length > MIDIA_MAX) throw new Error(`A mídia tem ${(buf.length / 1048576).toFixed(0)} MB (máximo ${MIDIA_MAX / 1048576} MB).`);

  const temporario = path.join(MIDIA_DIR, `.tmp-${crypto.randomBytes(8).toString("hex")}`);
  fs.writeFileSync(temporario, buf);
  /* Tipo pelo CONTEÚDO, nunca pelo Content-Type nem pela extensão da URL —
     mesma regra do upload do painel. SVG continua fora. */
  const real = midiaUtil.mimeReal(temporario);
  if (!real || !painel.MIMES_OK.includes(real)) {
    try { fs.unlinkSync(temporario); } catch { }
    throw new Error("O arquivo baixado não é uma imagem ou vídeo aceito (JPG, PNG, WEBP, GIF, MP4, MOV, WEBM).");
  }
  const nome = S.nomeArquivoSeguro(path.basename(u.pathname) || "midia", painel.EXT_DE_MIME[real]);
  fs.renameSync(temporario, path.join(MIDIA_DIR, nome));
  const med = midiaUtil.medir(path.join(MIDIA_DIR, nome), real);
  return { arquivo: nome, mime: real, bytes: buf.length, tipo: real.startsWith("video/") ? "video" : "imagem", ...med };
}

/* Webhooks moram na fila (fila.js), que já tem o laço e a retentativa. */
const { enfileirarWebhook } = fila;

/* ========================================================================== */
/*                                  ROTAS                                     */
/* ========================================================================== */
function handleApi(req, res, pathname) {
  if (pathname.startsWith("/conectar/")) { rotaConectar(req, res, pathname).catch((e) => {
    console.error("  ✖ /conectar:", e.stack || e.message);
    painel.paginaSimples(res, 500, "Não foi possível conectar", "Tente de novo em alguns instantes.");
  }); return true; }

  if (!pathname.startsWith("/api/v1/") && pathname !== "/api/v1") return false;

  rotaApi(req, res, pathname).catch((e) => {
    console.error("  ✖ /api/v1:", e.stack || e.message);
    try { erro(res, 500, "Erro interno."); } catch { }
  });
  return true;
}

async function rotaApi(req, res, pathname) {
  const ip = S.clientIp(req);
  if (demais("ip" + ip)) return erro(res, 429, "Muitas chamadas.");

  const corpoCru = await lerCorpoCru(req);
  if (corpoCru === null) return erro(res, 413, "Corpo grande demais.");

  /* Assina-se `req.url` — caminho E query string, exatamente como veio na
     linha da requisição. Assinar só o caminho deixaria `?origem_ref=` livre
     para ser trocado no meio do caminho sem quebrar a assinatura. */
  const auth = autenticar(req, req.url, corpoCru);
  if (auth.erro) return erro(res, auth.erro[0], auth.erro[1]);
  const cliente = auth.cliente;

  let corpo = {};
  if (corpoCru) { try { corpo = JSON.parse(corpoCru); } catch { return erro(res, 400, "JSON inválido."); } }

  const rota = pathname.replace(/^\/api\/v1/, "") || "/";
  const M = req.method;

  /* ------------------------------- ping --------------------------------- */
  if (rota === "/ping" && M === "GET")
    return json(res, 200, { ok: true, cliente: cliente.nome, versao: VERSAO, agora: agora() });

  /* --------------------------- regras das redes -------------------------- */
  if (rota === "/plataformas" && M === "GET")
    return json(res, 200, { plataformas: PLATAFORMAS, ordem: ORDEM });

  /* ------------------------------- contas -------------------------------- */
  if (rota === "/contas" && M === "GET") {
    return json(res, 200, {
      contas: contasDoCliente(cliente.id).map((c) => ({
        id: c.id, plataforma: c.plataforma, nome: c.apelido || c.nome,
        ativo: !!c.ativo, ultimo_erro: c.ultimo_erro || null,
      })),
    });
  }
  const mConta = rota.match(/^\/contas\/(\d+)$/);
  if (mConta && M === "DELETE") {
    if (!contaPermitida(cliente.id, Number(mConta[1]))) return erro(res, 404, "Conta não encontrada para esta chave.");
    db.prepare("DELETE FROM clientes_contas WHERE cliente_id=? AND conta_id=?").run(cliente.id, mConta[1]);
    auditar({ nome: "api:" + cliente.nome }, "desvincular-conta", `conta #${mConta[1]}`, ip);
    /* A conta em si continua existindo no sistema — só deixa de ser visível
       para esta chave. Apagar seria destruir histórico de outro cliente. */
    return json(res, 200, { ok: true });
  }

  /* --------------------- autoatendimento: link de conexão ---------------- */
  if (rota === "/conexoes" && M === "POST") {
    const plataforma = String(corpo.plataforma || "facebook");
    if (!["facebook", "youtube", "tiktok"].includes(plataforma))
      return erro(res, 400, "Plataforma inválida. Use facebook (traz Instagram junto), youtube ou tiktok.");

    /* Validar a ENTRADA antes de olhar o estado do servidor: um pedido
       malformado tem de responder 400 mesmo que o app da rede não esteja
       configurado — senão o 503 esconde o erro de quem está integrando. */
    let retorno = String(corpo.retorno_url || "").trim();
    if (retorno) {
      /* Redirecionamento aberto é falha clássica: qualquer URL aceita aqui
         viraria um trampolim com o domínio do LA Publisher na barra. Só
         permitimos voltar para a origem cadastrada do próprio cliente. */
      if (!cliente.origem) return erro(res, 400, "Esta chave não tem origem cadastrada; não posso validar a retorno_url.");
      try {
        const r = new URL(retorno), o = new URL(cliente.origem);
        if (r.origin !== o.origin) return erro(res, 400, `A retorno_url precisa estar em ${o.origin}.`);
      } catch { return erro(res, 400, "retorno_url inválida."); }
    }

    const app = fila.appDe(plataforma);
    if (!app?.client_id || !app.client_secret)
      return erro(res, 503, `O LA Publisher ainda não tem as credenciais do app de ${plataforma} cadastradas.`);
    if (!fila.urlPublica()) return erro(res, 503, "O LA Publisher está sem endereço público configurado.");

    const token = crypto.randomBytes(24).toString("hex");
    db.prepare(`INSERT INTO conexoes(cliente_id,token,plataforma,retorno_url,status,expira,criado)
                VALUES(?,?,?,?,'aberto',?,?)`)
      .run(cliente.id, token, plataforma, retorno || null,
           new Date(Date.now() + CONEXAO_MINUTOS * 60_000).toISOString(), agora());
    auditar({ nome: "api:" + cliente.nome }, "criar-link-conexao", plataforma, ip);
    return json(res, 201, {
      url: `${fila.urlPublica()}/conectar/${token}`,
      expira_em: new Date(Date.now() + CONEXAO_MINUTOS * 60_000).toISOString(),
      instrucoes: "Abra esta URL no navegador do dono da conta. O link vale uma vez só e expira em 30 minutos.",
    });
  }

  /* ----------------------------- publicações ----------------------------- */
  if (rota === "/publicacoes" && M === "POST") return criarPublicacao(res, cliente, corpo, ip);

  if (rota === "/publicacoes" && M === "GET") {
    const q = new URL(req.url, "http://x").searchParams;
    const ref = q.get("origem_ref");
    const linhas = ref
      ? db.prepare("SELECT * FROM posts WHERE cliente_id=? AND origem_ref=?").all(cliente.id, ref)
      : db.prepare("SELECT * FROM posts WHERE cliente_id=? ORDER BY id DESC LIMIT 50").all(cliente.id);
    return json(res, 200, { publicacoes: linhas.map((p) => resumoPublicacao(p)) });
  }

  const mPub = rota.match(/^\/publicacoes\/(\d+)$/);
  if (mPub && M === "GET") {
    const post = db.prepare("SELECT * FROM posts WHERE id=? AND cliente_id=?").get(mPub[1], cliente.id);
    if (!post) return erro(res, 404, "Publicação não encontrada para esta chave.");
    return json(res, 200, resumoPublicacao(post, true));
  }

  const mAcao = rota.match(/^\/publicacoes\/(\d+)\/(retentar|cancelar)$/);
  if (mAcao && M === "POST") {
    const post = db.prepare("SELECT * FROM posts WHERE id=? AND cliente_id=?").get(mAcao[1], cliente.id);
    if (!post) return erro(res, 404, "Publicação não encontrada para esta chave.");
    const alvo = corpo.plataforma ? " AND plataforma=?" : "";
    const args = corpo.plataforma ? [post.id, corpo.plataforma] : [post.id];
    const destinos = db.prepare(`SELECT * FROM destinos WHERE post_id=?${alvo}`).all(...args);
    let n = 0;
    for (const d of destinos) {
      if (d.status === "publicado" && d.plataforma !== "site") continue;
      if (mAcao[2] === "retentar") {
        db.prepare("UPDATE destinos SET status='pendente', tentativas=0, proxima_tentativa=NULL, erro=NULL, atualizado=? WHERE id=?").run(agora(), d.id);
      } else {
        db.prepare("UPDATE destinos SET status='cancelado', atualizado=? WHERE id=?").run(agora(), d.id);
      }
      n++;
    }
    fila.atualizarStatusPost(post.id);
    if (mAcao[2] === "retentar") fila.acordar();
    return json(res, 200, { ok: true, destinos_afetados: n });
  }

  return erro(res, 404, "Rota não encontrada.", { rotas: [
    "GET /api/v1/ping", "GET /api/v1/plataformas", "GET /api/v1/contas",
    "DELETE /api/v1/contas/{id}", "POST /api/v1/conexoes",
    "POST /api/v1/publicacoes", "GET /api/v1/publicacoes/{id}",
    "POST /api/v1/publicacoes/{id}/retentar", "POST /api/v1/publicacoes/{id}/cancelar",
  ] });
}

/* --------------------------- montar a resposta ---------------------------- */
function resumoPublicacao(post, completo = false) {
  const destinos = db.prepare("SELECT * FROM destinos WHERE post_id=? ORDER BY id").all(post.id);
  const saida = {
    id: post.id, origem_ref: post.origem_ref || null, titulo: post.titulo,
    status: post.status, criado: post.criado, atualizado: post.atualizado,
    destinos: destinos.map((d) => ({
      plataforma: d.plataforma, conta_id: d.conta_id, status: d.status,
      url: d.url_externa || null, erro: d.erro || null,
      tentativas: d.tentativas, agendado_para: d.agendado_para || null,
      publicado_em: d.publicado_em || null,
    })),
  };
  if (completo) {
    saida.midias = db.prepare("SELECT arquivo,tipo,mime,largura,altura,duracao,capa FROM midias WHERE post_id=? ORDER BY ordem,id").all(post.id)
      .map((m) => ({ ...m, url: `${fila.urlPublica()}/midia/${m.arquivo}` }));
    saida.logs = db.prepare("SELECT ts,nivel,plataforma,mensagem FROM logs WHERE post_id=? ORDER BY id DESC LIMIT 30").all(post.id);
  }
  return saida;
}

/* ============================ CRIAR PUBLICAÇÃO ============================ */
async function criarPublicacao(res, cliente, corpo, ip) {
  /* ---- idempotência: mesma referência de origem devolve o que já existe --- */
  const ref = String(corpo.origem_ref || "").trim().slice(0, 120);
  if (ref) {
    const ja = db.prepare("SELECT * FROM posts WHERE cliente_id=? AND origem_ref=?").get(cliente.id, ref);
    if (ja) return json(res, 200, { ...resumoPublicacao(ja, true), repetida: true });
  }

  const dados = painel.camposDoPost(corpo);
  if (!dados.titulo) return erro(res, 400, "A publicação precisa de um título.");

  /* ---- destinos: aceita a forma completa ou só a lista de plataformas ---- */
  let pedidos = Array.isArray(corpo.destinos) ? corpo.destinos : [];
  if (!pedidos.length && Array.isArray(corpo.plataformas)) {
    const minhas = contasDoCliente(cliente.id).filter((c) => c.ativo);
    for (const p of corpo.plataformas) {
      const candidatas = minhas.filter((c) => c.plataforma === p);
      if (!candidatas.length) return erro(res, 400, `Não há conta de ${p} vinculada a esta chave.`);
      if (candidatas.length > 1)
        return erro(res, 400, `Há ${candidatas.length} contas de ${p} nesta chave — informe conta_id em "destinos".`,
          { contas: candidatas.map((c) => ({ id: c.id, nome: c.apelido || c.nome })) });
      pedidos.push({ plataforma: p, conta_id: candidatas[0].id, opcoes: (corpo.opcoes && corpo.opcoes[p]) || {} });
    }
  }
  if (!pedidos.length) return erro(res, 400, 'Informe "plataformas": ["instagram"] ou "destinos": [{plataforma, conta_id}].');

  for (const d of pedidos) {
    if (!PLATAFORMAS[d.plataforma]) return erro(res, 400, `Plataforma inválida: ${d.plataforma}`);
    if (!d.conta_id) return erro(res, 400, `Falta conta_id para ${d.plataforma}.`);
    if (!contaPermitida(cliente.id, Number(d.conta_id)))
      return erro(res, 403, `A conta ${d.conta_id} não pertence a esta chave.`);
    const c = db.prepare("SELECT ativo, plataforma FROM contas WHERE id=?").get(d.conta_id);
    if (!c || !c.ativo) return erro(res, 400, `A conta ${d.conta_id} está desativada.`);
    if (c.plataforma !== d.plataforma) return erro(res, 400, `A conta ${d.conta_id} não é de ${d.plataforma}.`);
  }

  const quando = String(corpo.agendado_para || "").trim();
  if (quando && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(quando)) return erro(res, 400, "agendado_para inválido (use 2026-08-08T09:00).");
  const agendadoIso = quando ? new Date(quando).toISOString() : null;
  if (agendadoIso && new Date(agendadoIso).getTime() < Date.now() - 60_000)
    return erro(res, 400, "agendado_para está no passado.");

  let callback = String(corpo.callback_url || cliente.webhook_url || "").trim();
  if (callback) {
    try {
      const c = new URL(callback);
      if (!/^https?:$/.test(c.protocol)) return erro(res, 400, "callback_url precisa ser http ou https.");
      if (cliente.origem && new URL(cliente.origem).origin !== c.origin)
        return erro(res, 400, `A callback_url precisa estar em ${new URL(cliente.origem).origin}.`);
    } catch { return erro(res, 400, "callback_url inválida."); }
  }

  /* ------------------------------ grava --------------------------------- */
  let postId;
  try {
    const info = db.prepare(`INSERT INTO posts(titulo,slug,resumo_html,texto_html,fonte,fonte_url,autor,errata,
      data_publicacao,tipo,status,usuario_id,cliente_id,origem_ref,callback_url,criado,atualizado)
      VALUES(?,?,?,?,?,?,?,?,?,?,'rascunho',NULL,?,?,?,?,?)`)
      .run(dados.titulo, dados.slug, dados.resumo_html, dados.texto_html, dados.fonte, dados.fonte_url,
           dados.autor, dados.errata, dados.data_publicacao, dados.tipo,
           cliente.id, ref || null, callback || null, agora(), agora());
    postId = Number(info.lastInsertRowid);
  } catch (e) {
    /* Corrida: duas chamadas iguais ao mesmo tempo. O índice único segura, e
       devolvemos a que venceu — que é o comportamento idempotente correto. */
    if (/UNIQUE/i.test(e.message) && ref) {
      const ja = db.prepare("SELECT * FROM posts WHERE cliente_id=? AND origem_ref=?").get(cliente.id, ref);
      if (ja) return json(res, 200, { ...resumoPublicacao(ja, true), repetida: true });
    }
    throw e;
  }

  /* ------------------------------ mídia ---------------------------------- */
  const midias = Array.isArray(corpo.midias) ? corpo.midias.slice(0, 20) : [];
  const problemas = [];
  let ordem = 0;
  for (const m of midias) {
    const url = typeof m === "string" ? m : m.url;
    if (!url) continue;
    try {
      const arq = await baixarMidia(url);
      db.prepare(`INSERT INTO midias(post_id,arquivo,tipo,mime,bytes,largura,altura,duracao,alt,ordem,capa,criado)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(postId, arq.arquivo, arq.tipo, arq.mime, arq.bytes, arq.largura, arq.altura, arq.duracao,
             String((m && m.alt) || "").slice(0, 300), ordem,
             (m && m.capa) || (ordem === 0 && arq.tipo === "imagem") ? 1 : 0, agora());
      if (arq.tipo === "video") db.prepare("UPDATE posts SET tipo='video' WHERE id=?").run(postId);
      ordem++;
    } catch (e) { problemas.push(`${url}: ${e.message}`); }
  }
  if (problemas.length && !ordem) {
    db.prepare("DELETE FROM posts WHERE id=?").run(postId);
    return erro(res, 400, "Não consegui baixar nenhuma das mídias.", { detalhes: problemas });
  }

  /* --------------------------- valida as regras -------------------------- */
  const post = db.prepare("SELECT * FROM posts WHERE id=?").get(postId);
  const linhasMidia = db.prepare("SELECT * FROM midias WHERE post_id=? ORDER BY ordem,id").all(postId);
  const recusas = {};
  for (const d of pedidos) {
    const opcoes = { ...(d.opcoes || {}) };
    /* Legenda em branco vira a sugestão a partir do resumo — o site não é
       obrigado a montar texto para cada rede. */
    const R = PLATAFORMAS[d.plataforma];
    if (R.legenda?.max && !String(opcoes.legenda || "").trim() && d.plataforma !== "site")
      opcoes.legenda = legendaPadrao(d.plataforma, post);
    if (d.plataforma === "youtube" && !opcoes.titulo) opcoes.titulo = post.titulo.slice(0, 100);
    for (const [chave, , , extra] of R.campos) {
      if (opcoes[chave] === undefined && extra && extra.padrao !== undefined) opcoes[chave] = extra.padrao;
    }
    d._opcoes = opcoes;
    const v = validarDestino(d.plataforma, opcoes, post, linhasMidia);
    if (v.erros.length) recusas[d.plataforma] = v.erros;
  }
  if (Object.keys(recusas).length) {
    db.prepare("DELETE FROM midias WHERE post_id=?").run(postId);
    db.prepare("DELETE FROM posts WHERE id=?").run(postId);
    return erro(res, 422, "O conteúdo não passa nas regras da plataforma.", { recusas, midia: problemas.length ? problemas : undefined });
  }

  /* ------------------------------ enfileira ------------------------------ */
  for (const d of pedidos) {
    db.prepare(`INSERT INTO destinos(post_id,conta_id,plataforma,status,agendado_para,opcoes,criado,atualizado)
                VALUES(?,?,?,?,?,?,?,?)`)
      .run(postId, d.conta_id, d.plataforma, agendadoIso ? "agendado" : "pendente",
           agendadoIso, JSON.stringify(d._opcoes), agora(), agora());
  }
  fila.atualizarStatusPost(postId);
  auditar({ nome: "api:" + cliente.nome }, agendadoIso ? "api-agendar" : "api-publicar",
    `#${postId} ${dados.titulo} → ${pedidos.map((d) => d.plataforma).join(",")}`, ip);
  registrar("info", `Recebido pela API (${cliente.nome}).`, { postId });
  if (!agendadoIso) fila.acordar();

  const resposta = resumoPublicacao(db.prepare("SELECT * FROM posts WHERE id=?").get(postId), true);
  if (problemas.length) resposta.avisos = problemas;
  return json(res, 201, resposta);
}

/* ==========================================================================
   AUTOATENDIMENTO — página pública /conectar/{token}

   O site gera o link pela API e entrega ao dono da conta. Quem abre não tem
   sessão no LA Publisher: o próprio token é a credencial. Por isso ele é de
   uso único, expira em 30 minutos e some assim que a conta é criada.
   ========================================================================== */
async function rotaConectar(req, res, pathname) {
  const partes = pathname.split("/").filter(Boolean);   // ["conectar", token, ...]
  const token = partes[1] || "";
  const ip = S.clientIp(req);
  if (demais("cx" + ip)) return painel.paginaSimples(res, 429, "Muitas tentativas", "Aguarde um minuto.");

  const cx = db.prepare("SELECT * FROM conexoes WHERE token=?").get(token);
  const cliente = cx ? db.prepare("SELECT * FROM clientes_api WHERE id=?").get(cx.cliente_id) : null;
  const expirado = cx && cx.expira && new Date(cx.expira) < new Date();

  if (!cx || !cliente || cx.status !== "aberto" || expirado)
    return painel.paginaSimples(res, 410, "Link de conexão inválido",
      "Este link já foi usado ou passou de 30 minutos. Peça um novo no painel do seu site.");

  const rotulo = { facebook: "Instagram e Facebook", youtube: "YouTube", tiktok: "TikTok" }[cx.plataforma] || cx.plataforma;

  /* Passo 2: manda para a plataforma. */
  if (partes[2] === "ir") {
    const app = fila.appDe(cx.plataforma);
    if (!app?.client_id) return painel.paginaSimples(res, 503, "App não configurado", "Fale com o administrador do LA Publisher.");
    const state = crypto.randomBytes(24).toString("hex");
    const pend = { plataforma: cx.plataforma, conexaoId: cx.id, clienteId: cliente.id, nomeUsuario: `site:${cliente.nome}`, ts: Date.now() };
    let url;
    if (cx.plataforma === "tiktok") {
      const pkce = tiktok.novoPkce();
      pend.verifier = pkce.verifier;
      url = tiktok.autorizarUrl({ clientId: app.client_id, redirectUri: painel.redirectUri(cx.plataforma), state, extra: { challenge: pkce.challenge } });
    } else if (cx.plataforma === "youtube") {
      url = youtube.autorizarUrl({ clientId: app.client_id, redirectUri: painel.redirectUri(cx.plataforma), state });
    } else {
      url = meta.autorizarUrl({ clientId: app.client_id, redirectUri: painel.redirectUri(cx.plataforma), state, extra: app.extra });
    }
    painel.oauthPendentes.set(state, pend);
    res.writeHead(302, { Location: url, "Cache-Control": "no-store" });
    return res.end();
  }

  /* Passo 1: a página com o botão. */
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow", "Content-Security-Policy": painel.CSP,
  });
  res.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Conectar ${S.esc(rotulo)}</title>
<style>
 *{box-sizing:border-box;margin:0}
 body{font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;min-height:100vh;display:grid;place-items:center;padding:2rem;color:#e9ecfb;
  background:radial-gradient(900px 500px at 15% -10%,rgba(108,92,255,.35),transparent 60%),
             radial-gradient(700px 400px at 110% 110%,rgba(34,211,238,.2),transparent 55%),#0d1020}
 .cx{max-width:460px;background:#171c36;border:1px solid #2a3159;border-radius:18px;padding:2.2rem 2rem;text-align:center}
 .ico{width:42px;height:42px;border-radius:12px;margin:0 auto 1rem;display:grid;place-items:center;
  background:linear-gradient(135deg,#6c5cff,#22d3ee);color:#fff;font-size:1.2rem}
 h1{font-size:1.25rem;margin-bottom:.5rem}
 p{color:#a3abd8;font-size:.94rem;margin-bottom:.8rem}
 .btn{display:inline-block;margin-top:1rem;background:linear-gradient(120deg,#6c5cff,#4b3ce6);color:#fff;
  text-decoration:none;padding:.8rem 1.6rem;border-radius:999px;font-weight:700}
 .nota{margin-top:1.4rem;padding-top:1rem;border-top:1px solid #2a3159;color:#727ba9;font-size:.78rem}
 ul{text-align:left;color:#a3abd8;font-size:.88rem;margin:.6rem 0 0 1.1rem}
 li{margin-bottom:.25rem}
</style></head><body>
<div class="cx">
  <div class="ico">◆</div>
  <h1>Conectar ${S.esc(rotulo)}</h1>
  <p><strong>${S.esc(cliente.nome)}</strong> quer publicar em nome da sua conta.</p>
  <ul>
    <li>Você autoriza direto na plataforma — a senha não passa por aqui.</li>
    <li>O acesso serve só para publicar o conteúdo que você criar no painel.</li>
    <li>Dá para revogar quando quiser, na própria plataforma.</li>
  </ul>
  <a class="btn" href="/conectar/${S.esc(token)}/ir">Autorizar ${S.esc(rotulo)}</a>
  <div class="nota">Este link vale uma vez só e expira em 30 minutos.<br>
    <a href="/privacidade" style="color:#727ba9">Política de privacidade</a></div>
</div></body></html>`);
}

/* Chamado pelo painel.js quando o OAuth volta de uma conexão de
   autoatendimento: amarra as contas ao cliente e diz para onde voltar. */
function concluirConexao(conexaoId, contaIds) {
  const cx = db.prepare("SELECT * FROM conexoes WHERE id=?").get(conexaoId);
  if (!cx) return null;
  const liga = db.prepare("INSERT OR IGNORE INTO clientes_contas(cliente_id,conta_id,criado) VALUES(?,?,?)");
  for (const id of contaIds) liga.run(cx.cliente_id, id, agora());
  db.prepare("UPDATE conexoes SET status='usado', usado_em=?, contas=? WHERE id=?")
    .run(agora(), JSON.stringify(contaIds), conexaoId);
  const cliente = db.prepare("SELECT nome, webhook_url FROM clientes_api WHERE id=?").get(cx.cliente_id);
  registrar("ok", `Conta(s) conectada(s) pelo site ${cliente?.nome || cx.cliente_id}.`);
  if (cliente?.webhook_url) {
    enfileirarWebhook(cx.cliente_id, cliente.webhook_url, "conta.conectada",
      { contas: contaIds.map((id) => { const c = db.prepare("SELECT id,plataforma,nome FROM contas WHERE id=?").get(id); return c; }) });
  }
  return { retorno_url: cx.retorno_url, cliente: cliente?.nome };
}

module.exports = { handleApi, enfileirarWebhook, concluirConexao, contasDoCliente, contaPermitida, baixarMidia, ipPrivado };
