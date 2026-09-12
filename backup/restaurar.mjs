/* ============================================================
   RESTAURAÇÃO A PARTIR DE UM BACKUP
   ------------------------------------------------------------
   Backup que nunca foi testado não é backup. Este script existe para você poder
   provar, uma vez, que o arquivo gerado pelo backup.mjs realmente reconstrói o
   banco — e para servir de socorro no dia em que precisar.

   USO:
     node restaurar.mjs backups/backup-2026-09-11-0800.json           (simulação)
     node restaurar.mjs backups/backup-2026-09-11-0800.json --gravar  (grava de verdade)

   Sem --gravar ele NÃO escreve nada: só lista o que faria. Comece sempre assim.

   IMPORTANTE: a restauração ESCREVE POR CIMA dos documentos que existem no
   backup e NÃO apaga o que foi criado depois. Ou seja, ela devolve o que estava
   lá, mas não desfaz criações posteriores. Para um teste honesto, restaure num
   projeto Firebase separado (de teste), não no que está no ar.
   ============================================================ */
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const CAMINHO_CHAVE = join(AQUI, "chave-de-servico.json");
const arquivoBackup = process.argv[2];
const gravarDeVerdade = process.argv.includes("--gravar");

if (!arquivoBackup) {
  console.error("Diga qual arquivo restaurar. Ex: node restaurar.mjs backups/backup-2026-09-11-0800.json");
  process.exit(1);
}
if (!existsSync(CAMINHO_CHAVE)) {
  console.error("Falta a chave-de-servico.json nesta pasta — veja o SETUP.md.");
  process.exit(1);
}

initializeApp({ credential: cert(JSON.parse(readFileSync(CAMINHO_CHAVE, "utf8"))) });
const db = getFirestore();

/* Desfaz a conversão feita no backup: o que virou {__tipo:"timestamp"} volta a
   ser data de verdade, senão o site passaria a ver texto onde espera data. */
function doJSON(valor) {
  if (valor === null || valor === undefined) return valor;
  if (Array.isArray(valor)) return valor.map(doJSON);
  if (typeof valor === "object") {
    if (valor.__tipo === "timestamp") return Timestamp.fromDate(new Date(valor.valor));
    const out = {};
    for (const [k, v] of Object.entries(valor)) out[k] = doJSON(v);
    return out;
  }
  return valor;
}

const backup = JSON.parse(readFileSync(resolve(arquivoBackup), "utf8"));
const escritas = [];

const enfileirar = (caminho, docs) => {
  Object.entries(docs || {}).forEach(([id, dados]) => escritas.push([`${caminho}/${id}`, doJSON(dados)]));
};

enfileirar("pessoas", backup.pessoas);
enfileirar("contatos", backup.contatos);
Object.entries(backup.edicoes || {}).forEach(([eid, ed]) => {
  escritas.push([`edicoes/${eid}`, doJSON(ed.dados)]);
  ["inscricoes", "posicoes", "ensaios", "musicas", "config", "pagamentos", "presencas"]
    .forEach(sub => enfileirar(`edicoes/${eid}/${sub}`, ed[sub]));
});
Object.entries(backup.legado || {}).forEach(([nome, docs]) => enfileirar(nome, docs));

console.log(`Backup de ${backup.geradoEm}`);
console.log(`${escritas.length} documentos a restaurar.`);

if (!gravarDeVerdade) {
  console.log("\nSIMULAÇÃO — nada foi gravado. Amostra do que seria escrito:");
  escritas.slice(0, 10).forEach(([caminho]) => console.log("  " + caminho));
  if (escritas.length > 10) console.log(`  ... e mais ${escritas.length - 10}`);
  console.log("\nPara gravar de verdade, rode de novo com --gravar no final.");
  process.exit(0);
}

/* Um lote do Firestore aceita no máximo 500 operações. */
async function gravar() {
  for (let i = 0; i < escritas.length; i += 400) {
    const lote = db.batch();
    escritas.slice(i, i + 400).forEach(([caminho, dados]) => lote.set(db.doc(caminho), dados));
    await lote.commit();
    console.log(`  gravados ${Math.min(i + 400, escritas.length)}/${escritas.length}`);
  }
  console.log("\nRestauração concluída.");
}

gravar().catch(err => { console.error("\nDeu erro:", err.message); process.exit(1); });
