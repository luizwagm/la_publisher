/* ==========================================================================
   plataformas/site.js — conector para os sites feitos no nosso gerador
   (BemEstarClinic, Forms Fitness, Daniel's, Imobiliária, Instituto Kenósis…)

   Todos eles têm a MESMA tabela de blog:
       posts(id, title, slug, excerpt, content, image, date, sort)
   e um botão "Publicar" que regenera as páginas estáticas. Então o conector é
   um só e serve para todos: o que muda é a URL e o segredo de cada site.

   AUTENTICAÇÃO — por que não um token simples no cabeçalho:
   um token estático que vaza no log do nginx do cliente publicaria matéria no
   site dele para sempre. Aqui assinamos com HMAC-SHA256 o par
   (timestamp + corpo). O segredo NUNCA viaja, a assinatura muda a cada envio
   e o site recusa qualquer coisa com mais de 5 minutos — replay não cola.

   Do lado do site é preciso instalar `conector/lapublisher.js` (3 linhas no
   server.js). Está tudo no conector/INSTALAR.md.
   ========================================================================== */
const crypto = require("node:crypto");
const { pedir, ErroApi } = require("./http");

const CAMINHO = "/api/lapublisher";

function assinar(segredo, ts, corpo) {
  return "sha256=" + crypto.createHmac("sha256", String(segredo)).update(`${ts}.${corpo}`).digest("hex");
}

async function enviar(conta, rota, dados) {
  const base = String(conta.meta?.url || "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base))
    throw new ErroApi("Site sem URL válida cadastrada.", { status: 400, plataforma: "site", permanente: true });

  const corpo = JSON.stringify(dados);
  const ts = Math.floor(Date.now() / 1000);
  return pedir(`${base}${CAMINHO}${rota}`, {
    metodo: "POST", plataforma: "site", timeout: 120_000,
    cabecalhos: {
      "Content-Type": "application/json; charset=utf-8",
      "X-LAP-Timestamp": String(ts),
      "X-LAP-Assinatura": assinar(conta.token, ts, corpo),
      "User-Agent": "LA-Publisher",
    },
    corpo,
  });
}

async function publicar({ conta, post, opcoes, midias, urlDe }) {
  const capa = midias.find((m) => m.capa && m.tipo === "imagem")
    || midias.find((m) => m.tipo === "imagem");

  const r = await enviar(conta, "/receber", {
    titulo: post.titulo,
    slug: opcoes.slug || post.slug || "",
    resumo_html: post.resumo_html || "",
    texto_html: post.texto_html || "",
    imagem_url: capa ? urlDe(capa) : "",
    imagem_alt: capa?.alt || post.titulo || "",
    galeria: midias.filter((m) => m.tipo === "imagem" && m !== capa).map((m) => ({ url: urlDe(m), alt: m.alt || "" })),
    video_url: (midias.find((m) => m.tipo === "video") && urlDe(midias.find((m) => m.tipo === "video"))) || "",
    /* Quando o vídeo também foi para o YouTube, o site prefere o embed —
       quem preenche isto é a fila, depois que o YouTube responde. */
    video_youtube: opcoes.video_youtube || "",
    data: post.data_publicacao || new Date().toISOString().slice(0, 10),
    autor: post.autor || "",
    fonte: post.fonte || "",
    fonte_url: post.fonte_url || "",
    errata: post.errata || "",
    destaque: !!opcoes.destaque,
    publicar: opcoes.publicar_agora !== false,
    origem_id: post.id,
  });

  if (!r?.ok) throw new ErroApi(r?.error || "O site recusou a matéria.", { status: 400, plataforma: "site" });
  return { externo_id: String(r.id || ""), url: r.url || "", aviso: r.aviso || null };
}

async function verificar({ conta }) {
  const r = await enviar(conta, "/ping", { ping: true });
  if (!r?.ok) throw new ErroApi("O site respondeu, mas recusou a assinatura.", { status: 401, plataforma: "site" });
  return { ok: true, nome: r.site || conta.nome, versao: r.versao || "", posts: r.posts ?? null };
}

/* Gera um segredo novo para cadastrar no site. */
const novoSegredo = () => crypto.randomBytes(32).toString("hex");

module.exports = { publicar, verificar, novoSegredo, assinar, CAMINHO };
