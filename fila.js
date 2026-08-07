/* ==========================================================================
   fila.js — o motor: pega os destinos pendentes e publica.

   Por que fila e não publicar direto no clique:
   · o Instagram leva minutos processando um Reels e o YouTube pode levar meia
     hora subindo um arquivo — segurar a requisição do navegador nisso é
     receita para timeout e post duplicado;
   · agendamento ("publica sábado 9h") precisa de alguém rodando sozinho;
   · quando uma rede falha, as outras já foram — a fila retenta SÓ a que caiu,
     sem republicar o resto (por isso o estado é por DESTINO, não por post).

   Retentativa: 4 tentativas com espera crescente (5min, 20min, 1h20, 5h20).
   Erro de conteúdo (4xx) NÃO retenta — tentar de novo daria o mesmo erro e
   só queimaria cota; ele vira "erro" na hora e espera o operador corrigir.
   ========================================================================== */
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { db, ROOT, getC, cifrar, decifrar, agora, registrar } = require("./banco");
const { PLATAFORMAS, validarDestino } = require("./regras");
const meta = require("./plataformas/meta");
const tiktok = require("./plataformas/tiktok");
const youtube = require("./plataformas/youtube");
const site = require("./plataformas/site");

const MIDIA_DIR = path.join(ROOT, "midia");
const TENTATIVAS_MAX = 4;
const ESPERA_BASE_MIN = 5;

/* Ordem de publicação dentro do mesmo post. O YouTube vem primeiro de
   propósito: se o vídeo também vai para o site, o site recebe o ID do vídeo e
   embute o player em vez de servir o arquivo. */
const ORDEM_PUBLICACAO = ["youtube", "tiktok", "instagram", "facebook", "site"];

/* ------------------------- endereço público da mídia ---------------------
   Instagram, Facebook, TikTok (fotos) e os sites BAIXAM o arquivo. Precisam
   de uma URL que a internet alcance — em localhost nada disso funciona, e é
   por isso que o painel avisa quando a URL pública não está configurada. */
function urlPublica() {
  return String(getC("url_publica") || process.env.LAP_URL_PUBLICA || "").replace(/\/+$/, "");
}
const urlDe = (m) => `${urlPublica()}/midia/${m.arquivo}`;
const caminhoDe = (m) => path.join(MIDIA_DIR, path.basename(m.arquivo));

/* --------------------------- contas e credenciais ------------------------ */
function appDe(plataforma) {
  /* Instagram e Facebook usam o MESMO app da Meta. */
  const chave = plataforma === "instagram" ? "facebook" : plataforma;
  const a = db.prepare("SELECT * FROM apps WHERE plataforma=?").get(chave);
  if (!a) return null;
  return {
    ...a,
    client_secret: decifrar(a.client_secret),
    extra: a.extra ? JSON.parse(a.extra) : {},
  };
}
function carregarConta(id) {
  const c = db.prepare("SELECT * FROM contas WHERE id=?").get(id);
  if (!c) return null;
  return { ...c, token: decifrar(c.token), refresh: decifrar(c.refresh), meta: c.meta ? JSON.parse(c.meta) : {} };
}
function gravarTokens(contaId, { token, refresh, expira }) {
  const sets = [], args = [];
  if (token !== undefined) { sets.push("token=?"); args.push(cifrar(token)); }
  if (refresh !== undefined && refresh) { sets.push("refresh=?"); args.push(cifrar(refresh)); }
  if (expira !== undefined) { sets.push("expira=?"); args.push(expira); }
  sets.push("atualizado=?"); args.push(agora());
  db.prepare(`UPDATE contas SET ${sets.join(",")} WHERE id=?`).run(...args, contaId);
}

/* Renova o token quando falta menos de 10 minutos (ou já venceu). O TikTok e
   o YouTube têm token curto; a Meta tem token de 60 dias que renovamos por
   fora, na tela de Contas. */
async function garantirToken(conta) {
  if (!conta.expira) return conta;
  const falta = new Date(conta.expira).getTime() - Date.now();
  if (falta > 10 * 60_000) return conta;

  const app = appDe(conta.plataforma);
  if (!app?.client_id) return conta;
  const args = { clientId: app.client_id, clientSecret: app.client_secret, token: conta.token, refresh: conta.refresh, extra: app.extra };

  let novo = null;
  if (conta.plataforma === "youtube") novo = await youtube.renovar(args);
  else if (conta.plataforma === "tiktok") novo = await tiktok.renovar(args);
  else if (conta.plataforma === "facebook" || conta.plataforma === "instagram") novo = await meta.renovar(args);
  if (!novo?.token) return conta;

  gravarTokens(conta.id, novo);
  registrar("info", `Token renovado (${conta.plataforma}).`, { plataforma: conta.plataforma });
  return { ...conta, ...novo };
}

/* ------------------------------ publicação -------------------------------- */
const midiasDoPost = (postId) =>
  db.prepare("SELECT * FROM midias WHERE post_id=? ORDER BY ordem, id").all(postId);

async function publicarDestino(destino) {
  const post = db.prepare("SELECT * FROM posts WHERE id=?").get(destino.post_id);
  if (!post) throw Object.assign(new Error("Post não existe mais."), { permanente: true });
  const midias = midiasDoPost(post.id);
  const opcoes = destino.opcoes ? JSON.parse(destino.opcoes) : {};

  /* Revalida ANTES de gastar chamada de API: o post pode ter sido editado
     depois de agendado (trocaram a foto por uma 16:9 e o Instagram recusaria). */
  const { erros } = validarDestino(destino.plataforma, opcoes, post, midias);
  if (erros.length) throw Object.assign(new Error(erros[0]), { permanente: true });

  /* Mídia precisa existir no disco. */
  for (const m of midias) {
    if (!fs.existsSync(caminhoDe(m)))
      throw Object.assign(new Error(`O arquivo ${m.arquivo} sumiu da pasta de mídia.`), { permanente: true });
  }
  const R = PLATAFORMAS[destino.plataforma];
  if (R?.exigeUrlPublica && midias.length && !urlPublica())
    throw Object.assign(new Error(
      `${R.rotulo} baixa a mídia por URL — configure o "Endereço público" em Configurações antes de publicar.`),
      { permanente: true });

  let conta = carregarConta(destino.conta_id);
  if (!conta) throw Object.assign(new Error("A conta conectada não existe mais."), { permanente: true });
  if (!conta.ativo) throw Object.assign(new Error("A conta está desativada."), { permanente: true });
  conta = await garantirToken(conta);

  const ctx = { conta, post, midias, opcoes, urlDe, caminhoDe };
  switch (destino.plataforma) {
    case "instagram": return meta.publicarInstagram(ctx);
    case "facebook": return meta.publicarFacebook(ctx);
    case "tiktok": return tiktok.publicar(ctx);
    case "youtube": return youtube.publicar(ctx);
    case "site": {
      /* Se o mesmo post já subiu para o YouTube, o site embute o vídeo. */
      const yt = db.prepare("SELECT externo_id FROM destinos WHERE post_id=? AND plataforma='youtube' AND status='publicado'").get(post.id);
      if (yt?.externo_id) ctx.opcoes = { ...opcoes, video_youtube: yt.externo_id };
      return site.publicar(ctx);
    }
    default: throw Object.assign(new Error(`Plataforma desconhecida: ${destino.plataforma}`), { permanente: true });
  }
}

/* Recalcula o status do POST a partir dos destinos dele. */
function atualizarStatusPost(postId) {
  const ds = db.prepare("SELECT status FROM destinos WHERE post_id=?").all(postId);
  if (!ds.length) return;
  const tem = (s) => ds.some((d) => d.status === s);
  /* "cancelado" não conta como pendência nem como sucesso: um post com todos
     os destinos cancelados volta a ser rascunho, não vira "publicado". */
  const todos = (s) => ds.some((d) => d.status === s) && ds.every((d) => d.status === s || d.status === "cancelado");
  let status = "rascunho";
  if (todos("publicado")) status = "publicado";
  else if (tem("processando")) status = "publicando";
  else if (tem("publicado") && (tem("erro") || tem("pendente") || tem("agendado"))) status = "parcial";
  else if (tem("erro")) status = "erro";
  else if (tem("agendado")) status = "agendado";
  else if (tem("pendente")) status = "publicando";
  db.prepare("UPDATE posts SET status=?, atualizado=? WHERE id=?").run(status, agora(), postId);
}

/* ==========================================================================
   WEBHOOKS — avisar o site que mandou publicar

   Vive em TABELA e não num "dispara e esquece": o site do cliente pode estar
   fora do ar justamente na hora em que o post entra. Sem fila, o aviso se
   perderia e o painel dele ficaria mostrando "publicando" para sempre.

   A assinatura é a mesma ideia do conector, na direção contrária: HMAC do
   segredo do cliente sobre `${timestamp}.${corpo}`. Assim o site tem como
   provar que o aviso veio mesmo daqui.
   ========================================================================== */
const WEBHOOK_TENTATIVAS = 5;

function enfileirarWebhook(clienteId, url, evento, corpo, { postId = null, destinoId = null } = {}) {
  if (!url || !clienteId) return;
  try {
    db.prepare(`INSERT INTO webhooks(cliente_id,post_id,destino_id,url,evento,corpo,status,criado,atualizado)
                VALUES(?,?,?,?,?,?,'pendente',?,?)`)
      .run(clienteId, postId, destinoId, url, evento, JSON.stringify(corpo), agora(), agora());
  } catch (e) { registrar("aviso", "Não consegui enfileirar o webhook: " + e.message, { postId }); }
}

/* Monta e enfileira o aviso de um destino que acabou de terminar. */
function avisarDestino(destino, post) {
  if (!post?.cliente_id || !post.callback_url) return;
  const publicadosRestantes = db.prepare(
    "SELECT COUNT(*) c FROM destinos WHERE post_id=? AND status IN ('pendente','agendado','processando')").get(post.id).c;
  enfileirarWebhook(post.cliente_id, post.callback_url,
    destino.status === "publicado" ? "publicacao.destino.publicado" : "publicacao.destino.erro", {
      evento: destino.status === "publicado" ? "publicacao.destino.publicado" : "publicacao.destino.erro",
      publicacao_id: post.id, origem_ref: post.origem_ref || null,
      plataforma: destino.plataforma, conta_id: destino.conta_id,
      status: destino.status, url: destino.url_externa || null, erro: destino.erro || null,
      tentativas: destino.tentativas, concluida: publicadosRestantes === 0, em: agora(),
    }, { postId: post.id, destinoId: destino.id });
}

async function processarWebhooks() {
  const agoraIso = agora();
  const pendentes = db.prepare(`SELECT * FROM webhooks WHERE status='pendente'
    AND (proxima_tentativa IS NULL OR proxima_tentativa <= ?) ORDER BY id LIMIT 20`).all(agoraIso);
  for (const w of pendentes) {
    const cliente = db.prepare("SELECT * FROM clientes_api WHERE id=?").get(w.cliente_id);
    if (!cliente || !cliente.ativo) {
      db.prepare("UPDATE webhooks SET status='cancelado', resposta='cliente inativo', atualizado=? WHERE id=?").run(agora(), w.id);
      continue;
    }
    const segredo = decifrar(cliente.segredo);
    const ts = Math.floor(Date.now() / 1000);
    const assinatura = "sha256=" + crypto.createHmac("sha256", segredo).update(`${ts}.${w.corpo}`).digest("hex");
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 20_000);
    let ok = false, resposta = "";
    try {
      const r = await fetch(w.url, {
        method: "POST", signal: ac.signal, body: w.corpo,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-LAP-Timestamp": String(ts), "X-LAP-Assinatura": assinatura,
          "X-LAP-Evento": w.evento, "User-Agent": "LA-Publisher",
        },
      });
      ok = r.ok;
      resposta = `HTTP ${r.status}`;
    } catch (e) { resposta = e.name === "AbortError" ? "tempo esgotado" : e.message; }
    clearTimeout(t);

    const tentativas = (w.tentativas || 0) + 1;
    if (ok) {
      db.prepare("UPDATE webhooks SET status='entregue', tentativas=?, resposta=?, atualizado=? WHERE id=?")
        .run(tentativas, resposta, agora(), w.id);
    } else if (tentativas >= WEBHOOK_TENTATIVAS) {
      db.prepare("UPDATE webhooks SET status='falhou', tentativas=?, resposta=?, atualizado=? WHERE id=?")
        .run(tentativas, resposta, agora(), w.id);
      registrar("aviso", `Webhook de ${cliente.nome} falhou ${tentativas}× (${resposta}). O site pode consultar por GET /api/v1/publicacoes/${w.post_id}.`,
        { postId: w.post_id });
    } else {
      const espera = Math.pow(5, tentativas - 1);           // 1min, 5min, 25min, ~2h
      db.prepare("UPDATE webhooks SET tentativas=?, resposta=?, proxima_tentativa=?, atualizado=? WHERE id=?")
        .run(tentativas, resposta, new Date(Date.now() + espera * 60_000).toISOString(), agora(), w.id);
    }
  }
  return pendentes.length;
}

/* --------------------------- laço de trabalho ----------------------------- */
let rodando = false;

async function processarUmaVez() {
  if (rodando) return 0;
  rodando = true;
  let feitos = 0;
  try {
    const agoraIso = agora();
    const pendentes = db.prepare(`
      SELECT * FROM destinos
       WHERE status IN ('pendente','agendado')
         AND (agendado_para IS NULL OR agendado_para = '' OR agendado_para <= ?)
         AND (proxima_tentativa IS NULL OR proxima_tentativa = '' OR proxima_tentativa <= ?)
       ORDER BY post_id, id`).all(agoraIso, agoraIso);

    /* Respeita a ordem por plataforma dentro de cada post. */
    pendentes.sort((a, b) => a.post_id - b.post_id
      || ORDEM_PUBLICACAO.indexOf(a.plataforma) - ORDEM_PUBLICACAO.indexOf(b.plataforma));

    for (const d of pendentes) {
      /* Trava otimista: marca processando e só segue se ninguém marcou antes. */
      const t = db.prepare("UPDATE destinos SET status='processando', atualizado=? WHERE id=? AND status IN ('pendente','agendado')")
        .run(agora(), d.id);
      if (!t.changes) continue;
      atualizarStatusPost(d.post_id);
      registrar("info", `Publicando em ${PLATAFORMAS[d.plataforma]?.rotulo || d.plataforma}…`,
        { postId: d.post_id, destinoId: d.id, plataforma: d.plataforma });

      try {
        const r = await publicarDestino(d);
        db.prepare(`UPDATE destinos SET status='publicado', externo_id=?, url_externa=?, erro=NULL,
                    publicado_em=?, atualizado=? WHERE id=?`)
          .run(String(r.externo_id || ""), r.url || "", agora(), agora(), d.id);
        registrar("ok", r.aviso || `Publicado em ${PLATAFORMAS[d.plataforma]?.rotulo || d.plataforma}.`,
          { postId: d.post_id, destinoId: d.id, plataforma: d.plataforma, detalhe: r.url || "" });
        feitos++;
      } catch (e) {
        const tentativas = (d.tentativas || 0) + 1;
        const permanente = e.permanente === true || (e.permanente !== false && e.status >= 400 && e.status < 500 && e.status !== 429);
        const desiste = permanente || tentativas >= TENTATIVAS_MAX;
        if (desiste) {
          db.prepare("UPDATE destinos SET status='erro', erro=?, tentativas=?, atualizado=? WHERE id=?")
            .run(String(e.message).slice(0, 500), tentativas, agora(), d.id);
          registrar("erro", `${PLATAFORMAS[d.plataforma]?.rotulo || d.plataforma}: ${e.message}`,
            { postId: d.post_id, destinoId: d.id, plataforma: d.plataforma, detalhe: e.detalhe || "" });
        } else {
          const espera = ESPERA_BASE_MIN * Math.pow(4, tentativas - 1);   // 5min → 20min → 1h20
          const quando = new Date(Date.now() + espera * 60_000).toISOString();
          db.prepare("UPDATE destinos SET status='pendente', erro=?, tentativas=?, proxima_tentativa=?, atualizado=? WHERE id=?")
            .run(String(e.message).slice(0, 500), tentativas, quando, agora(), d.id);
          registrar("aviso", `${PLATAFORMAS[d.plataforma]?.rotulo || d.plataforma}: ${e.message} — nova tentativa em ${espera} min (${tentativas}/${TENTATIVAS_MAX}).`,
            { postId: d.post_id, destinoId: d.id, plataforma: d.plataforma, detalhe: e.detalhe || "" });
        }
        if (e.status === 401 || e.status === 403) {
          db.prepare("UPDATE contas SET ultimo_erro=? WHERE id=?")
            .run("Autorização recusada — reconecte a conta.", d.conta_id);
        }
      }
      atualizarStatusPost(d.post_id);
      /* Matéria que veio da API avisa o site assim que o destino conclui —
         sucesso ou erro. Reler o destino é de propósito: o estado gravado é
         o que vale, não a variável em memória. */
      const post = db.prepare("SELECT * FROM posts WHERE id=?").get(d.post_id);
      const atual = db.prepare("SELECT * FROM destinos WHERE id=?").get(d.id);
      if (atual && ["publicado", "erro"].includes(atual.status)) avisarDestino(atual, post);
    }
  } finally { rodando = false; }
  /* Entregar os avisos no mesmo tique: quem está esperando resposta é o
     painel de outra pessoa. */
  try { await processarWebhooks(); } catch (e) { registrar("erro", "Falha ao entregar webhooks: " + e.message); }
  return feitos;
}

let timer = null;
function iniciar({ intervaloSegundos = 30 } = {}) {
  if (timer) return;
  /* unref: a fila não segura o processo de encerrar. */
  timer = setInterval(() => { processarUmaVez().catch((e) => registrar("erro", "Falha no laço da fila: " + e.message)); }, intervaloSegundos * 1000);
  timer.unref?.();
  setTimeout(() => processarUmaVez().catch(() => { }), 3000).unref?.();
}
const parar = () => { if (timer) { clearInterval(timer); timer = null; } };

/* Chamado pelo painel logo depois de enfileirar, para não esperar o tique. */
const acordar = () => { setTimeout(() => processarUmaVez().catch(() => { }), 200).unref?.(); };

module.exports = {
  iniciar, parar, acordar, processarUmaVez, atualizarStatusPost,
  urlPublica, urlDe, caminhoDe, MIDIA_DIR, carregarConta, gravarTokens, appDe, garantirToken,
  TENTATIVAS_MAX, ORDEM_PUBLICACAO,
  enfileirarWebhook, processarWebhooks, avisarDestino, WEBHOOK_TENTATIVAS,
};
