/* ==========================================================================
   regras.js — FONTE ÚNICA das regras de cada plataforma.

   O mesmo objeto:
     · monta os campos específicos de cada rede no painel,
     · alimenta os contadores ao vivo (legenda, hashtags, título),
     · e é reaplicado NO SERVIDOR antes de enfileirar (o front esconde, quem
       manda é a checagem daqui — mesma filosofia dos perfis do /restrito).

   Mudou um limite lá fora? Muda AQUI e vale nos três lugares.

   Números conferidos com a documentação oficial em jul/2026. Onde a
   plataforma varia por conta (duração de vídeo do TikTok, cota do YouTube),
   o comentário diz o porquê do valor escolhido.
   ========================================================================== */

const PLATAFORMAS = {
  instagram: {
    rotulo: "Instagram",
    cor: "#E1306C",
    midia: "obrigatoria",              // não existe post só de texto
    aceita: ["foto", "video"],
    legenda: { max: 2200, hashtagsMax: 30, mencoesMax: 20 },
    imagem: {
      mimes: ["image/jpeg", "image/png"],
      bytesMax: 8 * 1024 * 1024,
      // A API rejeita fora da faixa 4:5 (0,8) a 1.91:1
      proporcaoMin: 0.8, proporcaoMax: 1.91,
    },
    video: {
      mimes: ["video/mp4", "video/quicktime"],
      bytesMax: 1024 * 1024 * 1024,
      segundosMin: 3, segundosMax: 15 * 60,   // Reels
    },
    carrossel: { min: 2, max: 10 },
    limiteDiario: 50,                  // limite de publicação da Graph API por 24h
    campos: [
      ["legenda", "Legenda", "textarea", { max: 2200, dica: "Até 2.200 caracteres e 30 hashtags." }],
      ["primeiro_comentario", "1º comentário (hashtags)", "textarea", { max: 2200, dica: "Opcional — muita gente prefere as hashtags aqui." }],
      ["formato", "Formato", "select", { opcoes: ["Feed", "Reels"], padrao: "Feed", dica: "Vídeo no Instagram sempre vira Reels." }],
    ],
    exigeUrlPublica: true,             // a Meta BAIXA a mídia; precisa de URL pública
  },

  facebook: {
    rotulo: "Facebook",
    cor: "#1877F2",
    midia: "opcional",
    aceita: ["foto", "video", "texto"],
    legenda: { max: 63206, hashtagsMax: 0, mencoesMax: 0 },
    imagem: { mimes: ["image/jpeg", "image/png", "image/webp"], bytesMax: 10 * 1024 * 1024 },
    video: { mimes: ["video/mp4", "video/quicktime"], bytesMax: 4 * 1024 * 1024 * 1024, segundosMin: 1, segundosMax: 240 * 60 },
    carrossel: { min: 1, max: 10 },
    campos: [
      ["legenda", "Texto da publicação", "textarea", { max: 63206, dica: "O Facebook aceita texto longo — dá para usar o resumo inteiro." }],
      ["link", "Link para saber mais", "text", { dica: "Opcional. Normalmente a URL da matéria no site." }],
    ],
    exigeUrlPublica: true,
  },

  tiktok: {
    rotulo: "TikTok",
    cor: "#000000",
    midia: "obrigatoria",
    aceita: ["video", "foto"],         // o TikTok também publica carrossel de fotos
    legenda: { max: 2200, hashtagsMax: 0, mencoesMax: 0 },
    imagem: { mimes: ["image/jpeg", "image/png", "image/webp"], bytesMax: 20 * 1024 * 1024 },
    video: {
      mimes: ["video/mp4", "video/quicktime", "video/webm"],
      bytesMax: 4 * 1024 * 1024 * 1024,
      segundosMin: 3, segundosMax: 10 * 60,  // teto conservador: contas novas ficam em 10min
    },
    carrossel: { min: 1, max: 35 },
    campos: [
      ["legenda", "Descrição", "textarea", { max: 2200 }],
      ["privacidade", "Quem pode ver", "select", {
        opcoes: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
        rotulos: { PUBLIC_TO_EVERYONE: "Todos", MUTUAL_FOLLOW_FRIENDS: "Amigos", FOLLOWER_OF_CREATOR: "Seguidores", SELF_ONLY: "Só eu (privado)" },
        padrao: "PUBLIC_TO_EVERYONE",
        dica: "Enquanto o app não passar pela auditoria do TikTok, só SELF_ONLY funciona — é regra deles, não do sistema.",
      }],
      ["comentarios", "Permitir comentários", "bool", { padrao: true }],
      ["duetos", "Permitir duetos", "bool", { padrao: true }],
      ["costura", "Permitir costura (stitch)", "bool", { padrao: true }],
      ["conteudo_comercial", "Conteúdo comercial / publicidade", "bool", { padrao: false, dica: "Marque quando o post promove marca própria ou de terceiro — o TikTok exige a divulgação." }],
    ],
    exigeUrlPublica: false,            // envia por FILE_UPLOAD; PULL_FROM_URL exigiria domínio verificado
    obs: "A conta precisa autorizar o app e o app precisa dos escopos video.publish/video.upload.",
  },

  youtube: {
    rotulo: "YouTube",
    cor: "#FF0000",
    midia: "obrigatoria",
    aceita: ["video"],
    legenda: { max: 5000, hashtagsMax: 15, mencoesMax: 0 },
    video: {
      mimes: ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"],
      bytesMax: 128 * 1024 * 1024 * 1024,
      segundosMin: 1, segundosMax: 12 * 3600,
    },
    tituloMax: 100,
    tagsMaxTotal: 500,                 // soma dos caracteres de todas as tags
    limiteDiario: 6,                   // cota padrão 10.000/dia ÷ 1.600 por upload
    campos: [
      ["titulo", "Título do vídeo", "text", { max: 100, dica: "Até 100 caracteres. Não aceita < nem >." }],
      ["descricao", "Descrição", "textarea", { max: 5000 }],
      ["tags", "Tags", "text", { dica: "Separadas por vírgula. Somadas, até 500 caracteres." }],
      ["privacidade", "Visibilidade", "select", {
        opcoes: ["public", "unlisted", "private"],
        rotulos: { public: "Público", unlisted: "Não listado", private: "Privado" },
        padrao: "public",
      }],
      ["categoria", "Categoria", "select", {
        opcoes: ["22", "24", "26", "27", "28", "10", "17", "19", "20", "25"],
        rotulos: { 22: "Pessoas e blogs", 24: "Entretenimento", 26: "Estilo de vida e faça você mesmo",
          27: "Educação", 28: "Ciência e tecnologia", 10: "Música", 17: "Esportes",
          19: "Viagens e eventos", 20: "Jogos", 25: "Notícias e política" },
        padrao: "22",
      }],
      ["short", "Publicar como Short", "bool", { padrao: false, dica: "Vertical e até 3 minutos. O sistema acrescenta #Shorts ao título." }],
      ["feito_para_criancas", "Conteúdo feito para crianças", "select", {
        opcoes: ["nao", "sim"], rotulos: { nao: "Não", sim: "Sim" }, padrao: "nao",
        dica: "Declaração obrigatória do YouTube (COPPA).",
      }],
    ],
    short: { segundosMax: 180, proporcaoMin: 0.5, proporcaoMax: 1.0 },
    exigeUrlPublica: false,            // upload resumable direto do arquivo
  },

  site: {
    rotulo: "Site / Blog",
    cor: "#0E8F7E",
    midia: "opcional",
    aceita: ["foto", "video", "texto"],
    legenda: { max: 0 },               // o site usa resumo_html + texto_html do post
    campos: [
      ["slug", "Endereço (slug)", "text", { dica: "Deixe vazio para gerar a partir do título." }],
      ["destaque", "Marcar como destaque", "bool", { padrao: false }],
      ["publicar_agora", "Publicar o site ao receber", "bool", { padrao: true, dica: "Roda o Publicar do CMS e regenera as páginas estáticas." }],
    ],
    exigeUrlPublica: true,             // o site baixa a imagem para servir na matéria
  },
};

const ORDEM = ["site", "instagram", "facebook", "youtube", "tiktok"];

/* Quantas hashtags/menções tem um texto. Conta "#a" mas não "#" solto nem
   "#" no meio de palavra (cor #FF0000 num texto colado não vira hashtag). */
const contaHashtags = (t) => (String(t || "").match(/(?:^|\s)#[\p{L}\p{N}_]+/gu) || []).length;
const contaMencoes = (t) => (String(t || "").match(/(?:^|\s)@[\w.]+/g) || []).length;

/* ==========================================================================
   VALIDAÇÃO — roda no painel (aviso ao vivo) e no servidor (bloqueia).
   Devolve { erros: [], avisos: [] }. Erro impede enfileirar; aviso só alerta.
   `midias` = linhas da tabela midias já com tipo/bytes/duracao/largura/altura.
   ========================================================================== */
function validarDestino(plataforma, opcoes = {}, post = {}, midias = []) {
  const R = PLATAFORMAS[plataforma];
  const erros = [], avisos = [];
  if (!R) return { erros: [`Plataforma desconhecida: ${plataforma}`], avisos };

  const imagens = midias.filter((m) => m.tipo === "imagem");
  const videos = midias.filter((m) => m.tipo === "video");

  /* --- mídia presente? ---------------------------------------------------- */
  if (R.midia === "obrigatoria" && midias.length === 0)
    erros.push(`${R.rotulo}: é preciso enviar ${R.aceita.includes("video") && !R.aceita.includes("foto") ? "um vídeo" : "ao menos uma foto ou um vídeo"}.`);

  if (plataforma === "youtube" && videos.length === 0)
    erros.push("YouTube: só publica vídeo — envie o arquivo de vídeo.");
  if (plataforma === "tiktok" && videos.length === 0 && imagens.length === 0)
    erros.push("TikTok: envie um vídeo ou fotos.");

  /* --- legenda ------------------------------------------------------------ */
  const legenda = String(opcoes.legenda || "");
  if (R.legenda?.max && legenda.length > R.legenda.max)
    erros.push(`${R.rotulo}: a legenda tem ${legenda.length} caracteres (máximo ${R.legenda.max}).`);
  if (R.legenda?.hashtagsMax) {
    const h = contaHashtags(legenda) + contaHashtags(opcoes.primeiro_comentario || "");
    if (h > R.legenda.hashtagsMax) erros.push(`${R.rotulo}: ${h} hashtags (máximo ${R.legenda.hashtagsMax}).`);
  }
  if (R.legenda?.mencoesMax && contaMencoes(legenda) > R.legenda.mencoesMax)
    erros.push(`${R.rotulo}: mais de ${R.legenda.mencoesMax} menções (@) na legenda.`);

  /* --- imagens ------------------------------------------------------------
     Quem decide se a plataforma aceita é `aceita`; o bloco `imagem` só traz os
     limites. Site/Blog aceita foto sem restrição de proporção, por isso não
     tem bloco — e não pode ser lido como "não aceita". */
  if (imagens.length && !R.aceita.includes("foto"))
    erros.push(`${R.rotulo} não publica foto.`);
  for (const m of R.imagem ? imagens : []) {
    if (R.imagem.mimes && m.mime && !R.imagem.mimes.includes(m.mime))
      erros.push(`${R.rotulo}: ${m.arquivo} está em ${m.mime}; aceita ${R.imagem.mimes.join(", ")}.`);
    if (R.imagem.bytesMax && m.bytes > R.imagem.bytesMax)
      erros.push(`${R.rotulo}: ${m.arquivo} tem ${(m.bytes / 1048576).toFixed(1)} MB (máximo ${(R.imagem.bytesMax / 1048576).toFixed(0)} MB).`);
    if (R.imagem.proporcaoMin && m.largura && m.altura) {
      const p = m.largura / m.altura;
      if (p < R.imagem.proporcaoMin || p > R.imagem.proporcaoMax)
        erros.push(`${R.rotulo}: ${m.arquivo} está em ${m.largura}×${m.altura} (proporção ${p.toFixed(2)}). A API só aceita entre ${R.imagem.proporcaoMin} (4:5) e ${R.imagem.proporcaoMax} (1.91:1).`);
    }
  }
  if (R.carrossel && imagens.length > R.carrossel.max)
    erros.push(`${R.rotulo}: ${imagens.length} fotos (máximo ${R.carrossel.max}).`);
  if (plataforma === "instagram" && imagens.length === 1 && videos.length === 0 && R.carrossel.min === 2) {
    /* uma foto só é post simples, não carrossel — nada a avisar */
  }

  /* --- vídeos ------------------------------------------------------------- */
  if (videos.length && !R.aceita.includes("video"))
    erros.push(`${R.rotulo} não publica vídeo.`);
  for (const m of R.video ? videos : []) {
    if (R.video.mimes && m.mime && !R.video.mimes.includes(m.mime))
      erros.push(`${R.rotulo}: ${m.arquivo} está em ${m.mime}; aceita ${R.video.mimes.join(", ")}.`);
    if (R.video.bytesMax && m.bytes > R.video.bytesMax)
      erros.push(`${R.rotulo}: ${m.arquivo} tem ${(m.bytes / 1073741824).toFixed(2)} GB (máximo ${(R.video.bytesMax / 1073741824).toFixed(0)} GB).`);
    if (m.duracao) {
      if (R.video.segundosMin && m.duracao < R.video.segundosMin)
        erros.push(`${R.rotulo}: o vídeo tem ${m.duracao.toFixed(1)}s (mínimo ${R.video.segundosMin}s).`);
      if (R.video.segundosMax && m.duracao > R.video.segundosMax)
        erros.push(`${R.rotulo}: o vídeo tem ${Math.round(m.duracao / 60)} min (máximo ${Math.round(R.video.segundosMax / 60)} min).`);
    }
  }
  if (videos.length > 1 && plataforma !== "site")
    erros.push(`${R.rotulo}: só um vídeo por publicação.`);
  if (videos.length && imagens.length && ["instagram", "youtube", "tiktok"].includes(plataforma))
    avisos.push(`${R.rotulo}: há foto e vídeo no mesmo post — só o vídeo será enviado.`);

  /* --- específicos --------------------------------------------------------- */
  if (plataforma === "youtube") {
    const t = String(opcoes.titulo || post.titulo || "");
    if (!t.trim()) erros.push("YouTube: o título é obrigatório.");
    if (t.length > R.tituloMax) erros.push(`YouTube: título com ${t.length} caracteres (máximo ${R.tituloMax}).`);
    if (/[<>]/.test(t)) erros.push("YouTube: o título não pode conter < nem >.");
    if (String(opcoes.descricao || "").length > 5000) erros.push("YouTube: descrição acima de 5.000 caracteres.");
    const tags = String(opcoes.tags || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (tags.join("").length > R.tagsMaxTotal) erros.push(`YouTube: as tags somam mais de ${R.tagsMaxTotal} caracteres.`);
    if (opcoes.short) {
      const v = videos[0];
      if (v?.duracao && v.duracao > R.short.segundosMax) erros.push("YouTube Shorts: o vídeo passa de 3 minutos.");
      if (v?.largura && v?.altura && v.largura / v.altura > R.short.proporcaoMax)
        avisos.push("YouTube Shorts: o vídeo não é vertical — o YouTube pode não tratá-lo como Short.");
    }
  }
  if (plataforma === "tiktok") {
    if (!opcoes.privacidade) erros.push("TikTok: escolha quem pode ver o vídeo (a API exige).");
  }
  if (plataforma === "site") {
    if (!String(post.texto_html || "").trim()) erros.push("Site: a matéria está sem texto.");
    if (!String(post.resumo_html || "").trim()) avisos.push("Site: sem resumo — a listagem do blog vai ficar sem chamada.");
  }
  if (plataforma === "instagram" && !legenda.trim())
    avisos.push("Instagram: publicação sem legenda.");

  return { erros, avisos };
}

/* Legenda automática a partir do post — usada quando o operador não escreve
   uma específica. Tira o HTML do resumo e corta no limite da rede. */
function legendaPadrao(plataforma, post) {
  const R = PLATAFORMAS[plataforma];
  const limpo = String(post.resumo_html || "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n").trim();
  let t = post.titulo ? `${post.titulo}\n\n${limpo}` : limpo;
  if (post.fonte) t += `\n\nFonte: ${post.fonte}`;
  const max = R?.legenda?.max || 2200;
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

module.exports = { PLATAFORMAS, ORDEM, validarDestino, legendaPadrao, contaHashtags, contaMencoes };
