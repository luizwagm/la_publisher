# API do LA Publisher — `/api/v1`

Para o site do cliente mandar publicar nas redes. O caso de uso: a pessoa
escreve a notícia no painel do site dela, marca *Instagram* e *Facebook*, o
site salva a matéria **e** aciona esta API.

Base: `https://publisher.luizaugust.me`

> Existe também o caminho contrário — o LA Publisher empurrando a matéria para
> o blog do site — em [conector/INSTALAR.md](conector/INSTALAR.md). Os dois
> podem conviver.

---

## Autenticação

Cada site tem uma **chave** (pública) e um **segredo** (nunca trafega). Toda
chamada leva três cabeçalhos:

| Cabeçalho | Conteúdo |
|---|---|
| `X-LAP-Chave` | `lap_a1b2c3…` |
| `X-LAP-Timestamp` | horário em segundos (unix) |
| `X-LAP-Assinatura` | `sha256=` + HMAC-SHA256 do segredo sobre `${ts}.${MÉTODO}.${caminho}.${corpo}` |

O `caminho` é o que vai na linha da requisição, **com a query string**
(`/api/v1/publicacoes?origem_ref=42`). O `corpo` é o JSON exatamente como
enviado — assine a mesma string que você manda, não uma reserialização.

```js
const base = `${ts}.POST./api/v1/publicacoes.${corpo}`;
const assinatura = "sha256=" + crypto.createHmac("sha256", segredo).update(base).digest("hex");
```

**Por que assinatura e não um token no cabeçalho:** token estático vaza em log
de proxy e vale para sempre. A assinatura muda a cada chamada, expira em **5
minutos** e cobre o método, a rota e o corpo — gravar uma requisição não
permite repeti-la nem reaproveitá-la em outra rota.

Limite: **120 chamadas por minuto** por chave.

### Obter a chave

No painel do LA Publisher: **Sites (API) → + Novo site**. O segredo aparece
**uma única vez** — depois fica cifrado no cofre e nem o administrador o lê de
volta. Perdeu, gere outro (o anterior morre na hora).

O campo **Endereço do site** não é decoração: é contra ele que validamos o
`callback_url` e a `retorno_url`, para a chave não virar trampolim de
redirecionamento para outro domínio.

---

## A regra que sustenta tudo

**Cada chave só enxerga as contas dela.** Listar, publicar e consultar são
todos recortados por cliente. A chave do site do BemEstar não publica no
Instagram de outro cliente nem lê as publicações dele — é o pior acidente
possível neste sistema, e por isso está coberto por teste.

---

## Rotas

### `GET /api/v1/ping`
Confere credencial e relógio.
```json
{ "ok": true, "cliente": "BemEstarClinic", "versao": "1.2.0", "agora": "2026-08-07T12:00:00.000Z" }
```

### `GET /api/v1/plataformas`
As regras de cada rede (limite de legenda, hashtags, proporção de imagem,
duração de vídeo, campos específicos). Use para montar a tela e validar antes
de enviar — é a **mesma fonte** que o servidor aplica.

### `GET /api/v1/contas`
As contas que este site pode usar.
```json
{ "contas": [ { "id": 7, "plataforma": "instagram", "nome": "@bemestarclinic_", "ativo": true, "ultimo_erro": null } ] }
```

### `POST /api/v1/conexoes`
Gera um link de uso único para o dono da conta autorizar.
```json
{ "plataforma": "facebook", "retorno_url": "https://bemestarclinic.com/admin/redes" }
```
```json
{ "url": "https://publisher.luizaugust.me/conectar/9f3c…", "expira_em": "2026-08-07T12:30:00.000Z" }
```
`plataforma`: `facebook` (traz o Instagram junto), `youtube` ou `tiktok`.
A `retorno_url` precisa estar na origem cadastrada do site. O link vale **uma
vez** e expira em **30 minutos**.

### `POST /api/v1/publicacoes`

```json
{
  "origem_ref": "post-123",
  "titulo": "Ozonioterapia: o que a ciência diz",
  "resumo_html": "<p>Chamada curta.</p>",
  "texto_html": "<h2>Subtítulo</h2><p>Matéria completa.</p>",
  "autor": "Dr. Ronalldo JM",
  "fonte": "Agência Brasil",
  "fonte_url": "https://agenciabrasil.ebc.com.br/…",
  "errata": "",
  "data_publicacao": "2026-08-07",
  "midias": [ { "url": "https://bemestarclinic.com/assets/img/uploads/capa.jpg", "alt": "…", "capa": true } ],
  "plataformas": ["instagram", "facebook"],
  "opcoes": { "instagram": { "legenda": "…", "primeiro_comentario": "#saude #caruaru" } },
  "agendado_para": "2026-08-08T09:00",
  "callback_url": "https://bemestarclinic.com/api/lapublisher/retorno"
}
```

| Campo | Observação |
|---|---|
| `origem_ref` | **Mande sempre.** O id da matéria no seu site. É o que impede post duplicado quando a chamada é repetida. |
| `midias` | URLs de onde a imagem/vídeo já está no seu site. Nós baixamos, conferimos o tipo **pelo conteúdo** e medimos. |
| `plataformas` | Atalho: resolvemos a conta sozinhos quando há só uma por rede. |
| `destinos` | Forma completa: `[{ "plataforma": "instagram", "conta_id": 7, "opcoes": {…} }]`. Obrigatória quando há mais de uma conta da mesma rede. |
| `opcoes` | Por rede. Legenda em branco vira a sugestão a partir do resumo. |
| `agendado_para` | Em branco publica assim que possível. |

Respostas: **201** criada · **200** com `"repetida": true` quando o
`origem_ref` já existe · **400** pedido malformado · **403** conta que não é
sua · **422** conteúdo fora das regras da rede (vem `recusas` por plataforma).

### `GET /api/v1/publicacoes/{id}`
Estado por destino, mídias e as últimas linhas do registro.

### `GET /api/v1/publicacoes?origem_ref=post-123`
Acha pela referência do seu lado.

### `POST /api/v1/publicacoes/{id}/retentar` · `/cancelar`
Corpo opcional `{"plataforma":"instagram"}` para agir só numa rede. Reenviar
para uma rede social que **já publicou** é ignorado (criaria post duplicado);
no destino `site`, reenviar **atualiza** a matéria.

---

## Webhook

Assim que cada rede conclui, chamamos o `callback_url` (ou o webhook do site,
cadastrado no painel):

```json
{
  "evento": "publicacao.destino.publicado",
  "publicacao_id": 12, "origem_ref": "post-123",
  "plataforma": "instagram", "conta_id": 7,
  "status": "publicado",
  "url": "https://www.instagram.com/p/Cxyz…",
  "erro": null, "tentativas": 1, "concluida": false,
  "em": "2026-08-07T12:05:00.000Z"
}
```

Eventos: `publicacao.destino.publicado`, `publicacao.destino.erro`,
`conta.conectada`. O campo `concluida` diz se ainda falta algum destino.

Cabeçalhos: `X-LAP-Evento`, `X-LAP-Timestamp`, `X-LAP-Assinatura`
(HMAC do **seu segredo** sobre `${ts}.${corpo}`).

**Confira a assinatura antes de acreditar no corpo** — sem isso, quem descobrir
a URL do seu webhook pode dizer que a publicação deu certo. Responda **2xx**;
qualquer outra coisa faz o LA Publisher tentar de novo (1min, 5min, 25min, 2h,
cinco vezes). Se o webhook falhar de vez, consulte por
`GET /api/v1/publicacoes/{id}` — a fila nunca é a única fonte da verdade.

---

## Usando o módulo pronto

Copie `conector/cliente-lapublisher.js` para a raiz do site.

```js
const { LaPublisher } = require("./cliente-lapublisher");
const lap = new LaPublisher();   // lê LAP_URL, LAP_CHAVE e LAP_SEGREDO
```

No systemd do site:
```ini
Environment=LAP_URL=https://publisher.luizaugust.me
Environment=LAP_CHAVE=lap_xxxxxxxxxxxx
Environment=LAP_SEGREDO=xxxxxxxxxxxxxxxx
```

Publicando, dentro do fluxo que já salva o post:

```js
// depois de gravar a matéria no banco do site
if (b.redes?.length) {
  try {
    const r = await lap.publicar({
      origem_ref: post.id,
      titulo: post.title,
      resumo_html: post.excerpt,
      texto_html: post.content,
      autor: post.autor,
      data_publicacao: post.date,
      midias: [{ url: `https://bemestarclinic.com${post.image}`, capa: true }],
      plataformas: b.redes,                    // ["instagram","facebook"]
      callback_url: "https://bemestarclinic.com/api/lapublisher/retorno",
    });
    db.prepare("UPDATE posts SET lap_publicacao=? WHERE id=?").run(r.id, post.id);
  } catch (e) {
    /* A matéria JÁ está salva no site. Falhar nas redes não pode desfazer
       isso nem derrubar a resposta — registre e siga. */
    console.error("LA Publisher:", e.message, e.dados?.recusas || "");
    aviso = "A matéria foi salva, mas a publicação nas redes falhou: " + e.message;
  }
}
```

Recebendo o webhook:

```js
if (p === "/api/lapublisher/retorno" && req.method === "POST") {
  const cru = await lerCorpoCru(req);                      // string crua
  if (!lap.conferirWebhook(req.headers, cru)) { res.writeHead(401); return res.end(); }
  const e = JSON.parse(cru);
  db.prepare("UPDATE posts SET lap_status=?, lap_url=? WHERE id=?")
    .run(e.status, e.url || "", Number(e.origem_ref));
  res.writeHead(200); res.end("ok");
}
```

Listando as contas para montar as caixinhas:

```js
const contas = await lap.contas();     // [{id, plataforma, nome, ativo}]
```

E o botão "conectar minha conta" no painel do cliente:

```js
const { url } = await lap.linkDeConexao({
  plataforma: "facebook",
  retorno_url: "https://bemestarclinic.com/admin/redes",
});
res.writeHead(302, { Location: url });
```

---

## Cuidados

- **Nunca versione o segredo.** Variável de ambiente, sempre.
- **Não bloqueie o salvamento do post** esperando a resposta das redes: publicar
  no Instagram leva segundos e no YouTube pode levar meia hora. Salve, dispare,
  e deixe o webhook atualizar o estado.
- **Mande `origem_ref`.** Sem ele, um duplo clique vira dois posts no Instagram.
- **Imagem em JPG** para o Instagram: a Meta documenta só JPEG na publicação
  por API.
- A mídia precisa estar **acessível pela internet** — Instagram, Facebook e o
  próprio LA Publisher baixam o arquivo. Endereços internos são recusados de
  propósito.
