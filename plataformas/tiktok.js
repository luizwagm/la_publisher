/* ==========================================================================
   plataformas/tiktok.js — TikTok Content Posting API (v2)

   Diferenças que valem saber antes de mexer:

   · PKCE obrigatório no login (code_challenge S256). O verifier fica na
     sessão do OAuth, nunca no banco.
   · O TikTok pede o creator_info ANTES de postar. É lá que ele diz quais
     níveis de privacidade a conta aceita e se comentário/dueto/costura estão
     desligados no perfil. Postar contrariando isso dá erro.
   · Enviamos o arquivo (FILE_UPLOAD), não a URL. PULL_FROM_URL exigiria
     verificar o domínio no painel de desenvolvedor do TikTok — passo a mais
     para o cliente, sem ganho.
   · Enquanto o app não passar pela auditoria do TikTok, TODO post sai como
     SELF_ONLY (privado). É regra deles: app não auditado só publica para o
     próprio dono. O sistema avisa isso na tela.
   ========================================================================== */
const fs = require("node:fs");
const crypto = require("node:crypto");
const { pedir, form, comQuery, esperar, ErroApi } = require("./http");

const BASE = "https://open.tiktokapis.com/v2";
const ESCOPOS = ["user.info.basic", "video.publish", "video.upload"];

/* --------------------------------- PKCE ---------------------------------- */
function novoPkce() {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function autorizarUrl({ clientId, redirectUri, state, extra = {} }) {
  return comQuery("https://www.tiktok.com/v2/auth/authorize/", {
    client_key: clientId, scope: ESCOPOS.join(","), response_type: "code",
    redirect_uri: redirectUri, state,
    code_challenge: extra.challenge, code_challenge_method: "S256",
  });
}

async function trocarCodigo({ clientId, clientSecret, redirectUri, code, extra = {} }) {
  const t = await pedir(`${BASE}/oauth/token/`, {
    metodo: "POST", plataforma: "tiktok",
    cabecalhos: { "Content-Type": "application/x-www-form-urlencoded" },
    corpo: form({
      client_key: clientId, client_secret: clientSecret, code,
      grant_type: "authorization_code", redirect_uri: redirectUri,
      code_verifier: extra.verifier,
    }),
  });
  if (t.error) throw new ErroApi(t.error_description || t.error, { status: 400, plataforma: "tiktok" });

  let nome = "TikTok", externo = t.open_id;
  try {
    const u = await pedir(comQuery(`${BASE}/user/info/`, { fields: "open_id,display_name,avatar_url" }), {
      plataforma: "tiktok", cabecalhos: { Authorization: `Bearer ${t.access_token}` },
    });
    if (u?.data?.user?.display_name) nome = "@" + u.data.user.display_name;
  } catch { /* o nome é enfeite; a conta funciona sem ele */ }

  return {
    contas: [{
      plataforma: "tiktok", externo_id: externo, nome,
      token: t.access_token, refresh: t.refresh_token,
      expira: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null,
      escopos: t.scope || ESCOPOS.join(","),
      meta: { open_id: externo },
    }],
  };
}

async function renovar({ clientId, clientSecret, refresh }) {
  const t = await pedir(`${BASE}/oauth/token/`, {
    metodo: "POST", plataforma: "tiktok",
    cabecalhos: { "Content-Type": "application/x-www-form-urlencoded" },
    corpo: form({ client_key: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refresh }),
  });
  if (t.error) throw new ErroApi(t.error_description || t.error, { status: 400, plataforma: "tiktok" });
  return {
    token: t.access_token, refresh: t.refresh_token,
    expira: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null,
  };
}

/* O que a conta permite hoje (privacidade disponível, interações desligadas,
   limite de duração). O painel usa para avisar antes de o operador errar. */
async function creatorInfo({ conta }) {
  const r = await pedir(`${BASE}/post/publish/creator_info/query/`, {
    metodo: "POST", plataforma: "tiktok",
    cabecalhos: { Authorization: `Bearer ${conta.token}`, "Content-Type": "application/json; charset=UTF-8" },
    corpo: "{}",
  });
  return r?.data || {};
}

/* ------------------------------ publicação -------------------------------- */
const CHUNK = 10 * 1024 * 1024;   // 10 MB — dentro da faixa aceita pelo TikTok

async function publicarVideo({ conta, opcoes, midias, caminhoDe }) {
  const video = midias.find((m) => m.tipo === "video");
  if (!video) throw new ErroApi("TikTok: nenhum vídeo no post.", { status: 400, plataforma: "tiktok", permanente: true });

  const caminho = caminhoDe(video);
  const tamanho = fs.statSync(caminho).size;
  /* Arquivo pequeno vai inteiro; grande vai em pedaços de 10 MB. O último
     pedaço leva o resto (o TikTok não aceita fatia final menor que 5 MB
     separada — por isso o cálculo com Math.floor). */
  const partes = tamanho <= CHUNK ? 1 : Math.floor(tamanho / CHUNK);
  const tamanhoParte = partes === 1 ? tamanho : CHUNK;

  const init = await pedir(`${BASE}/post/publish/video/init/`, {
    metodo: "POST", plataforma: "tiktok",
    cabecalhos: { Authorization: `Bearer ${conta.token}`, "Content-Type": "application/json; charset=UTF-8" },
    corpo: JSON.stringify({
      post_info: {
        title: String(opcoes.legenda || "").slice(0, 2200),
        privacy_level: opcoes.privacidade || "SELF_ONLY",
        disable_comment: opcoes.comentarios === false,
        disable_duet: opcoes.duetos === false,
        disable_stitch: opcoes.costura === false,
        brand_content_toggle: !!opcoes.conteudo_comercial_terceiro,
        brand_organic_toggle: !!opcoes.conteudo_comercial,
      },
      source_info: {
        source: "FILE_UPLOAD", video_size: tamanho,
        chunk_size: tamanhoParte, total_chunk_count: partes,
      },
    }),
  });
  if (init.error && init.error.code && init.error.code !== "ok")
    throw new ErroApi(init.error.message || init.error.code, { status: 400, plataforma: "tiktok" });

  const { publish_id, upload_url } = init.data || {};
  if (!upload_url) throw new ErroApi("TikTok não devolveu a URL de envio.", { status: 502, plataforma: "tiktok", permanente: false });

  const fd = fs.openSync(caminho, "r");
  try {
    for (let i = 0; i < partes; i++) {
      const ini = i * tamanhoParte;
      const fim = i === partes - 1 ? tamanho - 1 : ini + tamanhoParte - 1;
      const buf = Buffer.alloc(fim - ini + 1);
      fs.readSync(fd, buf, 0, buf.length, ini);
      const r = await pedir(upload_url, {
        metodo: "PUT", plataforma: "tiktok", cru: true, timeout: 300_000,
        cabecalhos: {
          "Content-Type": video.mime || "video/mp4",
          "Content-Length": String(buf.length),
          "Content-Range": `bytes ${ini}-${fim}/${tamanho}`,
        },
        corpo: buf,
      });
      if (!r.ok && r.status !== 308)
        throw new ErroApi(`Falha ao enviar o vídeo (HTTP ${r.status}).`, { status: r.status, plataforma: "tiktok" });
    }
  } finally { fs.closeSync(fd); }

  /* O TikTok processa depois do upload; só o status diz se entrou mesmo. */
  for (let i = 0; i < 40; i++) {
    await esperar(5000);
    const st = await pedir(`${BASE}/post/publish/status/fetch/`, {
      metodo: "POST", plataforma: "tiktok",
      cabecalhos: { Authorization: `Bearer ${conta.token}`, "Content-Type": "application/json; charset=UTF-8" },
      corpo: JSON.stringify({ publish_id }),
    });
    const s = st?.data?.status;
    if (s === "PUBLISH_COMPLETE") {
      const id = st.data.publicaly_available_post_id?.[0] || st.data.publicly_available_post_id?.[0] || publish_id;
      return { externo_id: String(id), url: id && conta.meta?.username ? `https://www.tiktok.com/@${conta.meta.username}/video/${id}` : "" };
    }
    if (s === "FAILED")
      throw new ErroApi(`TikTok recusou o vídeo: ${st.data.fail_reason || "motivo não informado"}.`,
        { status: 400, plataforma: "tiktok", permanente: true });
  }
  /* Passou de ~3 min processando: devolvemos o publish_id para acompanhar
     depois em vez de marcar erro (o vídeo costuma entrar). */
  return { externo_id: publish_id, url: "", aviso: "O TikTok ainda estava processando quando paramos de acompanhar. Confira no aplicativo." };
}

/* Carrossel de fotos. Aqui o TikTok SÓ aceita PULL_FROM_URL — por isso a
   mídia precisa estar na URL pública do sistema. */
async function publicarFotos({ conta, post, opcoes, midias, urlDe }) {
  const imagens = midias.filter((m) => m.tipo === "imagem").slice(0, 35);
  if (!imagens.length) throw new ErroApi("TikTok: nenhuma foto no post.", { status: 400, plataforma: "tiktok", permanente: true });

  const init = await pedir(`${BASE}/post/publish/content/init/`, {
    metodo: "POST", plataforma: "tiktok",
    cabecalhos: { Authorization: `Bearer ${conta.token}`, "Content-Type": "application/json; charset=UTF-8" },
    corpo: JSON.stringify({
      media_type: "PHOTO", post_mode: "DIRECT_POST",
      post_info: {
        title: String(post.titulo || "").slice(0, 90),
        description: String(opcoes.legenda || "").slice(0, 2200),
        privacy_level: opcoes.privacidade || "SELF_ONLY",
        disable_comment: opcoes.comentarios === false,
        auto_add_music: true,
      },
      source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: imagens.map(urlDe) },
    }),
  });
  const publish_id = init?.data?.publish_id;
  if (!publish_id) throw new ErroApi("TikTok não aceitou o carrossel de fotos.", { status: 400, plataforma: "tiktok" });
  return { externo_id: publish_id, url: "" };
}

async function publicar(ctx) {
  const temVideo = ctx.midias.some((m) => m.tipo === "video");
  return temVideo ? publicarVideo(ctx) : publicarFotos(ctx);
}

async function verificar({ conta }) {
  const info = await creatorInfo({ conta });
  return {
    ok: true,
    nome: info.creator_nickname ? "@" + info.creator_username : conta.nome,
    privacidades: info.privacy_level_options || [],
    duracaoMax: info.max_video_post_duration_sec || null,
  };
}

module.exports = { autorizarUrl, trocarCodigo, renovar, publicar, verificar, creatorInfo, novoPkce, ESCOPOS };
