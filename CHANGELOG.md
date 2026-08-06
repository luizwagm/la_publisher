# Changelog — LA Publisher

Regra de versão combinada:

```
MAIOR . FUNCIONALIDADE . CORREÇÃO [ . AJUSTE ]
  1    .      2        .    3     .    4
```

- **2ª casa** — funcionalidade nova: `1.1.0`, `1.2.0`, `1.3.0`… e segue além de
  um dígito: depois de `1.9.0` vem `1.10.0`.
- **3ª casa** — correção de bug ou melhoria: `1.1.1`, `1.1.2`, `1.2.4`.
- **4ª casa** (opcional) — ajuste pontual que nem chega a ser um bug fechado:
  `1.2.4.1`.
- **1ª casa** — só quando a base muda de forma incompatível.

A versão mora em `versao.js` (fonte única) e aparece na tela de login, na barra
lateral e em `GET /saude`. Toda alteração de versão precisa de uma linha aqui.

---

## 1.1.3 — 2026-08-06

- **`instalar.sh` não sobrescreve mais o vhost que o certbot ajustou.** O certbot
  reescreve o arquivo ao emitir o certificado (acrescenta o bloco 443 e o
  redirecionamento). Reexecutar o instalador depois disso jogava o HTTPS fora e
  deixava o site em HTTP puro — pior: o certificado continua existindo, então o
  sintoma não é óbvio. Agora, achando `managed by Certbot` no arquivo, o script
  mantém o que está. Para refazer de propósito: `RECRIAR_VHOST=1 sudo ./instalar.sh …`
  e passar o certbot em seguida.

---

## 1.1.2 — 2026-08-06

Dois defeitos do `instalar.sh`, encontrados na primeira instalação real.

- **Alarme falso de exposição.** A conferência final testava sempre em `https://`.
  Sem certificado, tudo responde `000` — e o script lia `000` como "diferente de
  404, logo está exposto", acusando `/server.js`, `/data/.chave` e o conector de
  estarem sendo servidos. Não estavam: por HTTP os cinco caminhos devolviam 404.
  Agora o script testa no esquema que **existe** e trata `000` como "não deu para
  testar", que é o que ele significa.
- **Colisão com a renovação automática.** O `certbot.timer` disparou às 20:10:43
  e o instalador chamou o certbot às 20:10:46 — três segundos depois. O certbot
  recusa com *"Another instance of Certbot is already running"*, que parece lock
  preso e não é. Agora o script reconhece essa mensagem, espera 90s e tenta mais
  uma vez; qualquer outro erro ele mostra e para.

---

## 1.1.1 — 2026-08-06

### A trava de força bruta não valia nada atrás do nginx

`clientIp()` lia o **primeiro** item do `X-Forwarded-For`. O nginx monta
`X-Forwarded-For: <o que o cliente mandou>, <IP real>` — ele **acrescenta no
fim**. O primeiro item é texto do próprio visitante: bastava variá-lo a cada
tentativa para que cada erro de senha caísse num "IP" novo e o quinto erro
nunca chegasse.

Não é hipótese — é o mesmo furo encontrado em produção em quatro servidores
nossos em 2026-07-29 (BemEstarClinic, Kenósis ×2, Forms Fitness). Este projeto
nasceu com ele copiado junto e só apareceu na conferência do deploy.

**Corrigido em `seguranca.js` e no conector**: o cabeçalho só é considerado
quando quem abriu o socket é o proxy local; usa-se o `X-Real-IP` (que o nginx
**sobrescreve**, e por isso o cliente não consegue forjar) e, na falta dele, o
**último** item do `X-Forwarded-For`. Três testes novos cobrem exatamente o
ataque (**106/106**).

### Deploy

- `nginx/publisher.luizaugust.me.conf` — vhost com `client_max_body_size 2048m`,
  `proxy_request_buffering off` (senão o nginx guarda o vídeo inteiro em disco
  antes de repassar) e timeout de 1h (o padrão de 60s cortaria o upload).
- `nginx/lapublisher.service` — unit do systemd, deliberadamente **sem**
  `MemoryDenyWriteExecute` (ela mata o V8 com `5/TRAP` segundos depois de subir).
- `instalar.sh` — primeira instalação: confere Node ≥ 22.5, acerta dono e
  permissões, sobe o serviço, cria o vhost, **confirma com `nginx -T` que o
  bloco foi mesmo carregado** (o `nginx -t` aprova vhost que o nginx nem lê) e
  só emite o certificado se o DNS já apontar para o servidor.
- `enviar.ps1` — envia do Windows sem git: confere CRLF nos `.sh` antes de
  mandar e usa arquivo em disco em vez de cano binário (que o PowerShell
  corrompe). Nunca inclui `data/`, `midia/` nem `backups/`.
- `manutencao.html` — página servida pelo nginx quando o app está fora do ar.
- Log do cofre passa a imprimir o caminho real da chave (com `LAP_DATA` a pasta
  muda, e o log dizia sempre `data/.chave`).

---

## 1.1.0 — 2026-08-05

Desbloqueia o cadastro do app da Meta.

### Login do Facebook para Empresas

A Meta tem hoje **dois** produtos de login e eles não se pedem do mesmo jeito:
o clássico manda as permissões na URL (`scope`), e o **Login para Empresas** as
tira de uma *configuração* criada dentro do produto, identificada por um
`config_id`. Mandar `scope` no fluxo de Empresas dá erro logo no primeiro clique
de Conectar.

- Novo campo **ID da configuração** em Configurações → Aplicativos (só na Meta).
  Preenchido, o sistema usa o fluxo de Empresas; vazio, o clássico. Não é preciso
  saber de antemão qual o app usa.
- Novo campo **Versão da Graph API**, para quando a Meta aposentar a versão
  padrão (`v21.0`) — o sintoma é erro no clique de Conectar.
- Os dois são validados no servidor (`config_id` só números, versão no formato
  `v21.0`) e **mesclados**: salvar só o Client ID não apaga mais o que já estava.

### Páginas públicas de privacidade e exclusão de dados

Meta, Google e TikTok só liberam o app com uma política de privacidade e uma
página de exclusão de dados que **abram de verdade** — apontar para o site deles,
como vem no exemplo do painel da Meta, reprova na revisão.

- Novas rotas públicas **`/privacidade`** e **`/exclusao-de-dados`**, servidas
  pelo próprio sistema (`publico.js`), sem script nenhum e com CSP `default-src
  'none'`. São as duas únicas páginas indexáveis; o `robots.txt` libera só elas.
- O texto descreve o que o sistema **realmente** guarda: hash de senha, IP na
  auditoria, token cifrado, mídia, log de 90 dias — e o que ele não faz.
- Empresa, CNPJ e e-mail de contato saem das Configurações, sem mexer em código.
  O painel avisa enquanto o e-mail não estiver preenchido.

### Testes

- A bateria saiu do scratchpad e passou a viver no projeto, em `testes/`:
  `seguranca.cjs` (**103/103**), `integracao.cjs` + `site-falso.cjs` (**32/32**).
  Instruções de uso no cabeçalho de cada arquivo — inclusive o lembrete de rodar
  a força bruta por último.

---

## 1.0.0 — 2026-07-26

Primeira versão. Publicação automática de postagens em Instagram, Facebook,
TikTok, YouTube e nos sites do nosso gerador.

### Matéria

- Título, autor, fonte (com link), data de publicação e errata.
- **Resumo** e **texto** com editor de formatação (negrito, itálico, títulos,
  listas, citação, link) e botão **`</> HTML`** que alterna para o código.
- Fotos e vídeo por arrastar-e-soltar, com barra de progresso, até 2 GB por
  arquivo. Carrossel ordenável, escolha da capa.
- Largura, altura e duração medidas do próprio arquivo (PNG, JPEG, GIF, WEBP,
  MP4/MOV com correção de rotação) — sem biblioteca externa.

### Publicação

- Escolha de plataforma por matéria: uma, várias ou todas.
- Campos específicos por rede, montados a partir de `regras.js`: legenda e 1º
  comentário no Instagram; texto e link no Facebook; descrição, privacidade,
  comentários/duetos/costura e divulgação de conteúdo comercial no TikTok;
  título, descrição, tags, categoria, visibilidade, Short e declaração COPPA no
  YouTube; slug, destaque e publicar-agora no site.
- **Validação das regras de cada plataforma** antes de gastar chamada de API:
  limite de legenda, número de hashtags, proporção da imagem (4:5 a 1.91:1 no
  Instagram), duração e tamanho do vídeo, título de até 100 caracteres do
  YouTube, e por aí. Roda no painel (aviso ao vivo) e de novo no servidor.
- **Fila** com agendamento, 4 tentativas e espera crescente (5min → 20min →
  1h20). Erro de conteúdo (4xx) não retenta; erro de rede sim.
- Estado por DESTINO: falhou no TikTok mas entrou no Instagram = `parcial`, e a
  retentativa mexe só no que caiu.
- Ordem interna de publicação: YouTube primeiro, site por último — assim o site
  recebe o ID do vídeo e embute o player em vez de servir o arquivo.

### Contas

- OAuth real: Meta (Instagram Business + Página do Facebook), TikTok (com PKCE)
  e YouTube (Data API v3, `access_type=offline`).
- Renovação automática de token antes de publicar.
- Conector próprio para os sites do gerador, com assinatura HMAC-SHA256 e
  janela anti-replay de 5 minutos (`conector/lapublisher.js`).
- Botão **testar** em cada conta, com o motivo do erro quando falha.

### Segurança

Camada portada do `/restrito` da BemEstarClinic (a que fechou 69/69 no pentest
de 2026-07-24), mais o que este sistema exige:

- scrypt com salt por senha · `HASH_ISCA` contra enumeração de usuário por
  tempo · trava de 5 tentativas / 15 min por IP · sessão de 8h que morre no
  servidor no logout · troca de senha derruba as outras sessões.
- Perfis conferidos **no servidor**: `admin`, `editor` (escreve e publica),
  `redator` (escreve, não publica, não vê credencial).
- CSRF por cabeçalho próprio, além do `SameSite=Lax`.
- **Cofre AES-256-GCM** para token de rede social e `client_secret`, com a
  chave fora do banco (`data/.chave`).
- **Higienização do HTML** das matérias por reconstrução (lista de permissão de
  tags e atributos; `javascript:`, `on*`, `<script>`, `<iframe>` e `<svg>` não
  passam) — e de novo no conector, antes de chegar ao site do cliente.
- Upload conferido pelo **conteúdo**, não pelo que o navegador declara. SVG
  recusado de propósito.
- Auditoria de ação sensível com IP; diário de bordo por publicação.
- CSP, HSTS, nosniff, `X-Frame-Options: DENY`, noindex; app escutando só em
  `127.0.0.1`.

### Testado

- 81/81 na bateria de segurança (acesso sem sessão, exposição de arquivo, path
  traversal, XSS armazenado, upload disfarçado, SQLi, CSRF, perfis, vazamento
  de segredo, sessão, enumeração por tempo, força bruta).
- 31/31 no teste de ponta a ponta contra um site do gerador com o conector
  instalado (assinatura, replay, publicação, atualização sem duplicar,
  agendamento, conta desativada, conta com histórico).
