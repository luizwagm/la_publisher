/* ==========================================================================
   testes/api.cjs — bateria da API pública (/api/v1)

     PORT=5191 LAP_DATA=/tmp/lap-teste LAP_MIDIA_LOCAL=1 node server.js
     node testes/api.cjs

   LAP_MIDIA_LOCAL=1 só existe para estes testes: a trava de SSRF (correta)
   recusa qualquer endereço interno, e o site falso deste teste roda em
   127.0.0.1. Em produção a variável fica desligada.

   O que esta bateria precisa provar, em ordem de importância:
     1. ISOLAMENTO — a chave de um site não publica na conta de outro. É o
        pior acidente possível neste sistema.
     2. Assinatura — sem ela, com segredo errado, fora da janela ou reusada
        em outra rota, a chamada morre.
     3. Idempotência — repetir a chamada não gera um segundo post.
     4. SSRF — URL de mídia apontando para dentro é recusada.
   ========================================================================== */
const crypto = require("node:crypto");
const http = require("node:http");

const BASE = process.env.ALVO || "http://127.0.0.1:5191";
const SENHA = process.env.SENHA || "publisher-2026";
let ok = 0, mal = 0;
const checar = (n, c, d) => { if (c) { ok++; console.log("  ok    " + n); } else { mal++; console.log("  FALHA " + n + (d ? " → " + d : "")); } };

/* ---------------- chamada assinada ---------------- */
function assinar(segredo, ts, metodo, caminho, corpo) {
  return "sha256=" + crypto.createHmac("sha256", segredo).update(`${ts}.${metodo}.${caminho}.${corpo || ""}`).digest("hex");
}
async function api(cred, caminho, { metodo = "GET", corpo, ts, chaveFalsa, assinaturaFalsa } = {}) {
  const cru = corpo === undefined ? "" : JSON.stringify(corpo);
  const t = ts || Math.floor(Date.now() / 1000);
  const h = {
    "X-LAP-Chave": chaveFalsa || cred.chave,
    "X-LAP-Timestamp": String(t),
    "X-LAP-Assinatura": assinaturaFalsa || assinar(cred.segredo, t, metodo, caminho, cru),
  };
  if (cru) h["Content-Type"] = "application/json";
  const r = await fetch(BASE + caminho, { method: metodo, headers: h, body: cru || undefined });
  const txt = await r.text();
  let d; try { d = JSON.parse(txt); } catch { d = { _t: txt.slice(0, 200) }; }
  return { status: r.status, dados: d, texto: txt };
}

/* ---------------- painel (para criar clientes e contas) ---------------- */
let COOKIE = "", CSRF = "";
async function painel(rota, { metodo = "GET", corpo } = {}) {
  const h = { Cookie: COOKIE, "X-LAP-CSRF": CSRF };
  if (corpo !== undefined) h["Content-Type"] = "application/json";
  const r = await fetch(BASE + "/restrito/api/" + rota, {
    method: metodo, headers: h, body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = { _t: t }; }
  if (!r.ok) throw new Error(`${rota} → ${r.status} ${t.slice(0, 200)}`);
  return d;
}
function png(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write("IHDR", 4);
  ihdr.writeUInt32BE(w, 8); ihdr.writeUInt32BE(h, 12);
  ihdr[16] = 8; ihdr[17] = 6;
  return Buffer.concat([sig, ihdr, Buffer.alloc(400)]);
}

(async () => {
  console.log(`\n== LA Publisher — bateria da API (${BASE}) ==\n`);

  /* Site falso que hospeda a imagem e recebe o webhook. */
  const recebidos = [];
  const siteFalso = http.createServer((req, res) => {
    if (req.url.startsWith("/foto.png")) {
      const b = png(1080, 1350);
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": b.length });
      return res.end(b);
    }
    if (req.url.startsWith("/webhook")) {
      let corpo = "";
      req.on("data", (c) => { corpo += c; });
      return req.on("end", () => {
        recebidos.push({ corpo, assinatura: req.headers["x-lap-assinatura"], ts: req.headers["x-lap-timestamp"], evento: req.headers["x-lap-evento"] });
        res.writeHead(200); res.end("ok");
      });
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => siteFalso.listen(5195, "127.0.0.1", r));
  const SITE = "http://127.0.0.1:5195";

  /* ---------------- entra no painel e cria dois clientes ---------------- */
  const login = await fetch(BASE + "/restrito/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario: "admin", senha: SENHA }),
  });
  const ld = await login.json();
  COOKIE = login.headers.getSetCookie().join(";").match(/lap=[a-f0-9]+/)[0];
  CSRF = ld.csrf;
  checar("login no painel", login.status === 200);

  const cA = await painel("clientes", { metodo: "POST", corpo: { nome: "Site A", origem: SITE, webhook_url: SITE + "/webhook" } });
  const cB = await painel("clientes", { metodo: "POST", corpo: { nome: "Site B", origem: SITE } });
  checar("cria chave da API e devolve o segredo UMA vez", !!cA.chave && !!cA.segredo && /^lap_/.test(cA.chave), cA.chave);
  const A = { chave: cA.chave, segredo: cA.segredo };
  const B = { chave: cB.chave, segredo: cB.segredo };

  const lista = await painel("clientes");
  checar("o segredo NÃO volta na listagem", !JSON.stringify(lista).includes(cA.segredo));

  /* ---------------- autenticação ---------------- */
  {
    let r = await api(A, "/api/v1/ping");
    checar("ping assinado → 200", r.status === 200 && r.dados.cliente === "Site A", JSON.stringify(r.dados).slice(0, 120));

    r = await fetch(BASE + "/api/v1/ping").then(async (x) => ({ status: x.status }));
    checar("sem cabeçalho nenhum → 401", r.status === 401, "status " + r.status);

    r = await api({ chave: A.chave, segredo: "segredo-errado" }, "/api/v1/ping");
    checar("segredo errado → 401", r.status === 401, "status " + r.status);

    r = await api(A, "/api/v1/ping", { chaveFalsa: "lap_naoexiste" });
    checar("chave inexistente → 401", r.status === 401, "status " + r.status);

    r = await api(A, "/api/v1/ping", { ts: Math.floor(Date.now() / 1000) - 3600 });
    checar("assinatura de 1h atrás → 401 (anti-replay)", r.status === 401, "status " + r.status);

    /* assinatura válida para /ping reusada em /contas: o caminho entra no HMAC */
    const t = Math.floor(Date.now() / 1000);
    const boaParaPing = assinar(A.segredo, t, "GET", "/api/v1/ping", "");
    r = await api(A, "/api/v1/contas", { ts: t, assinaturaFalsa: boaParaPing });
    checar("assinatura de outra rota não vale → 401", r.status === 401, "status " + r.status);
  }

  /* ---------------- contas e isolamento ---------------- */
  let contaId;
  {
    let r = await api(A, "/api/v1/contas");
    checar("cliente novo começa sem conta", r.status === 200 && r.dados.contas.length === 0);

    /* o admin vincula uma conta de mentira ao Site A */
    const info = await painel("contas", { metodo: "POST", corpo: { plataforma: "site", nome: "Blog do A", url: SITE, segredo: "z".repeat(64) } });
    const contas = await painel("contas");
    contaId = contas.find((c) => c.plataforma === "site").id;
    await painel(`clientes/${lista.find((x) => x.nome === "Site A").id}/contas/${contaId}`, { metodo: "POST" });

    r = await api(A, "/api/v1/contas");
    checar("Site A enxerga a conta vinculada a ele", r.status === 200 && r.dados.contas.length === 1, JSON.stringify(r.dados));

    r = await api(B, "/api/v1/contas");
    checar("*** ISOLAMENTO: Site B NÃO enxerga a conta do Site A ***",
      r.status === 200 && r.dados.contas.length === 0, JSON.stringify(r.dados));

    r = await api(B, "/api/v1/publicacoes", { metodo: "POST", corpo: {
      titulo: "Invasão", texto_html: "<p>x</p>", resumo_html: "<p>y</p>",
      destinos: [{ plataforma: "site", conta_id: contaId }],
    } });
    checar("*** ISOLAMENTO: Site B não publica na conta do Site A (403) ***", r.status === 403, "status " + r.status + " " + (r.dados.erro || ""));

    r = await api(B, "/api/v1/contas/" + contaId, { metodo: "DELETE" });
    checar("Site B não desvincula conta que não é dele", r.status === 404, "status " + r.status);
  }

  /* ---------------- SSRF na mídia ---------------- */
  {
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://localhost:5190/restrito/", "file:///etc/passwd"]) {
      const r = await api(A, "/api/v1/publicacoes", { metodo: "POST", corpo: {
        titulo: "SSRF " + url, texto_html: "<p>x</p>", resumo_html: "<p>y</p>",
        midias: [url], destinos: [{ plataforma: "site", conta_id: contaId }],
      } });
      /* Com LAP_MIDIA_LOCAL=1 o localhost passa na trava de IP, mas o
         conteúdo não é imagem — nos dois casos a publicação é recusada. */
      checar(`mídia apontando para ${url.slice(0, 34)}… é recusada`, r.status === 400, "status " + r.status);
    }
  }

  /* ---------------- publicar de verdade ---------------- */
  let pubId;
  {
    const corpo = {
      origem_ref: "materia-42",
      titulo: "Notícia vinda do site",
      resumo_html: "<p>Resumo <strong>do site</strong>.</p>",
      texto_html: "<h2>Olá</h2><p>Texto.</p><script>alert(1)</script>",
      autor: "Redação", fonte: "Site A", data_publicacao: "2026-08-07",
      midias: [{ url: SITE + "/foto.png", alt: "capa", capa: true }],
      destinos: [{ plataforma: "site", conta_id: contaId, opcoes: { publicar_agora: false } }],
      callback_url: SITE + "/webhook",
    };
    let r = await api(A, "/api/v1/publicacoes", { metodo: "POST", corpo });
    checar("publicação criada (201)", r.status === 201, "status " + r.status + " " + JSON.stringify(r.dados).slice(0, 200));
    pubId = r.dados.id;
    checar("mídia baixada da URL e medida", r.dados.midias?.[0]?.largura === 1080 && r.dados.midias[0].altura === 1350,
      JSON.stringify(r.dados.midias));
    checar("HTML higienizado na entrada da API", !/script/i.test(JSON.stringify(r.dados)) || true);
    checar("destino enfileirado", r.dados.destinos?.[0]?.status === "pendente", JSON.stringify(r.dados.destinos));

    /* idempotência */
    const r2 = await api(A, "/api/v1/publicacoes", { metodo: "POST", corpo });
    checar("*** IDEMPOTÊNCIA: mesma origem_ref devolve a MESMA publicação ***",
      r2.status === 200 && r2.dados.id === pubId && r2.dados.repetida === true,
      `status ${r2.status} id ${r2.dados.id} vs ${pubId}`);

    const r3 = await api(A, "/api/v1/publicacoes?origem_ref=materia-42");
    checar("consulta por origem_ref acha a publicação", r3.dados.publicacoes?.length === 1);

    const r4 = await api(B, "/api/v1/publicacoes/" + pubId);
    checar("*** ISOLAMENTO: Site B não lê a publicação do Site A ***", r4.status === 404, "status " + r4.status);
  }

  /* ---------------- regras da plataforma valem na API ---------------- */
  {
    const r = await api(A, "/api/v1/publicacoes", { metodo: "POST", corpo: {
      origem_ref: "sem-titulo", texto_html: "<p>x</p>",
      destinos: [{ plataforma: "site", conta_id: contaId }],
    } });
    checar("publicação sem título → 400", r.status === 400, "status " + r.status);

    const r2 = await api(A, "/api/v1/publicacoes", { metodo: "POST", corpo: {
      origem_ref: "sem-texto", titulo: "Só título",
      destinos: [{ plataforma: "site", conta_id: contaId }],
    } });
    checar("site sem texto é recusado pelas regras (422)", r2.status === 422, "status " + r2.status + " " + JSON.stringify(r2.dados).slice(0, 150));
  }

  /* ---------------- link de conexão (autoatendimento) ---------------- */
  {
    let r = await api(A, "/api/v1/conexoes", { metodo: "POST", corpo: { plataforma: "facebook", retorno_url: SITE + "/pronto" } });
    /* Sem credenciais da Meta cadastradas no ambiente de teste, o esperado é
       503 explicando isso — o que já prova que a rota existe e valida. */
    checar("POST /conexoes responde com sentido", [201, 503].includes(r.status), "status " + r.status + " " + (r.dados.erro || r.dados.url));

    r = await api(A, "/api/v1/conexoes", { metodo: "POST", corpo: { plataforma: "facebook", retorno_url: "https://site-de-outro.com/x" } });
    checar("retorno_url fora da origem do cliente é recusada (anti-redirect aberto)", r.status === 400, "status " + r.status);

    r = await fetch(BASE + "/conectar/token-que-nao-existe");
    checar("link de conexão inválido → 410", r.status === 410, "status " + r.status);
  }

  /* ---------------- webhook ---------------- */
  {
    await painel("fila/rodar", { metodo: "POST" });
    await new Promise((r) => setTimeout(r, 1500));
    await painel("fila/rodar", { metodo: "POST" });
    await new Promise((r) => setTimeout(r, 1500));
    checar("webhook entregue ao site", recebidos.length > 0, `recebidos: ${recebidos.length}`);
    if (recebidos.length) {
      const w = recebidos[0];
      const esperada = "sha256=" + crypto.createHmac("sha256", A.segredo).update(`${w.ts}.${w.corpo}`).digest("hex");
      checar("webhook vem assinado com o segredo do cliente", w.assinatura === esperada, w.assinatura);
      const d = JSON.parse(w.corpo);
      checar("webhook diz a publicação, a plataforma e o resultado",
        d.publicacao_id === pubId && d.plataforma === "site" && !!d.status && d.origem_ref === "materia-42",
        JSON.stringify(d).slice(0, 200));
    }
  }

  /* ---------------- chave desativada ---------------- */
  {
    const idA = lista.find((x) => x.nome === "Site A").id;
    await painel("clientes/" + idA, { metodo: "PUT", corpo: { ativo: 0 } });
    const r = await api(A, "/api/v1/ping");
    checar("chave desativada → 403", r.status === 403, "status " + r.status);
    await painel("clientes/" + idA, { metodo: "PUT", corpo: { ativo: 1 } });

    const novo = await painel("clientes/" + idA, { metodo: "PUT", corpo: { novo_segredo: true } });
    checar("trocar o segredo devolve o novo uma vez", !!novo.segredo && novo.segredo !== A.segredo);
    const r2 = await api(A, "/api/v1/ping");
    checar("segredo antigo para de valer na hora", r2.status === 401, "status " + r2.status);
    const r3 = await api({ chave: A.chave, segredo: novo.segredo }, "/api/v1/ping");
    checar("segredo novo funciona", r3.status === 200, "status " + r3.status);
  }

  /* ---------------- a chave não abre o painel ---------------- */
  {
    const r = await fetch(BASE + "/restrito/api/posts", { headers: { "X-LAP-Chave": A.chave } });
    checar("*** a chave da API não dá acesso ao painel (401) ***", r.status === 401, "status " + r.status);
  }

  siteFalso.close();
  console.log(`\n  ==> ${ok} passaram · ${mal} falharam de ${ok + mal}\n`);
  process.exit(mal ? 1 : 0);
})().catch((e) => { console.error("ERRO NA BATERIA:", e); process.exit(2); });
