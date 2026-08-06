/* ==========================================================================
   plataformas/http.js — utilidades de rede compartilhadas pelos adaptadores.

   Regras da casa:
   · SEMPRE com timeout (AbortController). API de rede social que pendura a
     conexão travaria o worker da fila inteiro.
   · O erro devolvido é sempre um Error com .status e .detalhe — a fila decide
     pelo status se vale retentar (5xx/429 sim; 4xx de conteúdo não).
   · Nada de segredo no log: o token entra por cabeçalho e o resumo do erro
     passa por mascarar().
   ========================================================================== */

const TIMEOUT_PADRAO = 30_000;

class ErroApi extends Error {
  constructor(mensagem, { status = 0, detalhe = "", plataforma = "", permanente = null } = {}) {
    super(mensagem);
    this.name = "ErroApi";
    this.status = status;
    this.detalhe = detalhe;
    this.plataforma = plataforma;
    /* permanente = não adianta tentar de novo (conteúdo inválido, permissão
       negada). null = decide pelo status. */
    this.permanente = permanente === null ? (status >= 400 && status < 500 && status !== 429 && status !== 408) : permanente;
  }
}

/* Esconde tokens em qualquer texto que vá para o log/tela. */
function mascarar(t) {
  return String(t || "")
    .replace(/(access_token=)[^&\s"']+/gi, "$1***")
    .replace(/(client_secret=)[^&\s"']+/gi, "$1***")
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1***")
    .replace(/"(access_token|refresh_token|client_secret|token)"\s*:\s*"[^"]*"/gi, '"$1":"***"')
    .slice(0, 4000);
}

async function pedir(url, { metodo = "GET", cabecalhos = {}, corpo = null, timeout = TIMEOUT_PADRAO, plataforma = "", cru = false, duplex } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  let r;
  try {
    /* duplex:"half" é exigido pelo fetch quando o corpo é um stream (upload de
       vídeo grande sem carregar o arquivo inteiro na memória). */
    const op = { method: metodo, headers: cabecalhos, body: corpo, signal: ac.signal, redirect: "follow" };
    if (duplex) op.duplex = duplex;
    r = await fetch(url, op);
  } catch (e) {
    clearTimeout(t);
    /* Rede caiu / timeout: é transitório, a fila deve tentar de novo. */
    throw new ErroApi(e.name === "AbortError" ? "A plataforma não respondeu a tempo." : "Falha de rede ao falar com a plataforma.",
      { status: 0, detalhe: mascarar(e.message), plataforma, permanente: false });
  }
  clearTimeout(t);

  if (cru) return r;
  const texto = await r.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : {}; } catch { dados = { _texto: texto }; }

  if (!r.ok) {
    const msg = dados?.error?.message || dados?.error?.error_description || dados?.error_description
      || dados?.error?.code || dados?.message || `HTTP ${r.status}`;
    throw new ErroApi(String(msg).slice(0, 400), { status: r.status, detalhe: mascarar(texto), plataforma });
  }
  return dados;
}

const form = (obj) => new URLSearchParams(
  Object.entries(obj).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])
).toString();

const comQuery = (base, obj) => `${base}${base.includes("?") ? "&" : "?"}${form(obj)}`;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { pedir, form, comQuery, esperar, ErroApi, mascarar, TIMEOUT_PADRAO };
