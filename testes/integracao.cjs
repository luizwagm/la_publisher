/* ==========================================================================
   testes/integracao.cjs — ponta a ponta: o LA Publisher publica DE VERDADE
   num site do gerador (o site-falso, com o conector instalado).

   Sobe os dois e roda:
     PORT=5191 LAP_DATA=/tmp/lap-teste node server.js
     node testes/site-falso.cjs                        # imprime SEGREDO=…
     node testes/integracao.cjs <segredo>

   Prova o que nenhum teste unitário prova: assinatura HMAC aceita e recusada,
   janela anti-replay, mídia baixada pelo site, errata e fonte no lugar certo,
   reenvio que atualiza em vez de duplicar, agendamento e conta desativada.
   ========================================================================== */
const PUB = process.env.PUB || "http://127.0.0.1:5191";
const SITE = process.env.SITE || "http://127.0.0.1:5192";
const SEGREDO = process.argv[2];
const SENHA = process.env.SENHA || "publisher-2026";
if (!SEGREDO) { console.error("Uso: node testes/integracao.cjs <segredo do site-falso>"); process.exit(2); }

const crypto = require("node:crypto");
let COOKIE = "", CSRF = "";
let ok = 0, mal = 0;
const checar = (n, c, d) => { if (c) { ok++; console.log("  ok    " + n); } else { mal++; console.log("  FALHA " + n + (d ? " → " + d : "")); } };

async function api(rota, { metodo = "GET", corpo } = {}) {
  const h = { Cookie: COOKIE, "X-LAP-CSRF": CSRF };
  if (corpo !== undefined) h["Content-Type"] = "application/json";
  const r = await fetch(PUB + "/restrito/api/" + rota, {
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
  return Buffer.concat([sig, ihdr, Buffer.alloc(500)]);
}
const assinar = (segredo, ts, corpo) =>
  "sha256=" + crypto.createHmac("sha256", segredo).update(`${ts}.${corpo}`).digest("hex");

(async () => {
  console.log("\n== Integração: publicar num site do gerador ==\n");

  const login = await fetch(PUB + "/restrito/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario: "admin", senha: SENHA }),
  });
  const ld = await login.json();
  COOKIE = login.headers.getSetCookie().join(";").match(/lap=[a-f0-9]+/)[0];
  CSRF = ld.csrf;
  checar("login no publisher", login.status === 200);

  await api("config", { metodo: "PUT", corpo: { url_publica: PUB } });
  checar("endereço público configurado", (await api("config")).url_publica === PUB);

  await api("contas", { metodo: "POST", corpo: { plataforma: "site", nome: "Site Falso", url: SITE, segredo: SEGREDO } });
  const conta = (await api("contas")).find((c) => c.plataforma === "site");
  checar("site cadastrado como conta", !!conta);

  const teste = await api(`contas/${conta.id}/verificar`, { metodo: "POST" });
  checar("ping assinado é aceito pelo site", teste.ok === true, JSON.stringify(teste));

  /* --- a porta do site tem de resistir a quem não sabe o segredo --- */
  {
    const ts = Math.floor(Date.now() / 1000), corpo = JSON.stringify({ ping: true });
    const chamar = (t, seg) => fetch(SITE + "/api/lapublisher/ping", {
      method: "POST", body: corpo,
      headers: { "Content-Type": "application/json", "X-LAP-Timestamp": String(t), "X-LAP-Assinatura": assinar(seg, t, corpo) },
    });
    checar("site recusa assinatura com segredo errado (401)", (await chamar(ts, "segredo-errado")).status === 401);
    checar("site recusa assinatura fora da janela de tempo (replay)", (await chamar(ts - 3600, SEGREDO)).status === 401);
    const semNada = await fetch(SITE + "/api/lapublisher/ping", { method: "POST", body: corpo, headers: { "Content-Type": "application/json" } });
    checar("site recusa requisição sem assinatura", semNada.status === 401);
  }

  const post = await api("posts", {
    metodo: "POST", corpo: {
      titulo: "Matéria de teste do LA Publisher",
      resumo_html: "<p>Resumo <strong>formatado</strong>.</p>",
      texto_html: '<h2>Subtítulo</h2><p>Texto com <a href="https://exemplo.com" target="_blank">link</a>.</p><script>alert(1)</script>',
      autor: "Redação", fonte: "Agência Teste", fonte_url: "https://exemplo.com/origem",
      errata: "Onde se lia 3, leia-se 4.", data_publicacao: "2026-07-26",
    },
  });
  checar("matéria criada", !!post.id);

  const up = await fetch(`${PUB}/restrito/api/posts/${post.id}/midia`, {
    method: "POST", body: png(1200, 800),
    headers: { Cookie: COOKIE, "X-LAP-CSRF": CSRF, "Content-Type": "image/png", "X-Nome": "capa.png" },
  });
  checar("imagem enviada", up.status === 200, "status " + up.status);

  await api(`posts/${post.id}/publicar`, { metodo: "POST",
    corpo: { destinos: [{ plataforma: "site", conta_id: conta.id, opcoes: { publicar_agora: true, destaque: true } }] } });
  const r = await api("fila/rodar", { metodo: "POST" });
  checar("fila processou 1 destino", r.processados === 1, "processados " + r.processados);

  const depois = await api("posts/" + post.id);
  const dest = depois.destinos[0];
  checar("destino marcado como publicado", dest.status === "publicado", dest.status + " · " + (dest.erro || ""));
  checar("URL da matéria devolvida pelo site", /^\/blog\//.test(dest.url_externa || ""), dest.url_externa);
  checar("status do post virou publicado", depois.status === "publicado", depois.status);

  const espiar = await (await fetch(SITE + "/espiar")).json();
  const p = espiar.posts[0];
  checar("site gravou a matéria", !!p, JSON.stringify(espiar).slice(0, 200));
  checar("site rodou o Publicar", espiar.publicou === 1, "publicou " + espiar.publicou);
  checar("título chegou íntegro", p.title === "Matéria de teste do LA Publisher", p.title);
  checar("slug gerado", p.slug === "materia-de-teste-do-la-publisher", p.slug);
  checar("resumo virou texto puro para a listagem", p.excerpt === "Resumo formatado.", p.excerpt);
  checar("texto manteve a formatação", /<h2>Subtítulo<\/h2>/.test(p.content));
  checar("script não sobreviveu à viagem", !/<script/i.test(p.content), p.content.slice(0, 200));
  checar("errata publicada no fim da matéria", /post-errata/.test(p.content) && /leia-se 4/.test(p.content));
  checar("fonte publicada com link", /post-fonte/.test(p.content) && /exemplo\.com\/origem/.test(p.content));
  checar("imagem baixada para o próprio site", /^\/assets\/img\/uploads\/lap-.*\.png$/.test(p.image || ""), p.image);
  checar("data preservada", p.date === "2026-07-26", p.date);
  checar("destaque virou sort -1", p.sort === -1, "sort " + p.sort);

  /* reenviar ao site ATUALIZA (é assim que sai uma errata) */
  await api("posts/" + post.id, { metodo: "PUT",
    corpo: { titulo: "Matéria de teste do LA Publisher", errata: "Corrigido o nome da fonte." } });
  await api(`destinos/${dest.id}/retentar`, { metodo: "POST" });
  await api("fila/rodar", { metodo: "POST" });
  const espiar2 = await (await fetch(SITE + "/espiar")).json();
  checar("reenvio ao site ATUALIZA em vez de duplicar", espiar2.posts.length === 1, espiar2.posts.length + " posts");
  checar("errata nova chegou na atualização", /Corrigido o nome da fonte/.test(espiar2.posts[0].content));

  /* agendamento */
  {
    const p2 = await api("posts", { metodo: "POST", corpo: { titulo: "Agendada", texto_html: "<p>x</p>", resumo_html: "<p>y</p>" } });
    const amanha = new Date(Date.now() + 864e5).toISOString().slice(0, 16);
    await api(`posts/${p2.id}/publicar`, { metodo: "POST",
      corpo: { destinos: [{ plataforma: "site", conta_id: conta.id, opcoes: {} }], agendado_para: amanha } });
    const rr = await api("fila/rodar", { metodo: "POST" });
    checar("agendado para amanhã NÃO publica agora", rr.processados === 0, "processados " + rr.processados);
    checar("post fica com status agendado", (await api("posts/" + p2.id)).status === "agendado");
    const passado = await api(`posts/${p2.id}/publicar`, { metodo: "POST",
      corpo: { destinos: [{ plataforma: "site", conta_id: conta.id, opcoes: {} }], agendado_para: "2020-01-01T10:00" } }).catch((e) => e);
    checar("agendar no passado é recusado", passado instanceof Error, String(passado).slice(0, 80));
  }

  /* conta desativada não publica */
  {
    await api("contas/" + conta.id, { metodo: "PUT", corpo: { ativo: 0 } });
    const p3 = await api("posts", { metodo: "POST", corpo: { titulo: "Com conta off", texto_html: "<p>x</p>", resumo_html: "<p>y</p>" } });
    const e = await api(`posts/${p3.id}/publicar`, { metodo: "POST",
      corpo: { destinos: [{ plataforma: "site", conta_id: conta.id, opcoes: {} }] } }).catch((x) => x);
    checar("conta desativada não aceita publicação", e instanceof Error, String(e).slice(0, 80));
    await api("contas/" + conta.id, { metodo: "PUT", corpo: { ativo: 1 } });
  }

  /* conta que já publicou não some do histórico */
  {
    const e = await api("contas/" + conta.id, { metodo: "DELETE" }).catch((x) => x);
    checar("conta com histórico não pode ser excluída (409)", e instanceof Error && /409/.test(String(e)), String(e).slice(0, 100));
  }

  console.log(`\n  ==> ${ok} passaram · ${mal} falharam de ${ok + mal}\n`);
  process.exit(mal ? 1 : 0);
})().catch((e) => { console.error("ERRO:", e); process.exit(2); });
