/* ==========================================================================
   midia.js — mede a mídia enviada SEM depender de biblioteca externa.

   Por que isto existe: a validação das plataformas é toda por número —
   "o Instagram só aceita entre 4:5 e 1.91:1", "o Reels tem de 3s a 15min",
   "Short é vertical até 3min". Sem largura, altura e duração, o sistema só
   descobriria o problema quando a API recusasse, depois de subir 800 MB.

   Lê o cabeçalho do arquivo direto:
     · PNG  → IHDR
     · JPEG → marcadores SOF
     · GIF  → screen descriptor
     · WEBP → VP8 / VP8L / VP8X
     · MP4/MOV → caixas mvhd (duração) e tkhd (dimensão), inclusive dentro de
       moov aninhado, com suporte a versão 1 (64 bits) e à matriz de rotação
       (vídeo de celular vem girado 90° — sem isso, um vertical seria medido
       como horizontal e o Short seria recusado à toa).
   Não sabendo medir, devolve null — a validação simplesmente não aplica
   aquela regra, em vez de barrar por engano.
   ========================================================================== */
const fs = require("node:fs");

function lerInicio(caminho, bytes) {
  const fd = fs.openSync(caminho, "r");
  try {
    const tam = Math.min(bytes, fs.fstatSync(fd).size);
    const buf = Buffer.alloc(tam);
    fs.readSync(fd, buf, 0, tam, 0);
    return buf;
  } finally { fs.closeSync(fd); }
}

/* ------------------------------- imagens ---------------------------------- */
function medirImagem(caminho) {
  const b = lerInicio(caminho, 65536);
  if (b.length < 16) return {};

  // PNG
  if (b[0] === 0x89 && b.toString("ascii", 1, 4) === "PNG")
    return { largura: b.readUInt32BE(16), altura: b.readUInt32BE(20) };

  // GIF
  if (b.toString("ascii", 0, 3) === "GIF")
    return { largura: b.readUInt16LE(6), altura: b.readUInt16LE(8) };

  // WEBP (RIFF....WEBP)
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const tipo = b.toString("ascii", 12, 16);
    if (tipo === "VP8 ") return { largura: b.readUInt16LE(26) & 0x3fff, altura: b.readUInt16LE(28) & 0x3fff };
    if (tipo === "VP8L") {
      const n = b.readUInt32LE(21);
      return { largura: (n & 0x3fff) + 1, altura: ((n >> 14) & 0x3fff) + 1 };
    }
    if (tipo === "VP8X") return { largura: (b.readUIntLE(24, 3) & 0xffffff) + 1, altura: (b.readUIntLE(27, 3) & 0xffffff) + 1 };
  }

  // JPEG: caminha pelos marcadores até um SOF
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xff) { i++; continue; }
      const marca = b[i + 1];
      if (marca === 0xd8 || marca === 0x01 || (marca >= 0xd0 && marca <= 0xd7)) { i += 2; continue; }
      const tam = b.readUInt16BE(i + 2);
      // SOF0..SOF15, menos DHT(c4), JPG(c8) e DAC(cc)
      if (marca >= 0xc0 && marca <= 0xcf && marca !== 0xc4 && marca !== 0xc8 && marca !== 0xcc)
        return { altura: b.readUInt16BE(i + 5), largura: b.readUInt16BE(i + 7) };
      i += 2 + tam;
    }
  }
  return {};
}

/* -------------------------------- vídeo ----------------------------------- */
/* Percorre as caixas do MP4/MOV procurando mvhd e tkhd. Lê só o começo do
   arquivo (2 MB): quando o moov está no fim (arquivo não otimizado para web),
   procuramos também nos últimos 4 MB. */
function varrerCaixas(buf, inicio, fim, achado, profundidade = 0) {
  let p = inicio;
  while (p + 8 <= fim && profundidade < 6) {
    let tam = buf.readUInt32BE(p);
    const tipo = buf.toString("ascii", p + 4, p + 8);
    let cabecalho = 8;
    if (tam === 1) {                       // tamanho 64 bits
      if (p + 16 > fim) break;
      tam = Number(buf.readBigUInt64BE(p + 8));
      cabecalho = 16;
    } else if (tam === 0) tam = fim - p;   // até o fim do arquivo
    if (tam < cabecalho || p + tam > fim + 1) break;

    if (["moov", "trak", "mdia", "edts"].includes(tipo)) {
      varrerCaixas(buf, p + cabecalho, Math.min(p + tam, fim), achado, profundidade + 1);
    } else if (tipo === "mvhd" && p + cabecalho + 20 <= fim) {
      const versao = buf[p + cabecalho];
      const base = p + cabecalho + 4;
      if (versao === 1) {
        const escala = buf.readUInt32BE(base + 16);
        const dur = Number(buf.readBigUInt64BE(base + 20));
        if (escala) achado.duracao = dur / escala;
      } else {
        const escala = buf.readUInt32BE(base + 8);
        const dur = buf.readUInt32BE(base + 12);
        if (escala) achado.duracao = dur / escala;
      }
    } else if (tipo === "tkhd" && p + cabecalho + 84 <= fim) {
      const versao = buf[p + cabecalho];
      const base = p + cabecalho + 4;
      const desl = versao === 1 ? 32 : 20;          // até o fim de reserved/duration
      const mat = base + desl + 16;                  // matriz 3×3 (9 × 4 bytes)
      const larg = buf.readUInt32BE(mat + 36) / 65536;
      const alt = buf.readUInt32BE(mat + 40) / 65536;
      if (larg && alt) {
        /* a[0][0] e a[0][1] da matriz dizem se o vídeo está girado */
        const a = buf.readInt32BE(mat) / 65536, bb = buf.readInt32BE(mat + 4) / 65536;
        const girado = Math.abs(a) < 0.01 && Math.abs(bb) > 0.99;
        const w = Math.round(larg), h = Math.round(alt);
        if (!achado.largura || w * h > achado.largura * achado.altura) {
          achado.largura = girado ? h : w;
          achado.altura = girado ? w : h;
        }
      }
    }
    p += tam;
  }
}

function medirVideo(caminho) {
  const st = fs.statSync(caminho);
  const achado = {};
  const fd = fs.openSync(caminho, "r");
  try {
    const pedaco = Math.min(2 * 1024 * 1024, st.size);
    const ini = Buffer.alloc(pedaco);
    fs.readSync(fd, ini, 0, pedaco, 0);
    varrerCaixas(ini, 0, pedaco, achado);

    if ((!achado.duracao || !achado.largura) && st.size > pedaco) {
      const fimTam = Math.min(4 * 1024 * 1024, st.size);
      const fim = Buffer.alloc(fimTam);
      fs.readSync(fd, fim, 0, fimTam, st.size - fimTam);
      /* O moov pode começar em qualquer offset aqui; procuramos a assinatura. */
      let i = fim.indexOf(Buffer.from("moov", "ascii"));
      while (i > 4) {
        varrerCaixas(fim, i - 4, fimTam, achado);
        if (achado.duracao && achado.largura) break;
        i = fim.indexOf(Buffer.from("moov", "ascii"), i + 4);
      }
    }
  } catch { /* arquivo estranho: devolve o que deu */ }
  finally { fs.closeSync(fd); }
  return achado;
}

/* MIME de verdade, pelo conteúdo — não pelo que o navegador disse.
   O nome e o Content-Type vêm do cliente e podem mentir; o cabeçalho não. */
function mimeReal(caminho) {
  const b = lerInicio(caminho, 32);
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  const marca = b.toString("ascii", 4, 8);
  if (marca === "ftyp") {
    const sub = b.toString("ascii", 8, 12);
    if (/qt/.test(sub)) return "video/quicktime";
    return "video/mp4";
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  return null;
}

function medir(caminho, mime) {
  try {
    if (String(mime || "").startsWith("video/")) {
      const v = medirVideo(caminho);
      return { largura: v.largura || null, altura: v.altura || null, duracao: v.duracao || null };
    }
    const i = medirImagem(caminho);
    return { largura: i.largura || null, altura: i.altura || null, duracao: null };
  } catch { return { largura: null, altura: null, duracao: null }; }
}

module.exports = { medir, mimeReal, medirImagem, medirVideo };
