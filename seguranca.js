/* ==========================================================================
   seguranca.js — autenticação, sessão, perfis e higienização de HTML.

   Portado do /restrito da BemEstarClinic (auditado em 2026-07-24, 69/69 no
   pentest) com o que este sistema pede a mais:

     · COFRE para os tokens das redes            → banco.js
     · CSRF por cabeçalho próprio                → exigeCsrf()
     · HIGIENIZAÇÃO do HTML das matérias         → sanitizarHtml()
       (aqui o conteúdo é HTML escrito à mão e vai parar em sites públicos de
        terceiros — sem isso, um redator mal-intencionado, ou um texto colado
        de fora, viraria XSS armazenado no site do cliente)
     · AUDITORIA de ação sensível                → banco.auditar()
   ========================================================================== */
const crypto = require("node:crypto");
const { db, agora } = require("./banco");

/* --------------------------- senha (scrypt) ------------------------------ */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(senha), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${dk.toString("hex")}`;
}
const iguais = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
function confereSenha(senha, guardado) {
  if (!guardado || !guardado.startsWith("scrypt$")) return false;
  const [, N, r, p, saltHex, dkHex] = guardado.split("$");
  const dk = crypto.scryptSync(String(senha), Buffer.from(saltHex, "hex"), dkHex.length / 2, { N: +N, r: +r, p: +p });
  return iguais(Buffer.from(dkHex, "hex"), dk);
}
/* Hash descartável: quando o login digitado NÃO existe, conferimos a senha
   contra ele só para gastar o mesmo tempo. Sem isso, "usuário inexistente"
   responde em ~1ms e "usuário certo, senha errada" em ~100ms — diferença que
   permite descobrir logins válidos por cronômetro. (Falha real encontrada no
   pentest do BemEstarClinic; não repetir.) */
const HASH_ISCA = hashSenha(crypto.randomBytes(16).toString("hex"));

/* ------------------------------- sessões --------------------------------- */
const SESSAO_HORAS = 8;
const sessoes = new Map();      // sid -> { userId, perfil, nome, csrf, ts }

function novaSessao(u) {
  const sid = crypto.randomBytes(24).toString("hex");
  sessoes.set(sid, {
    userId: u.id, perfil: u.perfil, nome: u.nome,
    csrf: crypto.randomBytes(24).toString("hex"), ts: Date.now(),
  });
  return sid;
}
function sessao(req) {
  const m = /(?:^|;\s*)lap=([a-f0-9]+)/.exec(req.headers.cookie || "");
  if (!m) return null;
  const s = sessoes.get(m[1]);
  if (!s) return null;
  if (Date.now() - s.ts > SESSAO_HORAS * 3600_000) { sessoes.delete(m[1]); return null; }
  s.ts = Date.now();                                   // sessão desliza enquanto usa
  return { sid: m[1], ...s };
}
function encerrarSessao(sid) { sessoes.delete(sid); }
function derrubarSessoesDoUsuario(userId, menos) {
  for (const [k, v] of sessoes) if (v.userId === userId && k !== menos) sessoes.delete(k);
}
setInterval(() => {
  const lim = Date.now() - SESSAO_HORAS * 3600_000;
  for (const [k, v] of sessoes) if (v.ts < lim) sessoes.delete(k);
}, 30 * 60_000).unref();

const cookieSessao = (sid, https) =>
  `lap=${sid}; HttpOnly; SameSite=Lax; Path=/restrito; Max-Age=${SESSAO_HORAS * 3600}${https ? "; Secure" : ""}`;
const cookieMorto = "lap=; HttpOnly; SameSite=Lax; Path=/restrito; Max-Age=0";

/* ------------------------ trava de força bruta --------------------------- */
const TENT_MAX = 5, BLOQ_MIN = 15;
const tentativas = new Map();
function bloqueado(ip) {
  const t = tentativas.get(ip);
  if (!t) return false;
  if (Date.now() - t.ts > BLOQ_MIN * 60_000) { tentativas.delete(ip); return false; }
  return t.n >= TENT_MAX;
}
function erroLogin(ip) {
  const t = tentativas.get(ip) || { n: 0, ts: Date.now() };
  t.n++; t.ts = Date.now(); tentativas.set(ip, t);
}
const limparTentativas = (ip) => tentativas.delete(ip);

/* --------------------------------- CSRF ----------------------------------
   SameSite=Lax já barra o POST vindo de outro site, mas ele é a ÚNICA
   barreira e depende do navegador. O painel manda o token da sessão no
   cabeçalho X-LAP-CSRF; um formulário forjado em outro domínio não consegue
   pôr cabeçalho próprio numa requisição cross-site sem passar pelo preflight
   do CORS — que não liberamos. Duas travas independentes. */
function exigeCsrf(req, s) {
  if (req.method === "GET" || req.method === "HEAD") return true;
  return String(req.headers["x-lap-csrf"] || "") === s.csrf;
}

/* ------------------------------- perfis -----------------------------------
   admin    → tudo, inclusive usuários, contas conectadas e credenciais de app
   editor   → cria matéria, envia mídia e PUBLICA
   redator  → cria e edita matéria; NÃO publica nem agenda, NÃO vê credenciais
   O painel esconde o que o perfil não pode; quem MANDA é esta checagem. */
const PERFIS = ["admin", "editor", "redator"];
const PERM = {
  admin: "*",
  editor: new Set(["posts", "midias", "destinos", "publicar", "contas_ler", "logs", "painel"]),
  redator: new Set(["posts", "midias", "painel"]),
};
const pode = (perfil, acao) => perfil === "admin" || (PERM[perfil] ? PERM[perfil].has(acao) : false);
const adminsAtivos = () => db.prepare("SELECT COUNT(*) c FROM usuarios WHERE perfil='admin' AND ativo=1").get().c;

/* ------------------------------ utilidades -------------------------------- */
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/* ==========================================================================
   IP do cliente — atrás do nginx, e sem acreditar no que o visitante escreve.

   O nginx monta `X-Forwarded-For: <o que o cliente mandou>, <IP real>` — ele
   ACRESCENTA NO FIM. Ler o PRIMEIRO item é ler texto do próprio atacante:
   mandando um valor diferente a cada tentativa, cada erro de senha cai num
   "IP" novo e a trava de 5 tentativas nunca dispara.

   Isso não é hipótese: foi encontrado em produção em quatro servidores nossos
   (BemEstarClinic, Kenósis ×2 e Forms Fitness) em 2026-07-29. Aqui já nasce
   certo:
     1. cabeçalho só é considerado quando quem abriu o socket é o proxy local;
     2. preferimos o X-Real-IP, que o nginx SOBRESCREVE (o cliente não consegue
        acrescentar nada nele);
     3. na falta dele, o ÚLTIMO item do X-Forwarded-For — o que o nginx pôs.
   ========================================================================== */
const DO_PROXY = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
function clientIp(req) {
  const socket = req.socket?.remoteAddress || "";
  if (!DO_PROXY.has(socket)) return socket;          // sem proxy na frente: o socket é a verdade
  const real = String(req.headers["x-real-ip"] || "").trim();
  if (real) return real;
  const lista = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return lista.length ? lista[lista.length - 1] : socket;
}

/* Nome de arquivo enviado pelo usuário → nome seguro no disco. Só letras,
   números, ponto, hífen e sublinhado; nenhuma sequência de pontos. */
function nomeArquivoSeguro(nome, ext) {
  const base = String(nome || "arq").replace(/\.[^.]*$/, "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-").replace(/\.{2,}/g, ".")
    .replace(/^[.\-]+/, "").replace(/-{2,}/g, "-").slice(0, 40) || "arq";
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}-${base}${ext}`;
}

/* Campo que \u00e9 TEXTO, n\u00e3o HTML (t\u00edtulo, autor, fonte, errata). Tira qualquer
   tag antes de gravar. Sem isto, um t\u00edtulo com <script> ficaria guardado no
   banco esperando o dia em que algu\u00e9m o imprimisse sem escapar \u2014 e ele viaja
   para legendas, para o title do site e para o YouTube. `<` solto continua
   valendo (um t\u00edtulo "Lucro < previsto" \u00e9 leg\u00edtimo). */
const soTexto = (s) => String(s ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

const slugify = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);

/* ==========================================================================
   HIGIENIZAÇÃO DE HTML

   O resumo e o texto da matéria são HTML escrito no editor (ou colado de
   fora) e vão para o site público do cliente. Aceitar HTML cru seria abrir
   XSS armazenado na ORIGEM do site dele — o mesmo furo que o upload de SVG
   abriu no /admin da BemEstarClinic.

   Estratégia: NADA passa por confiança. O texto é quebrado em pedaços e cada
   tag é REESCRITA a partir de uma lista de permissão; tudo o que não está na
   lista vira texto escapado. Assim não existe atributo, protocolo ou tag
   exótica que "sobreviva" — porque nada é copiado, tudo é reconstruído.
   ========================================================================== */
const TAGS_OK = new Set(["p", "br", "hr", "strong", "b", "em", "i", "u", "s", "sub", "sup",
  "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "a", "img", "figure",
  "figcaption", "span", "div", "code", "pre", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "small"]);
const VAZIAS = new Set(["br", "hr", "img"]);
const ATRIB_OK = {
  a: ["href", "title", "target", "rel"],
  img: ["src", "alt", "title", "width", "height", "loading"],
  th: ["colspan", "rowspan"], td: ["colspan", "rowspan"],
  "*": ["class"],
};
/* Tags cujo CONTEÚDO também é jogado fora (não basta tirar a tag). */
const TAGS_COM_MIOLO = /<(script|style|iframe|object|embed|svg|math|noscript|template|form|input|button|link|meta|base)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

function urlSegura(u, permitirDados) {
  const v = String(u || "").trim().replace(/[\u0000-\u0020]/g, "");
  if (!v) return null;
  if (/^(https?:)?\/\//i.test(v)) return v;               // http, https, //
  if (/^\/[^/]/.test(v) || /^\.{0,2}\//.test(v)) return v; // caminho relativo/absoluto do próprio site
  if (/^(mailto|tel):[^\s<>"']+$/i.test(v)) return v;
  if (permitirDados && /^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(v)) return v;
  return null;                                             // javascript:, vbscript:, data:text/html… caem aqui
}

function sanitizarHtml(entrada) {
  if (!entrada) return "";
  let html = String(entrada);
  if (html.length > 500_000) html = html.slice(0, 500_000);
  html = html.replace(/<!--[\s\S]*?-->/g, "").replace(TAGS_COM_MIOLO, "");

  const saida = [];
  const pilha = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>?/g;
  let pos = 0, m;

  while ((m = re.exec(html)) !== null) {
    if (m.index > pos) saida.push(esc(html.slice(pos, m.index)));  // texto entre tags: sempre escapado
    pos = re.lastIndex;

    const fechando = m[0][1] === "/";
    const tag = m[1].toLowerCase();
    if (!TAGS_OK.has(tag)) continue;                                // tag fora da lista: some (miolo fica)

    if (fechando) {
      const i = pilha.lastIndexOf(tag);
      if (i === -1) continue;                                       // fechamento órfão: descarta
      while (pilha.length > i) saida.push(`</${pilha.pop()}>`);      // fecha o que ficou aberto no meio
      continue;
    }

    /* atributos: um a um, só os da lista, com valor revalidado */
    const permitidos = new Set([...(ATRIB_OK[tag] || []), ...ATRIB_OK["*"]]);
    const attrs = [];
    const rea = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))|([a-zA-Z][a-zA-Z0-9-]*)/g;
    let a;
    while ((a = rea.exec(m[2] || "")) !== null) {
      const nome = (a[1] || a[5] || "").toLowerCase();
      if (!permitidos.has(nome)) continue;                          // on*, style, srcset… nunca entram
      let valor = a[2] ?? a[3] ?? a[4] ?? "";
      if (nome === "href" || nome === "src") {
        const u = urlSegura(valor, tag === "img");
        if (!u) continue;
        valor = u;
      } else if (nome === "class") {
        valor = valor.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 120);
        if (!valor) continue;
      } else if (nome === "target") {
        valor = valor === "_blank" ? "_blank" : "_self";
      } else if (nome === "rel") {
        valor = valor.replace(/[^a-zA-Z ]/g, "").slice(0, 60);
      } else if (["width", "height", "colspan", "rowspan"].includes(nome)) {
        if (!/^\d{1,5}$/.test(valor)) continue;
      } else if (nome === "loading") {
        valor = valor === "lazy" ? "lazy" : "eager";
      } else {
        valor = valor.slice(0, 300);
      }
      attrs.push(` ${nome}="${esc(valor)}"`);
    }
    /* link para fora sempre com rel de segurança: sem noopener, a página de
       destino recebe window.opener e pode redirecionar a aba de origem. */
    if (tag === "a" && attrs.some((x) => x.includes('target="_blank"')) && !attrs.some((x) => x.startsWith(" rel=")))
      attrs.push(' rel="noopener noreferrer"');

    const auto = /\/\s*>$/.test(m[0]);
    if (VAZIAS.has(tag) || auto) { saida.push(`<${tag}${attrs.join("")}>`); continue; }
    saida.push(`<${tag}${attrs.join("")}>`);
    pilha.push(tag);
    if (pilha.length > 60) { /* aninhamento absurdo: para de abrir */ pilha.pop(); saida.push(`</${tag}>`); }
  }
  if (pos < html.length) saida.push(esc(html.slice(pos)));
  while (pilha.length) saida.push(`</${pilha.pop()}>`);              // fecha o que sobrou aberto
  return saida.join("");
}

/* HTML → texto puro (legendas das redes, que não entendem marcação). */
const htmlParaTexto = (h) => String(h || "")
  .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, "\n")
  .replace(/<li[^>]*>/gi, "• ").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/* Semente do primeiro administrador. */
function semearAdmin() {
  if (db.prepare("SELECT COUNT(*) c FROM usuarios").get().c === 0) {
    const senha = process.env.LAP_SENHA_INICIAL || "publisher-2026";
    db.prepare("INSERT INTO usuarios(nome,email,senha_hash,perfil,ativo,criado) VALUES(?,?,?,?,1,?)")
      .run("Administrador", "admin", hashSenha(senha), "admin", agora());
    console.log(`  · usuário inicial criado — login: admin · senha: ${senha}`);
    console.log("    TROQUE a senha no primeiro acesso (menu da conta → Minha senha).");
  }
}

module.exports = {
  hashSenha, confereSenha, HASH_ISCA,
  novaSessao, sessao, encerrarSessao, derrubarSessoesDoUsuario, cookieSessao, cookieMorto, SESSAO_HORAS,
  bloqueado, erroLogin, limparTentativas, TENT_MAX, BLOQ_MIN,
  exigeCsrf, PERFIS, PERM, pode, adminsAtivos,
  esc, clientIp, nomeArquivoSeguro, slugify, soTexto, sanitizarHtml, htmlParaTexto, urlSegura,
  semearAdmin, sessoes,
};
