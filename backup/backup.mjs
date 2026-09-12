/* ============================================================
   BACKUP COMPLETO DO BANCO — roda no seu computador, não no site.
   ------------------------------------------------------------
   Diferente do botão "Baixar backup" do painel, este script usa uma credencial
   de servidor (a chave de serviço do Firebase) e por isso enxerga TUDO — inclui
   os comprovantes individuais de pagamento, que as regras de segurança reservam
   a cada dono e que nem o admin consegue ler pelo site.

   Como usar está no SETUP.md, na seção "Backup do banco de dados". Em resumo:
     npm install
     node backup.mjs

   O resultado é um arquivo backup-AAAA-MM-DD-HHMM.json na pasta backups/.
   Esse arquivo contém telefone, data de nascimento e o financeiro de toda a
   bateria — guarde como você guardaria uma planilha de RH, não no WhatsApp.
   ============================================================ */
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const CAMINHO_CHAVE = join(AQUI, "chave-de-servico.json");

if (!existsSync(CAMINHO_CHAVE)) {
  console.error(`
Não encontrei a chave de serviço em:
  ${CAMINHO_CHAVE}

Ela é o que autoriza este script a ler o banco. Como obter (uma vez só):
  1. Firebase Console -> engrenagem -> Configurações do projeto
  2. aba "Contas de serviço" -> "Gerar nova chave privada"
  3. salve o arquivo baixado nesta pasta com o nome chave-de-servico.json

ATENÇÃO: essa chave dá acesso TOTAL ao banco, ignorando todas as regras de
segurança. Nunca suba ela para o GitHub nem mande por mensagem.
`);
  process.exit(1);
}

initializeApp({ credential: cert(JSON.parse(readFileSync(CAMINHO_CHAVE, "utf8"))) });
const db = getFirestore();

/* O Firestore guarda datas e outros tipos que não existem em JSON. Converter
   para texto aqui é o que permite reabrir o arquivo daqui a anos sem depender
   de nenhuma biblioteca — e o restaurar.mjs sabe desfazer a conversão. */
function paraJSON(valor) {
  if (valor === null || valor === undefined) return valor;
  if (typeof valor.toDate === "function") return { __tipo: "timestamp", valor: valor.toDate().toISOString() };
  if (Array.isArray(valor)) return valor.map(paraJSON);
  if (typeof valor === "object" && valor.constructor === Object) {
    const out = {};
    for (const [k, v] of Object.entries(valor)) out[k] = paraJSON(v);
    return out;
  }
  return valor;
}

async function lerColecao(ref) {
  const snap = await ref.get();
  const out = {};
  snap.docs.forEach(d => { out[d.id] = paraJSON(d.data()); });
  return out;
}

async function principal() {
  console.log("Lendo o banco...");
  const backup = {
    geradoEm: new Date().toISOString(),
    formato: 1,
    origem: "backup.mjs (credencial de servidor — inclui os comprovantes de pagamento)",
    pessoas: await lerColecao(db.collection("pessoas")),
    contatos: await lerColecao(db.collection("contatos")),
    edicoes: {},
    legado: {},
  };

  const edicoes = await db.collection("edicoes").get();
  for (const ed of edicoes.docs) {
    const eid = ed.id;
    process.stdout.write(`  carnaval ${eid}... `);
    backup.edicoes[eid] = {
      dados: paraJSON(ed.data()),
      inscricoes: await lerColecao(db.collection(`edicoes/${eid}/inscricoes`)),
      posicoes: await lerColecao(db.collection(`edicoes/${eid}/posicoes`)),
      ensaios: await lerColecao(db.collection(`edicoes/${eid}/ensaios`)),
      musicas: await lerColecao(db.collection(`edicoes/${eid}/musicas`)),
      config: await lerColecao(db.collection(`edicoes/${eid}/config`)),
      pagamentos: await lerColecao(db.collection(`edicoes/${eid}/pagamentos`)),
      presencas: await lerColecao(db.collection(`edicoes/${eid}/presencas`)),
    };
    const n = Object.keys(backup.edicoes[eid].inscricoes).length;
    const p = Object.keys(backup.edicoes[eid].pagamentos).length;
    console.log(`${n} inscrições, ${p} comprovantes de pagamento`);
  }

  // Coleções do formato antigo, se ainda existirem. Enquanto elas estiverem no
  // banco fazem parte do que precisa ser preservado.
  for (const nome of ["users", "posicoes", "ensaios", "musicas", "config", "presencas", "pagamentos"]) {
    const dados = await lerColecao(db.collection(nome));
    if (Object.keys(dados).length) backup.legado[nome] = dados;
  }
  if (Object.keys(backup.legado).length) console.log("  coleções do formato antigo incluídas");

  const pasta = join(AQUI, "backups");
  mkdirSync(pasta, { recursive: true });
  const agora = new Date();
  const carimbo = agora.toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  const arquivo = join(pasta, `backup-${carimbo}.json`);
  writeFileSync(arquivo, JSON.stringify(backup, null, 2), "utf8");

  const totalPessoas = Object.keys(backup.pessoas).length;
  console.log(`
Pronto: ${arquivo}
  ${totalPessoas} cadastros, ${Object.keys(backup.edicoes).length} carnaval(is).

O arquivo tem dados pessoais da bateria inteira. Guarde num lugar privado.`);
}

principal().catch(err => { console.error("\nDeu erro:", err.message); process.exit(1); });
