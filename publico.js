/* ==========================================================================
   publico.js — as duas ÚNICAS páginas públicas do sistema:
     /privacidade          → política de privacidade
     /exclusao-de-dados    → instruções de exclusão de dados do usuário

   Por que elas existem: a Meta (e o Google, e o TikTok) só liberam o app com
   uma URL de política de privacidade e uma de exclusão de dados que abram de
   verdade. Apontar para facebook.com — como vem no exemplo do painel deles —
   reprova na revisão.

   O texto descreve o que este sistema REALMENTE faz. Se um dia o sistema
   passar a guardar outra coisa (métricas de seguidores, comentários, o que
   for), ESTE arquivo precisa mudar junto — política que não corresponde ao
   software é pior que política nenhuma.

   Nome da empresa, CNPJ e e-mail vêm das Configurações do painel, para não
   precisar mexer em código a cada cliente.
   ========================================================================== */
const { getC } = require("./banco");
const { esc } = require("./seguranca");
const { VERSAO } = require("./versao");

const ATUALIZADO = "5 de agosto de 2026";

const dados = () => ({
  empresa: getC("empresa") || "LA Software House",
  cnpj: getC("cnpj") || "",
  email: getC("email_privacidade") || "",
  sistema: getC("nome_sistema") || "LA Publisher",
});

/* CSP fechada: estas páginas não têm script nenhum. */
const CSP_PUBLICO = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const ESTILO = `
  :root{color-scheme:dark}
  *{box-sizing:border-box;margin:0}
  body{font:16px/1.7 system-ui,-apple-system,Segoe UI,sans-serif;background:#0d1020;color:#e9ecfb;
    padding:2.5rem 1.5rem 4rem}
  .folha{max-width:760px;margin:0 auto}
  .marca{display:flex;align-items:center;gap:.6rem;font-weight:800;font-size:1.1rem;margin-bottom:2rem}
  .marca .ico{width:32px;height:32px;border-radius:9px;display:grid;place-items:center;
    background:linear-gradient(135deg,#6c5cff,#22d3ee);color:#fff}
  h1{font-size:1.9rem;line-height:1.2;letter-spacing:-.02em;margin-bottom:.4rem}
  .quando{color:#727ba9;font-size:.85rem;margin-bottom:2rem}
  h2{font-size:1.15rem;margin:2.2rem 0 .6rem;color:#8b7dff}
  p,li{color:#c3c9ea}
  ul,ol{margin:.6rem 0 .6rem 1.3rem}
  li{margin-bottom:.35rem}
  strong{color:#e9ecfb}
  a{color:#22d3ee}
  table{width:100%;border-collapse:collapse;margin:.9rem 0;font-size:.92rem}
  th,td{text-align:left;padding:.55rem .6rem;border-bottom:1px solid #2a3159;vertical-align:top}
  th{color:#a3abd8;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
  .caixa{background:#171c36;border:1px solid #2a3159;border-radius:12px;padding:1.1rem 1.3rem;margin:1.4rem 0}
  .rodape{margin-top:3rem;padding-top:1.2rem;border-top:1px solid #2a3159;color:#727ba9;font-size:.83rem}
  .rodape a{color:#727ba9}
  @media(max-width:600px){body{padding:1.6rem 1.1rem 3rem}h1{font-size:1.5rem}}
`;

function moldura(titulo, miolo) {
  const d = dados();
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)} — ${esc(d.sistema)}</title>
<style>${ESTILO}</style></head><body><div class="folha">
<div class="marca"><span class="ico">◆</span> ${esc(d.sistema)}</div>
${miolo}
<div class="rodape">
  ${esc(d.empresa)}${d.cnpj ? " · CNPJ " + esc(d.cnpj) : ""}<br>
  <a href="/privacidade">Política de Privacidade</a> ·
  <a href="/exclusao-de-dados">Exclusão de dados</a><br>
  ${esc(d.sistema)} v${esc(VERSAO)}
</div></div></body></html>`;
}

/* ---------------------------- contato ------------------------------------ */
const contato = (d) => d.email
  ? `<a href="mailto:${esc(d.email)}">${esc(d.email)}</a>`
  : "o e-mail de contato informado no seu contrato";

/* ======================= política de privacidade ========================== */
function privacidade() {
  const d = dados();
  return moldura("Política de Privacidade", `
<h1>Política de Privacidade</h1>
<p class="quando">Atualizada em ${ATUALIZADO}</p>

<p><strong>${esc(d.sistema)}</strong> é uma ferramenta de trabalho operada por
<strong>${esc(d.empresa)}</strong>${d.cnpj ? ` (CNPJ ${esc(d.cnpj)})` : ""} para publicar conteúdo
nas redes sociais e nos sites dos seus clientes. Não é um serviço aberto ao público: só entra
quem recebe um login, e cada conta de rede social só é conectada por quem tem acesso a ela.</p>

<h2>O que o sistema guarda</h2>
<table>
  <thead><tr><th>Dado</th><th>Para quê</th><th>Por quanto tempo</th></tr></thead>
  <tbody>
    <tr><td>Nome, login e senha de quem opera o sistema</td>
        <td>Permitir o acesso ao painel. A senha nunca é guardada legível — só o resultado de um cálculo irreversível (scrypt com sal próprio).</td>
        <td>Enquanto a pessoa tiver acesso</td></tr>
    <tr><td>Endereço IP e ação realizada</td>
        <td>Registro de auditoria: saber quem publicou o quê e quando. Publicar em nome de uma marca é ato com consequência pública.</td>
        <td>Enquanto o sistema estiver em uso</td></tr>
    <tr><td>Token de acesso das contas conectadas</td>
        <td>Publicar nas contas autorizadas. Guardado <strong>cifrado</strong> (AES-256-GCM), com a chave fora do banco de dados.</td>
        <td>Até a conta ser desconectada ou o acesso ser revogado</td></tr>
    <tr><td>Identificador e nome de exibição da conta conectada</td>
        <td>Mostrar na tela em qual perfil o conteúdo vai ser publicado.</td>
        <td>Até a conta ser desconectada</td></tr>
    <tr><td>Conteúdo enviado para publicação (textos, fotos, vídeos)</td>
        <td>É o próprio material a ser publicado.</td>
        <td>Enquanto o contrato durar, ou até ser apagado no painel</td></tr>
    <tr><td>Registro de cada tentativa de publicação</td>
        <td>Saber se entrou no ar e, quando falha, por quê.</td>
        <td>90 dias (apagado automaticamente)</td></tr>
  </tbody>
</table>

<div class="caixa">
  <p><strong>O que o sistema NÃO faz:</strong> não lê mensagens privadas, não coleta lista de
  seguidores, não guarda comentários, não rastreia visitantes, não usa cookies de publicidade
  e não vende, aluga nem compartilha dado nenhum para fins de marketing. O único cookie
  existente é o da sessão de quem entra no painel — necessário para manter o login.</p>
</div>

<h2>Com quem os dados são compartilhados</h2>
<p>Apenas com as plataformas de destino, e apenas o conteúdo que o operador mandou publicar,
no momento em que ele mandou:</p>
<ul>
  <li><strong>Meta</strong> (Instagram e Facebook) — <a href="https://www.facebook.com/privacy/policy" target="_blank" rel="noopener noreferrer">política da Meta</a></li>
  <li><strong>Google</strong> (YouTube) — <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">política do Google</a></li>
  <li><strong>TikTok</strong> — <a href="https://www.tiktok.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer">política do TikTok</a></li>
  <li><strong>O site do próprio cliente</strong>, quando a matéria é publicada no blog dele</li>
</ul>
<p>Não há nenhum outro destinatário. Não usamos serviço de análise, rastreamento ou publicidade
dentro do sistema.</p>

<h2>Uso dos dados das plataformas</h2>
<p>Os acessos concedidos são usados <strong>exclusivamente</strong> para publicar o conteúdo que o
operador criou. O sistema não usa esses acessos para ler, coletar ou processar qualquer outra
informação da conta, nem para treinar modelo algum, nem para qualquer finalidade além da
publicação solicitada.</p>

<h2>Segurança</h2>
<ul>
  <li>Senhas guardadas com scrypt e sal individual — nunca em texto legível.</li>
  <li>Tokens das redes e chaves de aplicativo cifrados com AES-256-GCM, com a chave guardada
      fora do banco de dados.</li>
  <li>Todo o tráfego por HTTPS, com HSTS.</li>
  <li>Bloqueio automático após 5 tentativas de senha erradas; sessão expira em 8 horas.</li>
  <li>Acesso por perfis: quem escreve não necessariamente publica, e credenciais de aplicativo
      só o administrador enxerga — e mesmo ele não consegue lê-las de volta depois de salvas.</li>
  <li>Todo conteúdo em HTML passa por higienização antes de ser gravado e de novo antes de ir
      para o site de destino.</li>
</ul>

<h2>Seus direitos (LGPD, art. 18)</h2>
<p>Você pode pedir confirmação de tratamento, acesso, correção, portabilidade, anonimização,
bloqueio ou eliminação dos seus dados, além de revogar o consentimento a qualquer momento.
Basta escrever para ${contato(d)}. Respondemos em até 15 dias.</p>
<p>A base legal do tratamento é a <strong>execução do contrato</strong> firmado com o cliente
(art. 7º, V) e, para o registro de auditoria, o <strong>legítimo interesse</strong> de manter
rastro de quem publicou em nome da marca (art. 7º, IX).</p>

<h2>Como retirar o acesso</h2>
<p>A qualquer momento, sem depender de nós, na própria plataforma — ou pedindo para nós.
O passo a passo está em <a href="/exclusao-de-dados">Exclusão de dados</a>.</p>

<h2>Mudanças nesta política</h2>
<p>Se o sistema passar a tratar dados de outro jeito, esta página muda junto e a data no topo
é atualizada.</p>

<h2>Contato</h2>
<p>${esc(d.empresa)}${d.cnpj ? ` — CNPJ ${esc(d.cnpj)}` : ""}<br>
Encarregado pelo tratamento de dados: ${contato(d)}</p>`);
}

/* ====================== exclusão de dados do usuário ====================== */
function exclusao() {
  const d = dados();
  return moldura("Exclusão de dados", `
<h1>Como excluir seus dados</h1>
<p class="quando">Atualizada em ${ATUALIZADO}</p>

<p>Há dois caminhos, e eles são independentes: você pode cortar o acesso do
<strong>${esc(d.sistema)}</strong> à sua conta sozinho, na própria plataforma, e pode pedir que
apaguemos o que ficou guardado do nosso lado.</p>

<h2>1. Retirar o acesso na plataforma (imediato, sem depender de nós)</h2>
<p>Assim que você faz isso, o token guardado deixa de funcionar na hora e o sistema não
consegue mais publicar na sua conta.</p>
<ul>
  <li><strong>Facebook e Instagram</strong> — Facebook → Configurações e privacidade →
      Configurações → <em>Aplicativos e sites</em> → encontre <strong>${esc(d.sistema)}</strong> → Remover.
      (<a href="https://www.facebook.com/settings?tab=applications" target="_blank" rel="noopener noreferrer">atalho</a>)</li>
  <li><strong>YouTube / Google</strong> —
      <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer">myaccount.google.com/permissions</a>
      → escolha o aplicativo → Remover acesso.</li>
  <li><strong>TikTok</strong> — aplicativo do TikTok → Perfil → Menu → Configurações e privacidade
      → Segurança e permissões → <em>Gerenciar permissões de aplicativos</em> → remover.</li>
</ul>

<h2>2. Pedir a exclusão dos dados guardados aqui</h2>
<p>Escreva para ${contato(d)} com o assunto <strong>"Exclusão de dados"</strong>, dizendo qual
conta ou perfil está pedindo. Não é preciso formulário nem justificativa.</p>
<p>O que acontece:</p>
<ol>
  <li>Confirmamos o recebimento e conferimos que o pedido vem de quem tem direito de fazê-lo.</li>
  <li>Apagamos, em até <strong>15 dias</strong>: o token de acesso, o identificador e o nome da
      conta conectada, e os registros de publicação ligados a ela.</li>
  <li>Enviamos a confirmação por escrito.</li>
</ol>

<div class="caixa">
  <p><strong>O que continua existindo, e por quê:</strong> as publicações que já foram ao ar
  ficam nas redes sociais e nos sites — elas são suas, e só você pode apagá-las por lá. E o
  registro de auditoria (quem publicou o quê e quando) é mantido enquanto houver obrigação
  contratual ou legal, porque é ele que prova o que foi publicado em nome da marca. Esse
  registro não contém token nem conteúdo de conta alguma.</p>
</div>

<h2>Se preferir, sem e-mail</h2>
<p>Quem tem acesso ao painel pode desconectar a conta direto em <em>Contas → excluir</em>. O
token é apagado do banco no mesmo instante.</p>

<h2>Contato</h2>
<p>${esc(d.empresa)}${d.cnpj ? ` — CNPJ ${esc(d.cnpj)}` : ""}<br>${contato(d)}</p>`);
}

/* Devolve true se tratou. */
function handlePublico(req, res, pathname) {
  const paginas = {
    "/privacidade": privacidade,
    "/politica-de-privacidade": privacidade,
    "/exclusao-de-dados": exclusao,
    "/exclusao-de-dados/": exclusao,
  };
  const fn = paginas[pathname.replace(/\/+$/, "") || pathname] || paginas[pathname];
  if (!fn) return false;
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return true; }
  const html = fn();
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
    "Content-Security-Policy": CSP_PUBLICO,
    /* Estas duas páginas são as únicas que PODEM ser indexadas: a Meta e o
       Google conferem se a URL abre mesmo. */
    "X-Robots-Tag": "index, follow",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(req.method === "HEAD" ? undefined : html);
  return true;
}

module.exports = { handlePublico, CSP_PUBLICO };
