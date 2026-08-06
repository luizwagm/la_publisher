# LA Publisher

Publicação automática de postagens em **Instagram, Facebook, TikTok, YouTube** e
nos **sites/blogs** feitos no nosso gerador — a partir de uma matéria só.

Node.js + SQLite, **sem uma única dependência de npm**. Roda com `node server.js`.

```
LA-Publisher/
├── server.js            porta de entrada HTTP, cabeçalhos de segurança, /midia público
├── painel.js            área /restrito: telas, API e OAuth
├── publico.js           /privacidade e /exclusao-de-dados (exigidas pelas plataformas)
├── fila.js              o motor: pega os destinos pendentes e publica
├── regras.js            FONTE ÚNICA das regras de cada plataforma
├── seguranca.js         senha, sessão, perfis, higienização de HTML
├── banco.js             SQLite + cofre AES-256-GCM
├── midia.js             mede foto e vídeo lendo o cabeçalho do arquivo
├── versao.js            fonte única da versão
├── plataformas/
│   ├── meta.js          Instagram + Página do Facebook (Graph API)
│   ├── tiktok.js        Content Posting API (PKCE, upload em pedaços)
│   ├── youtube.js       Data API v3 (upload resumable)
│   ├── site.js          conector para os sites do gerador
│   └── http.js          fetch com timeout, erro tipado e máscara de token
├── conector/
│   ├── lapublisher.js   arquivo que se instala NO SITE do cliente
│   └── INSTALAR.md      3 linhas no server.js dele
├── restrito/app.html    o painel inteiro (SPA sem framework)
├── testes/              bateria de segurança (103) e teste ponta a ponta (32)
├── data/                banco + chave do cofre  (nunca versionado)
└── midia/               fotos e vídeos enviados (nunca versionado)
```

---

## Subir

Precisa de **Node ≥ 22.5** (usa o `node:sqlite` nativo). Aqui roda em 24.

```bash
node server.js
```

Painel em <http://localhost:5190/restrito/> · login inicial **admin** /
**publisher-2026** (defina outra com `LAP_SENHA_INICIAL` no primeiro boot).
**Troque no primeiro acesso.**

Variáveis de ambiente:

| Variável | Para quê |
|---|---|
| `PORT` | porta (padrão 5190) |
| `HOST` | `0.0.0.0` para expor direto; o padrão `127.0.0.1` assume que há nginx na frente |
| `LAP_DATA` | pasta de dados alternativa (subir uma cópia de teste sem tocar no banco do cliente) |
| `LAP_CHAVE` | chave do cofre em hexadecimal de 64 caracteres; sem ela, é criada em `data/.chave` |
| `LAP_URL_PUBLICA` | endereço público, caso prefira fixar fora do painel |

### Endereço público — leia antes de reclamar que não publica

Instagram, Facebook, TikTok (carrossel de fotos) e os sites **baixam a mídia por
URL**: quem busca o arquivo é o servidor deles, não o nosso. Um sistema rodando
só em `localhost` consegue cadastrar, agendar e validar tudo — mas o disparo
real nessas redes vai falhar, porque a Meta não alcança o seu `localhost`.

Configure em **/restrito → Configurações → Endereço público** algo como
`https://publisher.luizaugust.me`. É dele que saem:

- a URL da mídia: `https://publisher.luizaugust.me/midia/arquivo.jpg`
- a URL de retorno do OAuth: `…/restrito/oauth/retorno/facebook`

YouTube e vídeo no TikTok **não** precisam disso (o arquivo sobe direto), mas o
OAuth precisa de qualquer jeito.

---

## Conectar cada plataforma

Tudo em **/restrito → Configurações → Aplicativos** (só admin). O `client_secret`
é guardado cifrado e **nunca volta para a tela**.

### Instagram + Facebook (um app só)

1. <https://developers.facebook.com> → criar app do tipo **Business**.
2. Produtos: **Login do Facebook** (ou **Login do Facebook para Empresas**) e **Instagram**.
3. Em Login do Facebook → Configurações, cole a URL de retorno que o painel mostra.
4. Copie **App ID** e **App Secret** para o painel.
5. **Se o app usar o "Login do Facebook para Empresas"**, crie uma *configuração*
   dentro do produto (aba Configurações/Modelos) com as permissões e cole o **ID
   da configuração** no campo correspondente do painel. Nesse fluxo as permissões
   saem da configuração, não da URL — com o campo vazio, o sistema usa o login
   clássico. Não precisa saber de antemão qual é: preencha se existir.
6. Contas → **Instagram + Facebook** → autorize.

Se a Meta aposentar a versão da Graph API que o sistema usa por padrão (`v21.0`),
o sintoma é erro no clique de Conectar — troque no campo **Versão da Graph API**,
na mesma tela.

O Instagram precisa ser conta **Business ou Criador** vinculada a uma Página —
conta pessoal não publica por API, é regra da Meta. Publicação limitada a
**50 posts por 24h**. Vídeo no Instagram sai como **Reels**.

Para publicar em contas que não são suas, o app precisa passar pela **App
Review** da Meta pedindo `instagram_content_publish` e `pages_manage_posts`.

### YouTube

1. <https://console.cloud.google.com> → projeto → ative a **YouTube Data API v3**.
2. Credenciais → **ID do cliente OAuth** → tipo **Aplicativo da Web** → cole a
   URL de retorno.
3. Tela de consentimento: publique ou cadastre os e-mails como testadores.
4. Copie **Client ID** e **Client Secret** para o painel → Contas → YouTube.

**Cota**: 10.000 unidades/dia e cada upload custa 1.600 → cerca de **6 vídeos por
dia** por projeto. Estourou, o sistema diz exatamente isso em vez de ficar
tentando.

### TikTok

1. <https://developers.tiktok.com> → app com **Content Posting API**.
2. Escopos `user.info.basic`, `video.publish`, `video.upload`; cole a URL de retorno.
3. Copie **Client key** e **Client secret** → Contas → TikTok.

**Enquanto o app não passar pela auditoria do TikTok, todo post sai como
`SELF_ONLY` (privado)** — é regra deles. O painel avisa isso na tela.

### Site / Blog

Instale `conector/lapublisher.js` no site (3 linhas — veja
[conector/INSTALAR.md](conector/INSTALAR.md)), pegue o segredo que ele imprime
no primeiro boot e cadastre em Contas → **+ Site / Blog**.

Funciona com qualquer site nosso que tenha a tabela `posts`: BemEstarClinic,
Forms Fitness, Daniel's Barbearia, Imobiliária Caruaru, Instituto Kenósis, NYC
Confecções, Óticas Cardoso, Troféu Esportes.

---

## Como usar

1. **Matérias → + Nova.** Título, autor, fonte, data, errata.
2. Resumo e texto no editor. O botão **`</> HTML`** alterna para o código —
   dá para colar HTML pronto e voltar para o visual.
3. Arraste as fotos ou o vídeo. Escolha a capa.
4. Em **Para onde vai**, marque as plataformas. Cada uma abre os campos que ela
   exige e a legenda já vem sugerida a partir do resumo.
5. **Conferir regras** mostra o que cada rede vai recusar — antes de tentar.
6. **Publicar** (ou preencha *Agendar para* e publique depois sozinho).

O que acontece a seguir fica em **Situação por plataforma**, na própria matéria,
e na tela **Fila**.

### Regras aplicadas (fonte: `regras.js`)

| | Instagram | Facebook | TikTok | YouTube | Site |
|---|---|---|---|---|---|
| Legenda | 2.200 · 30 hashtags | 63.206 | 2.200 | 5.000 (descrição) | usa o texto da matéria |
| Título | — | — | — | 100 caracteres, sem `< >` | — |
| Foto | JPG/PNG, 8 MB, 4:5 a 1.91:1 | 10 MB | até 35 (carrossel) | não | livre |
| Vídeo | Reels 3s–15min, 1 GB | 4 GB | 3s–10min, 4 GB | até 12h | livre |
| Carrossel | 2 a 10 | até 10 | até 35 | — | — |
| Teto diário | 50 posts/24h | — | — | ~6 uploads (cota) | — |

Mudou um limite lá fora? Muda em `regras.js` e vale nos três lugares: campos do
painel, contador ao vivo e validação do servidor.

### Perfis

| Perfil | Pode |
|---|---|
| **admin** | tudo, inclusive contas conectadas, credenciais e usuários |
| **editor** | escreve, envia mídia e **publica** |
| **redator** | escreve e edita; **não publica**, não vê credencial |

O painel esconde o que o perfil não pode — mas quem manda é a checagem no
servidor (testado: o redator leva 403 mesmo chamando a API na mão).

### Republicar

Reenviar para uma **rede social** criaria um post duplicado — por isso o
destino já publicado fica travado. No **site** é o contrário: reenviar
**atualiza** a matéria que já está no ar (o conector reconhece a origem pelo
`lap_id`). É assim que se publica uma errata.

---

## Páginas de privacidade e exclusão de dados

Meta, Google e TikTok só liberam o app com uma política de privacidade e uma
página de exclusão de dados que abram de verdade. O sistema publica as duas
sozinho:

- `https://SEUDOMINIO/privacidade`
- `https://SEUDOMINIO/exclusao-de-dados`

Preencha **empresa, CNPJ e e-mail de contato** em Configurações → Identificação;
é de lá que sai o conteúdo. São as duas únicas páginas indexáveis do sistema — o
`robots.txt` fecha todo o resto.

O texto descreve o que o sistema realmente guarda. **Se um dia ele passar a
guardar outra coisa, `publico.js` precisa mudar junto** — política que não
corresponde ao software é pior que política nenhuma. E vale a leitura de um
advogado antes de usar com cliente: o texto é honesto quanto ao software, mas
não substitui parecer jurídico.

## Testes

```bash
# terminal 1 — servidor de teste, banco e porta separados
PORT=5191 LAP_DATA=/tmp/lap-teste node server.js

# terminal 2
node testes/seguranca.cjs          # 103 testes
node testes/site-falso.cjs         # sobe um site do gerador falso, imprime o segredo
node testes/integracao.cjs <segredo>   # 32 testes de ponta a ponta
```

**Nunca aponte a bateria para o servidor do cliente**, e rode sempre com
`LAP_DATA` próprio. A trava de força bruta é por IP e dura 15 minutos: o teste
dela é o último de propósito, e depois é preciso reiniciar o servidor antes de
mexer à mão.

## Segurança

Camada portada do `/restrito` da BemEstarClinic — a mesma que fechou 69/69 no
pentest de 2026-07-24 — com o que este sistema exige a mais.

- **Senha**: scrypt com salt por senha. Login inexistente gasta o mesmo tempo de
  um scrypt real (`HASH_ISCA`), senão daria para descobrir usuários válidos por
  cronômetro. 5 tentativas erradas → 15 min de bloqueio por IP.
- **Sessão**: 8h, cookie `HttpOnly; SameSite=Lax; Path=/restrito`, `Secure` sob
  HTTPS. Logout mata no servidor; trocar a senha derruba as outras sessões.
- **CSRF**: cabeçalho `X-LAP-CSRF` com token da sessão, além do SameSite. Sem
  CORS liberado, um site de terceiro não consegue nem mandar o cabeçalho.
- **Cofre**: token das redes e `client_secret` cifrados com AES-256-GCM, chave
  em `data/.chave` (fora do banco — cifrar com a chave dentro do banco não
  protegeria nada).
- **HTML das matérias**: reconstruído a partir de uma lista de permissão. Nada é
  copiado do que veio: `<script>`, `<iframe>`, `<svg>`, `on*`, `style` e
  `javascript:` não sobrevivem. E o conector higieniza **de novo** antes de
  gravar no site do cliente.
- **Upload**: tipo conferido pelo cabeçalho binário, não pelo que o navegador
  declara. SVG recusado de propósito (SVG é XML e executa script na origem de
  quem o serve — foi o furo encontrado no `/admin` da BemEstarClinic).
- **Auditoria**: login, publicação, conexão de conta e mexida em usuário ficam
  registrados com IP.
- Cabeçalhos: CSP no painel, HSTS sob HTTPS, `nosniff`, `X-Frame-Options: DENY`,
  `noindex`. O app escuta só em `127.0.0.1`.

### Guardar a chave do cofre

`data/.chave` **não** está no repositório e **não** pode se perder: sem ela os
tokens viram bytes ilegíveis e todas as contas precisam ser reconectadas. O
`deploy.sh` copia a chave para `backups/` com permissão 600 a cada atualização.

---

## Instalar no servidor

Produção: **publisher.luizaugust.me** · Hetzner `budget-ia-prod` (204.168.208.52)
· `/var/www/projetos/LA-Publisher` · `lapublisher.service` · porta 5190.

**Pré-requisito que não dá para pular:** o registro DNS `A` de
`publisher.luizaugust.me` apontando para o servidor. Sem ele o certificado não
sai, e o Let's Encrypt limita 5 falhas por hora no mesmo domínio.

```powershell
# do Windows, na pasta do projeto
.\enviar.ps1              # só envia os arquivos
.\enviar.ps1 -Instalar    # envia e roda a primeira instalação (pede a senha do sudo)
.\enviar.ps1 -Reiniciar   # envia e reinicia (atualizações do dia a dia)
```

No servidor, a primeira instalação é:

```bash
cd /var/www/projetos/LA-Publisher && sudo ./instalar.sh publisher.luizaugust.me
```

O `instalar.sh` confere o Node, acerta dono e permissões, sobe o serviço, cria o
vhost, **confirma com `nginx -T`** que o bloco foi mesmo carregado (o `nginx -t`
aprova vhost que o nginx nem chega a ler) e só chama o certbot se o DNS já
estiver apontando.

## Operação

```bash
./verificar.sh          # só lê: commit, serviço, permissões, contas, fila, exposição
sudo ./deploy.sh        # backup → parar → proteger banco/chave/mídia → pull → devolver → subir → conferir
```

**Nunca `git pull` puro**: o banco, a chave e a mídia não são versionados e um
commit antigo pode removê-los. O `deploy.sh` tira tudo do caminho antes.
**`git pull` não reinicia o Node** — mexeu no `.js`, reinicie o serviço.

### systemd

```ini
[Unit]
Description=LA Publisher
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/var/www/projetos/LA-Publisher
ExecStart=/usr/bin/node server.js
Environment=PORT=5190
Restart=always

[Install]
WantedBy=multi-user.target
```

O nginx faz o proxy do domínio para `127.0.0.1:5190`. Precisa aceitar corpo
grande (vídeo):

```nginx
client_max_body_size 2048m;
proxy_request_buffering off;
proxy_read_timeout 3600s;
```

---

## Versão

`1.0.0`. Funcionalidade nova sobe a 2ª casa (`1.1.0`), correção sobe a 3ª
(`1.0.1`), ajuste pontual pode usar a 4ª (`1.0.1.1`). Detalhe em
[CHANGELOG.md](CHANGELOG.md). A versão mora em `versao.js` e aparece na tela de
login, na barra lateral e em `GET /saude`.

---

Desenvolvido por **LA Software House** · <https://luizaugust.me>
