/* ==========================================================================
   plataformas/youtube.js — YouTube Data API v3 (upload resumable)

   Pontos de atenção:
   · access_type=offline + prompt=consent é o que faz o Google devolver o
     refresh_token. Sem isso a conexão morre em 1 hora e não tem como renovar.
   · O upload é "resumable": primeiro um POST com os metadados, que responde
     um Location; o arquivo vai por PUT nessa URL. Fazemos em uma tirada só
     (o arquivo está no nosso disco, não há rede instável no meio).
   · COTA: 10.000 unidades/dia e cada upload custa 1.600 → ~6 vídeos por dia
     por projeto do Google Cloud. Estourou, o erro é quotaExceeded e a fila
     reagenda para o dia seguinte em vez de ficar batendo.
   · Shorts não têm endpoint próprio: é vídeo vertical de até 3 min. O que
     "marca" é o formato + a hashtag #Shorts no título/descrição.
   ========================================================================== */
const fs = require("node:fs");
const { pedir, form, comQuery, ErroApi } = require("./http");

const ESCOPOS = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

function autorizarUrl({ clientId, redirectUri, state }) {
  return comQuery("https://accounts.google.com/o/oauth2/v2/auth", {
    client_id: clientId, redirect_uri: redirectUri, response_type: "code",
    scope: ESCOPOS.join(" "), access_type: "offline", prompt: "consent",
    include_granted_scopes: "true", state,
  });
}

async function trocarCodigo({ clientId, clientSecret, redirectUri, code }) {
  const t = await pedir("https://oauth2.googleapis.com/token", {
    metodo: "POST", plataforma: "youtube",
    cabecalhos: { "Content-Type": "application/x-www-form-urlencoded" },
    corpo: form({ client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri }),
  });
  if (!t.refresh_token)
    throw new ErroApi("O Google não devolveu refresh_token. Remova o acesso do app em myaccount.google.com/permissions e conecte de novo.",
      { status: 400, plataforma: "youtube", permanente: true });

  const canais = await pedir(comQuery("https://www.googleapis.com/youtube/v3/channels", {
    part: "snippet,contentDetails", mine: "true",
  }), { plataforma: "youtube", cabecalhos: { Authorization: `Bearer ${t.access_token}` } });

  const c = canais.items?.[0];
  if (!c) throw new ErroApi("Nenhum canal do YouTube nesta conta Google.", { status: 400, plataforma: "youtube", permanente: true });

  return {
    contas: [{
      plataforma: "youtube", externo_id: c.id, nome: c.snippet?.title || "Canal",
      token: t.access_token, refresh: t.refresh_token,
      expira: new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString(),
      escopos: t.scope || ESCOPOS.join(" "),
      meta: { channel_id: c.id, handle: c.snippet?.customUrl || "" },
    }],
  };
}

async function renovar({ clientId, clientSecret, refresh }) {
  const t = await pedir("https://oauth2.googleapis.com/token", {
    metodo: "POST", plataforma: "youtube",
    cabecalhos: { "Content-Type": "application/x-www-form-urlencoded" },
    corpo: form({ client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: "refresh_token" }),
  });
  return { token: t.access_token, expira: new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString() };
}

async function publicar({ conta, post, opcoes, midias, caminhoDe }) {
  const video = midias.find((m) => m.tipo === "video");
  if (!video) throw new ErroApi("YouTube: o post não tem vídeo.", { status: 400, plataforma: "youtube", permanente: true });

  const caminho = caminhoDe(video);
  const tamanho = fs.statSync(caminho).size;

  let titulo = String(opcoes.titulo || post.titulo || "Vídeo").replace(/[<>]/g, "").slice(0, 100);
  let descricao = String(opcoes.descricao || "").slice(0, 5000);
  if (opcoes.short) {
    /* #Shorts é o sinal que o YouTube lê. Só entra se couber no limite. */
    if (!/#shorts/i.test(titulo) && titulo.length <= 92) titulo += " #Shorts";
    if (!/#shorts/i.test(descricao)) descricao = (descricao + "\n\n#Shorts").slice(0, 5000);
  }
  const tags = String(opcoes.tags || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 30);

  const corpo = {
    snippet: {
      title: titulo, description: descricao, tags,
      categoryId: String(opcoes.categoria || "22"),
      defaultLanguage: "pt-BR", defaultAudioLanguage: "pt-BR",
    },
    status: {
      privacyStatus: ["public", "unlisted", "private"].includes(opcoes.privacidade) ? opcoes.privacidade : "public",
      selfDeclaredMadeForKids: opcoes.feito_para_criancas === "sim" || opcoes.feito_para_criancas === true,
      embeddable: true, license: "youtube",
    },
  };
  /* Agendamento nativo do YouTube: publishAt só vale com privacidade private
     (é assim que o YouTube trata "programado"). Quando o operador agenda pelo
     sistema, a fila é quem segura — este campo só é usado se ele pedir
     explicitamente a estreia programada. */
  if (opcoes.estrear_em) { corpo.status.privacyStatus = "private"; corpo.status.publishAt = opcoes.estrear_em; }

  /* 1) inicia o upload resumable */
  const inicio = await pedir(comQuery("https://www.googleapis.com/upload/youtube/v3/videos", {
    uploadType: "resumable", part: "snippet,status",
  }), {
    metodo: "POST", plataforma: "youtube", cru: true,
    cabecalhos: {
      Authorization: `Bearer ${conta.token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(tamanho),
      "X-Upload-Content-Type": video.mime || "video/mp4",
    },
    corpo: JSON.stringify(corpo),
  });
  if (!inicio.ok) {
    const t = await inicio.text();
    const cotaEstourou = /quotaExceeded|uploadLimitExceeded/i.test(t);
    throw new ErroApi(cotaEstourou
      ? "Cota diária do YouTube esgotada (o padrão do Google permite ~6 uploads por dia)."
      : `O YouTube recusou os dados do vídeo (HTTP ${inicio.status}).`,
      { status: inicio.status, detalhe: t.slice(0, 2000), plataforma: "youtube", permanente: !cotaEstourou });
  }
  const destino = inicio.headers.get("location");
  if (!destino) throw new ErroApi("O YouTube não devolveu a URL de upload.", { status: 502, plataforma: "youtube", permanente: false });

  /* 2) envia o arquivo */
  const envio = await pedir(destino, {
    metodo: "PUT", plataforma: "youtube", cru: true, timeout: 3600_000,
    cabecalhos: { "Content-Type": video.mime || "video/mp4", "Content-Length": String(tamanho) },
    corpo: fs.createReadStream(caminho),
    duplex: "half",
  });
  const texto = await envio.text();
  if (!envio.ok)
    throw new ErroApi(`Falha ao enviar o vídeo ao YouTube (HTTP ${envio.status}).`,
      { status: envio.status, detalhe: texto.slice(0, 2000), plataforma: "youtube" });

  let dados = {}; try { dados = JSON.parse(texto); } catch { }
  const id = dados.id;
  return { externo_id: id, url: id ? `https://www.youtube.com/watch?v=${id}` : "" };
}

async function verificar({ conta }) {
  const r = await pedir(comQuery("https://www.googleapis.com/youtube/v3/channels", { part: "snippet,statistics", mine: "true" }),
    { plataforma: "youtube", cabecalhos: { Authorization: `Bearer ${conta.token}` } });
  const c = r.items?.[0];
  return { ok: !!c, nome: c?.snippet?.title || conta.nome, seguidores: c?.statistics?.subscriberCount ? Number(c.statistics.subscriberCount) : null };
}

module.exports = { autorizarUrl, trocarCodigo, renovar, publicar, verificar, ESCOPOS };
