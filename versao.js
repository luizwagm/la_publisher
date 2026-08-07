/* ==========================================================================
   versao.js — fonte ÚNICA da versão do LA Publisher

   Regra combinada (a mesma do /restrito da BemEstarClinic, estendida):

     MAIOR . FUNCIONALIDADE . CORREÇÃO [ . AJUSTE ]
       1   .      2         .    3     .    4

     · 2ª casa  → funcionalidade nova            1.1.0, 1.2.0, 1.3.0 … 1.10.0, 1.11.0
     · 3ª casa  → correção de bug / melhoria     1.1.1, 1.1.2, 1.2.4
     · 4ª casa  → ajuste pontual (opcional)      1.2.4.1  — retoque que nem chega
                                                 a ser um bug fechado
     · 1ª casa  → só quando a base muda de forma incompatível

   As casas NÃO são limitadas a um dígito: depois de 1.9.0 vem 1.10.0.
   Toda alteração de versão precisa de uma linha no CHANGELOG.md.
   ========================================================================== */
const VERSAO = "1.2.0";

/* Compara duas versões ("1.10.0" > "1.9.0"). Devolve -1, 0 ou 1. */
function compararVersao(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const VERSAO_RE = /^\d+\.\d+\.\d+(\.\d+)?$/;

module.exports = { VERSAO, compararVersao, VERSAO_RE };
