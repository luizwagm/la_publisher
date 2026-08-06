# Conector do LA Publisher — instalação num site do gerador

Serve para qualquer site nosso que tenha a tabela `posts` (BemEstarClinic,
Forms Fitness, Daniel's Barbearia, Imobiliária Caruaru, Instituto Kenósis,
NYC Confecções, Óticas Cardoso, Troféu Esportes). Todos usam o mesmo esquema:

```sql
posts(id, title, slug, excerpt, content, image, date, sort)
```

## 1. Copiar o arquivo

Copie `lapublisher.js` para a **raiz do site** (ao lado do `server.js`).

```bash
cp LA-Publisher/conector/lapublisher.js /var/www/projetos/BemEstarClinic/
```

## 2. Três linhas no `server.js` do site

No topo, junto dos outros `require`:

```js
const { conectorLaPublisher } = require("./lapublisher");
```

Depois de `publish` e do `db` já existirem (perto do fim do arquivo, antes do
`http.createServer`):

```js
const laPublisher = conectorLaPublisher({ db, root: ROOT, publish, site: "BemEstarClinic" });
```

E dentro do handler HTTP, **logo depois dos cabeçalhos de segurança e antes de
qualquer outra rota** — inclusive antes do modo manutenção, para que a matéria
entre mesmo com o site fechado:

```js
if (laPublisher(req, res, p)) return;
```

> `p` é a variável que o site já usa para o pathname. Se no seu arquivo ela se
> chama `pathname`, use o nome de lá.

## 3. Pegar o segredo

Reinicie o serviço. No primeiro boot o conector cria
`data/lapublisher.json` e imprime no log:

```
  · LA Publisher: segredo criado em data/lapublisher.json
    Cadastre no Publisher → Contas → Site:
    9f3c…  (64 caracteres)
```

```bash
sudo systemctl restart bemestar.service
sudo journalctl -u bemestar.service -n 30 | grep -A2 "LA Publisher"
```

Se preferir definir você mesmo, use a variável de ambiente `LAP_SEGREDO` no
arquivo do systemd — nesse caso o JSON nem é criado.

## 4. Cadastrar no LA Publisher

Painel → **Contas** → **+ Site / Blog**:

| Campo | Valor |
|---|---|
| Nome | BemEstarClinic |
| URL do site | `https://bemestarclinic.com` |
| Segredo | o hexadecimal de 64 caracteres do passo 3 |

Clique em **testar**. Se responder `OK — BemEstarClinic · N matérias no site`,
está ligado.

## 5. Proteger o arquivo do segredo

O `data/lapublisher.json` **não pode ser servido nem versionado**.

- O `.gitignore` dos nossos sites já ignora `data/`. Confirme.
- O `server.js` deles já bloqueia `/data` e a extensão `.json` fora de
  `/assets/`. Confirme com:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://bemestarclinic.com/data/lapublisher.json
```

Tem que responder **404**.

---

## O que o conector faz

| | |
|---|---|
| Rota | `POST /api/lapublisher/receber` e `POST /api/lapublisher/ping` |
| Autenticação | HMAC-SHA256 de `timestamp.corpo`, comparado em tempo constante |
| Anti-replay | assinatura vale 5 minutos |
| Limite | 30 requisições por minuto por IP · corpo até 2 MB |
| HTML | higienizado de novo aqui (o site não confia no que chega) |
| Imagem | **baixada** e servida pelo próprio site em `/assets/img/uploads/` — nada de hotlink. Só png/jpg/webp/gif, até 12 MB. SVG é recusado (SVG é XML e executa script na origem do site) |
| Idempotência | coluna `lap_id` — reenviar a mesma matéria **atualiza**, não duplica |
| Colunas extras | cria `lap_id`, `autor`, `fonte`, `errata` em `posts` se não existirem (ALTER TABLE idempotente) |
| Errata e fonte | entram marcadas no fim do `content`, em `<p class="post-errata">` e `<p class="post-fonte">` |
| Publicar | roda o `publish()` do site ao receber, regenerando as páginas estáticas |

### Estilo opcional no CSS do site

```css
.post-errata { border-left: 3px solid #c0392b; background: #fdf3f2; padding: .7rem 1rem; margin-top: 2rem; }
.post-fonte  { font-size: .9rem; color: #6b7280; margin-top: 1rem; }
```

### Desligar temporariamente

Edite `data/lapublisher.json` e ponha `"ativo": false`, depois reinicie. O
endpoint passa a responder 403 sem derrubar mais nada.
