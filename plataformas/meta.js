/* ==========================================================================
   plataformas/meta.js — Instagram (conta Business/Criador) e Página do Facebook

   As duas redes moram no mesmo arquivo porque compartilham TUDO: o mesmo app
   da Meta, o mesmo login (Facebook Login), o mesmo token de Página. Conectar
   uma vez traz as duas.

   COMO FUNCIONA A PUBLICAÇÃO NO INSTAGRAM (não é um POST só):
     1. cria um "container" apontando para a URL da mídia
     2. (vídeo) espera o container terminar de processar
     3. publica o container
   Por isso o Instagram EXIGE que a mídia esteja numa URL pública: quem baixa
   o arquivo é o servidor da Meta, não nós. Em localhost não funciona — é
   limitação da API deles, não do sistema.

   Escopos necessários no app da Meta:
     pages_show_list · pages_read_engagement · pages_manage_posts
     instagram_basic · instagram_content_publish · business_management
   ========================================================================== */
const { pedir, comQuery, form, esperar, ErroApi } = require("./http");

const VERSAO_GRAPH_PADRAO = "v21.0";
const graph = (v) => `https://graph.facebook.com/${v || VERSAO_GRAPH_PADRAO}`;

const ESCOPOS = ["pages_show_list", "pages_read_engagement", "pages_manage_posts",
  "instagram_basic", "instagram_content_publish", "business_management"];

/* --------------------------------- OAuth ---------------------------------
   A Meta tem HOJE dois produtos de login e eles não se pedem do mesmo jeito:

   · "Login do Facebook" (clássico) — a lista de permissões vai na URL, em
     `scope`.
   · "Login do Facebook para Empresas" — as permissões ficam numa CONFIGURAÇÃO
     criada dentro do produto (aba Modelos/Configurações), e a URL manda só o
     `config_id` dela. Mandar `scope` aqui é ignorado ou dá erro.

   Não dá para adivinhar qual o app usa, e trocar de produto no meio do
   caminho é comum. Então: tem `config_id` cadastrado → usa o fluxo de
   Empresas; não tem → usa o clássico. */
function autorizarUrl({ clientId, redirectUri, state, extra = {} }) {
  const base = `https://www.facebook.com/${extra.versao || VERSAO_GRAPH_PADRAO}/dialog/oauth`;
  const comum = { client_id: clientId, redirect_uri: redirectUri, state, response_type: "code" };
  if (extra.config_id)
    return comQuery(base, { ...comum, config_id: extra.config_id, override_default_response_type: "true" });
  return comQuery(base, { ...comum, scope: ESCOPOS.join(",") });
}

/* Troca o code por um token de usuário e já o converte em token LONGO (60
   dias). O token curto morre em 1–2h; sem a troca, a conexão duraria uma
   tarde. */
async function trocarCodigo({ clientId, clientSecret, redirectUri, code, extra = {} }) {
  const v = extra.versao;
  const curto = await pedir(comQuery(`${graph(v)}/oauth/access_token`, {
    client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code,
  }), { plataforma: "meta" });

  const longo = await pedir(comQuery(`${graph(v)}/oauth/access_token`, {
    grant_type: "fb_exchange_token", client_id: clientId, client_secret: clientSecret,
    fb_exchange_token: curto.access_token,
  }), { plataforma: "meta" });

  const tokenUsuario = longo.access_token || curto.access_token;

  /* Lista as Páginas administradas e, em cada uma, a conta do Instagram
     ligada. O token de PÁGINA (que vem aqui dentro) é o que publica — e ele
     não expira enquanto o token de usuário longo estiver válido. */
  const contas = await pedir(comQuery(`${graph(v)}/me/accounts`, {
    fields: "id,name,access_token,instagram_business_account{id,username,name}",
    limit: 100, access_token: tokenUsuario,
  }), { plataforma: "meta" });

  const achados = [];
  for (const pg of contas.data || []) {
    achados.push({
      plataforma: "facebook",
      externo_id: pg.id,
      nome: pg.name,
      token: pg.access_token,
      meta: { page_id: pg.id, tipo: "pagina" },
    });
    if (pg.instagram_business_account) {
      achados.push({
        plataforma: "instagram",
        externo_id: pg.instagram_business_account.id,
        nome: "@" + (pg.instagram_business_account.username || pg.instagram_business_account.name || pg.name),
        token: pg.access_token,                       // o IG publica com o token da Página
        meta: { ig_user_id: pg.instagram_business_account.id, page_id: pg.id, tipo: "instagram" },
      });
    }
  }
  if (!achados.length)
    throw new ErroApi("Nenhuma Página encontrada nesta conta. O Instagram precisa ser Business/Criador e estar vinculado a uma Página.",
      { status: 400, plataforma: "meta" });

  return { tokenUsuario, expira: longo.expires_in ? new Date(Date.now() + longo.expires_in * 1000).toISOString() : null, contas: achados };
}

/* Renova o token de usuário longo (a Meta devolve outro de 60 dias) e
   recolhe os tokens de Página atualizados. */
async function renovar({ clientId, clientSecret, token, extra = {} }) {
  const v = extra.versao;
  const r = await pedir(comQuery(`${graph(v)}/oauth/access_token`, {
    grant_type: "fb_exchange_token", client_id: clientId, client_secret: clientSecret, fb_exchange_token: token,
  }), { plataforma: "meta" });
  return { token: r.access_token, expira: r.expires_in ? new Date(Date.now() + r.expires_in * 1000).toISOString() : null };
}

/* ======================= publicação — INSTAGRAM =========================== */
/* ==========================================================================
   ESPERAR O CONTAINER FICAR PRONTO — vale para FOTO também, não só vídeo.

   Quem baixa o arquivo é o servidor da Meta, e isso leva segundos. Publicar
   antes disso devolve:
       code 9007 · subcode 2207027 · "A mídia não está pronta para ser
       publicada. Aguarde um momento."

   Foi exatamente o que aconteceu na primeira publicação real (07/08/2026): o
   log do nginx mostrou a Meta baixando a imagem às 12:27:33, o publish às
   12:27:36 e a Meta terminando o download às 12:27:38. Três segundos de
   corrida. Antes desta correção, só o ramo de vídeo esperava.
   ========================================================================== */
async function esperarContainer(v, containerId, token, { intervalo = 5000, tentativas = 60, plataforma = "instagram" } = {}) {
  for (let i = 0; i < tentativas; i++) {
    const st = await pedir(comQuery(`${graph(v)}/${containerId}`, {
      fields: "status_code,status", access_token: token,
    }), { plataforma });
    /* Nem todo tipo de container reporta status_code. Sem o campo, não há o
       que esperar — seguir é melhor que travar por um dado que não existe. */
    if (!st.status_code) return true;
    if (st.status_code === "FINISHED") return true;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED")
      throw new ErroApi(`O Instagram rejeitou a mídia (${st.status_code}).`,
        { status: 400, detalhe: st.status || "", plataforma, permanente: true });
    await esperar(intervalo);
  }
  const seg = Math.round(intervalo * tentativas / 1000);
  throw new ErroApi(`O Instagram não terminou de processar a mídia em ${seg >= 60 ? Math.round(seg / 60) + " minutos" : seg + " segundos"}.`,
    { status: 504, plataforma, permanente: false });
}
/* Foto é rápida (segundos); vídeo é lento (minutos). Mesma função, ritmos
   diferentes — cutucar a API de 5 em 5 segundos por uma foto é desperdício,
   e esperar só 30s por um Reels é pouco. */
const RITMO_FOTO = { intervalo: 1500, tentativas: 40 };   // até 60s
const RITMO_VIDEO = { intervalo: 5000, tentativas: 60 };  // até 5min

/* Rede de segurança: se ainda assim o publish disser "não está pronta",
   espera e tenta de novo em vez de marcar a matéria como erro. */
async function publicarContainer(v, ig, containerId, token) {
  for (let i = 0; i < 5; i++) {
    try {
      return await pedir(`${graph(v)}/${ig}/media_publish`, {
        metodo: "POST", plataforma: "instagram",
        cabecalhos: { "Content-Type": "application/x-www-form-urlencoded" },
        corpo: form({ creation_id: containerId, access_token: token }),
      });
    } catch (e) {
      const naoPronta = /2207027/.test(e.detalhe || "") || /not available|não está pronta/i.test(e.message);
      if (!naoPronta || i === 4) throw e;
      await esperar(3000);
    }
  }
}

async function publicarInstagram({ conta, midias, opcoes, urlDe }) {
  const v = conta.meta?.versao;
  const token = conta.token;
  const ig = conta.meta?.ig_user_id || conta.externo_id;
  const legenda = String(opcoes.legenda || "");
  const videos = midias.filter((m) => m.tipo === "video");
  const imagens = midias.filter((m) => m.tipo === "imagem");

  let containerId;

  if (videos.length) {
    /* Vídeo no Instagram é sempre Reels desde 2024. */
    const c = await pedir(`${graph(v)}/${ig}/media`, {
      metodo: "POST", plataforma: "instagram",
      cabecalhos: { "Content-Type": "application/x-www-form-urlencoded" },
      corpo: form({ media_type: "REELS", video_url: urlDe(videos[0]), caption: legenda, access_token: token }),
    });
    containerId = c.id;
    await esperarContainer(v, containerId, token, RITMO_VIDEO);
  } else if (imagens.length > 1) {
    /* Carrossel: cada filho é um container com is_carousel_item. Cada um
       precisa que a Meta BAIXE a imagem — por isso cada filho é esperado
       antes de entrar no carrossel, e o carrossel é esperado antes de ir ao ar. */
    const filhos = [];
    for (const img of imagens.slice(0, 10)) {
      const f = await pedir(`${graph(v)}/${ig}/media`, {
        metodo: "POST", plataforma: "instagram",
        cabecalhos: { "Content-Type": "application/x-www-form-urlencoded" },
        corpo: form({ image_url: urlDe(img), is_carousel_item: "true", access_token: token }),
      });
      await esperarContainer(v, f.id, token, RITMO_FOTO);
      filhos.push(f.id);
    }
    const c = await pedir(`${graph(v)}/${ig}/media`, {
      metodo: "POST", plataforma: "instagram",
      cabecalhos: { "Content-Type": "application/x-www-form-urlencoded" },
      corpo: form({ media_type: "CAROUSEL", children: filhos.join(","), caption: legenda, access_token: token }),
    });
    containerId = c.id;
    await esperarContainer(v, containerId, token, RITMO_FOTO);
  } else if (imagens.length === 1) {
    const c = await pedir(`${graph(v)}/${ig}/media`, {
      metodo: "POST", plataforma: "instagram",
      cabecalhos: { "Content-Type": "application/x-www-form-urlencoded" },
      corpo: form({ image_url: urlDe(imagens[0]), caption: legenda, access_token: token }),
    });
    containerId = c.id;
    /* ERA AQUI O DEFEITO: publicava direto, sem dar tempo de a Meta baixar a
       imagem do nosso servidor. Ver o comentário de esperarContainer. */
    await esperarContainer(v, containerId, token, RITMO_FOTO);
  } else {
    throw new ErroApi("O Instagram não publica post sem foto nem vídeo.", { status: 400, plataforma: "instagram", permanente: true });
  }

  const pub = await publicarContainer(v, ig, containerId, token);

  /* Hashtags no 1º comentário — prática comum para não poluir a legenda.
     Falha aqui NÃO derruba a publicação: o post já está no ar. */
  let avisoComentario = null;
  if (String(opcoes.primeiro_comentario || "").trim()) {
    try {
      await pedir(`${graph(v)}/${pub.id}/comments`, {
        metodo: "POST", plataforma: "instagram",
        cabecalhos: { "Content-Type": "application/x-www-form-urlencoded" },
        corpo: form({ message: opcoes.primeiro_comentario, access_token: token }),
      });
    } catch (e) { avisoComentario = `Post publicado, mas o 1º comentário falhou: ${e.message}`; }
  }

  let url = `https://www.instagram.com/p/`;
  try {
    const info = await pedir(comQuery(`${graph(v)}/${pub.id}`, { fields: "permalink", access_token: token }), { plataforma: "instagram" });
    if (info.permalink) url = info.permalink;
  } catch { url = ""; }

  return { externo_id: pub.id, url, aviso: avisoComentario };
}

/* ======================= publicação — FACEBOOK ============================ */
async function publicarFacebook({ conta, post, midias, opcoes, urlDe }) {
  const v = conta.meta?.versao;
  const token = conta.token;
  const pagina = conta.meta?.page_id || conta.externo_id;
  const texto = String(opcoes.legenda || "");
  const videos = midias.filter((m) => m.tipo === "video");
  const imagens = midias.filter((m) => m.tipo === "imagem");

  if (videos.length) {
    const r = await pedir(`${graph(v)}/${pagina}/videos`, {
      metodo: "POST", plataforma: "facebook", timeout: 120_000,
      cabecalhos: { "Content-Type": "application/x-www-form-urlencoded" },
      corpo: form({ file_url: urlDe(videos[0]), description: texto, title: post.titulo || "", access_token: token }),
    });
    return { externo_id: r.id, url: `https://www.facebook.com/${r.id}` };
  }

  if (imagens.length > 1) {
    /* Várias fotos numa publicação só: sobe cada uma sem publicar
       (published=false) e depois amarra todas no /feed. */
    const ids = [];
    for (const img of imagens.slice(0, 10)) {
      const f = await pedir(`${graph(v)}/${pagina}/photos`, {
        metodo: "POST", plataforma: "facebook",
        cabecalhos: { "Content-Type": "application/x-www-form-urlencoded" },
        corpo: form({ url: urlDe(img), published: "false", access_token: token }),
      });
      ids.push(f.id);
    }
    const corpo = { message: texto, access_token: token };
    ids.forEach((id, i) => { corpo[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
    const r = await pedir(`${graph(v)}/${pagina}/feed`, {
      metodo: "POST", plataforma: "facebook",
      cabecalhos: { "Content-Type": "application/x-www-form-urlencoded" }, corpo: form(corpo),
    });
    return { externo_id: r.id, url: `https://www.facebook.com/${r.id}` };
  }

  if (imagens.length === 1) {
    const r = await pedir(`${graph(v)}/${pagina}/photos`, {
      metodo: "POST", plataforma: "facebook",
      cabecalhos: { "Content-Type": "application/x-www-form-urlencoded" },
      corpo: form({ url: urlDe(imagens[0]), caption: texto, access_token: token }),
    });
    return { externo_id: r.post_id || r.id, url: `https://www.facebook.com/${r.post_id || r.id}` };
  }

  /* Só texto (com link opcional para a matéria no site). */
  const r = await pedir(`${graph(v)}/${pagina}/feed`, {
    metodo: "POST", plataforma: "facebook",
    cabecalhos: { "Content-Type": "application/x-www-form-urlencoded" },
    corpo: form({ message: texto, link: opcoes.link || undefined, access_token: token }),
  });
  return { externo_id: r.id, url: `https://www.facebook.com/${r.id}` };
}

/* Confere se o token ainda vale — usado pela tela de Contas. */
async function verificar({ conta }) {
  const v = conta.meta?.versao;
  const alvo = conta.meta?.ig_user_id || conta.meta?.page_id || conta.externo_id;
  const campos = conta.plataforma === "instagram" ? "id,username,followers_count" : "id,name,fan_count";
  const r = await pedir(comQuery(`${graph(v)}/${alvo}`, { fields: campos, access_token: conta.token }), { plataforma: conta.plataforma });
  return { ok: true, nome: r.username ? "@" + r.username : r.name, seguidores: r.followers_count ?? r.fan_count ?? null };
}

module.exports = { autorizarUrl, trocarCodigo, renovar, publicarInstagram, publicarFacebook, verificar, ESCOPOS, VERSAO_GRAPH_PADRAO };
