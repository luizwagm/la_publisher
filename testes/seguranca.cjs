/* ==========================================================================
   testes/seguranca.cjs — bateria de segurança do LA Publisher

   Como rodar (SEMPRE numa porta e num banco separados, nunca no do cliente):

     PORT=5191 LAP_DATA=/tmp/lap-teste node server.js     # noutro terminal
     node testes/seguranca.cjs

   No Windows (PowerShell):
     $env:PORT=5191; $env:LAP_DATA="$env:TEMP\lap-teste"; node server.js
     node testes\seguranca.cjs

   A ORDEM DOS TESTES IMPORTA. A trava de força bruta é por IP e dura 15
   minutos: se ela disparar no meio, TODOS os testes seguintes falham com 429
   e você perde a tarde procurando bug que não existe. Por isso o teste de
   força bruta é o ÚLTIMO — e, depois dele, o servidor precisa ser reiniciado
   antes de qualquer outra coisa.
   ========================================================================== */
const BASE = process.env.ALVO || "http://127.0.0.1:5191";
const SENHA = process.env.SENHA || "publisher-2026";
let ok = 0, falhou = 0;
const res = [];
function checar(nome, condicao, detalhe) {
  if (condicao) { ok++; res.push(`  ok    ${nome}`); }
  else { falhou++; res.push(`  FALHA ${nome}${detalhe ? " → " + detalhe : ""}`); }
}
let COOKIE = "", CSRF = "";
async function req(rota, { metodo = "GET", corpo, cabecalhos = {}, semCsrf, cookie } = {}) {
  const h = { ...cabecalhos };
  const ck = cookie !== undefined ? cookie : COOKIE;
  if (ck) h.Cookie = ck;
  if (!semCsrf && CSRF) h["X-LAP-CSRF"] = CSRF;
  if (corpo !== undefined) h["Content-Type"] = "application/json";
  const r = await fetch(BASE + rota, {
    method: metodo, headers: h,
    body: corpo === undefined ? undefined : JSON.stringify(corpo), redirect: "manual",
  });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = { _texto: t }; }
  return { status: r.status, dados: d, texto: t, cab: r.headers };
}
/* PNG com IHDR de verdade — serve para conferir a medição de dimensão. */
function png(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write("IHDR", 4);
  ihdr.writeUInt32BE(w, 8); ihdr.writeUInt32BE(h, 12);
  ihdr[16] = 8; ihdr[17] = 6;
  return Buffer.concat([sig, ihdr, Buffer.alloc(200)]);
}

(async () => {
  console.log(`\n== LA Publisher — bateria de segurança (${BASE}) ==\n`);

  /* ---------------- 1. acesso sem autenticação ---------------- */
  for (const rota of ["painel", "posts", "contas", "usuarios", "apps", "config", "logs", "auditoria", "fila"]) {
    const r = await req("/restrito/api/" + rota);
    checar(`sem sessão: /api/${rota} responde 401`, r.status === 401, "status " + r.status);
  }

  /* ---------------- 2. arquivos que não podem ser servidos ---------------- */
  for (const rota of ["/server.js", "/painel.js", "/publico.js", "/data/publisher.db", "/data/.chave",
                      "/.gitignore", "/package.json", "/restrito/app.html", "/conector/lapublisher.js",
                      "/testes/seguranca.cjs", "/midia/../data/publisher.db",
                      "/midia/..%2f..%2fdata%2fpublisher.db", "/.git/config"]) {
    const r = await req(rota);
    checar(`não serve ${rota}`, r.status === 404 || r.status === 400, "status " + r.status);
  }

  /* ---------------- 3. cabeçalhos de segurança ---------------- */
  {
    const r = await req("/restrito/");
    checar("painel: nosniff", r.cab.get("x-content-type-options") === "nosniff");
    checar("painel: X-Frame-Options DENY", r.cab.get("x-frame-options") === "DENY");
    checar("painel: CSP presente", /frame-ancestors 'none'/.test(r.cab.get("content-security-policy") || ""));
    checar("painel: noindex", /noindex/.test(r.cab.get("x-robots-tag") || ""));
    checar("painel: sem CORS aberto", !r.cab.get("access-control-allow-origin"));
  }

  /* ------- 4. páginas públicas exigidas pelas plataformas ------- */
  {
    for (const rota of ["/privacidade", "/exclusao-de-dados"]) {
      const r = await req(rota);
      checar(`${rota} abre para qualquer um (200)`, r.status === 200, "status " + r.status);
      checar(`${rota} é indexável (a Meta confere a URL)`, /index/.test(r.cab.get("x-robots-tag") || ""), r.cab.get("x-robots-tag"));
      checar(`${rota} sem script nenhum`, !/<script/i.test(r.texto));
      checar(`${rota} com CSP fechada`, /default-src 'none'/.test(r.cab.get("content-security-policy") || ""));
      const post = await req(rota, { metodo: "POST" });
      checar(`${rota} recusa POST (405)`, post.status === 405, "status " + post.status);
    }
    const rp = await req("/privacidade");
    checar("privacidade cita as três plataformas", /Meta/.test(rp.texto) && /Google/.test(rp.texto) && /TikTok/.test(rp.texto));
    checar("privacidade fala dos direitos da LGPD", /LGPD/.test(rp.texto));
    const re = await req("/exclusao-de-dados");
    checar("exclusão ensina a revogar em cada plataforma",
      /myaccount\.google\.com\/permissions/.test(re.texto) && /tiktok/i.test(re.texto) && /facebook\.com\/settings/.test(re.texto));
    const rb = await req("/robots.txt");
    checar("robots.txt libera as duas páginas legais e fecha o resto",
      /Allow: \/privacidade/.test(rb.texto) && /Allow: \/exclusao-de-dados/.test(rb.texto) && /Disallow: \/$/m.test(rb.texto));
  }

  /* ---------------- 5. login ---------------- */
  {
    const mau = await req("/restrito/api/login", { metodo: "POST", corpo: { usuario: "admin", senha: "errada" } });
    checar("login com senha errada → 401", mau.status === 401, "status " + mau.status);
    checar("erro de login não diz se o usuário existe", /Usuário ou senha incorretos/.test(mau.dados.error || ""));

    const bom = await req("/restrito/api/login", { metodo: "POST", corpo: { usuario: "admin", senha: SENHA } });
    checar("login correto → 200", bom.status === 200, JSON.stringify(bom.dados).slice(0, 120));
    const sc = bom.cab.getSetCookie ? bom.cab.getSetCookie().join(";") : (bom.cab.get("set-cookie") || "");
    checar("cookie HttpOnly", /HttpOnly/i.test(sc));
    checar("cookie SameSite=Lax", /SameSite=Lax/i.test(sc));
    checar("cookie com Path isolado", /Path=\/restrito/i.test(sc));
    checar("cookie com Max-Age", /Max-Age=/i.test(sc));
    COOKIE = (sc.match(/lap=[a-f0-9]+/) || [""])[0];
    CSRF = bom.dados.csrf || "";
    checar("login devolve token CSRF", !!CSRF);
  }

  /* ---------------- 6. CSRF ---------------- */
  {
    const semTok = await req("/restrito/api/posts", { metodo: "POST", corpo: { titulo: "csrf" }, semCsrf: true });
    checar("POST sem cabeçalho CSRF → 403", semTok.status === 403, "status " + semTok.status);
    const errado = await req("/restrito/api/posts", { metodo: "POST", corpo: { titulo: "csrf" },
      cabecalhos: { "X-LAP-CSRF": "a".repeat(48) }, semCsrf: true });
    checar("POST com CSRF errado → 403", errado.status === 403, "status " + errado.status);
  }

  /* ---------------- 7. higienização de HTML (XSS armazenado) ---------------- */
  let postId;
  {
    const veneno = `<p>ok</p><script>alert(1)</script><img src=x onerror="alert(2)">
      <a href="javascript:alert(3)">clique</a><iframe src="//evil.com"></iframe>
      <svg onload=alert(4)></svg><p style="background:url(javascript:alert(5))">estilo</p>
      <a href="https://ok.com" target="_blank">externo</a><div onclick="alert(6)">div</div>`;
    const c = await req("/restrito/api/posts", { metodo: "POST",
      corpo: { titulo: "Teste <script>alert(7)</script>", resumo_html: veneno, texto_html: veneno } });
    checar("cria matéria → 200", c.status === 200, JSON.stringify(c.dados).slice(0, 150));
    postId = c.dados.id;
    const p = await req("/restrito/api/posts/" + postId);
    const h = (p.dados.resumo_html || "") + (p.dados.texto_html || "");
    checar("XSS: <script> removido", !/<script/i.test(h), h.slice(0, 120));
    checar("XSS: onerror removido", !/onerror/i.test(h));
    checar("XSS: onload removido", !/onload=/i.test(h));
    checar("XSS: onclick removido", !/onclick/i.test(h));
    checar("XSS: javascript: removido", !/javascript:/i.test(h));
    checar("XSS: <iframe> removido", !/<iframe/i.test(h));
    checar("XSS: <svg> removido", !/<svg/i.test(h));
    checar("XSS: style removido", !/style=/i.test(h));
    checar("higienização preserva o conteúdo legítimo", /<p>ok<\/p>/.test(h));
    checar("link externo ganha rel=noopener", /rel="noopener/.test(h), h.slice(0, 300));
    checar("título é texto puro (tag descartada)", !/<script/i.test(p.dados.titulo), p.dados.titulo);
  }

  /* ---------------- 8. upload ---------------- */
  {
    const enviar = (buf, tipo, nome) => fetch(`${BASE}/restrito/api/posts/${postId}/midia`, {
      method: "POST", body: buf,
      headers: { Cookie: COOKIE, "X-LAP-CSRF": CSRF, "Content-Type": tipo, "X-Nome": encodeURIComponent(nome) },
    });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');

    let r = await enviar(svg, "image/svg+xml", "x.svg");
    checar("upload: SVG recusado pelo tipo declarado", r.status === 415, "status " + r.status);
    r = await enviar(svg, "image/png", "disfarcado.png");
    checar("upload: SVG disfarçado de PNG recusado pelo conteúdo", r.status === 415, "status " + r.status);
    r = await enviar(Buffer.from("<?php system($_GET[c]); ?>"), "image/jpeg", "shell.php.jpg");
    checar("upload: PHP disfarçado de JPEG recusado", r.status === 415, "status " + r.status);

    r = await enviar(png(1080, 1350), "image/png", "../../escapar.png");
    const d = await r.json();
    checar("upload: PNG legítimo aceito", r.status === 200, JSON.stringify(d).slice(0, 150));
    checar("upload: nome de arquivo não escapa da pasta",
      d.midia && !d.midia.arquivo.includes("..") && !d.midia.arquivo.includes("/"), d.midia?.arquivo);
    checar("upload: dimensões medidas do cabeçalho",
      d.midia?.largura === 1080 && d.midia?.altura === 1350, `${d.midia?.largura}x${d.midia?.altura}`);
  }

  /* ---------------- 9. regras das plataformas ---------------- */
  {
    const checa = (destinos) => req(`/restrito/api/posts/${postId}/checar`, { metodo: "POST", corpo: { destinos } });

    let r = await checa([{ plataforma: "instagram", opcoes: { legenda: "oi" } }]);
    checar("regras: foto 4:5 passa no Instagram", r.dados.instagram?.erros.length === 0, JSON.stringify(r.dados.instagram));
    r = await checa([{ plataforma: "instagram", opcoes: { legenda: "x".repeat(2300) } }]);
    checar("regras: legenda acima de 2.200 é barrada", r.dados.instagram?.erros.some((e) => /2200|2\.200/.test(e)));
    r = await checa([{ plataforma: "instagram", opcoes: { legenda: Array.from({ length: 35 }, (_, i) => "#tag" + i).join(" ") } }]);
    checar("regras: mais de 30 hashtags é barrado", r.dados.instagram?.erros.some((e) => /hashtags/.test(e)));
    r = await checa([{ plataforma: "youtube", opcoes: { titulo: "t" } }]);
    checar("regras: YouTube sem vídeo é barrado", r.dados.youtube?.erros.some((e) => /vídeo/i.test(e)));
    r = await checa([{ plataforma: "youtube", opcoes: { titulo: "x".repeat(120) } }]);
    checar("regras: título do YouTube acima de 100 é barrado", r.dados.youtube?.erros.some((e) => /100/.test(e)));
    r = await checa([{ plataforma: "tiktok", opcoes: { legenda: "oi" } }]);
    checar("regras: TikTok sem privacidade é barrado", r.dados.tiktok?.erros.some((e) => /pode ver/.test(e)));
    r = await checa([{ plataforma: "site", opcoes: {} }]);
    checar("regras: site aceita foto (não é 'não aceita foto')",
      !r.dados.site?.erros.some((e) => /não publica foto/.test(e)), JSON.stringify(r.dados.site?.erros));
  }

  /* ---------------- 10. publicar com pedido inválido ---------------- */
  {
    let r = await req(`/restrito/api/posts/${postId}/publicar`, { metodo: "POST",
      corpo: { destinos: [{ plataforma: "instagram", conta_id: 999, opcoes: { legenda: "oi" } }] } });
    checar("publicar com conta inexistente → 400", r.status === 400, "status " + r.status);
    r = await req(`/restrito/api/posts/${postId}/publicar`, { metodo: "POST", corpo: { destinos: [] } });
    checar("publicar sem plataforma → 400", r.status === 400);
    r = await req(`/restrito/api/posts/${postId}/publicar`, { metodo: "POST", corpo: { destinos: [{ plataforma: "orkut", conta_id: 1 }] } });
    checar("plataforma inventada → 400", r.status === 400);
  }

  /* ---------------- 11. injeção de SQL ---------------- */
  {
    let r = await req("/restrito/api/posts?q=" + encodeURIComponent("' OR 1=1 --"));
    checar("SQLi na busca não quebra nem vaza", r.status === 200 && Array.isArray(r.dados) && r.dados.length === 0,
      "status " + r.status + " itens " + (r.dados?.length ?? "?"));
    r = await req("/restrito/api/posts?status=" + encodeURIComponent("x'; DROP TABLE posts; --"));
    checar("SQLi no filtro de status é inofensivo", r.status === 200);
    r = await req("/restrito/api/posts/1%20OR%201=1");
    checar("id não numérico não casa a rota", r.status === 404);
  }

  /* ---------------- 12. perfis (autorização no SERVIDOR) ---------------- */
  {
    await req("/restrito/api/usuarios", { metodo: "POST",
      corpo: { nome: "Redator Teste", email: "redator.teste", perfil: "redator", senha: "senha-de-teste-1" } });
    const guardaCookie = COOKIE, guardaCsrf = CSRF;
    const login = await req("/restrito/api/login", { metodo: "POST",
      corpo: { usuario: "redator.teste", senha: "senha-de-teste-1" }, cookie: "" });
    const sc = login.cab.getSetCookie ? login.cab.getSetCookie().join(";") : (login.cab.get("set-cookie") || "");
    COOKIE = (sc.match(/lap=[a-f0-9]+/) || [""])[0];
    CSRF = login.dados.csrf;
    checar("redator consegue entrar", login.status === 200);

    let r = await req(`/restrito/api/posts/${postId}/publicar`, { metodo: "POST", corpo: { destinos: [{ plataforma: "site", conta_id: 1 }] } });
    checar("redator NÃO publica (403 no servidor)", r.status === 403, "status " + r.status);
    r = await req("/restrito/api/usuarios"); checar("redator não lista usuários", r.status === 403);
    r = await req("/restrito/api/apps"); checar("redator não vê credenciais dos apps", r.status === 403);
    r = await req("/restrito/api/auditoria"); checar("redator não vê auditoria", r.status === 403);
    r = await req("/restrito/api/conectar/facebook", { metodo: "POST" });
    checar("redator não inicia OAuth", r.status === 403, "status " + r.status);
    r = await req("/restrito/api/contas", { metodo: "POST",
      corpo: { plataforma: "site", nome: "x", url: "https://x.com", segredo: "a".repeat(64) } });
    checar("redator não conecta conta", r.status === 403);
    r = await req("/restrito/api/config", { metodo: "PUT", corpo: { url_publica: "https://invadido.com" } });
    checar("redator não muda configuração", r.status === 403);
    r = await req("/restrito/api/posts", { metodo: "POST", corpo: { titulo: "Do redator" } });
    checar("redator PODE criar matéria", r.status === 200, "status " + r.status);

    COOKIE = guardaCookie; CSRF = guardaCsrf;
  }

  /* ---------------- 13. segredos nunca voltam ---------------- */
  {
    await req("/restrito/api/apps/facebook", { metodo: "PUT",
      corpo: { client_id: "12345", client_secret: "segredo-super-secreto", extra: { config_id: "1234567890123", versao: "v23.0" } } });
    const r = await req("/restrito/api/apps");
    checar("client_secret não volta na API", !/segredo-super-secreto/.test(r.texto), r.texto.slice(0, 200));
    checar("API só informa que existe segredo", r.dados.apps.facebook.tem_secret === true);
    checar("config_id e versão da API voltam (não são segredo)",
      r.dados.apps.facebook.extra?.config_id === "1234567890123" && r.dados.apps.facebook.extra?.versao === "v23.0");

    /* salvar só o client_id não pode apagar o extra que já estava lá */
    await req("/restrito/api/apps/facebook", { metodo: "PUT", corpo: { client_id: "999" } });
    const r2 = await req("/restrito/api/apps");
    checar("salvar só o Client ID preserva config_id e versão", r2.dados.apps.facebook.extra?.config_id === "1234567890123");

    let bad = await req("/restrito/api/apps/facebook", { metodo: "PUT", corpo: { extra: { config_id: "nao-numerico" } } });
    checar("config_id não numérico é recusado", bad.status === 400, "status " + bad.status);
    bad = await req("/restrito/api/apps/facebook", { metodo: "PUT", corpo: { extra: { versao: "21" } } });
    checar("versão da API em formato errado é recusada", bad.status === 400, "status " + bad.status);

    await req("/restrito/api/contas", { metodo: "POST",
      corpo: { plataforma: "site", nome: "Site Teste", url: "https://exemplo.com", segredo: "s".repeat(64) } });
    const c = await req("/restrito/api/contas");
    checar("token/segredo da conta não volta na API", !/s{40}/.test(c.texto) && !/"token"/.test(c.texto), c.texto.slice(0, 200));
  }

  /* ---------------- 14. sessão ---------------- */
  {
    const antes = await req("/restrito/api/me");
    checar("sessão válida antes do logout", antes.status === 200);
    await req("/restrito/api/logout", { metodo: "POST" });
    const depois = await req("/restrito/api/me");
    checar("logout mata a sessão NO SERVIDOR", depois.status === 401, "status " + depois.status);
  }

  /* ---------------- 15. enumeração de usuário por tempo ---------------- */
  {
    const medir = async (usuario) => {
      const t = [];
      for (let i = 0; i < 3; i++) {
        const ini = process.hrtime.bigint();
        await req("/restrito/api/login", { metodo: "POST", corpo: { usuario, senha: "senha-qualquer-errada" }, cookie: "" });
        t.push(Number(process.hrtime.bigint() - ini) / 1e6);
      }
      return t.reduce((a, b) => a + b) / t.length;
    };
    const existe = await medir("admin");
    const naoExiste = await medir("nao-existe-" + Date.now());
    const razao = Math.max(existe, naoExiste) / Math.max(1, Math.min(existe, naoExiste));
    checar(`login não vaza usuário válido por tempo (existe ${existe.toFixed(0)}ms × inexistente ${naoExiste.toFixed(0)}ms)`,
      razao < 2, `razão ${razao.toFixed(2)}`);
  }

  /* --------- 16. X-Forwarded-For forjado NÃO burla a trava -------------
     O nginx monta "X-Forwarded-For: <texto do cliente>, <IP real>". Se o
     sistema lesse o PRIMEIRO item, bastaria variá-lo a cada tentativa para a
     trava nunca disparar — foi o furo encontrado em produção em quatro
     servidores nossos. Aqui simulamos o cabeçalho exatamente como o nginx o
     entrega: primeiro item diferente a cada vez, último item fixo.
     Estes testes usam IPs simulados, então não queimam o balde do 127.0.0.1. */
  {
    const VITIMA = "203.0.113.7", OUTRO = "203.0.113.8";
    let travou = 0;
    for (let i = 0; i < 7; i++) {
      const r = await req("/restrito/api/login", {
        metodo: "POST", corpo: { usuario: "admin", senha: "errada" + i }, cookie: "",
        cabecalhos: { "X-Forwarded-For": `10.0.0.${i}, ${VITIMA}` },   // 1º item muda sempre
      });
      if (r.status === 429) { travou = i + 1; break; }
    }
    checar("XFF com primeiro item variável NÃO burla a trava", travou > 0 && travou <= 7,
      travou ? `travou na ${travou}ª` : "nunca travou — a trava está sendo lida do item errado");

    const outro = await req("/restrito/api/login", {
      metodo: "POST", corpo: { usuario: "admin", senha: "errada" }, cookie: "",
      cabecalhos: { "X-Forwarded-For": `10.0.0.99, ${OUTRO}` },
    });
    checar("trava é por IP real, não pega quem não errou", outro.status === 401, "status " + outro.status);

    /* X-Real-IP tem precedência: é o que o nginx sobrescreve */
    const real = await req("/restrito/api/login", {
      metodo: "POST", corpo: { usuario: "admin", senha: "errada" }, cookie: "",
      cabecalhos: { "X-Real-IP": VITIMA, "X-Forwarded-For": "10.0.0.1, 198.51.100.1" },
    });
    checar("X-Real-IP tem precedência sobre o XFF", real.status === 429, "status " + real.status);
  }

  /* ------------- 17. FORÇA BRUTA — SEMPRE POR ÚLTIMO ------------------- */
  {
    let bloqueou = false;
    for (let i = 0; i < 8; i++) {
      const r = await req("/restrito/api/login", { metodo: "POST", corpo: { usuario: "admin", senha: "errada" + i }, cookie: "" });
      if (r.status === 429) { bloqueou = true; break; }
    }
    checar("trava de força bruta dispara (429)", bloqueou);
    const certo = await req("/restrito/api/login", { metodo: "POST", corpo: { usuario: "admin", senha: SENHA }, cookie: "" });
    checar("com o IP travado, nem a senha certa entra", certo.status === 429, "status " + certo.status);
  }

  console.log(res.join("\n"));
  console.log(`\n  ==> ${ok} passaram · ${falhou} falharam de ${ok + falhou}`);
  console.log("  (o IP está travado por 15 min — reinicie o servidor antes de testar à mão)\n");
  process.exit(falhou ? 1 : 0);
})().catch((e) => { console.error("ERRO NA BATERIA:", e); process.exit(2); });
