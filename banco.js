/* ==========================================================================
   banco.js — SQLite (node:sqlite), esquema, semente e COFRE de segredos.

   Um módulo só, carregado uma vez pelo processo: o server.js, o painel e a
   fila conversam com a MESMA conexão. Usa `node:sqlite` (nativo, sem npm
   install) — exige Node ≥ 22.5; aqui rodamos em 24.

   COFRE: token de rede social e client_secret são credenciais de terceiro.
   Se o banco vazar, quem pegar publica no lugar do cliente. Por isso nada
   disso é gravado em claro: AES-256-GCM com chave fora do banco (data/.chave,
   que o .gitignore e o deploy nunca versionam, ou a env LAP_CHAVE).
   ========================================================================== */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
/* LAP_DATA permite subir uma cópia de teste com banco próprio, sem encostar
   no banco do cliente (mesma ideia do PORT por env). */
const DATA_DIR = process.env.LAP_DATA ? path.resolve(process.env.LAP_DATA) : path.join(ROOT, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

/* --- teste de escrita no boot ---------------------------------------------
   O SQLite grava o -wal/-shm NA PASTA, então a pasta precisa ser gravável, não
   só o arquivo. Descobrir isso no primeiro POST do cliente custa caro; melhor
   gritar aqui. (Armadilha já paga no BemEstarClinic.) */
try {
  const t = path.join(DATA_DIR, ".escrita-teste");
  fs.writeFileSync(t, "ok"); fs.unlinkSync(t);
} catch (e) {
  console.error(`\n  ✖ SEM PERMISSÃO DE ESCRITA em ${DATA_DIR}`);
  console.error(`    O SQLite precisa gravar o -wal na PASTA, não só no arquivo.`);
  console.error(`    Corrija o dono da pasta para o usuário que roda o serviço.\n`);
}

const db = new DatabaseSync(path.join(DATA_DIR, "publisher.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  /* ---------------- operadores do sistema ------------------------------ */
  -- perfil: admin (tudo) | editor (cria e publica) | redator (cria, não publica)
  CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, email TEXT UNIQUE, senha_hash TEXT NOT NULL,
    perfil TEXT NOT NULL DEFAULT 'admin', ativo INTEGER DEFAULT 1, criado TEXT);

  CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);

  /* ---------------- credenciais dos apps de desenvolvedor ---------------
     Uma linha por plataforma. client_secret vai CIFRADO (ver cofre abaixo).
     "extra" guarda o que é específico de cada uma em JSON (ex.: o
     redirect_uri registrado, o id do app da Meta, a categoria padrão do
     YouTube). */
  CREATE TABLE IF NOT EXISTS apps (id INTEGER PRIMARY KEY AUTOINCREMENT,
    plataforma TEXT NOT NULL UNIQUE, client_id TEXT, client_secret TEXT,
    extra TEXT, ativo INTEGER DEFAULT 1, atualizado TEXT);

  /* ---------------- contas conectadas -----------------------------------
     Cada linha é um DESTINO possível: um perfil do Instagram, uma Página do
     Facebook, uma conta do TikTok, um canal do YouTube ou um site do gerador.
     token/refresh cifrados. "meta" em JSON: ig_user_id, page_id, channel_id,
     url do site, etc. */
  CREATE TABLE IF NOT EXISTS contas (id INTEGER PRIMARY KEY AUTOINCREMENT,
    plataforma TEXT NOT NULL, nome TEXT NOT NULL, apelido TEXT,
    externo_id TEXT, token TEXT, refresh TEXT, expira TEXT,
    escopos TEXT, meta TEXT, ativo INTEGER DEFAULT 1,
    ultimo_erro TEXT, criado TEXT, atualizado TEXT);

  /* ---------------- postagens -------------------------------------------
     O post é o CONTEÚDO. Para onde ele vai é a tabela "destinos" — assim a
     mesma matéria pode ir para 5 lugares com legendas diferentes e estados
     diferentes (publicou no Instagram, falhou no TikTok).
     tipo: foto | video | texto   ·   status: rascunho | agendado | publicando
                                              | publicado | parcial | erro */
  CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo TEXT NOT NULL, slug TEXT,
    resumo_html TEXT, texto_html TEXT,
    fonte TEXT, fonte_url TEXT, autor TEXT, errata TEXT,
    data_publicacao TEXT, tipo TEXT DEFAULT 'foto',
    status TEXT DEFAULT 'rascunho',
    usuario_id INTEGER, criado TEXT, atualizado TEXT);

  /* ---------------- mídia do post ---------------------------------------
     "arquivo" é o nome no diretório /midia (servido publicamente: Instagram,
     TikTok e o site BAIXAM a mídia por URL, não aceitam upload local).
     ordem monta o carrossel; capa=1 marca a imagem principal do blog. */
  CREATE TABLE IF NOT EXISTS midias (id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL, arquivo TEXT NOT NULL, tipo TEXT DEFAULT 'imagem',
    mime TEXT, bytes INTEGER, largura INTEGER, altura INTEGER, duracao REAL,
    alt TEXT, ordem INTEGER DEFAULT 0, capa INTEGER DEFAULT 0, criado TEXT,
    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE);

  /* ---------------- destinos (post × plataforma) -------------------------
     status: pendente | agendado | processando | publicado | erro | cancelado
     "opcoes" em JSON guarda o que é específico da rede: legenda, hashtags,
     título/descrição/tags/privacidade do YouTube, privacy_level do TikTok,
     categoria e slug do site. */
  CREATE TABLE IF NOT EXISTS destinos (id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL, conta_id INTEGER, plataforma TEXT NOT NULL,
    status TEXT DEFAULT 'pendente', agendado_para TEXT,
    tentativas INTEGER DEFAULT 0, proxima_tentativa TEXT,
    erro TEXT, externo_id TEXT, url_externa TEXT, opcoes TEXT,
    publicado_em TEXT, criado TEXT, atualizado TEXT,
    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE);

  /* ---------------- diário de bordo -------------------------------------- */
  CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER, destino_id INTEGER, plataforma TEXT,
    nivel TEXT DEFAULT 'info', mensagem TEXT, detalhe TEXT, ts TEXT);

  /* ==================================================================
     API PÚBLICA — um "cliente" é um SITE que aciona o LA Publisher.

     Inversão de sentido em relação ao conector: lá nós empurramos a matéria
     para o site; aqui o site é quem manda publicar nas redes.

     A regra que sustenta tudo: **cada chave só enxerga as contas dela**. Sem
     isso, a chave do site do BemEstar publicaria no Instagram de outro
     cliente — que é o pior acidente possível neste sistema.
     ================================================================== */
  CREATE TABLE IF NOT EXISTS clientes_api (id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, chave TEXT NOT NULL UNIQUE, segredo TEXT NOT NULL,
    origem TEXT, webhook_url TEXT, ativo INTEGER DEFAULT 1,
    criado TEXT, ultimo_uso TEXT, chamadas INTEGER DEFAULT 0);

  -- quais contas cada cliente pode usar (nasce do autoatendimento)
  CREATE TABLE IF NOT EXISTS clientes_contas (
    cliente_id INTEGER NOT NULL, conta_id INTEGER NOT NULL, criado TEXT,
    PRIMARY KEY (cliente_id, conta_id));

  /* Convite de conexão: link de USO ÚNICO que o site entrega ao dono da
     conta. Quem clica autoriza na Meta e a conta nasce amarrada àquele
     cliente. É uma credencial temporária — por isso expira e só serve uma vez. */
  CREATE TABLE IF NOT EXISTS conexoes (id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER NOT NULL, token TEXT NOT NULL UNIQUE,
    plataforma TEXT, retorno_url TEXT, status TEXT DEFAULT 'aberto',
    contas TEXT, expira TEXT, criado TEXT, usado_em TEXT, ip TEXT);

  /* Entrega de webhook. Guardada em tabela (e não disparada e esquecida)
     porque o site do cliente pode estar fora do ar na hora — sem fila, o
     aviso se perderia justamente quando mais importa. */
  CREATE TABLE IF NOT EXISTS webhooks (id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER, post_id INTEGER, destino_id INTEGER,
    url TEXT NOT NULL, evento TEXT NOT NULL, corpo TEXT,
    status TEXT DEFAULT 'pendente', tentativas INTEGER DEFAULT 0,
    proxima_tentativa TEXT, resposta TEXT, criado TEXT, atualizado TEXT);

  /* ---------------- auditoria (quem fez o quê) ---------------------------
     Publicar em nome de uma marca é ação com consequência pública. Toda ação
     sensível (login, publicar, conectar/desconectar conta, mexer em usuário)
     fica registrada com IP. */
  CREATE TABLE IF NOT EXISTS auditoria (id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER, usuario_nome TEXT, acao TEXT, alvo TEXT,
    ip TEXT, ts TEXT);

  CREATE INDEX IF NOT EXISTS idx_wh_pendente ON webhooks(status, proxima_tentativa);
  CREATE INDEX IF NOT EXISTS idx_cli_chave ON clientes_api(chave);
  CREATE INDEX IF NOT EXISTS idx_dest_post ON destinos(post_id);
  CREATE INDEX IF NOT EXISTS idx_dest_status ON destinos(status, proxima_tentativa);
  CREATE INDEX IF NOT EXISTS idx_midia_post ON midias(post_id, ordem);
  CREATE INDEX IF NOT EXISTS idx_logs_post ON logs(post_id, id);
  CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
`);

/* Migrações leves — CREATE TABLE IF NOT EXISTS não altera tabela existente.
   Cada linha é idempotente: se a coluna já existe, o erro é ignorado. */
for (const alt of [
  "ALTER TABLE contas ADD COLUMN ultimo_erro TEXT",
  "ALTER TABLE posts ADD COLUMN fonte_url TEXT",
  "ALTER TABLE midias ADD COLUMN alt TEXT",
  /* Matéria criada pela API: de qual site veio, qual o id dela LÁ (é o que
     torna o reenvio idempotente) e para onde avisar o resultado. */
  "ALTER TABLE posts ADD COLUMN cliente_id INTEGER",
  "ALTER TABLE posts ADD COLUMN origem_ref TEXT",
  "ALTER TABLE posts ADD COLUMN callback_url TEXT",
]) { try { db.exec(alt); } catch { /* já existe */ } }
/* Índice único parcial: o MESMO site não cria duas matérias com a mesma
   referência de origem — é isto que impede post duplicado quando o site
   repete a chamada por timeout ou por clique dobrado. */
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_origem
           ON posts(cliente_id, origem_ref)
           WHERE cliente_id IS NOT NULL AND origem_ref IS NOT NULL AND origem_ref <> ''`);
} catch { /* banco antigo sem suporte a índice parcial */ }

const getC = (k) => db.prepare("SELECT value FROM config WHERE key=?").get(k)?.value;
const setC = (k, v) => db.prepare(
  "INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
).run(k, String(v));

/* ==========================================================================
   COFRE — AES-256-GCM
   A chave NÃO mora no banco (senão cifrar não protegeria nada: quem leva o
   .db levaria a chave junto). Ordem: env LAP_CHAVE → data/.chave → cria uma.
   ========================================================================== */
function carregarChave() {
  if (process.env.LAP_CHAVE && /^[a-f0-9]{64}$/i.test(process.env.LAP_CHAVE))
    return Buffer.from(process.env.LAP_CHAVE, "hex");
  const arq = path.join(DATA_DIR, ".chave");
  if (fs.existsSync(arq)) {
    const t = fs.readFileSync(arq, "utf8").trim();
    if (/^[a-f0-9]{64}$/i.test(t)) return Buffer.from(t, "hex");
  }
  const nova = crypto.randomBytes(32);
  fs.writeFileSync(arq, nova.toString("hex"), { mode: 0o600 });
  try { fs.chmodSync(arq, 0o600); } catch { /* Windows */ }
  /* Imprime o caminho REAL (com LAP_DATA a pasta muda) — numa emergência,
     log que aponta para o lugar errado custa mais caro que log nenhum. */
  console.log(`  · cofre: chave nova criada em ${arq} (guarde um backup dela)`);
  return nova;
}
const CHAVE = carregarChave();

/* Guarda no formato v1:<iv>:<tag>:<cifrado>, tudo em base64url. */
function cifrar(texto) {
  if (texto === null || texto === undefined || texto === "") return "";
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", CHAVE, iv);
  const dados = Buffer.concat([c.update(String(texto), "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), dados.toString("base64url")].join(":");
}
function decifrar(guardado) {
  if (!guardado) return "";
  const p = String(guardado).split(":");
  if (p[0] !== "v1" || p.length !== 4) return "";       // valor antigo/corrompido: trata como vazio
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", CHAVE, Buffer.from(p[1], "base64url"));
    d.setAuthTag(Buffer.from(p[2], "base64url"));
    return Buffer.concat([d.update(Buffer.from(p[3], "base64url")), d.final()]).toString("utf8");
  } catch { return ""; }                                 // chave trocada → não decifra (correto)
}

/* Segredo para assinar o "state" do OAuth e os tokens do conector dos sites.
   Fica no banco porque é só um HMAC interno, não uma credencial de terceiro. */
function segredoHmac() {
  let s = getC("hmac_segredo");
  if (!s) { s = crypto.randomBytes(32).toString("hex"); setC("hmac_segredo", s); }
  return s;
}

/* --------------------------------- utilidades ---------------------------- */
const agora = () => new Date().toISOString();

/* Registro no diário de bordo. Silencioso de propósito: log que derruba a
   publicação seria pior que log perdido. */
function registrar(nivel, mensagem, { postId = null, destinoId = null, plataforma = null, detalhe = null } = {}) {
  try {
    db.prepare("INSERT INTO logs(post_id,destino_id,plataforma,nivel,mensagem,detalhe,ts) VALUES(?,?,?,?,?,?,?)")
      .run(postId, destinoId, plataforma, nivel, String(mensagem || "").slice(0, 2000),
           detalhe ? String(detalhe).slice(0, 8000) : null, agora());
  } catch { /* nunca deixar o log quebrar a operação */ }
}
function auditar(sessao, acao, alvo, ip) {
  try {
    db.prepare("INSERT INTO auditoria(usuario_id,usuario_nome,acao,alvo,ip,ts) VALUES(?,?,?,?,?,?)")
      .run(sessao?.userId || null, sessao?.nome || "(sistema)", acao, String(alvo || "").slice(0, 300), ip || "", agora());
  } catch { /* idem */ }
}

/* Limpeza: log é útil por 90 dias; depois é só peso. Roda uma vez por dia. */
setInterval(() => {
  const limite = new Date(Date.now() - 90 * 864e5).toISOString();
  try { db.prepare("DELETE FROM logs WHERE ts < ?").run(limite); } catch { }
}, 24 * 3600_000).unref();

module.exports = { db, ROOT, DATA_DIR, getC, setC, cifrar, decifrar, segredoHmac, agora, registrar, auditar };
