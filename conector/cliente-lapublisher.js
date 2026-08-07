/* ==========================================================================
   cliente-lapublisher.js — o SITE falando com o LA Publisher
   (copie para a raiz do site, ao lado do server.js)

   Não confundir com o outro arquivo desta pasta:

     lapublisher.js          ← o LA Publisher EMPURRA a matéria para o site
     cliente-lapublisher.js  ← o SITE MANDA o LA Publisher publicar nas redes
                               (este aqui)

   Os dois podem conviver. Este é o que serve ao fluxo "escrevi a notícia no
   painel do meu site e quero que ela vá para o Instagram e o Facebook".

   INSTALAÇÃO
     1. copie este arquivo para a raiz do site
     2. no server.js:
          const { LaPublisher } = require("./cliente-lapublisher");
          const lap = new LaPublisher();       // lê as variáveis de ambiente
     3. defina no systemd do site:
          Environment=LAP_URL=https://publisher.luizaugust.me
          Environment=LAP_CHAVE=lap_xxxxxxxx
          Environment=LAP_SEGREDO=xxxxxxxx

   Sem dependência de npm. Node ≥ 18 (usa o fetch nativo).
   ========================================================================== */
const crypto = require("node:crypto");

class ErroLaPublisher extends Error {
  constructor(mensagem, status, dados) {
    super(mensagem);
    this.name = "ErroLaPublisher";
    this.status = status;
    this.dados = dados;
  }
}

class LaPublisher {
  constructor({ url, chave, segredo, timeout = 60_000 } = {}) {
    this.url = (url || process.env.LAP_URL || "").replace(/\/+$/, "");
    this.chave = chave || process.env.LAP_CHAVE || "";
    this.segredo = segredo || process.env.LAP_SEGREDO || "";
    this.timeout = timeout;
    this.configurado = !!(this.url && this.chave && this.segredo);
    if (!this.configurado) {
      console.warn("  ! LA Publisher: LAP_URL, LAP_CHAVE ou LAP_SEGREDO ausente — a publicação nas redes fica desligada.");
    }
  }

  /* A assinatura cobre método + caminho (com query) + corpo + horário. Trocar
     qualquer um deles invalida — e ela vale 5 minutos, então gravar a
     requisição de um log não serve para repetir depois. */
  _assinar(ts, metodo, caminho, corpo) {
    return "sha256=" + crypto.createHmac("sha256", this.segredo)
      .update(`${ts}.${metodo}.${caminho}.${corpo || ""}`).digest("hex");
  }

  async _chamar(metodo, caminho, corpo) {
    if (!this.configurado) throw new ErroLaPublisher("LA Publisher não configurado neste site.", 0, null);
    const cru = corpo === undefined ? "" : JSON.stringify(corpo);
    const ts = Math.floor(Date.now() / 1000);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeout);
    let r;
    try {
      r = await fetch(this.url + caminho, {
        method: metodo, signal: ac.signal, body: cru || undefined,
        headers: {
          ...(cru ? { "Content-Type": "application/json; charset=utf-8" } : {}),
          "X-LAP-Chave": this.chave,
          "X-LAP-Timestamp": String(ts),
          "X-LAP-Assinatura": this._assinar(ts, metodo, caminho, cru),
          "User-Agent": "cliente-lapublisher",
        },
      });
    } catch (e) {
      clearTimeout(t);
      throw new ErroLaPublisher(
        e.name === "AbortError" ? "O LA Publisher não respondeu a tempo." : "Não consegui falar com o LA Publisher.",
        0, null);
    }
    clearTimeout(t);
    const txt = await r.text();
    let d = null;
    try { d = txt ? JSON.parse(txt) : {}; } catch { d = { _texto: txt.slice(0, 300) }; }
    if (!r.ok) throw new ErroLaPublisher(d?.erro || `HTTP ${r.status}`, r.status, d);
    return d;
  }

  /* ------------------------------ consultas ------------------------------ */
  ping() { return this._chamar("GET", "/api/v1/ping"); }
  regras() { return this._chamar("GET", "/api/v1/plataformas"); }

  /* Contas que ESTE site pode usar. É com isto que se montam as caixinhas
     "publicar também no Instagram / Facebook" no painel do site. */
  async contas() { return (await this._chamar("GET", "/api/v1/contas")).contas; }

  desvincularConta(id) { return this._chamar("DELETE", `/api/v1/contas/${Number(id)}`); }

  /* ---------------------- conectar uma conta nova -----------------------
     Devolve uma URL para o dono da conta abrir. Ele autoriza na própria
     plataforma e a conta nasce amarrada a este site. Uso único, 30 minutos. */
  linkDeConexao({ plataforma = "facebook", retorno_url } = {}) {
    return this._chamar("POST", "/api/v1/conexoes", { plataforma, retorno_url });
  }

  /* ------------------------------ publicar ------------------------------
     `origem_ref` é o id da matéria NO SITE. Mande sempre: é ele que impede
     um segundo post quando a chamada é repetida por timeout ou clique
     dobrado — repetir devolve a publicação que já existe, sem republicar. */
  publicar({ origem_ref, titulo, resumo_html, texto_html, autor, fonte, fonte_url,
             errata, data_publicacao, midias, plataformas, destinos, opcoes,
             agendado_para, callback_url } = {}) {
    return this._chamar("POST", "/api/v1/publicacoes", {
      origem_ref: origem_ref === undefined ? undefined : String(origem_ref),
      titulo, resumo_html, texto_html, autor, fonte, fonte_url, errata, data_publicacao,
      midias, plataformas, destinos, opcoes, agendado_para, callback_url,
    });
  }

  status(id) { return this._chamar("GET", `/api/v1/publicacoes/${Number(id)}`); }
  porReferencia(ref) { return this._chamar("GET", `/api/v1/publicacoes?origem_ref=${encodeURIComponent(ref)}`); }
  retentar(id, plataforma) { return this._chamar("POST", `/api/v1/publicacoes/${Number(id)}/retentar`, plataforma ? { plataforma } : {}); }
  cancelar(id, plataforma) { return this._chamar("POST", `/api/v1/publicacoes/${Number(id)}/cancelar`, plataforma ? { plataforma } : {}); }

  /* ------------------------------ webhook -------------------------------
     Confere que o aviso veio mesmo do LA Publisher. Chame ANTES de acreditar
     no corpo — sem isso, qualquer um que descubra a URL do seu webhook pode
     dizer que a publicação deu certo.

       const cru = await lerCorpoCru(req);           // string, NÃO o objeto
       if (!lap.conferirWebhook(req.headers, cru)) return res.writeHead(401).end();
       const evento = JSON.parse(cru);
  */
  conferirWebhook(cabecalhos, corpoCru, janelaSegundos = 300) {
    const ts = Number(cabecalhos["x-lap-timestamp"] || cabecalhos["X-LAP-Timestamp"] || 0);
    const assinatura = String(cabecalhos["x-lap-assinatura"] || cabecalhos["X-LAP-Assinatura"] || "");
    if (!ts || Math.abs(Math.floor(Date.now() / 1000) - ts) > janelaSegundos) return false;
    const esperada = "sha256=" + crypto.createHmac("sha256", this.segredo).update(`${ts}.${corpoCru}`).digest("hex");
    const a = Buffer.from(assinatura), b = Buffer.from(esperada);
    /* Comparação em tempo constante: comparar com === vaza, byte a byte,
       quanto do prefixo está certo. */
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}

module.exports = { LaPublisher, ErroLaPublisher };
