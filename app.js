import {
  auth, db,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, sendPasswordResetEmail,
  collection, doc, setDoc, updateDoc, deleteDoc, addDoc, getDoc, getDocs,
  onSnapshot, query, where, writeBatch, increment, serverTimestamp,
} from './firebase-init.js';

/* ============================================================
   CONSTANTES
   ============================================================ */
const CAMISAS = ["P", "M", "G", "GG", "XGG"];
const PLANOS = {
  avista:    { label: "À vista", parcelas: 1 },
  duasVezes: { label: "2x",      parcelas: 2 },
  tresVezes: { label: "3x",      parcelas: 3 },
};
const STATUS_ORDEM = ["Isenta", "Sem plano", "No prazo", "Atrasado", "Quitado"];

const DEFAULT_POSICOES = [
  { nome: "Agogô", isenta: false }, { nome: "Caixa", isenta: false }, { nome: "Cuíca", isenta: false },
  { nome: "Repique", isenta: false }, { nome: "Rocar/Ganzá", isenta: false },
  { nome: "Surdo 1", isenta: false }, { nome: "Surdo 2", isenta: false }, { nome: "Surdo 3", isenta: false },
  { nome: "Tamborim", isenta: false },
  { nome: "Apoio", isenta: true }, { nome: "Breguete", isenta: true }, { nome: "Harmonia", isenta: true },
  { nome: "Princesa/Rainha", isenta: true }, { nome: "Voz", isenta: true }, { nome: "Mestre", isenta: true },
  { nome: "Produção", isenta: true }, { nome: "Metais", isenta: true },
];
const DEFAULT_PRECOS = {
  chavePix: "",
  avista:    { valor: 210, prazos: [""] },
  duasVezes: { valor: 230, prazos: ["", ""] },
  tresVezes: { valor: 250, prazos: ["", "", ""] },
};

/* Estados possíveis de uma edição do carnaval. */
const EDICAO_STATUS = {
  preparando: { label: "Em preparação", cls: "badge-warning", sub: "Ainda não liberada — não aparece para os batuqueiros no site" },
  aberta:     { label: "Aberta",        cls: "badge-good",    sub: "Em andamento — os batuqueiros estão usando" },
  encerrada:  { label: "Encerrada",     cls: "badge-isenta",  sub: "Histórico — ninguém edita mais, nem o admin" },
};

/* ============================================================
   CAMINHOS NO BANCO
   ------------------------------------------------------------
   Os dados permanentes de cada pessoa (nome, nascimento, contato e os acessos
   de organização) ficam em /pessoas/{uid} e valem para sempre. Tudo o que muda
   de um carnaval para o outro (posição, camisa, se vai tocar, isenção,
   pagamento, ensaios, músicas, preços, presença) vive dentro da edição
   correspondente, em /edicoes/{id}/..., de modo que um ano nunca se mistura
   com o outro e o histórico fica preservado.

   O id de uma edição é "ano-sequência" (ex: 2027-1, 2027-2): no Firestore o id
   de um documento é imutável, e a data do desfile muda com frequência — usar a
   data como id deixaria o identificador permanentemente errado. O ano não muda,
   a sequência cobre o caso de desfilar duas vezes no mesmo ano, e a data real
   fica no campo dataDoCarnaval, livre para editar.
   ============================================================ */
const P = {
  pessoas:    ()          => collection(db, "pessoas"),
  pessoa:     (uid)       => doc(db, "pessoas", uid),
  // Contato (celular e data de nascimento) fica FORA de /pessoas de propósito:
  // /pessoas é lido por qualquer pessoa logada (é o que monta a lista da bateria,
  // a presença e o histórico), e regra do Firestore não filtra campo — só
  // documento. Separando, o celular e o nascimento só podem ser lidos pelo
  // próprio dono e pela organização. Ver firestore.rules, match /contatos/{uid}.
  contatos:   ()          => collection(db, "contatos"),
  contato:    (uid)       => doc(db, "contatos", uid),
  edicoes:    ()          => collection(db, "edicoes"),
  edicao:     (eid)       => doc(db, "edicoes", eid),
  inscricoes: (eid)       => collection(db, "edicoes", eid, "inscricoes"),
  inscricao:  (eid, uid)  => doc(db, "edicoes", eid, "inscricoes", uid),
  posicoes:   (eid)       => collection(db, "edicoes", eid, "posicoes"),
  posicao:    (eid, id)   => doc(db, "edicoes", eid, "posicoes", id),
  ensaios:    (eid)       => collection(db, "edicoes", eid, "ensaios"),
  ensaio:     (eid, id)   => doc(db, "edicoes", eid, "ensaios", id),
  musicas:    (eid)       => collection(db, "edicoes", eid, "musicas"),
  musica:     (eid, id)   => doc(db, "edicoes", eid, "musicas", id),
  precos:     (eid)       => doc(db, "edicoes", eid, "config", "precos"),
  pagamentos: (eid)       => collection(db, "edicoes", eid, "pagamentos"),
  presencas:  (eid)       => collection(db, "edicoes", eid, "presencas"),
  presenca:   (eid, id)   => doc(db, "edicoes", eid, "presencas", id),
};

/* ============================================================
   ESTADO EM MEMÓRIA (espelho local do Firestore, mantido sempre
   atualizado por listeners onSnapshot)
   ============================================================ */
let fbUser = null;          // usuário do Firebase Auth (ou null)
let pessoaLoaded = false;   // true assim que o listener de pessoas/{uid} respondeu 1x
let myPessoa = null;        // { id, ...campos } de pessoas/{uid} do usuário logado
let myLegado = null;        // cadastro do formato antigo (/users/{uid}), só até a importação
let legadoConsultado = false;
let pessoasCache = [];      // todas as pessoas cadastradas (dados permanentes)
/* uid -> { celular, dataNascimento }. Para um batuqueiro comum contém só o
   próprio contato; para o admin, o de todo mundo. É a diferença entre os dois
   listeners de /contatos, e ela é imposta pelas regras do Firestore — não é só
   uma escolha da tela. */
let contatosCache = {};
let edicoesCache = [];      // todas as edições do carnaval
let inscricoesCache = [];   // inscrições da edição em contexto
let posicoesCache = [];
let ensaiosCache = [];
let musicasCache = [];
let precosCache = null;
let presencasCache = {};    // uid -> { ensaioId: true/false }
let myPagamentos = [];      // só os pagamentos do próprio usuário logado, na edição em contexto
/* Células de presença com gravação em andamento, para o segundo clique não
   recalcular o novo valor em cima de um cache que ainda não voltou. */
const presencasEmVoo = new Set();

const unsub = { myPessoa: null, pessoas: null, edicoes: null, meuContato: null, contatos: null };
const unsubEd = { inscricoes: null, posicoes: null, ensaios: null, musicas: null, precos: null, presencas: null, myPagamentos: null };
let edicaoListenersFor = null;  // id da edição para a qual os listeners acima estão ativos
/* Quais listeners da edição já entregaram o primeiro resultado. Enquanto não
   entregaram, os caches estão vazios porque ainda não carregaram — e não porque
   a edição esteja vazia de verdade. Confundir as duas coisas fazia a caixa
   "carregar padrões" piscar a cada troca de edição; um clique nesse instante
   duplicava as 17 posições e sobrescrevia os valores da anuidade. */
let edicaoCarregou = { posicoes: false, precos: false, musicas: false, inscricoes: false };
/* true assim que o listener de /edicoes respondeu pela primeira vez. Antes disso
   não dá para saber se existe carnaval em andamento — e afirmar que não existe
   (ou que a pessoa não está inscrita) é pior do que dizer "carregando". */
let edicoesLoaded = false;
const pagamentosMigradosPara = new Set(); // edições cuja migração de pagamentos próprios já foi tentada

const session = {
  view: "landing",
  draftUser: null,
  errors: {},
  editingMyData: false,
  addPayOpenFor: null,
  presencaFiltro: "todas",
  presencaEnsaioFiltro: "todos",
  adminPessoasFiltro: "todas",
  relatorioFiltroStatus: "todos",
  relatorioFiltroPosicao: "todas",
  adminEditingUser: null,
  posicoesDraft: null,
  musicasDraft: null,
  ensaioMusicasAberto: null,
  ensaioMusicasDraft: null,
  edicaoId: null,             // edição em contexto (null = usar a que estiver aberta)
  novaEdicaoAberta: false,    // formulário de "criar nova edição" visível
  novaEdicaoAno: null,
  novaEdicaoNome: "",
  novaEdicaoData: "",
  emailDigitado: "",
  historico: null,            // carregado sob demanda em "Meu histórico"
  historicoBusy: false,
  histGeral: null,            // carregado sob demanda no "Histórico geral" do admin
  histGeralBusy: false,
  histFiltro: "",
  // Comprovantes da pessoa que o admin está editando. Carregados sob demanda —
  // não faz sentido manter um listener aberto para os pagamentos de todo mundo.
  pagsDoEditado: null,
  pagsDoEditadoDe: null,
  pagsDoEditadoBusy: false,
  draftInscricao: null,           // pré-preenchimento da tela de confirmar inscrição
  draftInscricaoDeEdicao: null,   // de qual edição veio esse pré-preenchimento
  draftInscricaoCarregadaPara: null,
  acabouDeCadastrar: false,
  busy: {},
};

/* Ordena posições (ou músicas — qualquer lista com campo .nome) em ordem alfabética, ignorando maiúsculas/acentos. */
function ordenarPosicoesAlfabetica(lista) {
  return [...lista].sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "pt-BR", { sensitivity: "base" }));
}
const ordenarMusicasAlfabetica = ordenarPosicoesAlfabetica;
/* Nomes de posição únicos (para droplists de filtro), em ordem alfabética. */
function posicoesUnicasOrdenadas(pessoas) {
  return [...new Set(pessoas.map(p => p.posicao))].sort((a, b) => (a || "").localeCompare(b || "", "pt-BR", { sensitivity: "base" }));
}
/* Nome da música + tom/cantor entre parênteses, quando cadastrados (ex: "Vem Ni Mim (Sol maior · Carla)"). */
function musicaResumo(id) {
  const m = musicasCache.find(x => x.id === id);
  if (!m) return null;
  const extras = [m.tom, m.cantor].filter(Boolean).join(" · ");
  return extras ? `${m.nome} (${extras})` : m.nome;
}

/* ============================================================
   EDIÇÕES — helpers de contexto
   ============================================================ */
function edicoesOrdenadas() {
  // mais recente primeiro (ano desc, depois sequência desc)
  return [...edicoesCache].sort((a, b) => (b.id || "").localeCompare(a.id || "", "pt-BR", { numeric: true }));
}
function edicaoAberta() { return edicoesCache.find(e => e.status === "aberta") || null; }
function edicaoCtxId() {
  if (session.edicaoId && edicoesCache.some(e => e.id === session.edicaoId)) return session.edicaoId;
  const aberta = edicaoAberta();
  if (aberta) return aberta.id;
  // Sem nenhum carnaval aberto, o admin continua vendo o mais recente — que
  // costuma ser justamente o que ele está preparando. Sem isso, bastava sair e
  // voltar para o painel afirmar que não havia edição nenhuma cadastrada.
  // Para o batuqueiro comum não há contexto: não existe carnaval em andamento.
  if (souAdmin()) {
    const maisRecente = edicoesOrdenadas()[0];
    return maisRecente ? maisRecente.id : null;
  }
  return null;
}
function edicaoCtx() { const id = edicaoCtxId(); return id ? edicoesCache.find(e => e.id === id) || null : null; }
function edicaoEditavel(ed) { return !!(ed && ed.status !== "encerrada"); }
/* Descrição do status de uma edição, tolerante a um valor inesperado no banco —
   uma tela inteira não pode ficar em branco por causa de um campo estranho. */
function statusInfo(ed) { return (ed && EDICAO_STATUS[ed.status]) || EDICAO_STATUS.preparando; }
function edicaoLabel(ed) {
  if (!ed) return "—";
  return ed.nome || `Carnaval ${ed.ano || ed.id}`;
}
/* Próximo id livre no formato ano-sequência (2027-1, 2027-2, ...). */
function proximoEdicaoId(ano) {
  let n = 1;
  while (edicoesCache.some(e => e.id === `${ano}-${n}`)) n++;
  return `${ano}-${n}`;
}
/* Estou inscrito na edição em contexto? */
function estouInscrito() { return !!(fbUser && inscricoesCache.some(i => i.id === fbUser.uid)); }

/* ============================================================
   BOOT — autenticação dirige tudo
   ============================================================ */
let uidAnterior = null;
onAuthStateChanged(auth, (user) => {
  fbUser = user;
  teardownUserListeners();
  // Ao sair (ou ao entrar com outra conta no mesmo navegador — o que acontece de
  // verdade num aparelho compartilhado), tudo o que era da sessão anterior tem
  // que ir embora: rascunhos de formulário, filtros, telas carregadas sob demanda
  // e a edição que estava sendo visualizada. Sem isso, a pessoa seguinte herda
  // estado que não é dela.
  if (!user || user.uid !== uidAnterior) { limparEstadoDeSessao(); esconderToast(); }
  uidAnterior = user ? user.uid : null;

  if (!user) {
    myPessoa = null; pessoaLoaded = false; myLegado = null; legadoConsultado = false;
    pessoasCache = []; edicoesCache = []; contatosCache = {}; edicoesLoaded = false;
    limparCachesDaEdicao();
    if (session.view && !["landing", "login", "register1"].includes(session.view)) session.view = "landing";
    render();
    return;
  }
  setupUserListeners(user.uid);
  render();
});

/* ============================================================
   PONTE COM O FORMATO ANTIGO
   ------------------------------------------------------------
   Enquanto a importação não foi feita, o cadastro da pessoa (inclusive o acesso
   de admin) ainda está em /users, e não em /pessoas. Sem enxergar isso, quem já
   era admin entraria no site sem o botão do painel — justamente quem precisa
   dele para rodar a importação. As regras de segurança já aceitam as duas
   origens; aqui o app passa a fazer o mesmo.
   ============================================================ */
async function carregarCadastroLegado(uid) {
  try {
    const snap = await getDoc(doc(db, "users", uid));
    myLegado = snap.exists() ? { id: snap.id, ...snap.data() } : null;
  } catch (err) {
    // Se as coleções antigas já foram removidas, simplesmente não há legado.
    myLegado = null;
  }
  legadoConsultado = true;
  ensureContatosListener();
  ensureEdicaoListeners();
  render();
}

/* Liga (ou desliga) o listener que lê o contato de TODO MUNDO. Só o admin tem
   permissão para isso, e a consulta de coleção inteira é recusada pelo Firestore
   para quem não é — por isso ela só pode ser aberta depois que já se sabe quem é
   o usuário, e precisa ser fechada se o acesso for revogado no meio da sessão. */
function ensureContatosListener() {
  if (souAdmin()) {
    if (unsub.contatos) return;
    unsub.contatos = onSnapshot(P.contatos(), snap => {
      const novo = {};
      snap.docs.forEach(d => { novo[d.id] = d.data(); });
      // preserva o próprio contato, que vem do outro listener
      if (fbUser && contatosCache[fbUser.uid] && !novo[fbUser.uid]) novo[fbUser.uid] = contatosCache[fbUser.uid];
      contatosCache = novo;
      renderExterno();
    }, onErr("contatos"));
  } else if (unsub.contatos) {
    unsub.contatos(); unsub.contatos = null;
    contatosCache = fbUser && contatosCache[fbUser.uid] ? { [fbUser.uid]: contatosCache[fbUser.uid] } : {};
    renderExterno();
  }
}

/* Contato de uma pessoa, com queda para os campos antigos que ainda estejam
   dentro de /pessoas enquanto a separação não foi rodada pelo admin. Quem não
   pode ler o contato simplesmente recebe vazio — a tela não quebra. */
function contatoDe(p) {
  const c = (p && contatosCache[p.id]) || {};
  return {
    celular: c.celular || (p && p.celular) || "",
    dataNascimento: c.dataNascimento || (p && p.dataNascimento) || "",
  };
}

/* Cadastro do usuário logado, venha ele do formato novo ou do antigo. */
function meuCadastro() { return myPessoa || myLegado || null; }
/* Sou admin? Vale tanto o cadastro novo quanto o antigo (período de transição). */
function souAdmin() { return !!(myPessoa && myPessoa.adminAccess) || !!(myLegado && myLegado.adminAccess); }
/* Idem para quem pode marcar presença. */
function souEditorDePresenca() {
  return souAdmin() || !!(myPessoa && myPessoa.presencaAccess) || !!(myLegado && myLegado.presencaAccess);
}
/* Ainda existe cadastro no formato antigo esperando importação? */
function precisaImportarLegado() { return !!myLegado && !edicoesCache.some(e => e.migradaDoFormatoAntigo); }

/* Zera o estado que pertence a uma pessoa/sessão específica, preservando só o
   roteamento (a view atual é definida logo depois pelo próprio fluxo de login). */
function limparEstadoDeSessao() {
  Object.assign(session, {
    draftUser: null,
    draftInscricao: null,
    draftInscricaoDeEdicao: null,
    draftInscricaoCarregadaPara: null,
    acabouDeCadastrar: false,
    errors: {},
    busy: {},
    editingMyData: false,
    addPayOpenFor: null,
    presencaFiltro: "todas",
    presencaEnsaioFiltro: "todos",
    adminPessoasFiltro: "todas",
    relatorioFiltroStatus: "todos",
    relatorioFiltroPosicao: "todas",
    adminEditingUser: null,
    posicoesDraft: null,
    musicasDraft: null,
    ensaioMusicasAberto: null,
    ensaioMusicasDraft: null,
    edicaoId: null,
    novaEdicaoAberta: false,
    novaEdicaoAno: null,
    novaEdicaoNome: "",
    novaEdicaoData: "",
    emailDigitado: "",
    historico: null,
    historicoBusy: false,
    histGeral: null,
    histGeralBusy: false,
    histFiltro: "",
  // Comprovantes da pessoa que o admin está editando. Carregados sob demanda —
  // não faz sentido manter um listener aberto para os pagamentos de todo mundo.
  pagsDoEditado: null,
  pagsDoEditadoDe: null,
  pagsDoEditadoBusy: false,
  });
  pagamentosMigradosPara.clear();
}

function limparCachesDaEdicao() {
  inscricoesCache = []; posicoesCache = []; ensaiosCache = []; musicasCache = [];
  precosCache = null; presencasCache = {}; myPagamentos = [];
}

function onErr(label) {
  return (err) => { console.error(label, err); showToast("Erro ao carregar dados: " + (err && err.message ? err.message : label)); };
}

function setupUserListeners(uid) {
  myLegado = null; legadoConsultado = false;
  carregarCadastroLegado(uid);

  unsub.myPessoa = onSnapshot(P.pessoa(uid), snap => {
    myPessoa = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    pessoaLoaded = true;
    ensureContatosListener();
    // edicaoCtxId() depende de souAdmin(): fora de temporada (nenhuma edição
    // aberta) o admin enxerga a edição mais recente e o batuqueiro comum não
    // enxerga nenhuma. Quando o acesso admin chega depois — concedido com a
    // pessoa logada, ou vindo do cadastro antigo — o contexto muda e os
    // listeners da edição precisam ser reavaliados; senão o painel abria com
    // tudo zerado ("0 inscritos", "0 posições") e não se corrigia sozinho.
    ensureEdicaoListeners();
    renderExterno();
  }, onErr("perfil"));

  // O próprio contato, sempre. Um batuqueiro comum só consegue ler este.
  unsub.meuContato = onSnapshot(P.contato(uid), snap => {
    contatosCache = { ...contatosCache, [uid]: snap.exists() ? snap.data() : {} };
    renderExterno();
  }, onErr("meu contato"));

  unsub.pessoas = onSnapshot(P.pessoas(), snap => {
    pessoasCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderExterno();
  }, onErr("lista de pessoas"));

  unsub.edicoes = onSnapshot(P.edicoes(), snap => {
    edicoesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    edicoesLoaded = true;
    ensureEdicaoListeners();
    renderExterno();
  }, onErr("edições do carnaval"));
}

function teardownUserListeners() {
  Object.keys(unsub).forEach(k => { if (unsub[k]) { unsub[k](); unsub[k] = null; } });
  teardownEdicaoListeners();
  edicaoListenersFor = null;
}
function teardownEdicaoListeners() {
  Object.keys(unsubEd).forEach(k => { if (unsubEd[k]) { unsubEd[k](); unsubEd[k] = null; } });
}

/* (Re)liga os listeners das subcoleções da edição em contexto. Chamado sempre que
   a lista de edições muda ou que o admin troca a edição que está olhando. */
function ensureEdicaoListeners() {
  const eid = edicaoCtxId();
  if (eid === edicaoListenersFor) return;
  teardownEdicaoListeners();
  edicaoListenersFor = eid;
  limparCachesDaEdicao();
  // Os rascunhos de posições/músicas pertencem à edição anterior. Sem zerá-los
  // aqui, uma troca de edição que acontece SOZINHA (outro admin abre um novo
  // carnaval, e o contexto muda por baixo) deixava a tela com o cabeçalho do
  // carnaval novo e as linhas do antigo — e "Salvar" gravava por cima, porque a
  // cópia entre edições preserva os ids dos documentos.
  session.posicoesDraft = null; session.musicasDraft = null;
  session.ensaioMusicasAberto = null; session.ensaioMusicasDraft = null;
  edicaoCarregou = { posicoes: false, precos: false, musicas: false, inscricoes: false };
  if (!eid || !fbUser) return;

  unsubEd.inscricoes = onSnapshot(P.inscricoes(eid), snap => {
    inscricoesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    edicaoCarregou.inscricoes = true;
    // Se esta edição veio de uma migração do formato antigo, cada pessoa leva os
    // próprios comprovantes de pagamento na primeira vez que entra (as regras não
    // deixam o admin ler os pagamentos alheios, então isso não pôde ir na migração).
    const ed = edicoesCache.find(e => e.id === eid);
    if (ed && ed.migradaDoFormatoAntigo && !pagamentosMigradosPara.has(eid) && inscricoesCache.some(i => i.id === fbUser.uid)) {
      pagamentosMigradosPara.add(eid);
      migrarMeusPagamentos(eid);
    }
    renderExterno();
  }, onErr("inscrições"));

  unsubEd.posicoes = onSnapshot(P.posicoes(eid), snap => {
    posicoesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    edicaoCarregou.posicoes = true;
    renderExterno();
  }, onErr("posições"));

  unsubEd.ensaios = onSnapshot(P.ensaios(eid), snap => {
    ensaiosCache = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.data || "").localeCompare(b.data || ""));
    renderExterno();
  }, onErr("ensaios"));

  unsubEd.musicas = onSnapshot(P.musicas(eid), snap => {
    musicasCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    edicaoCarregou.musicas = true;
    renderExterno();
  }, onErr("músicas"));

  unsubEd.precos = onSnapshot(P.precos(eid), snap => {
    precosCache = snap.exists() ? snap.data() : null;
    edicaoCarregou.precos = true;
    renderExterno();
  }, onErr("valores da anuidade"));

  unsubEd.presencas = onSnapshot(P.presencas(eid), snap => {
    const map = {};
    snap.docs.forEach(d => {
      const v = d.data();
      if (!map[v.uid]) map[v.uid] = {};
      map[v.uid][v.ensaioId] = !!v.presente;
    });
    presencasCache = map;
    renderExterno();
  }, onErr("presenças"));

  unsubEd.myPagamentos = onSnapshot(query(P.pagamentos(eid), where("uid", "==", fbUser.uid)), snap => {
    myPagamentos = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.data || "").localeCompare(b.data || ""));
    renderExterno();
  }, onErr("pagamentos"));
}

/* Troca a edição que está sendo visualizada (só o admin faz isso). */
function trocarEdicaoCtx(eid) {
  session.edicaoId = eid;
  session.posicoesDraft = null; session.musicasDraft = null;
  session.ensaioMusicasAberto = null; session.ensaioMusicasDraft = null;
  session.adminEditingUser = null;
  session.editingMyData = false;
  // Os filtros guardam id de ensaio e nome de posição, que não existem na outra
  // edição: mantê-los deixava a tabela de presença sem nenhuma coluna e a lista
  // de cadastros vazia, com o seletor exibindo "Todos"/"Todas" — ou seja,
  // mentindo sobre o próprio estado, e sem disparar change ao reselecionar.
  session.presencaEnsaioFiltro = "todos";
  session.presencaFiltro = "todas";
  session.adminPessoasFiltro = "todas";
  session.relatorioFiltroPosicao = "todas";
  session.relatorioFiltroPago = "todos";
  session.relatorioFiltroSaldo = "todos";
  ensureEdicaoListeners();
  render();
}

/* ============================================================
   VISÃO UNIFICADA — pessoa + inscrição
   ------------------------------------------------------------
   As telas continuam recebendo um objeto único por batuqueiro (nome, posição,
   camisa, pagamento...), como sempre foi. A diferença é que agora esse objeto é
   montado juntando os dados permanentes da pessoa com a inscrição dela na
   edição em contexto.
   ============================================================ */
function minhaInscricao() { return fbUser ? inscricoesCache.find(i => i.id === fbUser.uid) || null : null; }
function perfilMesclado() {
  const base = meuCadastro();
  if (!base) return null;
  const insc = minhaInscricao();
  const id = fbUser ? fbUser.uid : base.id;
  const juntos = insc ? { ...base, ...insc, id } : { ...base, id };
  return { ...juntos, ...soDoCadastro(base), ...contatoDe(juntos) };
}
/* Identidade e privilégio vêm SEMPRE de /pessoas, nunca da inscrição.
   A inscrição é escrita pelo próprio dono, e as telas montam cada batuqueiro
   fundindo os dois documentos com a inscrição por cima. Sem esta reimposição,
   bastava alguém gravar adminAccess: true na própria inscrição para o painel
   desenhar o selo de admin e deixar a caixa "Acesso ao painel admin" marcada —
   e o admin, ao salvar qualquer outra coisa daquela pessoa, gravava a promoção
   de verdade em /pessoas sem perceber. As regras do Firestore também bloqueiam
   isso agora; esta é a segunda camada. */
function soDoCadastro(pes) {
  return {
    nome: pes.nome, sobrenome: pes.sobrenome, apelido: pes.apelido, email: pes.email,
    adminAccess: !!pes.adminAccess, presencaAccess: !!pes.presencaAccess,
  };
}

/* Quem vai desfilar neste carnaval — a lista que as telas operacionais usam.
   Quem respondeu que NÃO vai tocar continua inscrito, com cadastro, isenção e
   histórico preservados, mas não entra na presença, nos naipes nem na conta de
   camisas: ele não vai ao ensaio nem desfila, e deixá-lo ali fazia a bateria
   parecer maior do que é e a lista de presença ficar cheia de gente que nunca
   seria marcada. Eles aparecem num bloco próprio na tela de Cadastros. */
function vaoTocarNaEdicao() { return batuqueirosDaEdicao().filter(p => !naoVaiTocar(p)); }
function naoVaoTocarNaEdicao() { return batuqueirosDaEdicao().filter(naoVaiTocar); }

/* Lista de batuqueiros inscritos na edição em contexto (pessoa + inscrição). */
function batuqueirosDaEdicao() {
  return inscricoesCache
    .map(i => {
      const pes = pessoasCache.find(x => x.id === i.id);
      if (!pes) return null;
      const juntos = { ...pes, ...i, id: i.id };
      // celular/nascimento entram só se o usuário logado tiver permissão de ler
      return { ...juntos, ...soDoCadastro(pes), ...contatoDe(juntos) };
    })
    .filter(Boolean)
    .sort((a, b) => fullName(a).localeCompare(fullName(b), "pt-BR", { sensitivity: "base" }));
}

/* ============================================================
   HELPERS
   ============================================================ */
const $ = (sel, el = document) => el.querySelector(sel);
/* Escapa texto vindo das pessoas antes de entrar no HTML. As telas são montadas
   com template strings e innerHTML, então um nome de música como Vem Ni Mim "2"
   quebraria o atributo value do campo, e um caractere < quebraria a página
   inteira. Vale para tudo que alguém digita: nomes, posições, tom, cantor,
   chave pix, nome da edição. */
const esc = v => String(v == null ? "" : v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const currency = v => (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
/* Escapa na origem: esta função é interpolada crua em dezenas de pontos, e as
   datas vêm do banco (inclusive de importação de dados antigos, que ninguém
   validou). Escapar aqui é mais seguro que lembrar de escapar em cada uso. */
const dateBR = iso => { if (!iso) return "—"; const [y, m, d] = String(iso).split("-"); return esc(`${d}/${m}/${y}`); };
const fullName = u => `${u.nome || ""} ${u.sobrenome || ""}`.trim();
/* Como a pessoa prefere ser chamada. Numa bateria quase todo mundo se conhece
   pelo apelido, então é ele que aparece na saudação; o nome completo continua
   sendo o registro formal nas listas e relatórios. */
const apelidoDe = u => ((u && u.apelido) || "").trim();
const nomeExibicao = u => apelidoDe(u) || (u && u.nome) || "";
/* Nome completo com o apelido ao lado, em texto secundário, para as listas em
   que é preciso reconhecer a pessoa sem perder o registro formal. */
const nomeComApelido = u => `${esc(fullName(u))}${apelidoDe(u) ? ` <span class="muted-sm">“${esc(apelidoDe(u))}”</span>` : ""}`;
/* Texto usado para busca: encontra tanto pelo nome quanto pelo apelido. */
const textoBusca = u => `${fullName(u)} ${apelidoDe(u)}`.trim().toLowerCase();
const hojeISO = () => new Date().toISOString().slice(0, 10);
const ensaioLabel = e => dateBR(e.data);
function calcIdade(dataNascISO) {
  if (!dataNascISO) return null;
  const [y, m, d] = dataNascISO.split("-").map(Number);
  const hoje = new Date();
  let idade = hoje.getFullYear() - y;
  const aindaNaoFezAniversario = (hoje.getMonth() + 1 < m) || (hoje.getMonth() + 1 === m && hoje.getDate() < d);
  if (aindaNaoFezAniversario) idade--;
  return idade;
}

/* ============================================================
   DATA DE NASCIMENTO — dia/mês/ano em três campos separados.
   Um <input type="date"> nativo mostra os campos na ordem do idioma
   do NAVEGADOR (não da página), e em muitos navegadores isso é
   mês/dia/ano mesmo com o site em português. Quem digita pensando em
   dia/mês (padrão brasileiro) pode acabar salvando uma data diferente
   da pretendida sem perceber — por isso aqui usamos três seletores
   nomeados (Dia / Mês por extenso / Ano), sem nenhuma ambiguidade.
   ============================================================ */
const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
function dataNascimentoFieldsHtml(idPrefix, isoValue, anoMax) {
  // A data vem do banco, e o banco aceita o que a pessoa gravar — inclusive por
  // fora do site. Uma data fora do formato aaaa-mm-dd é descartada aqui, e o que
  // sobra ainda vai escapado para o HTML: sem isso, alguém podia gravar aspas e
  // um atributo de evento no próprio nascimento e o código rodaria na sessão de
  // quem abrisse o cadastro dela no painel — ou seja, na sessão do admin.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(String(isoValue || "")) ? isoValue : "";
  const [anoAtual, mesAtual, diaAtual] = iso.split("-");
  const diaOpts = Array.from({ length: 31 }, (_, i) => i + 1)
    .map(n => { const v = String(n).padStart(2, "0"); return `<option value="${v}" ${diaAtual === v ? "selected" : ""}>${n}</option>`; }).join("");
  const mesOpts = MESES.map((nome, i) => { const v = String(i + 1).padStart(2, "0"); return `<option value="${v}" ${mesAtual === v ? "selected" : ""}>${nome}</option>`; }).join("");
  return `
    <div class="grid-3">
      <div class="field"><label>Dia</label><select id="${idPrefix}-dia"><option value="">Dia</option>${diaOpts}</select></div>
      <div class="field"><label>Mês</label><select id="${idPrefix}-mes"><option value="">Mês</option>${mesOpts}</select></div>
      <div class="field"><label>Ano</label><input type="number" id="${idPrefix}-ano" placeholder="aaaa" value="${esc(anoAtual || "")}" min="1920" max="${anoMax || new Date().getFullYear()}"></div>
    </div>`;
}
function lerDataNascimento(idPrefix) {
  const dia = $(`#${idPrefix}-dia`)?.value, mes = $(`#${idPrefix}-mes`)?.value, ano = $(`#${idPrefix}-ano`)?.value;
  if (!dia || !mes || !ano) return "";
  // Ano com menos de 4 dígitos ("27") montava "27-05-10": uma data que nenhum
  // campo de calendário aceita e que faria a idade sair absurda. Melhor não
  // gravar nada do que gravar lixo — quem chama já trata o "" como não
  // preenchido e mostra a mensagem de erro.
  if (!/^\d{4}$/.test(String(ano))) return "";
  return `${ano}-${mes}-${dia}`;
}

function temAcessoAdmin(u) { return !!(u && u.adminAccess); }
/* Admins sempre podem editar presença; além deles, só quem recebeu o acesso individual (presencaAccess). */
function temAcessoPresenca(u) { return !!(u && (u.adminAccess || u.presencaAccess)); }
function posicaoInfo(nome) { return posicoesCache.find(p => p.nome === nome); }
/* Quem não vai tocar no carnaval não paga anuidade — é a regra da bateria.
   Isso vale junto com as outras duas isenções: por função (Voz, Mestre, Apoio...)
   e a individual, concedida caso a caso pela organização. */
/* Normaliza a resposta de "vai tocar". O valor vem do banco e nem sempre foi
   digitado por este site: a importação do formato antigo traz o que estivesse
   lá ("NÃO", "nao", " Não "), e uma comparação exata com "Não" deixava essas
   pessoas escapando dos filtros — voltando a aparecer na lista de presença,
   nos naipes e na conta de camisas como se fossem desfilar. */
function respostaVaiTocar(u) {
  const bruto = String((u && u.vaiTocar) || "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");   // tira acento
  if (bruto === "nao" || bruto === "n") return "Não";
  if (bruto === "sim" || bruto === "s") return "Sim";
  return "";
}
function naoVaiTocar(u) { return respostaVaiTocar(u) === "Não"; }
function isIsento(u) {
  const info = posicaoInfo(u.posicao);
  return naoVaiTocar(u) || !!(info && info.isenta) || !!u.isentoManual;
}
function isentoMotivo(u) {
  const info = posicaoInfo(u.posicao);
  if (naoVaiTocar(u)) return "você não vai tocar neste carnaval";
  if (info && info.isenta) return `isento pela função de ${u.posicao}`;
  if (u.isentoManual) return "isenção especial concedida pela organização";
  return "";
}
function posicaoOptionsHtml(selected) {
  let opts = ordenarPosicoesAlfabetica(posicoesCache).map(p => `<option value="${esc(p.nome)}" ${p.nome === selected ? "selected" : ""}>${esc(p.nome)}</option>`).join("");
  opts += `<option value="Outro" ${selected === "Outro" ? "selected" : ""}>Outro</option>`;
  if (selected && selected !== "Outro" && !posicoesCache.some(p => p.nome === selected)) {
    opts = `<option value="${esc(selected)}" selected>${esc(selected)} (removida da lista)</option>` + opts;
  } else if (!selected) {
    // Sem esta opção, um cadastro sem posição (vindo da importação, por exemplo)
    // abria o formulário com a primeira da lista já selecionada — e o admin, ao
    // salvar qualquer outro campo, escolhia um instrumento por ela sem saber.
    opts = `<option value="" selected>Ainda não escolheu</option>` + opts;
  }
  return opts;
}
function chavePixDaEdicao() { return ((precosCache && precosCache.chavePix) || "").trim(); }
function valorDoPlano(k) { return precosCache && precosCache[k] ? precosCache[k].valor : 0; }
function prazosDoPlano(k) { return precosCache && precosCache[k] ? precosCache[k].prazos : []; }
function totalDevido(u) { return planoValido(u.formaPagamento) ? valorDoPlano(u.formaPagamento) : null; }
function planoLabel(k) {
  const p = PLANOS[k], total = valorDoPlano(k);
  return p.parcelas === 1 ? `${p.label} — ${currency(total)}` : `${p.label} — ${currency(total)} (${p.parcelas}x de ${currency(total / p.parcelas)})`;
}
function totalPago(u) { return u.totalPago || 0; }
/* Só trata como plano válido o que existe em PLANOS — protege contra um valor
   inesperado gravado no banco (dado antigo, importação, edição manual). */
function planoValido(k) { return !!(k && PLANOS[k]); }

/* Um plano só produz cobrança se tiver valor configurado. Sem esse teste, um
   documento de preços incompleto (importação, edição nova, campo apagado) fazia
   totalDevido() valer 0 — e "0 pago de 0" era exibido como QUITADO, com a
   adimplência do painel indo a 100% sem ninguém ter pago nada. */
function planoComValor(u) { return planoValido(u.formaPagamento) && !!precosCache && valorDoPlano(u.formaPagamento) > 0; }

function parcelasInfo(u) {
  if (!planoComValor(u)) return [];
  const { parcelas } = PLANOS[u.formaPagamento];
  const meta = totalDevido(u), prazos = prazosDoPlano(u.formaPagamento), pago = totalPago(u), hoje = hojeISO();
  const valorParcela = meta / parcelas;
  const out = [];
  for (let i = 0; i < parcelas; i++) {
    const alvo = valorParcela * (i + 1);
    const prazo = prazos[i];
    let status;
    if (pago >= alvo - 0.005) status = { label: "Paga", cls: "badge-good" };
    else if (prazo && prazo <= hoje) status = { label: "Atrasada", cls: "badge-critical" };
    else status = { label: "No prazo", cls: "badge-warning" };
    out.push({ n: i + 1, prazo, valor: valorParcela, status });
  }
  return out;
}
function isAtrasado(u) { return parcelasInfo(u).some(p => p.status.label === "Atrasada"); }

function paymentStatus(u) {
  if (isIsento(u)) return { label: "Isenta", cls: "badge-isenta" };
  if (!planoComValor(u)) return { label: "Sem plano", cls: "badge-warning" };
  const pago = totalPago(u), meta = totalDevido(u);
  if (pago >= meta) return { label: "Quitado", cls: "badge-good" };
  if (isAtrasado(u)) return { label: "Atrasado", cls: "badge-critical" };
  return { label: "No prazo", cls: "badge-warning" };
}
function statusBadgeCls(label) {
  if (label === "Isenta") return "badge-isenta";
  if (label === "Quitado") return "badge-good";
  if (label === "Atrasado") return "badge-critical";
  return "badge-warning";
}
function contagemPorStatus(pessoas) {
  const map = {};
  pessoas.forEach(p => { const l = paymentStatus(p).label; map[l] = (map[l] || 0) + 1; });
  return map;
}
/* Quantas camisas de cada tamanho encomendar. Só de quem vai desfilar. */
function contagemPorCamisa(pessoas) {
  const mapa = {};
  pessoas.forEach(p => { const c = (p.camisa || "").trim() || "Sem tamanho"; mapa[c] = (mapa[c] || 0) + 1; });
  // Na ordem dos tamanhos, não alfabética — GG antes de P não ajuda ninguém.
  return [...CAMISAS, "Sem tamanho"].filter(c => mapa[c]).map(c => [c, mapa[c]]);
}

/* Devolve o filtro de posição só se ele ainda existir entre as opções da tela.
   Mesmo problema já corrigido no filtro de ensaio: quando a última pessoa de um
   naipe muda de posição (ou avisa que não vai tocar), a opção some da lista,
   nenhum <option> fica selecionado, o navegador mostra "Todas as posições" — e
   a tabela aparece vazia, com o seletor mentindo sobre o próprio estado.
   Reselecionar "Todas" nem dispara change, então não havia saída sem trocar de
   tela. */
function filtroDePosicaoValido(valor, pessoas) {
  if (!valor || valor === "todas") return "todas";
  return posicoesUnicasOrdenadas(pessoas).includes(valor) ? valor : "todas";
}

/* Saldo em aberto de uma pessoa. Devolve null quando não dá para saber: quem
   ainda não escolheu a forma de pagamento não tem valor devido definido, e
   fingir que deve zero colocaria essa pessoa junto de quem já quitou. */
function saldoEmAberto(p) {
  if (isIsento(p)) return 0;
  if (!planoComValor(p)) return null;
  return Math.max(0, totalDevido(p) - totalPago(p));
}

/* Faixas de R$ 100 para os seletores de Pago e Saldo, geradas a partir do maior
   valor que existe na lista — assim acompanham a anuidade de cada carnaval sem
   nada fixo no código. A opção "zero" fica separada porque é a que mais se usa:
   quem não pagou nada, e quem não deve mais nada. */
function faixasDeValor(valores) {
  const maximo = Math.max(0, ...valores.filter(v => typeof v === "number"));
  const faixas = [];
  for (let inicio = 0; inicio < maximo; inicio += 100) {
    faixas.push({ chave: `${inicio}-${inicio + 100}`, min: inicio, max: inicio + 100 });
  }
  return faixas;
}
function rotuloDaFaixa(f) {
  return f.min === 0 ? `Até ${currency(f.max)}` : `${currency(f.min)} a ${currency(f.max)}`;
}
/* Compara com a faixa. O limite inferior é exclusivo (e o zero sai por fora, na
   opção própria), então uma pessoa nunca cai em duas faixas ao mesmo tempo. */
function valorNaFaixa(valor, chave) {
  if (!chave || chave === "todos") return true;
  if (valor === null || valor === undefined) return false;  // indefinido só em "todos"
  if (chave === "zero") return valor === 0;
  const [min, max] = chave.split("-").map(Number);
  return valor > min && valor <= max;
}
function selectDeFaixa(id, rotulo, valorAtual, valores, rotuloZero) {
  const faixas = faixasDeValor(valores);
  return `
    <div><label>${rotulo}</label>
      <select id="${id}">
        <option value="todos" ${(valorAtual || "todos") === "todos" ? "selected" : ""}>Qualquer valor</option>
        <option value="zero" ${valorAtual === "zero" ? "selected" : ""}>${rotuloZero}</option>
        ${faixas.map(f => `<option value="${f.chave}" ${valorAtual === f.chave ? "selected" : ""}>${rotuloDaFaixa(f)}</option>`).join("")}
      </select>
    </div>`;
}

function contagemPorPosicao(pessoas) {
  const map = {};
  pessoas.forEach(p => { map[p.posicao] = (map[p.posicao] || 0) + 1; });
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}

function friendlyAuthError(err) {
  const map = {
    "auth/email-already-in-use": "Já existe um cadastro com esse e-mail. Tente entrar.",
    "auth/invalid-email": "E-mail inválido.",
    "auth/weak-password": "A senha precisa ter pelo menos 6 caracteres.",
    "auth/invalid-credential": "E-mail ou senha incorretos.",
    "auth/wrong-password": "E-mail ou senha incorretos.",
    "auth/user-not-found": "E-mail ou senha incorretos.",
    "auth/too-many-requests": "Muitas tentativas. Aguarde um pouco e tente de novo.",
    "auth/network-request-failed": "Falha de conexão. Verifique sua internet e tente de novo.",
  };
  return (err && map[err.code]) || "Não foi possível completar a ação. Tente novamente.";
}
function friendlyFirestoreError(err) {
  if (err && err.code === "permission-denied") return "Você não tem permissão para fazer isso.";
  return (err && err.message) || "Ocorreu um erro inesperado.";
}

/* O aviso flutuante vive FORA de #app e é manipulado direto no DOM, de propósito.
   Antes ele fazia parte do HTML redesenhado, então aparecer e — 3,5 segundos
   depois — sumir disparava dois redesenhos completos da tela. Se a pessoa
   estivesse preenchendo qualquer formulário nesse intervalo (o que é comum: um
   aviso aparece logo após salvar algo, e é justamente aí que se continua
   digitando), o que ela tinha escrito era apagado. Fora de #app, o aviso vai e
   volta sem tocar no resto da página. */
let toastTimer = null;
function toastHost() {
  let host = document.getElementById("toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast-host";
    host.className = "toast";
    host.style.display = "none";
    document.body.appendChild(host);
  }
  return host;
}
/* Some com o aviso na hora — usado ao trocar de usuário, para que um aviso do
   organizador não fique pendurado na tela de quem entra em seguida. */
function esconderToast() {
  clearTimeout(toastTimer);
  const host = document.getElementById("toast-host");
  if (host) host.style.display = "none";
}
function showToast(msg) {
  const host = toastHost();
  host.textContent = msg;   // textContent, não innerHTML: nada de marcação vinda de texto digitado
  host.style.display = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { host.style.display = "none"; }, 3500);
}

function go(view, extra = {}) {
  // Mensagens de erro pertencem à tela onde aconteceram: sem isso, um "e-mail ou
  // senha incorretos" continuava aparecendo sobre o formulário limpo depois de
  // navegar para outra tela e voltar.
  session.errors = {};
  Object.assign(session, { view }, extra);
  render();
}

/* ============================================================
   RENDER — roteador principal
   ============================================================ */
const VIEWS_ADMIN = ["admin", "admin-edicoes", "admin-historico", "admin-precos", "admin-ensaios", "admin-relatorio", "admin-posicoes", "admin-musicas", "admin-pessoas"];

/* ============================================================
   REDESENHO POR DADOS QUE CHEGAM DE FORA
   ------------------------------------------------------------
   render() reconstrói a tela inteira, e ele é chamado a cada dado que chega em
   tempo real — presença marcada por outra pessoa, um pagamento registrado, um
   cadastro novo. Se isso acontece enquanto alguém preenche um formulário, o que
   estava digitado é destruído junto com os elementos, e o foco vai para o corpo
   da página: a pessoa continua digitando e as letras não aparecem em lugar
   nenhum. Guardar campo por campo em session resolveria só os formulários que
   alguém lembrou de cobrir; aqui a proteção é geral — antes de um redesenho
   causado por dados externos, o conteúdo dos campos, o foco e a posição do
   cursor são fotografados e recolocados depois.

   Redesenhos disparados por uma ação da própria pessoa continuam usando
   render() puro: ali limpar o formulário costuma ser o comportamento desejado
   (por exemplo, o campo "nova posição" tem que esvaziar depois de adicionar).
   ============================================================ */
function seletorDoCampo(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const dados = Object.entries(el.dataset || {});
  if (!dados.length) return null;
  const classe = (el.className || "").split(/\s+/).filter(Boolean)[0];
  const attrs = dados
    .map(([k, v]) => `[data-${k.replace(/[A-Z]/g, m => "-" + m.toLowerCase())}="${CSS.escape(v)}"]`)
    .join("");
  return `${el.tagName.toLowerCase()}${classe ? "." + CSS.escape(classe) : ""}${attrs}`;
}

function fotografarFormularios() {
  const app = document.getElementById("app");
  if (!app) return null;
  const valores = [];
  app.querySelectorAll("input, select, textarea").forEach(el => {
    const sel = seletorDoCampo(el);
    if (!sel) return;
    valores.push({ sel, valor: el.type === "checkbox" || el.type === "radio" ? el.checked : el.value });
  });
  // As escolhas de "vai tocar" e tamanho de camisa não são <input>: são <div>
  // com a classe .active, e o HTML é redesenhado a partir do que está salvo.
  // Sem fotografá-las, quem estivesse com o formulário aberto perdia a escolha
  // em silêncio a cada dado que chegasse em tempo real — e "vai tocar" é o que
  // decide a isenção da anuidade.
  const pills = [];
  app.querySelectorAll(".radio-row[id]").forEach(row => {
    const ativo = row.querySelector(".radio-pill.active");
    pills.push({ row: row.id, valor: ativo ? ativo.dataset.val : null });
  });
  // Campos mostrados/escondidos por handler (o "Qual?" da posição "Outro").
  const visibilidade = [];
  app.querySelectorAll('[id$="-wrap-posicao-outro"]').forEach(el => {
    visibilidade.push({ id: el.id, display: el.style.display });
  });

  const ativo = document.activeElement;
  const foco = ativo && app.contains(ativo) ? seletorDoCampo(ativo) : null;
  let selInicio = null, selFim = null;
  if (foco && typeof ativo.selectionStart === "number") { selInicio = ativo.selectionStart; selFim = ativo.selectionEnd; }
  return { valores, pills, visibilidade, foco, selInicio, selFim };
}

function restaurarFormularios(foto) {
  if (!foto) return;
  const app = document.getElementById("app");
  if (!app) return;
  foto.valores.forEach(({ sel, valor }) => {
    let el;
    try { el = app.querySelector(sel); } catch { return; }
    if (!el) return;
    if (el.type === "checkbox" || el.type === "radio") el.checked = valor;
    else el.value = valor;
  });
  (foto.pills || []).forEach(({ row, valor }) => {
    const el = document.getElementById(row);
    if (!el || !app.contains(el)) return;
    el.querySelectorAll(".radio-pill").forEach(p => p.classList.toggle("active", p.dataset.val === valor));
  });
  (foto.visibilidade || []).forEach(({ id, display }) => {
    const el = document.getElementById(id);
    if (el && app.contains(el)) el.style.display = display;
  });
  if (!foto.foco) return;
  let alvo;
  try { alvo = app.querySelector(foto.foco); } catch { return; }
  if (!alvo) return;
  alvo.focus();
  if (foto.selInicio !== null && typeof alvo.setSelectionRange === "function") {
    try { alvo.setSelectionRange(foto.selInicio, foto.selFim); } catch { /* campos que não aceitam seleção */ }
  }
}

/* Usado por todos os listeners onSnapshot: redesenha sem atropelar quem digita. */
function renderExterno() {
  const foto = fotografarFormularios();
  render();
  restaurarFormularios(foto);
}

function render() {
  const app = document.getElementById("app");
  let html = "";

  if (fbUser) {
    // Só decide o que mostrar depois de saber se existe cadastro novo E se existe
    // cadastro antigo — senão quem ainda não foi importado seria mandado para a
    // tela de "criar cadastro" e acabaria com um registro duplicado.
    if (!pessoaLoaded || !legadoConsultado) {
      html = viewLoading("Carregando seus dados...");
    } else if (!meuCadastro()) {
      if (!session.draftUser) session.draftUser = { email: fbUser.email };
      html = viewRegister2();
    } else {
      const u = perfilMesclado();
      const validViews = ["batuqueiro", "historico", ...VIEWS_ADMIN];
      if (!validViews.includes(session.view)) session.view = "batuqueiro";
      if (VIEWS_ADMIN.includes(session.view) && !souAdmin()) session.view = "batuqueiro";

      if (session.view === "historico") html = viewHistorico(u);
      else if (session.view === "admin") html = viewAdmin();
      else if (session.view === "admin-edicoes") html = viewAdminEdicoes();
      else if (session.view === "admin-historico") html = viewAdminHistorico();
      else if (session.view === "admin-precos") html = viewAdminPrecos();
      else if (session.view === "admin-ensaios") html = viewAdminEnsaios();
      else if (session.view === "admin-relatorio") html = viewAdminRelatorio();
      else if (session.view === "admin-posicoes") html = viewAdminPosicoes();
      else if (session.view === "admin-musicas") html = viewAdminMusicas();
      else if (session.view === "admin-pessoas") html = viewAdminPessoas();
      // Estas duas esperas existem para NÃO afirmar coisa errada enquanto os
      // dados ainda estão chegando. Sem elas, quem já respondeu tudo via, por
      // cerca de um segundo a cada login, a tela de confirmar inscrição — e um
      // clique ali dentro naquele instante reescrevia a inscrição por cima,
      // zerando forma de pagamento e valor já pago.
      else if (!edicoesLoaded) html = viewLoading("Carregando o carnaval...");
      else if (!edicaoCtx()) html = viewSemEdicao(u);
      else if (!edicaoCarregou.inscricoes) html = viewLoading("Carregando sua inscrição...");
      else if (!estouInscrito()) { prepararDraftInscricao(); html = viewConfirmarInscricao(u); }
      else html = viewBatuqueiro();
    }
  } else {
    if (session.view === "register1") html = viewRegister1();
    else if (session.view === "login") html = viewLogin();
    else html = viewLanding();
  }

  app.innerHTML = html + rodape();
  wireEvents();
}

/* Rodapé fixo em todas as telas. O aviso de privacidade fica aberto de propósito
   em vez de escondido atrás de um link: é curto, e a pessoa está entregando
   celular e data de nascimento a poucos cliques dali. */
function rodape() {
  return `
  <footer class="rodape">
    <div class="wrap">
      <h3>Privacidade</h3>
      <div class="rodape-blocos">
      <p><b>O que é guardado:</b> nome, apelido, e-mail, celular e data de nascimento; e, a cada carnaval, sua posição, tamanho de camisa, se vai tocar, presença nos ensaios e os pagamentos da anuidade que você registrar.</p>
      <p><b>Para que serve:</b> só para organizar a bateria — montar os naipes, encomendar camisas, controlar a anuidade e acompanhar os ensaios. Nada é usado para outra finalidade, vendido ou enviado para fora do bloco.</p>
      <p><b>Quem enxerga o quê:</b> quem tem cadastro no site vê o nome, o apelido, a posição e a presença dos outros nos ensaios — é o que faz a lista de ensaio funcionar. Seu <b>celular e sua data de nascimento</b> só são vistos por você e pela organização. Seus <b>pagamentos</b> (valor, data e o nome de quem pagou) são vistos por você e pela organização, que precisa conferir cada Pix no extrato do bloco — nenhum outro batuqueiro vê.</p>
      <p><b>Seus direitos:</b> você pode ver e corrigir seus dados a qualquer momento em "Meus dados", e pode pedir a exclusão do seu cadastro falando com a organização do bloco. Os dados ficam guardados enquanto você fizer parte da bateria.</p>
      <p class="rodape-fim">Carnaval do Fogo e Paixão · site de uso interno da bateria</p>
      </div>
    </div>
  </footer>`;
}

function viewLoading(msg) {
  return `<div class="wrap"><div class="loading-screen"><div class="spinner"></div>${msg || "Carregando..."}</div></div>`;
}

/* ============================================================
   VIEW: LANDING
   ============================================================ */
function viewLanding() {
  return `
  <div class="hero"><div class="hero-inner">
    <div style="display:flex; align-items:center; gap:14px; justify-content:center;">
      <img src="logo.png" alt="Logo Carnaval do Fogo e Paixão" class="brand-logo">
      <h1 style="margin:0;">Carnaval do Fogo e Paixão</h1>
    </div>
    <p>Cadastro oficial de batuqueiros da bateria</p>
  </div></div>
  <div class="wrap">
    <div class="center-wrap card">
      <h2 style="text-align:center">Bem-vindo(a)!</h2>
      <p class="card-sub" style="text-align:center">Crie seu login para se cadastrar na bateria, ou entre se já tiver uma conta.</p>
      <div style="display:flex; flex-direction:column; gap:10px;">
        <button class="btn-primary" id="btn-goto-register" style="width:100%">Criar meu cadastro</button>
        <button class="btn-secondary" id="btn-goto-login" style="width:100%">Já tenho login — Entrar</button>
      </div>
    </div>
  </div>`;
}

/* ============================================================
   VIEW: REGISTER STEP 1 — login e senha (Firebase Auth)
   ============================================================ */
function viewRegister1() {
  const err = session.errors.register1;
  const busy = !!session.busy.register1;
  return `
  <div class="hero"><div class="hero-inner"><h1>Criar cadastro</h1><p>Passo 1 — seu login individual</p></div></div>
  <div class="wrap">
    <div class="center-wrap card">
      <h2>Crie seu login e senha</h2>
      <p class="card-sub">Escolha um e-mail e uma senha para acessar sua área de batuqueiro.</p>
      ${err ? `<div class="error-box">${esc(err)}</div>` : ""}
      <form id="form-register1">
        <div class="field"><label>E-mail</label><input type="email" id="reg-email" required placeholder="seuemail@exemplo.com" value="${esc(session.emailDigitado)}" ${busy ? "disabled" : ""}></div>
        <div class="field"><label>Senha</label><input type="password" id="reg-senha" required placeholder="Mínimo 6 caracteres" ${busy ? "disabled" : ""}></div>
        <div class="field"><label>Confirmar senha</label><input type="password" id="reg-senha2" required ${busy ? "disabled" : ""}></div>
        <button class="btn-primary" style="width:100%" type="submit" ${busy ? "disabled" : ""}>${busy ? "Enviando..." : "Continuar"}</button>
      </form>
      <p style="text-align:center; margin-top:14px;"><button class="link-btn" id="back-to-landing">← Voltar</button></p>
    </div>
  </div>`;
}

/* ============================================================
   VIEW: REGISTER STEP 2 — dados do batuqueiro
   Cria o cadastro permanente (/pessoas) e, se houver uma edição aberta,
   já inscreve a pessoa nela.
   ============================================================ */
function viewRegister2() {
  const d = session.draftUser || { email: fbUser.email };
  const err = session.errors.register2;
  const busy = !!session.busy.register2;
  const ed = edicaoAberta();
  // Só o que é permanente. Posição, camisa e "vai tocar" mudam a cada carnaval e
  // são pedidos na tela de inscrição — a mesma que a pessoa vai reencontrar todo
  // ano. Assim quem se cadastra dentro ou fora de temporada segue o mesmo caminho,
  // e esses três campos existem num lugar só no site inteiro.
  const totalPassos = ed ? 3 : 2;
  return `
  <div class="hero"><div class="hero-inner"><h1>Criar cadastro</h1><p>Passo 2 de ${totalPassos} — seus dados</p></div></div>
  <div class="wrap">
    <div class="center-wrap card" style="max-width:560px">
      <div class="step-dots"><div class="step-dot"></div><div class="step-dot active"></div>${ed ? `<div class="step-dot"></div>` : ""}</div>
      <h2>Complete seu cadastro</h2>
      <p class="card-sub">Logado como <b>${esc(d.email)}</b>. Estes dados valem para sempre — você não precisa preenchê-los de novo a cada carnaval.</p>
      ${err ? `<div class="error-box">${esc(err)}</div>` : ""}
      ${!ed ? `<div class="seed-box" style="text-align:left;">As inscrições para o próximo carnaval ainda não estão abertas. Você pode deixar seu cadastro pronto agora — quando a organização abrir, é só entrar e confirmar sua inscrição.</div>` : ""}
      <form id="form-register2">
        <div class="grid-2">
          <div class="field"><label>Nome</label><input type="text" id="c-nome" required value="${esc(d.nome)}"></div>
          <div class="field"><label>Sobrenome</label><input type="text" id="c-sobrenome" required value="${esc(d.sobrenome)}"></div>
        </div>
        <div class="field"><label>Apelido / como prefere ser chamado(a)</label><input type="text" id="c-apelido" placeholder="Opcional — é assim que a bateria vai te chamar no site" value="${esc(d.apelido)}"></div>
        <div class="field"><label>Celular</label><input type="tel" id="c-celular" required placeholder="(21) 90000-0000" value="${esc(d.celular)}"></div>
        <div class="field">
          <label>Data de nascimento</label>
          ${dataNascimentoFieldsHtml("c-datanasc", d.dataNascimento)}
        </div>
        <button class="btn-primary" style="width:100%" type="submit" ${busy ? "disabled" : ""}>${busy ? "Salvando..." : (ed ? "Continuar" : "Finalizar cadastro")}</button>
      </form>
    </div>
  </div>`;
}

/* ============================================================
   VIEW: LOGIN
   ============================================================ */
function viewLogin() {
  const err = session.errors.login;
  const busy = !!session.busy.login;
  return `
  <div class="hero"><div class="hero-inner"><h1>Entrar</h1><p>Acesse sua área de batuqueiro</p></div></div>
  <div class="wrap">
    <div class="center-wrap card">
      <h2>Entrar na minha conta</h2>
      ${err ? `<div class="error-box">${esc(err)}</div>` : ""}
      <form id="form-login">
        <div class="field"><label>E-mail</label><input type="email" id="log-email" required value="${esc(session.emailDigitado)}" ${busy ? "disabled" : ""}></div>
        <div class="field"><label>Senha</label><input type="password" id="log-senha" required ${busy ? "disabled" : ""}></div>
        <button class="btn-primary" style="width:100%" type="submit" ${busy ? "disabled" : ""}>${busy ? "Entrando..." : "Entrar"}</button>
      </form>
      <p style="text-align:center; margin-top:14px;"><button class="link-btn" id="btn-forgot-password">Esqueci minha senha</button></p>
      <p style="text-align:center; margin-top:4px;"><button class="link-btn" id="goto-register-from-login">Ainda não tenho cadastro</button></p>
      <p style="text-align:center; margin-top:4px;"><button class="link-btn" id="back-to-landing2">← Voltar</button></p>
    </div>
  </div>`;
}

/* ============================================================
   VIEW: SEM EDIÇÃO ABERTA
   ============================================================ */
function viewSemEdicao(u) {
  const encerradas = edicoesOrdenadas().filter(e => e.status === "encerrada");
  // Caso do período de transição: o site foi atualizado, mas os dados antigos
  // ainda não foram importados. Quem é admin precisa ser levado direto ao botão
  // de importar, em vez de ver só "inscrições fechadas".
  if (precisaImportarLegado() && souAdmin()) {
    return `
    ${headerBar(u)}
    <div class="wrap">
      <div class="seed-box" style="text-align:left;">
        <b>Seus dados ainda estão no formato antigo.</b>
        <p style="margin:8px 0 0;">O site foi atualizado para guardar um carnaval por edição, mas os cadastros, ensaios, músicas, valores e presenças que já existiam ainda não foram importados. Enquanto isso não for feito, os batuqueiros veem o site como se não houvesse carnaval aberto.</p>
        <div style="margin-top:10px;">
          <button class="btn-primary btn-sm" id="btn-migrar-legado">Importar dados do formato antigo</button>
        </div>
        <p class="hint" style="margin-top:8px;">Prefere conferir antes? O botão <b>Painel admin</b>, no topo da página, também leva ao mesmo lugar.</p>
      </div>
    </div>`;
  }
  // Site recém-instalado: ninguém é admin ainda, então não há quem crie a primeira
  // edição. Sem essa dica, o dono do site fica sem saída nesta tela. A condição é
  // estreita de propósito — nenhum batuqueiro comum chega a ver isso.
  const siteNovoSemAdmin = edicoesCache.length === 0 && !myLegado && !pessoasCache.some(p => p.adminAccess);
  return `
  ${headerBar(u)}
  <div class="wrap">
    ${precisaImportarLegado() ? `<div class="seed-box" style="text-align:left;">Seu cadastro já existe e está guardado. A organização ainda está terminando de preparar o próximo carnaval no site — assim que abrir, é só entrar e confirmar sua inscrição.</div>` : ""}
    ${siteNovoSemAdmin ? `<div class="seed-box" style="text-align:left;">
      <b>É você quem organiza a bateria?</b>
      <p style="margin:8px 0 0;">Este site ainda não tem nenhum organizador definido, e por isso ninguém consegue criar o primeiro carnaval. Esse passo é feito uma única vez, direto no Firebase (por segurança, ninguém pode se tornar organizador pelo próprio site): no <b>Firebase Console → Firestore Database → Dados</b>, abra a coleção <b>pessoas</b>, encontre o registro com o seu e-mail e mude o campo <b>adminAccess</b> de <code>false</code> para <code>true</code>. Depois é só atualizar esta página. O passo a passo completo está no arquivo SETUP.md.</p>
    </div>` : ""}
    <div class="center-wrap card">
      <h2 style="text-align:center">Inscrições fechadas no momento</h2>
      <p class="card-sub" style="text-align:center">Não há nenhum carnaval com inscrições abertas agora. Assim que a organização abrir a próxima edição, é só entrar aqui e confirmar sua inscrição — seus dados de cadastro continuam guardados.</p>
      ${encerradas.length > 0 ? `<div style="display:flex; justify-content:center;"><button class="btn-secondary btn-sm" id="btn-goto-historico">Ver meu histórico de carnavais</button></div>` : ""}
    </div>
  </div>`;
}

/* ============================================================
   VIEW: CONFIRMAR INSCRIÇÃO NA EDIÇÃO
   Ao abrir uma nova edição, quem já participou antes vê os campos
   pré-preenchidos com o último carnaval em que esteve inscrito.
   ============================================================ */
function viewConfirmarInscricao(u) {
  const ed = edicaoCtx();
  const err = session.errors.inscricao;
  const busy = !!session.busy.inscricao;
  const d = session.draftInscricao || {};
  const jaParticipou = !!session.draftInscricaoDeEdicao;

  if (ed.status !== "aberta") {
    // Dois casos caem aqui e o texto precisa dizer a verdade sobre cada um: um
    // carnaval encerrado do qual a pessoa não participou, e um carnaval ainda em
    // preparação (o admin acabou de criar e voltou para a própria área). Antes,
    // os dois diziam "está encerrado" e a tela não tinha nenhuma saída.
    const emPreparacao = ed.status === "preparando";
    return `
    ${headerBar(u)}
    <div class="wrap">
      ${bannerEdicao(ed)}
      <div class="center-wrap card">
        <h2 style="text-align:center">${emPreparacao ? "Este carnaval ainda não foi aberto" : "Você não participou desta edição"}</h2>
        <p class="card-sub" style="text-align:center">${emPreparacao
          ? `O ${esc(edicaoLabel(ed))} está em preparação, então ainda não dá para se inscrever nele. Abra-o em "Gerenciar edições" quando estiver pronto.`
          : `O ${esc(edicaoLabel(ed))} está encerrado e você não tinha inscrição nele.`}</p>
        <div style="display:flex; justify-content:center; gap:8px; flex-wrap:wrap;">
          <button class="btn-secondary btn-sm" id="btn-goto-historico">Ver meu histórico</button>
        </div>
        <p class="hint" style="text-align:center; margin-top:10px;">${edicaoAberta()
          ? `Use o botão acima para voltar ao ${esc(edicaoLabel(edicaoAberta()))}, o carnaval em andamento.`
          : "Nenhum carnaval está aberto no momento."}</p>
      </div>
    </div>`;
  }

  // A mesma tela serve a dois momentos: o último passo de quem acabou de se
  // cadastrar, e a renovação anual de quem já é da bateria. Muda só o texto.
  const recemCadastrado = !!session.acabouDeCadastrar;
  return `
  ${headerBar(u)}
  <div class="wrap">
    <div class="center-wrap card" style="max-width:560px">
      ${recemCadastrado ? `<div class="step-dots"><div class="step-dot"></div><div class="step-dot"></div><div class="step-dot active"></div></div>` : ""}
      <h2>${recemCadastrado ? "Sua inscrição no" : "Confirmar inscrição —"} ${esc(edicaoLabel(ed))}</h2>
      <p class="card-sub">${recemCadastrado
        ? `Falta só dizer como você vai participar deste carnaval. A cada novo carnaval o site pergunta isso de novo, porque instrumento, camisa e disponibilidade mudam de um ano para o outro — seu cadastro em si já está pronto.`
        : jaParticipou
        ? `Preenchemos abaixo com os seus dados do ${esc(edicaoLabel(session.draftInscricaoDeEdicao))}. Confira, ajuste o que mudou e confirme para participar deste carnaval.`
        : `Preencha os dados da sua participação neste carnaval.`}</p>
      ${ed.dataDoCarnaval ? `<p class="hint" style="margin-top:-10px;">Desfile em ${dateBR(ed.dataDoCarnaval)}</p>` : ""}
      ${err ? `<div class="error-box">${esc(err)}</div>` : ""}
      <form id="form-inscricao">
        <div class="field">
          <label>Vai tocar no ${esc(edicaoLabel(ed))}?</label>
          <div class="radio-row" id="insc-radio-vaitocar">
            <div class="radio-pill ${respostaVaiTocar(d) === "Sim" ? "active" : ""}" data-val="Sim">Sim</div>
            <div class="radio-pill ${respostaVaiTocar(d) === "Não" ? "active" : ""}" data-val="Não">Não</div>
          </div>
        </div>
        <div class="field">
          <label>Posição / instrumento</label>
          <select id="insc-posicao">${posicaoOptionsHtml(d.posicao)}</select>
        </div>
        <div class="field" id="insc-wrap-posicao-outro" style="display:${d.posicao === "Outro" ? "block" : "none"}">
          <label>Qual?</label><input type="text" id="insc-posicao-outro" value="${esc(d.posicaoOutro)}">
        </div>
        <div class="field">
          <label>Tamanho da camisa</label>
          <div class="radio-row" id="insc-radio-camisa">
            ${CAMISAS.map(c => `<div class="radio-pill ${d.camisa === c ? "active" : ""}" data-val="${c}">${c}</div>`).join("")}
          </div>
        </div>
        <button class="btn-primary" style="width:100%" type="submit" ${busy ? "disabled" : ""}>${busy ? "Confirmando..." : "Confirmar minha inscrição"}</button>
      </form>
      <p style="text-align:center; margin-top:14px;"><button class="link-btn" id="btn-goto-historico">Ver meu histórico de carnavais</button></p>
    </div>
  </div>`;
}

/* ============================================================
   VIEW: BATUQUEIRO
   ============================================================ */
function viewBatuqueiro() {
  const u = perfilMesclado();
  const ed = edicaoCtx();
  // Um filtro que aponta para algo que não existe mais (ensaio apagado, posição
  // removida) esvaziava a tela enquanto o seletor exibia "Todos" — o filtro
  // mentia sobre o próprio estado, e reselecionar "Todos" nem disparava change.
  const ensaioFiltro = ensaiosCache.some(e => e.id === session.presencaEnsaioFiltro) ? session.presencaEnsaioFiltro : "todos";
  const ensaios = ensaioFiltro === "todos" ? ensaiosCache : ensaiosCache.filter(e => e.id === ensaioFiltro);
  // Quem avisou que não vai tocar não vai a ensaio: fora da tabela de presença.
  const todos = vaoTocarNaEdicao();
  const posicaoFiltro = filtroDePosicaoValido(session.presencaFiltro, todos);
  const editavel = edicaoEditavel(ed);

  return `
  ${headerBar(u)}
  <div class="wrap">
    ${bannerEdicao(ed)}

    <div class="two-col">
      <!-- BOX 1: MEUS DADOS -->
      <div class="card">
        <div class="card-head">
          <div><h2>Meus dados</h2><p class="card-sub" style="margin-bottom:0">Suas informações de cadastro</p></div>
          ${!session.editingMyData && editavel ? `<button class="btn-secondary btn-sm" id="btn-edit-data">Editar</button>` : ``}
        </div>
        ${session.editingMyData ? renderEditMyData(u) : renderViewMyData(u, ed)}
      </div>

      <!-- BOX 2: PAGAMENTO DA ANUIDADE -->
      <div class="card">
        <div class="card-head">
          <div><h2>Pagamento da anuidade</h2><p class="card-sub" style="margin-bottom:0">${isIsento(u) ? "Situação da sua anuidade" : (planoValido(u.formaPagamento) ? `Forma escolhida: ${planoLabel(u.formaPagamento)}` : "Escolha como prefere pagar")}</p></div>
          ${isIsento(u) || !planoValido(u.formaPagamento) ? "" : `<span class="badge ${paymentStatus(u).cls}">${paymentStatus(u).label}</span>`}
        </div>
        ${renderPaymentBoxBody(u, editavel)}
      </div>
    </div>

    <!-- BOX 3: PRESENÇA EM ENSAIOS -->
    <div class="card">
      <div class="card-head">
        <div><h2>Presença em ensaios</h2><p class="card-sub" style="margin-bottom:0">${souEditorDePresenca() && editavel ? "Clique em SIM/NÃO para marcar a presença de qualquer batuqueiro em cada ensaio" : "Veja a presença de todos os batuqueiros em cada ensaio"}</p></div>
      </div>
      <div class="filter-row">
        <div><label>Filtrar por posição</label>
          <select id="presenca-filtro-posicao">
            <option value="todas" ${posicaoFiltro === "todas" ? "selected" : ""}>Todas as posições</option>
            ${posicoesUnicasOrdenadas(todos).map(pos => `<option value="${esc(pos)}" ${posicaoFiltro === pos ? "selected" : ""}>${esc(pos)}</option>`).join("")}
          </select>
        </div>
        <div><label>Filtrar por ensaio</label>
          <select id="presenca-filtro-ensaio">
            <option value="todos" ${ensaioFiltro === "todos" ? "selected" : ""}>Todos os ensaios</option>
            ${ensaiosCache.map(e => `<option value="${e.id}" ${ensaioFiltro === e.id ? "selected" : ""}>${ensaioLabel(e)}</option>`).join("")}
          </select>
        </div>
      </div>
      ${ensaiosCache.length === 0 ? `<div class="hint">Nenhum ensaio cadastrado ainda.</div>` : (() => {
        const pessoasFiltradas = todos.filter(p => posicaoFiltro === "todas" || p.posicao === posicaoFiltro);
        return `
      <div class="table-scroll">
        <table>
          <thead><tr>
            <th>Batuqueiro</th><th>Posição</th>
            ${ensaios.map(e => `<th>${ensaioLabel(e)}</th>`).join("")}
          </tr></thead>
          <tbody>
            ${pessoasFiltradas.map(p => `
              <tr class="${p.id === u.id ? "me" : ""}">
                <td class="name-cell">${nomeComApelido(p)}${p.id === u.id ? ' <span class="muted-sm">(você)</span>' : ""}</td>
                <td>${esc(p.posicao)}</td>
                ${ensaios.map(e => {
                  const on = !!(presencasCache[p.id] && presencasCache[p.id][e.id]);
                  if (!souEditorDePresenca() || !editavel) return `<td><span class="badge ${on ? "badge-good" : "badge-critical"}">${on ? "Presente" : "Ausente"}</span></td>`;
                  return `<td><div class="toggle ${on ? "on" : "off"}" data-uid="${p.id}" data-eid="${e.id}"><span class="yes">SIM</span><span class="no">NÃO</span></div></td>`;
                }).join("")}
              </tr>`).join("") || `<tr><td colspan="${2 + ensaios.length}" class="hint">Ninguém encontrado com esse filtro.</td></tr>`}
          </tbody>
          ${pessoasFiltradas.length > 0 ? `
          <tfoot>
            <tr class="presenca-total-row">
              <td class="name-cell">Total presentes</td>
              <td>${pessoasFiltradas.length} pessoa${pessoasFiltradas.length === 1 ? "" : "s"} no filtro</td>
              ${ensaios.map(e => {
                const presentes = pessoasFiltradas.filter(p => presencasCache[p.id] && presencasCache[p.id][e.id]).length;
                return `<td>${presentes}/${pessoasFiltradas.length}</td>`;
              }).join("")}
            </tr>
          </tfoot>` : ""}
        </table>
      </div>
      <div class="legend"><span><i style="background:var(--good)"></i>Presente</span><span><i style="background:var(--critical)"></i>Ausente</span></div>`;
      })()}
    </div>

    <!-- BOX 4: REPERTÓRIO ENSAIADO -->
    ${musicasCache.length > 0 ? `
    <div class="card">
      <div class="card-head">
        <div><h2>Repertório</h2><p class="card-sub" style="margin-bottom:0">Músicas do ${esc(edicaoLabel(ed))} e em quais ensaios cada uma foi tocada</p></div>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Música</th><th>Tom</th><th>Cantor(a)</th><th>Ensaiada em</th></tr></thead>
          <tbody>
            ${ordenarMusicasAlfabetica(musicasCache).map(m => {
              const datas = ensaiosCache.filter(e => (e.musicaIds || []).includes(m.id)).map(ensaioLabel);
              return `<tr>
                <td class="name-cell">${esc(m.nome)}</td>
                <td>${esc(m.tom) || "—"}</td>
                <td>${esc(m.cantor) || "—"}</td>
                <td>${datas.length ? datas.join(", ") : '<span class="hint">Ainda não</span>'}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>` : ""}
  </div>`;
}

/* Faixa no topo avisando quando a edição em contexto não é a que está aberta. */
function bannerEdicao(ed) {
  if (!ed) return "";
  if (ed.status === "aberta") return "";
  const s = statusInfo(ed);
  return `<div class="seed-box" style="text-align:left; margin-bottom:18px;">
    <b>${esc(edicaoLabel(ed))} — ${s.label}.</b> ${s.sub}. Você está vendo dados de um carnaval que não está em andamento.
    ${edicaoAberta() ? `<div style="margin-top:8px;"><button class="btn-secondary btn-sm" id="btn-voltar-edicao-aberta">Voltar para o ${esc(edicaoLabel(edicaoAberta()))}</button></div>` : ""}
  </div>`;
}

function renderPaymentBoxBody(u, editavel = true) {
  if (isIsento(u)) {
    // Se a pessoa já tinha pago algo antes de ficar isenta (por exemplo, pagou e
    // depois avisou que não vai tocar), o valor continua à vista dela — some da
    // cobrança, não do registro.
    const jaPagou = totalPago(u) > 0;
    return `<div class="isenta-box">Anuidade ISENTA<div class="sub">Você está isento(a) — ${esc(isentoMotivo(u))}.</div></div>
    ${jaPagou ? `
    <p class="card-sub" style="margin:14px 0 6px;">Pagamentos que você já tinha registrado</p>
    <div>
      ${myPagamentos.map(p => `
        <div class="pay-row">
          <span>${dateBR(p.data)}</span>
          <span class="muted-sm">Pago por: ${esc(p.pix) || "—"}</span>
          <span class="pv">${currency(p.valor)}</span>
        </div>`).join("")}
      <div class="pay-total"><span>Total registrado</span><span class="amt">${currency(totalPago(u))}</span></div>
    </div>
    <p class="hint">Como você está isento(a), esse valor não é mais cobrado. Fale com a organização para combinar a devolução ou o crédito.</p>` : ""}`;
  }
  if (!precosCache) {
    return `<div class="hint">O organizador ainda não configurou os valores da anuidade. Volte em breve.</div>`;
  }
  if (!planoValido(u.formaPagamento)) {
    if (!editavel) return `<div class="hint">Nenhuma forma de pagamento foi escolhida neste carnaval.</div>`;
    return `
      <p class="card-sub" style="margin-bottom:12px">Pagando à vista sai mais barato; parcelar em 2x ou 3x custa um pouco mais. Cada parcela tem uma data-limite.</p>
      <div style="display:flex; gap:10px; flex-wrap:wrap;" id="plan-picker">
        ${Object.keys(PLANOS).map(k => `<div class="plan-pill" data-plano="${k}">
          <div style="font-weight:700;">${PLANOS[k].label}</div>
          <div class="muted-sm">${currency(valorDoPlano(k))}${PLANOS[k].parcelas > 1 ? ` (${PLANOS[k].parcelas}x de ${currency(valorDoPlano(k) / PLANOS[k].parcelas)})` : ""}</div>
          <div class="muted-sm">${prazosDoPlano(k).map((d, i) => `${PLANOS[k].parcelas > 1 ? `${i + 1}ª: ` : ""}até ${dateBR(d)}`).join(" · ")}</div>
        </div>`).join("")}
      </div>`;
  }
  const meta = totalDevido(u);
  const pago = totalPago(u);
  const pct = meta ? Math.min(100, Math.round((pago / meta) * 100)) : 0;
  const parcelas = parcelasInfo(u);
  return `
    <div class="progress-bar"><div style="width:${pct}%"></div></div>
    <div class="hint">${currency(pago)} pagos de ${currency(meta)} (${pct}%)</div>

    <div style="margin-top:14px;">
      ${parcelas.map(pc => `
        <div class="pay-row">
          <span>Parcela ${pc.n}/${parcelas.length}</span>
          <span class="muted-sm">até ${dateBR(pc.prazo)} · ${currency(pc.valor)}</span>
          <span class="badge ${pc.status.cls}" style="margin-left:auto">${pc.status.label}</span>
        </div>`).join("")}
    </div>

    <p class="card-sub" style="margin:14px 0 6px;">Pagamentos registrados</p>
    <div>
      ${myPagamentos.length === 0 ? `<div class="hint">Nenhum pagamento registrado ainda.</div>` : myPagamentos.map(p => `
        <div class="pay-row">
          <span>${dateBR(p.data)}</span>
          <span class="muted-sm">Pago por: ${esc(p.pix) || "—"}</span>
          <span class="pv">${currency(p.valor)}</span>
          ${editavel ? `<button class="btn-ghost btn-sm" data-remove-pay="${p.id}" title="Remover este lançamento">Remover</button>` : ""}
        </div>`).join("")}
    </div>
    ${myPagamentos.length && editavel ? `<p class="hint">Lançou errado? Remova e registre de novo — o valor sai da sua conta na hora. Um lançamento não pode ser editado: some e entra outro no lugar, para não mudar um registro por baixo.</p>` : ""}

    ${chavePixDaEdicao() ? `
    <div class="pix-box">
      <div>
        <div class="hint">Chave Pix da bateria</div>
        <div class="pix-chave">${esc(chavePixDaEdicao())}</div>
      </div>
      <button class="btn-secondary btn-sm" id="btn-copiar-pix">Copiar</button>
    </div>
    <p class="hint">Faça o pix por aqui e depois registre o pagamento abaixo — só entra na sua conta o que for registrado.</p>` : ""}

    ${editavel ? `
    <div style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap;">
      <button class="btn-secondary btn-sm" id="btn-toggle-addpay">+ Adicionar pagamento</button>
      ${totalPago(u) > 0 ? "" : `<button class="btn-ghost btn-sm" id="btn-change-plan">Alterar forma de pagamento</button>`}
    </div>
    ${totalPago(u) > 0 ? `<p class="hint">A forma de pagamento não pode mais ser trocada, porque você já registrou um pagamento nela.</p>` : ""}
    <div class="add-pay-form ${session.addPayOpenFor === u.id ? "open" : ""}" id="add-pay-form">
      <div class="grid-3">
        <div class="field"><label>Data em que você pagou</label><input type="date" id="pay-data" value="${hojeISO()}" max="${hojeISO()}"></div>
        <div class="field"><label>Valor (R$)</label><input type="number" id="pay-valor" min="1" step="0.01"></div>
        <div class="field"><label>Nome de quem fez o Pix</label><input type="text" id="pay-pix" placeholder="${esc(fullName(u))}"></div>
      </div>
      <p class="hint" style="margin:-6px 0 10px;">É o nome do titular da conta de onde saiu o Pix, como aparece no extrato. Se você mesmo pagou, é o seu nome. Se quem pagou foi outra pessoa (marido, esposa, pai, mãe, um amigo), escreva o nome dela — é assim que a organização acha o seu pagamento no extrato do bloco. Deixando em branco, entra o seu nome.</p>
      <button class="btn-primary btn-sm" id="btn-save-pay">Salvar pagamento</button>
    </div>` : ""}`;
}

function renderViewMyData(u, ed) {
  return `
    <div class="grid-2">
      <div><div class="hint">Nome completo</div><div>${esc(fullName(u))}</div></div>
      <div><div class="hint">Apelido</div><div>${esc(apelidoDe(u)) || "—"}</div></div>
      <div><div class="hint">E-mail</div><div>${esc(u.email)}</div></div>
      <div><div class="hint">Celular</div><div>${esc(u.celular)}</div></div>
      <div><div class="hint">Data de nascimento</div><div>${dateBR(u.dataNascimento)}${calcIdade(u.dataNascimento) !== null ? ` (${calcIdade(u.dataNascimento)} anos)` : ""}</div></div>
      <div><div class="hint">Vai tocar no ${esc(edicaoLabel(ed))}?</div><div>${esc(u.vaiTocar) || "—"}</div></div>
      <div><div class="hint">Posição / instrumento</div><div>${esc(u.posicao) || "—"}${u.posicao === "Outro" && u.posicaoOutro ? ` (${esc(u.posicaoOutro)})` : ""}</div></div>
      <div><div class="hint">Tamanho da camisa</div><div>${esc(u.camisa) || "—"}</div></div>
    </div>
    <p style="margin-top:14px;"><button class="link-btn" id="btn-goto-historico">Ver meu histórico de carnavais →</button></p>`;
}

function renderEditMyData(u) {
  const ed = edicaoCtx();
  return `
    <form id="form-edit-mydata">
      <div class="grid-2">
        <div class="field"><label>Nome</label><input type="text" id="e-nome" value="${esc(u.nome)}" required></div>
        <div class="field"><label>Sobrenome</label><input type="text" id="e-sobrenome" value="${esc(u.sobrenome)}" required></div>
      </div>
      <div class="field"><label>Apelido / como prefere ser chamado(a)</label><input type="text" id="e-apelido" placeholder="Opcional" value="${esc(apelidoDe(u))}"></div>
      <div class="field"><label>Celular</label><input type="tel" id="e-celular" value="${esc(u.celular)}" required></div>
      <div class="field">
        <label>Data de nascimento</label>
        ${dataNascimentoFieldsHtml("e-datanasc", u.dataNascimento)}
      </div>
      <div class="field">
        <label>Vai tocar no ${esc(edicaoLabel(ed))}?</label>
        <div class="radio-row" id="edit-radio-vaitocar">
          <div class="radio-pill ${respostaVaiTocar(u) === "Sim" ? "active" : ""}" data-val="Sim">Sim</div>
          <div class="radio-pill ${respostaVaiTocar(u) === "Não" ? "active" : ""}" data-val="Não">Não</div>
        </div>
      </div>
      <div class="field">
        <label>Posição / instrumento</label>
        <select id="e-posicao">${posicaoOptionsHtml(u.posicao)}</select>
      </div>
      <div class="field" id="edit-wrap-posicao-outro" style="display:${u.posicao === "Outro" ? "block" : "none"}">
        <label>Qual?</label><input type="text" id="e-posicao-outro" value="${esc(u.posicaoOutro)}">
      </div>
      <div class="field">
        <label>Tamanho da camisa</label>
        <div class="radio-row" id="edit-radio-camisa">${CAMISAS.map(c => `<div class="radio-pill ${u.camisa === c ? "active" : ""}" data-val="${c}">${c}</div>`).join("")}</div>
      </div>
      <p class="hint">Nome, sobrenome, celular e data de nascimento valem para todos os carnavais. Posição, camisa e "vai tocar" são só deste carnaval.</p>
      <div style="display:flex; gap:8px; margin-top:10px;">
        <button class="btn-primary btn-sm" type="submit">Salvar alterações</button>
        <button class="btn-secondary btn-sm" type="button" id="btn-cancel-edit">Cancelar</button>
      </div>
    </form>`;
}

function headerBar(u) {
  const ed = edicaoCtx();
  return `
  <div class="hero" style="padding-bottom:20px;"><div class="hero-inner">
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
      <div style="display:flex; align-items:center; gap:10px;">
        <img src="logo.png" alt="Logo Carnaval do Fogo e Paixão" class="brand-logo brand-logo-sm">
        <div>
          <h1 style="font-size:22px; margin:0;">Área do Batuqueiro</h1>
          <p style="margin:0;">Bem-vindo(a), ${esc(nomeExibicao(u))}!${ed ? ` · ${esc(edicaoLabel(ed))}` : ""}</p>
        </div>
      </div>
      <div style="display:flex; gap:8px;">
        ${souAdmin() ? `<button class="btn-secondary" id="btn-goto-admin">Painel admin</button>` : ""}
        <button class="btn-secondary" id="btn-logout">Sair</button>
      </div>
    </div>
  </div></div>`;
}

/* ============================================================
   VIEW: MEU HISTÓRICO DE CARNAVAIS
   ============================================================ */
function viewHistorico(u) {
  const linhas = session.historico;
  return `
  ${headerBar(u)}
  <div class="wrap">
    <p><button class="link-btn" id="btn-back-from-historico">← Voltar</button></p>
    <div class="card">
      <h2>Meu histórico de carnavais</h2>
      <p class="card-sub">Todos os carnavais em que você participou, com a sua posição, a situação da anuidade e a sua presença nos ensaios de cada ano.</p>
      ${session.historicoBusy ? `<div class="loading-screen"><div class="spinner"></div>Carregando seu histórico...</div>` :
        !linhas ? `<div class="hint">Carregando...</div>` :
        linhas.length === 0 ? `<div class="hint">Você ainda não participou de nenhum carnaval registrado aqui.</div>` : `
      <div class="table-scroll">
        <table>
          <thead><tr><th>Carnaval</th><th>Desfile</th><th>Posição</th><th>Vai tocar</th><th>Camisa</th><th>Anuidade</th><th>Presença nos ensaios</th></tr></thead>
          <tbody>
            ${linhas.map(l => `
              <tr>
                <td class="name-cell">${esc(edicaoLabel(l.edicao))}</td>
                <td>${dateBR(l.edicao.dataDoCarnaval)}</td>
                <td>${esc(l.inscricao.posicao) || "—"}</td>
                <td>${esc(l.inscricao.vaiTocar) || "—"}</td>
                <td>${esc(l.inscricao.camisa) || "—"}</td>
                <td><span class="badge ${statusBadgeCls(l.statusPagamento)}">${l.statusPagamento}</span></td>
                <td>${l.totalEnsaios === 0 ? "—" : `${l.presencas} de ${l.totalEnsaios} ensaio${l.totalEnsaios === 1 ? "" : "s"}`}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`}
    </div>
  </div>`;
}

/* Rascunhos dos formulários de cadastro e inscrição, criados na hora se ainda
   não existirem. Guardar o que já foi preenchido fora do DOM é o que permite
   redesenhar a tela (por causa de dados chegando em tempo real) sem apagar o
   que a pessoa está digitando. */
function draftInscricao() {
  if (!session.draftInscricao) session.draftInscricao = {};
  return session.draftInscricao;
}
function draftUser() {
  if (!session.draftUser) session.draftUser = { email: fbUser ? fbUser.email : "" };
  return session.draftUser;
}

/* Busca a inscrição mais recente da pessoa em edições anteriores, para
   pré-preencher a tela de confirmação da edição nova — assim quem já participou
   só revisa o que mudou em vez de digitar tudo de novo. Roda uma única vez por
   edição (o render() é chamado muitas vezes; o guard evita repetir a consulta). */
async function prepararDraftInscricao() {
  const ed = edicaoCtx();
  if (!ed || !fbUser) return;
  if (session.draftInscricaoCarregadaPara === ed.id) return;
  session.draftInscricaoCarregadaPara = ed.id;
  try {
    for (const anterior of edicoesOrdenadas()) {
      if (anterior.id === ed.id) continue;
      const snap = await getDoc(P.inscricao(anterior.id, fbUser.uid));
      if (!snap.exists()) continue;
      const v = snap.data();
      // Só preenche o que a pessoa ainda não escolheu — se ela já começou a
      // mexer no formulário enquanto essa consulta corria, o que ela fez vence.
      const d = draftInscricao();
      ["vaiTocar", "posicao", "posicaoOutro", "camisa"].forEach(k => { if (d[k] === undefined) d[k] = v[k]; });
      session.draftInscricaoDeEdicao = anterior;
      render();
      return;
    }
  } catch (err) {
    console.warn("não foi possível pré-preencher a inscrição:", err);
  }
}

/* Carrega, sob demanda, os dados de todas as edições em que a pessoa participou.
   Não usa listeners em tempo real de propósito: é uma tela de consulta, e manter
   listeners abertos em todas as edições passadas custaria leituras à toa. */
async function carregarHistorico() {
  if (!fbUser || session.historicoBusy) return;
  const uid = fbUser.uid;            // fixado antes dos awaits: pode sair no meio
  session.historicoBusy = true;
  render();
  const out = [];
  try {
    for (const ed of edicoesOrdenadas()) {
      const inscSnap = await getDoc(P.inscricao(ed.id, uid));
      if (!inscSnap.exists()) continue;
      const inscricao = { id: uid, ...inscSnap.data() };

      const [posSnap, precoSnap, ensaiosSnap, presSnap] = await Promise.all([
        getDocs(P.posicoes(ed.id)),
        getDoc(P.precos(ed.id)),
        getDocs(P.ensaios(ed.id)),
        getDocs(query(P.presencas(ed.id), where("uid", "==", uid))),
      ]);
      const posicoes = posSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const precos = precoSnap.exists() ? precoSnap.data() : null;
      const totalEnsaios = ensaiosSnap.docs.length;
      // Cruza com os ensaios que ainda existem: apagar um ensaio não apaga os
      // registros de presença dele, e sem o cruzamento o histórico chegava a
      // dizer "5 de 4 ensaios" — três telas com três números para o mesmo fato.
      const idsDeEnsaio = ensaiosSnap.docs.map(d => d.id);
      const presencas = presSnap.docs.filter(d => d.data().presente && idsDeEnsaio.includes(d.data().ensaioId)).length;

      out.push({
        edicao: ed,
        inscricao,
        totalEnsaios,
        presencas,
        statusPagamento: statusPagamentoHistorico(inscricao, posicoes, precos),
      });
    }
    if (fbUser && fbUser.uid === uid) session.historico = out;
  } catch (err) {
    console.error("histórico", err);
    // Se a pessoa saiu no meio do carregamento, o erro é dela e não interessa a
    // quem estiver na tela agora — some sem avisar ninguém.
    if (fbUser && fbUser.uid === uid) {
      session.historico = [];
      showToast("Não foi possível carregar o histórico: " + friendlyFirestoreError(err));
    }
  }
  if (fbUser && fbUser.uid === uid) { session.historicoBusy = false; render(); }
}

/* Mesma regra de paymentStatus(), mas calculada com as posições/preços de uma
   edição específica (que não é necessariamente a que está carregada em memória). */
function statusPagamentoHistorico(insc, posicoes, precos) {
  const info = posicoes.find(p => p.nome === insc.posicao);
  // As TRÊS origens de isenção, na mesma ordem de isIsento(): não vai tocar,
  // função isenta e isenção individual. Sem a primeira, o histórico cobrava
  // anuidade de quem tinha avisado que não ia desfilar.
  if (respostaVaiTocar(insc) === "Não" || (info && info.isenta) || insc.isentoManual) return "Isenta";
  if (!planoValido(insc.formaPagamento) || !precos) return "Sem plano";
  const cfg = precos[insc.formaPagamento];
  // valor 0 não é "quitado": é anuidade que ninguém configurou ainda.
  if (!cfg || !(cfg.valor > 0)) return "Sem plano";
  const pago = insc.totalPago || 0;
  if (pago >= cfg.valor) return "Quitado";
  const parcelas = PLANOS[insc.formaPagamento].parcelas;
  const hoje = hojeISO();
  for (let i = 0; i < parcelas; i++) {
    const alvo = (cfg.valor / parcelas) * (i + 1);
    const prazo = (cfg.prazos || [])[i];
    if (pago < alvo - 0.005 && prazo && prazo <= hoje) return "Atrasado";
  }
  return "No prazo";
}

/* ============================================================
   EXPORTAÇÃO DA LISTA DE CADASTROS (Excel / CSV)
   ------------------------------------------------------------
   Uma linha por pessoa INSCRITA no carnaval selecionado, juntando o que é
   permanente (nome, contato) com o que é daquele ano (posição, camisa, dinheiro,
   presença). Sai do painel de Cadastros, então só o admin gera — e é ele quem
   tem permissão de ler o contato de todo mundo.

   Repare que a planilha leva dados pessoais para fora do controle de acesso do
   site: quem receber o arquivo passa a ter o telefone e o nascimento da bateria
   inteira, sem nenhuma das restrições montadas aqui. Por isso a primeira linha
   do arquivo é um aviso — não impede nada tecnicamente, mas fica registrado
   para quem abrir.
   ============================================================ */
const AVISO_EXPORTACAO = "ATENÇÃO: esta planilha contém dados pessoais da bateria (telefone e data de nascimento). Use só para a organização do carnaval e não repasse para fora.";

/* Linhas da planilha, já como texto pronto para exibição. A primeira é o
   cabeçalho. Devolve também um nome de arquivo com o carnaval e a data. */
function dadosDaExportacao() {
  const ed = edicaoCtx();
  const pessoas = batuqueirosDaEdicao();
  const ensaios = ensaiosCache;
  const totalEnsaios = ensaios.length;

  const cabecalho = [
    "Nome", "Sobrenome", "Apelido", "E-mail", "Celular", "Data de nascimento", "Idade",
    "Vai tocar", "Posição", "Camisa",
    "Isento", "Motivo da isenção",
    "Forma de pagamento", "Valor devido", "Valor pago", "Saldo", "Situação",
    "Presenças", "Total de ensaios", "% presença",
    "Acesso admin", "Marca presença",
  ];

  const linhas = pessoas.map(p => {
    const presencas = ensaios.filter(e => presencasCache[p.id] && presencasCache[p.id][e.id]).length;
    const isento = isIsento(p);
    // Quem é isento não deve nada, mesmo tendo plano escolhido antes da isenção.
    const devido = isento ? 0 : (planoComValor(p) ? valorDoPlano(p.formaPagamento) : 0);
    const pago = totalPago(p);
    return [
      p.nome || "", p.sobrenome || "", apelidoDe(p), p.email || "",
      p.celular || "", p.dataNascimento ? dateBR(p.dataNascimento) : "",
      calcIdade(p.dataNascimento) === null ? "" : String(calcIdade(p.dataNascimento)),
      p.vaiTocar || "", p.posicao === "Outro" && p.posicaoOutro ? `Outro (${p.posicaoOutro})` : (p.posicao || ""),
      p.camisa || "",
      isento ? "Sim" : "Não", isento ? isentoMotivo(p) : "",
      planoValido(p.formaPagamento) ? PLANOS[p.formaPagamento].label : "",
      devido, pago, Math.max(0, devido - pago),
      paymentStatus(p).label,
      presencas, totalEnsaios,
      totalEnsaios ? Math.round((presencas / totalEnsaios) * 100) + "%" : "",
      p.adminAccess ? "Sim" : "Não", p.presencaAccess ? "Sim" : "Não",
    ];
  });

  const nomeBase = `batuqueiros-${(ed && ed.id) || "carnaval"}-${hojeISO()}`;
  return { cabecalho, linhas, nomeBase, ed, quantas: linhas.length };
}

/* ============================================================
   BACKUP DO BANCO (feito pelo navegador, pelo admin)
   ------------------------------------------------------------
   Baixa em um único JSON tudo que a organização consegue ler: os cadastros, os
   contatos e todas as edições com suas subcoleções. Serve para o dia a dia —
   antes de mexer em algo grande, antes de encerrar um carnaval, de vez em
   quando por garantia.

   O QUE ESTE BACKUP NÃO LEVA, e por quê: os comprovantes individuais de
   pagamento (/edicoes/{id}/pagamentos). As regras de segurança só deixam cada
   pessoa ler os próprios — nem o admin lê os dos outros, e isso é de propósito,
   para preservar os dados de pagamento de cada um. O total pago de cada pessoa
   vai junto (está na inscrição), então o financeiro consolidado está coberto;
   o que falta é o detalhe de cada lançamento. Para um backup realmente
   completo, use o script backup/backup.mjs, que roda com credencial de
   servidor e enxerga tudo. O SETUP explica.
   ============================================================ */
async function baixarBackup() {
  if (!souAdmin()) return;
  const botao = $("#btn-backup");
  if (botao) { botao.disabled = true; botao.textContent = "Montando backup..."; }
  try {
    const lerColecao = async (ref) => {
      const snap = await getDocs(ref);
      const out = {};
      snap.docs.forEach(d => { out[d.id] = d.data(); });
      return out;
    };

    const backup = {
      geradoEm: new Date().toISOString(),
      geradoPor: (meuCadastro() && meuCadastro().email) || "",
      formato: 1,
      aviso: "Backup parcial: NÃO inclui os comprovantes individuais de pagamento, que as regras de segurança reservam a cada dono. Contém dados pessoais da bateria — guarde em local privado.",
      pessoas: await lerColecao(P.pessoas()),
      contatos: await lerColecao(P.contatos()),
      edicoes: {},
    };

    const edicoes = await getDocs(P.edicoes());
    for (const ed of edicoes.docs) {
      const eid = ed.id;
      backup.edicoes[eid] = {
        dados: ed.data(),
        inscricoes: await lerColecao(P.inscricoes(eid)),
        posicoes: await lerColecao(P.posicoes(eid)),
        ensaios: await lerColecao(P.ensaios(eid)),
        musicas: await lerColecao(P.musicas(eid)),
        presencas: await lerColecao(P.presencas(eid)),
        config: {},
      };
      const precos = await getDoc(P.precos(eid));
      if (precos.exists()) backup.edicoes[eid].config.precos = precos.data();
    }

    const quantas = Object.keys(backup.pessoas).length;
    const quantasEd = Object.keys(backup.edicoes).length;
    baixarArquivo(
      `backup-carnaval-FP-${hojeISO()}.json`,
      new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" })
    );
    showToast(`Backup baixado: ${quantas} cadastros e ${quantasEd} carnaval${quantasEd === 1 ? "" : "s"}.`);
  } catch (err) {
    alert("Não foi possível montar o backup: " + friendlyFirestoreError(err));
  }
  render();
}

/* Entrega um arquivo ao navegador. Um <a download> criado na hora é o caminho
   que funciona em todos os navegadores usados pela bateria, inclusive celular. */
function baixarArquivo(nomeArquivo, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revogar na hora cortaria o download em alguns navegadores.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* CSV no dialeto que o Excel em português entende sem perguntar nada:
   separador ponto-e-vírgula (vírgula é separador decimal aqui) e BOM UTF-8 no
   começo, sem o qual o Excel abre "Jos<C3><A9>" em vez de "José". */
function exportarCSV() {
  const { cabecalho, linhas, nomeBase, quantas } = dadosDaExportacao();
  if (quantas === 0) { alert("Não há ninguém inscrito neste carnaval para exportar."); return; }
  const campo = v => {
    if (typeof v === "number") return String(v).replace(".", ",");
    let texto = String(v == null ? "" : v);
    // Excel, LibreOffice e Google Sheets tratam uma célula que começa com
    // = + - @ (ou tabulação) como FÓRMULA, e aspas não impedem isso. Como nome e
    // apelido são digitados pelos próprios batuqueiros, alguém poderia cadastrar
    // =HYPERLINK(...) e a fórmula rodaria na máquina de quem abrisse a planilha —
    // que é justamente a planilha com o telefone de todo mundo. O apóstrofo à
    // frente obriga a célula a ser tratada como texto.
    if (/^[=+\-@\t\r]/.test(texto)) texto = "'" + texto;
    // Aspas duplas dentro do campo viram duas aspas; qualquer campo com
    // separador, aspas ou quebra de linha precisa ir entre aspas.
    return /[";\n\r]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
  };
  const corpo = [[AVISO_EXPORTACAO], cabecalho, ...linhas]
    .map(linha => linha.map(campo).join(";")).join("\r\n");
  baixarArquivo(`${nomeBase}.csv`, new Blob(["\uFEFF" + corpo], { type: "text/csv;charset=utf-8;" }));
}

/* Carrega o SheetJS sob demanda — só quando alguém clica em "Excel (.xlsx)".
   Não faz parte do site: se o CDN estiver fora do ar ou bloqueado, a promessa
   falha e quem chamou cai para o CSV. */
let promessaSheetJS = null;
function carregarSheetJS() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (promessaSheetJS) return promessaSheetJS;
  // Tenta primeiro uma cópia hospedada junto com o site (vendor/xlsx.full.min.js)
  // e só depois o CDN. Um script de terceiro roda com todos os privilégios da
  // página — e esta função só é chamada na tela do admin, com o login dele
  // ativo; se o CDN for comprometido ou interceptado na rede, o estrago é a
  // conta de organizador e, por ela, o banco inteiro. Hospedar o arquivo junto
  // remove esse terceiro do caminho. O SETUP explica como (é baixar um arquivo
  // e subir na pasta vendor/); enquanto isso não for feito, o CDN continua
  // valendo, e se nenhum dos dois carregar o site cai para o CSV.
  const tentar = (src) => new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.crossOrigin = "anonymous";
    script.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error("biblioteca carregou sem se registrar")));
    script.onerror = () => reject(new Error("falhou: " + src));
    document.head.appendChild(script);
  });
  promessaSheetJS = tentar("vendor/xlsx.full.min.js")
    .catch(() => tentar("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.20.3/xlsx.full.min.js"))
    .catch(err => { promessaSheetJS = null; throw err; });
  return promessaSheetJS;
}

async function exportarXLSX() {
  const { cabecalho, linhas, nomeBase, quantas } = dadosDaExportacao();
  if (quantas === 0) { alert("Não há ninguém inscrito neste carnaval para exportar."); return; }
  let XLSX;
  try {
    XLSX = await carregarSheetJS();
  } catch (err) {
    // Não deixa o admin na mão: entrega o mesmo conteúdo no formato que não
    // depende de nada e explica o que aconteceu.
    alert("Não consegui carregar a biblioteca que gera o arquivo .xlsx (pode ser a internet ou um bloqueio de rede).\n\nVou baixar a mesma planilha em CSV, que o Excel abre normalmente.");
    exportarCSV();
    return;
  }
  const matriz = [[AVISO_EXPORTACAO], cabecalho, ...linhas];
  const aba = XLSX.utils.aoa_to_sheet(matriz);
  // Largura das colunas pelo maior conteúdo, com teto para o aviso não esticar
  // a primeira coluna até o infinito.
  aba["!cols"] = cabecalho.map((titulo, i) => ({
    wch: Math.min(38, Math.max(titulo.length + 2, ...linhas.map(l => String(l[i] == null ? "" : l[i]).length + 2))),
  }));
  aba["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: cabecalho.length - 1 } }];
  const livro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(livro, aba, "Batuqueiros");
  const bytes = XLSX.write(livro, { bookType: "xlsx", type: "array" });
  baixarArquivo(`${nomeBase}.xlsx`, new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
}

/* ============================================================
   VIEW: ADMIN — painel principal
   ============================================================ */
/* Aviso no topo do painel enquanto houver contato guardado em local legível por
   qualquer pessoa logada. Some sozinho depois que a separação é feita. */
function boxContatosExpostos() {
  const n = contatosExpostos().length;
  if (!n) return "";
  return `
  <div class="seed-box" style="text-align:left; border-style:solid;">
    <b>Celular e data de nascimento de ${n} cadastro${n === 1 ? "" : "s"} ainda estão em área de leitura geral.</b>
    <p style="margin:8px 0 0;">No formato antigo esses dados ficavam junto do cadastro, que é lido por qualquer pessoa logada no site — inclusive fora das telas, consultando o banco direto. A separação move o celular e o nascimento para uma área que só a própria pessoa e a organização conseguem ler. Nada é apagado.</p>
    <div style="margin-top:10px;">
      <button class="btn-primary btn-sm" id="btn-separar-contatos">Restringir esses dados agora</button>
    </div>
  </div>`;
}

function viewAdmin() {
  const u = perfilMesclado();
  const ed = edicaoCtx();
  // "todos" aqui é só quem vai desfilar: é dele que saem naipes, camisas,
  // presença e cobrança. Quem avisou que não vai tocar tem contagem à parte.
  const todos = vaoTocarNaEdicao();
  const foraDesteCarnaval = naoVaoTocarNaEdicao();
  const pagantes = todos.filter(p => !isIsento(p));
  const isentos = todos.filter(isIsento);
  const totalInscritos = todos.length;
  const confirmados = todos.filter(p => respostaVaiTocar(p) === "Sim").length;
  // O arrecadado precisa contar TODO MUNDO: quem pagou e depois avisou que não
  // vai tocar continua com dinheiro no caixa, à espera de devolução ou crédito.
  const arrecadado = batuqueirosDaEdicao().reduce((s, p) => s + totalPago(p), 0);
  // planoComValor, não planoValido: com um plano de valor 0 (documento de preços
  // incompleto), totalPago >= 0 é sempre verdade e a adimplência ia a 100% com o
  // painel logo abaixo dizendo "Sem plano: 12". É o mesmo guard de paymentStatus.
  const quitados = pagantes.filter(p => planoComValor(p) && totalPago(p) >= totalDevido(p)).length;
  const adimplencia = pagantes.length ? Math.round((quitados / pagantes.length) * 100) : 0;
  const hoje = hojeISO();
  const ensaiosRealizados = ensaiosCache.filter(e => e.data <= hoje);
  const statusCounts = contagemPorStatus(todos);   // "todos" = quem vai desfilar
  const precisaSeed = ed && edicaoEditavel(ed) && edicaoCarregou.posicoes && edicaoCarregou.precos
    // E, não OU: com posições cadastradas mas sem preços (ou o contrário) a
    // caixa aparecia e o botão sempre recusava, por checar a condição inversa.
    && !precosCache && posicoesCache.length === 0;

  if (!ed) {
    return `
    ${headerBar(u)}
    <div class="wrap">
      <p><button class="link-btn" id="btn-back-batuqueiro">← Voltar para minha área</button></p>
      ${boxContatosExpostos()}
      ${precisaImportarLegado() ? `
      <div class="seed-box" style="text-align:left; border-style:solid;">
        <b>Encontrei dados no formato antigo esperando importação.</b>
        <p style="margin:8px 0 0;">Seu cadastro (e o dos outros batuqueiros) ainda está na estrutura anterior. Clique em importar abaixo: é um passo único e leva tudo — cadastros, posições, ensaios, músicas, valores e presenças — para dentro de uma edição.</p>
      </div>` : ""}
      <div class="seed-box" style="text-align:left;">
        <b>Nenhuma edição do carnaval cadastrada ainda.</b>
        <p style="margin:8px 0 0;">Cada carnaval (2027, 2028...) é uma "edição": um pacote com as suas próprias posições, ensaios, músicas, valores de anuidade, inscrições e presenças. Isso é o que permite guardar o histórico de um ano sem misturar com o outro.</p>
        <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn-primary btn-sm" id="btn-goto-edicoes">Criar a primeira edição</button>
          <button class="btn-secondary btn-sm" id="btn-migrar-legado">Importar dados do formato antigo</button>
        </div>
        <p class="hint" style="margin-top:8px;">Se o site já estava em uso antes desta atualização, clique em "Importar dados do formato antigo" — ele reorganiza os cadastros, ensaios, músicas, preços e presenças que já existem para dentro de uma edição, automaticamente.</p>
      </div>
    </div>`;
  }

  return `
  ${headerBar(u)}
  <div class="wrap">
    <p><button class="link-btn" id="btn-back-batuqueiro">← Voltar para minha área</button></p>
      ${boxContatosExpostos()}

    <!-- ÁREA 1: um carnaval por vez ------------------------------------- -->
    <h2 class="section-title">Acompanhar um carnaval</h2>
    <p class="section-sub">Escolha o carnaval e trabalhe nele: inscritos, ensaios, valores, posições, repertório e pagamentos daquele ano.</p>

    <div class="card">
      <div class="card-head">
        <div style="flex:1; min-width:220px;">
          <label style="display:block; margin-bottom:6px;">Carnaval selecionado</label>
          <select id="admin-troca-edicao" style="max-width:420px;">
            ${edicoesOrdenadas().map(e => `<option value="${esc(e.id)}" ${e.id === ed.id ? "selected" : ""}>${esc(edicaoLabel(e))} — ${statusInfo(e).label}</option>`).join("")}
          </select>
          <p class="card-sub" style="margin:8px 0 0;">${ed.dataDoCarnaval ? `Desfile em ${dateBR(ed.dataDoCarnaval)} · ` : ""}${statusInfo(ed).sub}</p>
          ${ed.status !== "aberta" && edicaoAberta() ? `<p class="hint" style="margin-top:6px;">O carnaval em andamento para os batuqueiros é o ${esc(edicaoLabel(edicaoAberta()))}. Aqui você está olhando outro.</p>` : ""}
        </div>
        <button class="btn-secondary btn-sm" id="btn-goto-edicoes">Gerenciar edições</button>
      </div>
    </div>

    ${precisaSeed ? `
    <div class="seed-box">
      <b>Primeiro acesso desta edição:</b> ainda faltam posições e/ou valores de anuidade cadastrados.
      <div style="margin-top:8px;"><button class="btn-primary btn-sm" id="btn-seed-defaults">Carregar posições e valores padrão</button></div>
    </div>` : ""}

    <div class="stat-row">
      <div class="stat-tile"><div class="label">Vão desfilar</div><div class="value">${totalInscritos}</div></div>
      <div class="stat-tile"><div class="label">Avisaram que não vão tocar</div><div class="value">${foraDesteCarnaval.length}</div></div>
      <div class="stat-tile"><div class="label">Arrecadado</div><div class="value">${currency(arrecadado)}</div></div>
      <div class="stat-tile"><div class="label">Adimplência (pagantes)</div><div class="value">${adimplencia}<small>%</small></div></div>
    </div>
    <p class="hint" style="margin:-10px 0 22px;">${isentos.length} de ${totalInscritos} que vão desfilar são isentos de anuidade (não entram no cálculo de adimplência).${foraDesteCarnaval.length ? ` Quem avisou que não vai tocar fica fora das listas deste carnaval — naipes, camisas e presença — e aparece em Cadastros, num bloco separado.` : ""}</p>

    <div class="two-col">
      <div class="card">
        <div class="card-head">
          <div><h2>Datas de ensaio</h2><p class="card-sub" style="margin-bottom:0">${ensaiosRealizados.length} de ${ensaiosCache.length} ensaios já realizados</p></div>
          <button class="btn-secondary btn-sm" id="btn-goto-ensaios">Ver detalhes dos ensaios</button>
        </div>
      </div>
      <div class="card">
        <div class="card-head">
          <div><h2>Valores e prazos da anuidade</h2><p class="card-sub" style="margin-bottom:0">${precosCache ? `À vista ${currency(valorDoPlano("avista"))} · 2x ${currency(valorDoPlano("duasVezes"))} · 3x ${currency(valorDoPlano("tresVezes"))}` : "Ainda não configurado"}</p></div>
          <button class="btn-secondary btn-sm" id="btn-goto-precos">Editar valores e prazos</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div><h2>Posições / instrumentos</h2><p class="card-sub" style="margin-bottom:0">${posicoesCache.length} posições cadastradas · ${posicoesCache.filter(p => p.isenta).length} isentas automaticamente</p></div>
        <button class="btn-secondary btn-sm" id="btn-goto-posicoes">Gerenciar posições</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div><h2>Repertório / músicas</h2><p class="card-sub" style="margin-bottom:0">${musicasCache.length} música${musicasCache.length === 1 ? "" : "s"} cadastrada${musicasCache.length === 1 ? "" : "s"}</p></div>
        <button class="btn-secondary btn-sm" id="btn-goto-musicas">Gerenciar músicas</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div><h2>Relatório geral de pagamentos</h2><p class="card-sub" style="margin-bottom:0">Quantas pessoas em cada status</p></div>
        <button class="btn-secondary btn-sm" id="btn-goto-relatorio">Ver relatório completo</button>
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:6px;">
        ${STATUS_ORDEM.map(s => `<span class="badge ${statusBadgeCls(s)}">${s}: ${statusCounts[s] || 0}</span>`).join("")}
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div><h2>Cadastros</h2><p class="card-sub" style="margin-bottom:0">${totalInscritos} pessoa${totalInscritos === 1 ? "" : "s"} vão desfilar neste carnaval${foraDesteCarnaval.length ? ` · ${foraDesteCarnaval.length} avisaram que não vão tocar` : ""}</p></div>
        <button class="btn-secondary btn-sm" id="btn-goto-pessoas">Ver lista completa</button>
      </div>
      <div class="two-col">
        <div class="table-scroll">
          <table>
            <thead><tr><th>Posição</th><th>Vão desfilar</th></tr></thead>
            <tbody>${contagemPorPosicao(todos).map(([nome, n]) => `<tr><td>${esc(nome)}</td><td>${n}</td></tr>`).join("") || '<tr><td colspan="2" class="hint">Ninguém confirmado para desfilar ainda.</td></tr>'}</tbody>
          </table>
        </div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Camisa</th><th>Quantas</th></tr></thead>
            <tbody>${contagemPorCamisa(todos).map(([tam, n]) => `<tr><td>${esc(tam)}</td><td>${n}</td></tr>`).join("") || '<tr><td colspan="2" class="hint">Nenhuma camisa a encomendar ainda.</td></tr>'}</tbody>
          </table>
        </div>
      </div>
      <p class="hint" style="margin-top:10px;">A encomenda de camisas conta só quem vai desfilar. Se alguém que não vai tocar quiser comprar, some à mão.</p>
    </div>

    <!-- ÁREA 2: todos os carnavais juntos -------------------------------- -->
    <div style="border-top:1px solid var(--gridline); margin:34px 0 22px;"></div>
    <h2 class="section-title">Todos os carnavais juntos</h2>
    <p class="section-sub">Visão consolidada, que não muda conforme o carnaval selecionado acima.</p>

    <div class="card">
      <div class="card-head">
        <div><h2>Histórico geral</h2><p class="card-sub" style="margin-bottom:0">Uma coluna por carnaval: quem tocou em cada um, com a posição daquele ano, e o repertório de cada edição</p></div>
        <button class="btn-secondary btn-sm" id="btn-goto-historico-geral">Ver histórico geral</button>
      </div>
      <div class="stat-row" style="margin-top:4px;">
        <div class="stat-tile"><div class="label">Carnavais registrados</div><div class="value">${edicoesCache.length}</div></div>
        <div class="stat-tile"><div class="label">Pessoas já cadastradas</div><div class="value">${pessoasCache.length}</div></div>
        <div class="stat-tile"><div class="label">Carnavais já encerrados</div><div class="value">${edicoesCache.filter(e => e.status === "encerrada").length}</div></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <h2>Backup do banco</h2>
          <p class="card-sub" style="margin-bottom:0">Baixa num arquivo só os cadastros, os contatos e todos os carnavais com ensaios, músicas, posições, valores, inscrições e presenças</p>
        </div>
        <button class="btn-secondary btn-sm" id="btn-backup">Baixar backup</button>
      </div>
      <p class="hint">Vale rodar antes de encerrar um carnaval, antes de importar dados ou de tempos em tempos. O arquivo contém telefone e data de nascimento de todo mundo — guarde num lugar privado, não no grupo.</p>
      <p class="hint"><b>O que este backup não leva:</b> os comprovantes individuais de pagamento. As regras de segurança reservam cada comprovante ao próprio dono — nem você lê os dos outros, e isso é de propósito. O total pago de cada pessoa vai junto, então o financeiro consolidado está coberto; falta só o detalhe de cada lançamento. Para o backup completo, use os scripts da pasta <code>backup/</code> — o SETUP explica em cinco passos.</p>
    </div>
  </div>`;
}

/* ============================================================
   VIEW: ADMIN — edições do carnaval
   ============================================================ */
function viewAdminEdicoes() {
  const u = perfilMesclado();
  const lista = edicoesOrdenadas();
  const anoSugerido = new Date().getFullYear() + 1;
  const anterior = lista[0];
  return `
  ${headerBar(u)}
  <div class="wrap">
    <p><button class="link-btn" id="btn-back-admin7">← Voltar para o painel admin</button></p>
    <div class="card">
      <div class="card-head">
        <div>
          <h2>Edições do carnaval</h2>
          <p class="card-sub" style="margin-bottom:0">Cada carnaval é uma edição, com as próprias posições, ensaios, músicas, valores, inscrições e presenças. Só uma edição fica aberta por vez.</p>
        </div>
        <button class="btn-primary btn-sm" id="btn-toggle-nova-edicao">${session.novaEdicaoAberta ? "Cancelar" : "Criar nova edição"}</button>
      </div>

      ${session.novaEdicaoAberta ? `
      <div class="add-pay-form open">
        <div class="grid-3">
          <div class="field"><label>Ano</label><input type="number" id="nova-edicao-ano" value="${esc(session.novaEdicaoAno || anoSugerido)}" min="2024" max="2100"></div>
          <div class="field"><label>Nome</label><input type="text" id="nova-edicao-nome" placeholder="Carnaval do Fogo e Paixão ${anoSugerido}" value="${esc(session.novaEdicaoNome || "")}"></div>
          <div class="field"><label>Data do desfile</label>${dataNascimentoFieldsHtml("nova-edicao-data", session.novaEdicaoData || "", new Date().getFullYear() + 5)}</div>
        </div>
        ${anterior ? `
        <label style="display:flex; align-items:center; gap:8px; font-weight:400; font-size:13px; cursor:pointer; margin-bottom:10px;">
          <input type="checkbox" id="nova-edicao-copiar" checked style="width:auto;">
          Copiar posições e valores de anuidade do ${esc(edicaoLabel(anterior))} como ponto de partida
        </label>` : ""}
        <p class="hint" style="margin-bottom:10px;">A edição nasce "em preparação": só você a enxerga, então dá para ajustar posições, valores e ensaios com calma antes de liberar para os batuqueiros. A data do desfile pode ser alterada depois quando quiser.</p>
        <button class="btn-primary btn-sm" id="btn-criar-edicao">Criar edição</button>
      </div>` : ""}

      ${lista.length === 0 ? `<div class="hint">Nenhuma edição cadastrada ainda.</div>` : `
      <div class="table-scroll">
        <table>
          <thead><tr><th>Edição</th><th>Data do desfile</th><th>Situação</th><th>Vão desfilar</th><th></th></tr></thead>
          <tbody>
            ${lista.map(e => {
              const emCtx = e.id === edicaoCtxId();
              return `<tr class="${emCtx ? "me" : ""}">
                <td class="name-cell">${esc(edicaoLabel(e))} <span class="muted-sm">(${esc(e.id)})</span></td>
                <td><input type="date" class="edicao-data-input" data-edicao-id="${e.id}" value="${esc(e.dataDoCarnaval || "")}" ${e.status === "encerrada" ? "disabled" : ""}></td>
                <td><span class="badge ${statusInfo(e).cls}">${statusInfo(e).label}</span></td>
                <td>${emCtx ? vaoTocarNaEdicao().length : "—"}</td>
                <td class="row-actions">
                  ${e.status !== "encerrada" ? `<button class="btn-secondary btn-sm" data-save-edicao="${e.id}">Salvar data</button>` : ""}
                  ${!emCtx ? `<button class="btn-ghost btn-sm" data-ver-edicao="${e.id}">Ver dados</button>` : `<span class="muted-sm">visualizando</span>`}
                  ${e.status === "preparando" ? `<button class="btn-primary btn-sm" data-abrir-edicao="${e.id}">Abrir para os batuqueiros</button>` : ""}
                  ${e.status === "aberta" ? `<button class="btn-danger btn-sm" data-encerrar-edicao="${e.id}">Encerrar</button>` : ""}
                  ${e.status === "encerrada" ? `<button class="btn-ghost btn-sm" data-reabrir-edicao="${e.id}">Reabrir</button>` : ""}
                </td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
      <p class="hint" style="margin-top:12px;">Ao abrir uma edição, a que estiver aberta no momento é encerrada automaticamente — sempre há no máximo uma edição em andamento. Uma edição encerrada vira histórico e fica travada até para você; use "Reabrir" só se precisar corrigir algo depois do carnaval.</p>`}
    </div>

    <div class="card">
      <div class="card-head">
        <div><h2>Importar dados do formato antigo</h2><p class="card-sub" style="margin-bottom:0">Só é necessário uma única vez, se o site já estava em uso antes da separação por edições</p></div>
        <button class="btn-secondary btn-sm" id="btn-migrar-legado">Importar agora</button>
      </div>
      <p class="hint">Move os cadastros, posições, ensaios, músicas, valores e presenças que estavam no formato antigo para dentro de uma edição nova, separando o que é permanente (nome, nascimento, contato) do que muda a cada carnaval. Rodar de novo depois não duplica nada: o processo avisa se não houver dados antigos a importar.</p>
    </div>
  </div>`;
}

/* ============================================================
   VIEW: ADMIN — histórico geral (todos os carnavais lado a lado)
   ------------------------------------------------------------
   Esta é a única tela que atravessa as edições: em vez de olhar um carnaval por
   vez, mostra a lista completa de batuqueiros (e de músicas) com uma coluna por
   carnaval. Os dados são buscados sob demanda, sem listeners em tempo real — é
   uma tela de consulta, e manter listeners abertos em todas as edições passadas
   custaria leituras à toa.
   ============================================================ */
async function carregarHistoricoGeral() {
  if (!fbUser || session.histGeralBusy) return;
  const uid = fbUser.uid;
  session.histGeralBusy = true;
  render();
  try {
    const eds = [...edicoesOrdenadas()].reverse(); // do carnaval mais antigo para o mais recente
    const porPessoa = {};
    const musicasPorNome = new Map();

    for (const ed of eds) {
      const [inscSnap, musSnap, ensSnap] = await Promise.all([
        getDocs(P.inscricoes(ed.id)),
        getDocs(P.musicas(ed.id)),
        getDocs(P.ensaios(ed.id)),
      ]);

      inscSnap.docs.forEach(d => {
        if (!porPessoa[d.id]) porPessoa[d.id] = {};
        porPessoa[d.id][ed.id] = d.data();
      });

      const ensaios = ensSnap.docs.map(d => d.data());
      musSnap.docs.forEach(d => {
        const m = d.data();
        // As músicas são documentos independentes em cada edição (a cópia de um
        // ano para o outro gera ids novos), então o nome é o que identifica a
        // mesma música ao longo dos carnavais.
        const chave = (m.nome || "").trim().toLowerCase();
        if (!chave) return;
        if (!musicasPorNome.has(chave)) musicasPorNome.set(chave, { nome: m.nome, tom: "", cantor: "", porEdicao: {} });
        const reg = musicasPorNome.get(chave);
        reg.nome = m.nome;
        if (m.tom) reg.tom = m.tom;
        if (m.cantor) reg.cantor = m.cantor;
        reg.porEdicao[ed.id] = { ensaios: ensaios.filter(e => (e.musicaIds || []).includes(d.id)).length };
      });
    }

    if (fbUser && fbUser.uid === uid) {
      session.histGeral = {
        edicoes: eds,
        porPessoa,
        musicas: [...musicasPorNome.values()].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" })),
      };
    }
  } catch (err) {
    console.error("histórico geral", err);
    if (fbUser && fbUser.uid === uid) {
      session.histGeral = null;
      showToast("Não foi possível carregar o histórico geral: " + friendlyFirestoreError(err));
    }
  }
  if (fbUser && fbUser.uid === uid) { session.histGeralBusy = false; render(); }
}

/* Recalcula os totais do rodapé a partir das linhas que estão visíveis, para que
   eles acompanhem o filtro sem precisar redesenhar a tela inteira. */
function atualizarRodapesHistorico() {
  const conta = (tbodyId, seletorRodape, seletorCelula) => {
    const linhas = [...document.querySelectorAll(`#${tbodyId} tr[data-hist-nome]`)].filter(tr => tr.style.display !== "none");
    document.querySelectorAll(seletorRodape).forEach(td => {
      const i = td.cellIndex;
      td.textContent = linhas.filter(tr => tr.cells[i] && tr.cells[i].querySelector(seletorCelula)).length;
    });
  };
  conta("hist-pessoas-tbody", ".hist-rodape-pessoas", ".badge-good");   // quem tocou
  conta("hist-musicas-tbody", ".hist-rodape-musicas", ".badge");        // esteve no repertório
}

function viewAdminHistorico() {
  const u = perfilMesclado();
  const dados = session.histGeral;
  const termo = (session.histFiltro || "").trim().toLowerCase();

  if (session.histGeralBusy || !dados) {
    return `
    ${headerBar(u)}
    <div class="wrap">
      <p><button class="link-btn" id="btn-back-admin8">← Voltar para o painel admin</button></p>
      <div class="card"><h2>Histórico geral</h2>${viewLoading("Juntando os dados de todos os carnavais...")}</div>
    </div>`;
  }

  const eds = dados.edicoes;
  const pessoas = [...pessoasCache].sort((a, b) => fullName(a).localeCompare(fullName(b), "pt-BR", { sensitivity: "base" }));
  const pessoasFiltradas = termo ? pessoas.filter(p => textoBusca(p).includes(termo)) : pessoas;
  const musicasFiltradas = termo ? dados.musicas.filter(m => m.nome.toLowerCase().includes(termo)) : dados.musicas;

  const tocou = (uid, edId) => {
    const reg = dados.porPessoa[uid] && dados.porPessoa[uid][edId];
    return !!(reg && respostaVaiTocar(reg) === "Sim");
  };

  return `
  ${headerBar(u)}
  <div class="wrap">
    <p><button class="link-btn" id="btn-back-admin8">← Voltar para o painel admin</button></p>

    <div class="card">
      <div class="card-head">
        <div>
          <h2>Histórico geral</h2>
          <p class="card-sub" style="margin-bottom:0">Todos os carnavais lado a lado — quem tocou em cada um e quais músicas fizeram parte de cada repertório. Independe da edição que você está visualizando no painel.</p>
        </div>
        <button class="btn-secondary btn-sm" id="btn-recarregar-historico">Atualizar</button>
      </div>
      <div class="filter-row">
        <div style="flex:1;">
          <label>Buscar por nome (pessoa ou música)</label>
          <input type="text" id="hist-filtro" value="${esc(session.histFiltro)}" placeholder="Digite para filtrar as duas tabelas">
        </div>
      </div>
    </div>

    ${eds.length === 0 ? `<div class="card"><div class="hint">Nenhuma edição cadastrada ainda.</div></div>` : `

    <div class="card">
      <h2>Batuqueiros por carnaval</h2>
      <p class="card-sub">Todo mundo que já teve cadastro no site, tenha participado de um carnaval ou de todos. Quando a pessoa tocou, a célula mostra a posição dela naquele ano.</p>
      <div class="table-scroll">
        <table id="hist-pessoas-table">
          <thead><tr>
            <th>Batuqueiro</th>
            ${eds.map(e => `<th>${esc(edicaoLabel(e))}${e.dataDoCarnaval ? `<br><span class="muted-sm">${dateBR(e.dataDoCarnaval)}</span>` : ""}</th>`).join("")}
            <th>Carnavais</th>
          </tr></thead>
          <tbody id="hist-pessoas-tbody">
            ${pessoasFiltradas.map(p => {
              const total = eds.filter(e => tocou(p.id, e.id)).length;
              return `<tr data-hist-nome="${esc(textoBusca(p))}">
                <td class="name-cell">${nomeComApelido(p)}</td>
                ${eds.map(e => {
                  const reg = dados.porPessoa[p.id] && dados.porPessoa[p.id][e.id];
                  if (!reg) return `<td><span class="hint">—</span></td>`;
                  if (respostaVaiTocar(reg) === "Sim") return `<td><span class="badge badge-good">${esc(reg.posicao) || "Tocou"}</span></td>`;
                  return `<td><span class="badge badge-warning">Não tocou</span></td>`;
                }).join("")}
                <td class="hist-total-pessoa">${total}</td>
              </tr>`;
            }).join("") || `<tr><td colspan="${2 + eds.length}" class="hint">Ninguém encontrado com esse filtro.</td></tr>`}
          </tbody>
          <tfoot>
            <tr class="presenca-total-row">
              <td class="name-cell">Total que tocou</td>
              ${eds.map(e => `<td class="hist-rodape-pessoas">${pessoasFiltradas.filter(p => tocou(p.id, e.id)).length}</td>`).join("")}
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="legend">
        <span><i style="background:var(--good)"></i>Tocou (mostra a posição)</span>
        <span><i style="background:var(--warning)"></i>Inscrito, mas não tocou</span>
        <span><i style="background:var(--gridline)"></i>Sem inscrição naquele carnaval</span>
      </div>
    </div>

    <div class="card">
      <h2>Músicas por carnaval</h2>
      <p class="card-sub">Todo o repertório já cadastrado, em qualquer carnaval. Quando a música esteve no repertório, a célula mostra em quantos ensaios daquele ano ela foi tocada.</p>
      <div class="table-scroll">
        <table id="hist-musicas-table">
          <thead><tr>
            <th>Música</th><th>Tom</th><th>Cantor(a)</th>
            ${eds.map(e => `<th>${esc(edicaoLabel(e))}</th>`).join("")}
            <th>Carnavais</th>
          </tr></thead>
          <tbody id="hist-musicas-tbody">
            ${musicasFiltradas.map(m => {
              const total = eds.filter(e => m.porEdicao[e.id]).length;
              return `<tr data-hist-nome="${esc(m.nome.toLowerCase())}">
                <td class="name-cell">${esc(m.nome)}</td>
                <td>${esc(m.tom) || "—"}</td>
                <td>${esc(m.cantor) || "—"}</td>
                ${eds.map(e => {
                  const reg = m.porEdicao[e.id];
                  if (!reg) return `<td><span class="hint">—</span></td>`;
                  if (reg.ensaios > 0) return `<td><span class="badge badge-good">${reg.ensaios} ensaio${reg.ensaios === 1 ? "" : "s"}</span></td>`;
                  return `<td><span class="badge badge-warning">No repertório</span></td>`;
                }).join("")}
                <td class="hist-total-musica">${total}</td>
              </tr>`;
            }).join("") || `<tr><td colspan="${4 + eds.length}" class="hint">Nenhuma música encontrada com esse filtro.</td></tr>`}
          </tbody>
          <tfoot>
            <tr class="presenca-total-row">
              <td class="name-cell">Total no repertório</td>
              <td></td><td></td>
              ${eds.map(e => `<td class="hist-rodape-musicas">${musicasFiltradas.filter(m => !!m.porEdicao[e.id]).length}</td>`).join("")}
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="legend">
        <span><i style="background:var(--good)"></i>Ensaiada (mostra em quantos ensaios)</span>
        <span><i style="background:var(--warning)"></i>No repertório, mas não ensaiada</span>
        <span><i style="background:var(--gridline)"></i>Fora do repertório daquele carnaval</span>
      </div>
    </div>`}
  </div>`;
}

/* ============================================================
   VIEW: ADMIN — ensaios
   ============================================================ */
function viewAdminEnsaios() {
  const u = perfilMesclado();
  const ed = edicaoCtx();
  const editavel = edicaoEditavel(ed);
  const hoje = hojeISO();
  const totalPessoas = vaoTocarNaEdicao().length;
  return `
  ${headerBar(u)}
  <div class="wrap">
    <p><button class="link-btn" id="btn-back-admin4">← Voltar para o painel admin</button></p>
    ${bannerEdicao(ed)}
    <div class="card">
      <h2>Ensaios — ${esc(edicaoLabel(ed))}</h2>
      <p class="card-sub">Edite a data, veja quantas pessoas foram em cada ensaio, registre as músicas ensaiadas e adicione novas datas</p>
      <p class="hint" style="margin-bottom:12px;">A data grava sozinha assim que você troca — não há botão de salvar. Os batuqueiros passam a ver a data nova na mesma hora, sem precisar recarregar o site.</p>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Data</th><th>Situação</th><th>Presença</th><th>Músicas ensaiadas</th><th></th></tr></thead>
          <tbody>
            ${ensaiosCache.length === 0 ? `<tr><td colspan="5" class="hint">Nenhum ensaio cadastrado.</td></tr>` : ensaiosCache.map(e => {
              const realizado = e.data <= hoje;
              // Sobre a MESMA lista do denominador (quem vai tocar). Contando
              // inscricoesCache, uma marca de presença de quem depois avisou que
              // não vai tocar continuava somando e a tela mostrava "10/9".
              const presentes = vaoTocarNaEdicao().filter(p => presencasCache[p.id] && presencasCache[p.id][e.id]).length;
              const musicaIds = e.musicaIds || [];
              const nomesMusicas = musicaIds.map(musicaResumo).filter(Boolean);
              const aberto = session.ensaioMusicasAberto === e.id;
              const draftIds = aberto ? (session.ensaioMusicasDraft || []) : musicaIds;
              return `<tr>
                <td><input type="date" class="ensaio-data-input" data-ensaio-id="${e.id}" value="${esc(e.data)}" ${editavel ? "" : "disabled"}></td>
                <td><span class="badge ${realizado ? "badge-good" : "badge-warning"}">${realizado ? "Realizado" : "Agendado"}</span></td>
                <td>${presentes}/${totalPessoas} presentes</td>
                <td>
                  <div>${nomesMusicas.length ? esc(nomesMusicas.join(", ")) : '<span class="hint">Nenhuma</span>'}</div>
                  ${editavel ? `<button class="btn-ghost btn-sm" style="margin-top:4px;" data-toggle-musicas-ensaio="${e.id}">${aberto ? "Fechar" : "Editar músicas"}</button>` : ""}
                </td>
                <td class="row-actions">
                  ${editavel ? `
                  <button class="btn-ghost btn-sm" data-remove-ensaio="${e.id}">Remover</button>` : `<span class="muted-sm">só leitura</span>`}
                </td>
              </tr>
              ${aberto ? `<tr><td colspan="5">
                <div class="add-pay-form open">
                  <p class="card-sub" style="margin:0 0 10px;">Marque as músicas ensaiadas em ${dateBR(e.data)}:</p>
                  ${musicasCache.length === 0 ? `<p class="hint">Nenhuma música cadastrada ainda. Cadastre no repertório (painel admin → Repertório / músicas).</p>` : `
                  <div style="display:flex; flex-direction:column; gap:8px;">
                    ${ordenarMusicasAlfabetica(musicasCache).map(m => `
                      <label style="display:flex; align-items:center; gap:6px; font-weight:400; font-size:13.5px;">
                        <input type="checkbox" class="musica-ensaio-check" data-musica-id="${m.id}" ${draftIds.includes(m.id) ? "checked" : ""} style="width:auto;"> ${esc(m.nome)}${(m.tom || m.cantor) ? ` <span class="hint">${esc([m.tom, m.cantor].filter(Boolean).join(" · "))}</span>` : ""}
                      </label>`).join("")}
                  </div>`}
                  <div style="display:flex; gap:8px; margin-top:14px;">
                    <button class="btn-primary btn-sm" data-save-musicas-ensaio="${e.id}">Salvar músicas deste ensaio</button>
                    <button class="btn-ghost btn-sm" data-cancel-musicas-ensaio="1">Cancelar</button>
                  </div>
                </div>
              </td></tr>` : ""}`;
            }).join("")}
          </tbody>
        </table>
      </div>
      ${editavel ? `
      <div style="display:flex; gap:8px; margin-top:14px;">
        <input type="date" id="new-ensaio-data" style="flex:1">
        <button class="btn-primary btn-sm" id="btn-add-ensaio">Adicionar ensaio</button>
      </div>` : ""}
    </div>
  </div>`;
}

/* ============================================================
   VIEW: ADMIN — relatório
   ============================================================ */
function viewAdminRelatorio() {
  const u = perfilMesclado();
  const ed = edicaoCtx();
  const todos = vaoTocarNaEdicao();
  // Quem não vai tocar não é cobrado — mas se já tinha pago, esse dinheiro está
  // no caixa e alguém precisa decidir se devolve ou credita. Some da lista de
  // cobrança e reaparece embaixo, só quem tem valor pago.
  const aDevolver = naoVaoTocarNaEdicao().filter(p => totalPago(p) > 0);
  const posicaoFiltro = filtroDePosicaoValido(session.relatorioFiltroPosicao, todos);
  const filtrados = todos.filter(p => {
    const st = paymentStatus(p).label;
    const okStatus = !session.relatorioFiltroStatus || session.relatorioFiltroStatus === "todos" || st === session.relatorioFiltroStatus;
    const okPos = posicaoFiltro === "todas" || p.posicao === posicaoFiltro;
    const okPago = valorNaFaixa(totalPago(p), session.relatorioFiltroPago);
    const okSaldo = valorNaFaixa(saldoEmAberto(p), session.relatorioFiltroSaldo);
    return okStatus && okPos && okPago && okSaldo;
  });
  return `
  ${headerBar(u)}
  <div class="wrap">
    <p><button class="link-btn" id="btn-back-admin5">← Voltar para o painel admin</button></p>
    ${bannerEdicao(ed)}
    <div class="card">
      <h2>Relatório geral de pagamentos — ${esc(edicaoLabel(ed))}</h2>
      <p class="card-sub">Visão completa — só o organizador vê os pagamentos de todos</p>
      <div class="filter-row">
        <div><label>Status</label>
          <select id="relatorio-filtro-status">
            <option value="todos" ${(session.relatorioFiltroStatus || "todos") === "todos" ? "selected" : ""}>Todos os status</option>
            ${STATUS_ORDEM.map(s => `<option value="${s}" ${session.relatorioFiltroStatus === s ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </div>
        <div><label>Posição</label>
          <select id="relatorio-filtro-posicao">
            <option value="todas" ${posicaoFiltro === "todas" ? "selected" : ""}>Todas as posições</option>
            ${posicoesUnicasOrdenadas(todos).map(pos => `<option value="${esc(pos)}" ${posicaoFiltro === pos ? "selected" : ""}>${esc(pos)}</option>`).join("")}
          </select>
        </div>
        ${selectDeFaixa("relatorio-filtro-pago", "Pago", session.relatorioFiltroPago, todos.map(totalPago), "Não pagou nada")}
        ${selectDeFaixa("relatorio-filtro-saldo", "Saldo", session.relatorioFiltroSaldo, todos.map(saldoEmAberto), "Não deve nada")}
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Nome</th><th>Posição</th><th>Forma pagto</th><th>Pago</th><th>Devido</th><th>Saldo</th><th>Status</th></tr></thead>
          <tbody>
            ${filtrados.map(p => {
              const status = paymentStatus(p);
              // Coluna "Pago" preenchida mesmo para isentos: alguém pode ter pago
              // antes de ficar isento (por exemplo, avisou depois que não vai
              // tocar), e esse dinheiro não pode sumir do relatório.
              if (isIsento(p)) return `<tr><td class="name-cell">${esc(fullName(p))}</td><td>${esc(p.posicao)}</td><td>—</td><td>${totalPago(p) > 0 ? currency(totalPago(p)) : "—"}</td><td>Isenta</td><td>—</td><td><span class="badge ${status.cls}">${status.label}</span></td></tr>`;
              if (!planoValido(p.formaPagamento)) return `<tr><td class="name-cell">${esc(fullName(p))}</td><td>${esc(p.posicao)}</td><td colspan="4">Ainda não escolheu a forma de pagamento</td><td><span class="badge ${status.cls}">${status.label}</span></td></tr>`;
              const pago = totalPago(p), meta = totalDevido(p);
              return `<tr>
                <td class="name-cell">${esc(fullName(p))}</td>
                <td>${esc(p.posicao)}</td>
                <td>${PLANOS[p.formaPagamento].label}</td>
                <td>${currency(pago)}</td>
                <td>${currency(meta)}</td>
                <td>${currency(Math.max(0, meta - pago))}</td>
                <td><span class="badge ${status.cls}">${status.label}</span></td>
              </tr>`;
            }).join("") || '<tr><td colspan="7" class="hint">Ninguém encontrado com esses filtros.</td></tr>'}
          </tbody>
          <tfoot>
            <tr>
              <th>${filtrados.length} pessoa${filtrados.length === 1 ? "" : "s"}</th>
              <th></th><th></th>
              <th>${currency(filtrados.reduce((soma, p) => soma + totalPago(p), 0))}</th>
              <th></th>
              <th>${currency(filtrados.reduce((soma, p) => soma + (saldoEmAberto(p) || 0), 0))}</th>
              <th></th>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="hint" style="margin-top:10px;">A lista traz só quem vai desfilar. Quem avisou que não vai tocar está isento e não é cobrado. O rodapé soma o que está na tela, então acompanha os filtros.</p>
      <p class="hint">Quem ainda não escolheu a forma de pagamento não tem saldo definido — essas pessoas só aparecem com o filtro de Saldo em "Qualquer valor".</p>
    </div>

    ${aDevolver.length > 0 ? `
    <div class="card">
      <div class="card-head">
        <div>
          <h2>Pagaram, mas não vão tocar</h2>
          <p class="card-sub" style="margin-bottom:0">${aDevolver.length} pessoa${aDevolver.length === 1 ? "" : "s"} registrou pagamento antes de avisar que não vai desfilar. O dinheiro está no caixa e precisa ser devolvido ou virar crédito para o próximo carnaval — o site não decide isso por você.</p>
        </div>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Nome</th><th>Valor pago</th></tr></thead>
          <tbody>
            ${aDevolver.map(p => `<tr><td class="name-cell">${esc(fullName(p))}</td><td>${currency(totalPago(p))}</td></tr>`).join("")}
            <tr><td><b>Total</b></td><td><b>${currency(aDevolver.reduce((soma, p) => soma + totalPago(p), 0))}</b></td></tr>
          </tbody>
        </table>
      </div>
    </div>` : ""}
  </div>`;
}

/* ============================================================
   VIEW: ADMIN — preços
   ============================================================ */
function viewAdminPrecos() {
  const u = perfilMesclado();
  const ed = edicaoCtx();
  const editavel = edicaoEditavel(ed);
  const precos = precosCache || DEFAULT_PRECOS;
  return `
  ${headerBar(u)}
  <div class="wrap">
    <p><button class="link-btn" id="btn-back-admin3">← Voltar para o painel admin</button></p>
    ${bannerEdicao(ed)}
    <div class="card">
      <h2>Valores e datas-limite da anuidade — ${esc(edicaoLabel(ed))}</h2>
      <p class="card-sub">Preço total e prazo de cada parcela, conforme a forma de pagamento. Valem só para este carnaval.</p>
      <div class="field">
        <label>Chave Pix para receber a anuidade</label>
        <input type="text" id="admin-chave-pix" value="${esc(precos.chavePix)}" placeholder="e-mail, telefone, CPF/CNPJ ou chave aleatória" ${editavel ? "" : "disabled"}>
        <p class="hint">Aparece na área de pagamento de cada batuqueiro, com um botão de copiar. Deixe em branco para não mostrar nada.</p>
      </div>
      ${Object.keys(PLANOS).map(k => pricingPlanFieldset(k, precos, editavel)).join("")}
      ${editavel ? `<button class="btn-primary btn-sm" id="btn-save-precos">Salvar valores e prazos</button>` : `<p class="hint">Edição encerrada — os valores ficam como registro histórico.</p>`}
    </div>
  </div>`;
}

function pricingPlanFieldset(planoKey, precos, editavel = true) {
  const plano = PLANOS[planoKey];
  // Tolera um documento de preços incompleto (por exemplo vindo da importação):
  // sem isso, a tela inteira ficava em branco por causa de um campo faltando.
  const base = (precos && precos[planoKey]) || DEFAULT_PRECOS[planoKey];
  const cfg = { valor: base.valor, prazos: Array.isArray(base.prazos) ? base.prazos : [] };
  while (cfg.prazos.length < plano.parcelas) cfg.prazos.push("");
  const dis = editavel ? "" : "disabled";
  return `
    <div style="border:1px solid var(--gridline); border-radius:10px; padding:12px; margin-bottom:12px;">
      <div style="font-weight:700; font-size:13.5px; margin-bottom:8px;">${plano.label}</div>
      <div class="field"><label>Valor total (R$)</label><input type="number" id="admin-preco-${planoKey}" value="${esc(cfg.valor)}" min="1" step="0.01" ${dis}></div>
      <div class="${plano.parcelas > 1 ? "grid-" + plano.parcelas : ""}">
        ${cfg.prazos.map((d, i) => `<div class="field"><label>${plano.parcelas > 1 ? `Parcela ${i + 1} — ` : ""}Data-limite</label><input type="date" id="admin-prazo-${planoKey}-${i}" value="${esc(d || "")}" ${dis}></div>`).join("")}
      </div>
    </div>`;
}

/* ============================================================
   VIEW: ADMIN — posições
   ============================================================ */
function viewAdminPosicoes() {
  const u = perfilMesclado();
  const ed = edicaoCtx();
  const editavel = edicaoEditavel(ed);
  // O rascunho local (session.posicoesDraft) é a fonte da verdade enquanto essa
  // tela está aberta — assim, edições digitadas não se perdem se um re-render
  // acontecer por outro motivo (ex: alguém mais mexendo em outra parte do
  // sistema em tempo real). Só é recriado a partir do servidor quando ainda
  // não existe (entrada na tela) ou depois de salvar/adicionar/remover.
  // O rascunho só pode ser montado DEPOIS que o cache respondeu. Montá-lo de um
  // cache ainda vazio (logo depois de trocar de edição, por exemplo) o
  // congelava vazio para sempre — [] é truthy —, a tela dizia "nenhuma posição"
  // numa edição que tem 17, e o admin recadastraria tudo por cima, duplicando.
  if (!session.posicoesDraft && edicaoCarregou.posicoes) {
    session.posicoesDraft = ordenarPosicoesAlfabetica(posicoesCache.map(p => ({ id: p.id, nome: p.nome, isenta: !!p.isenta })));
  }
  const draft = session.posicoesDraft || [];
  return `
  ${headerBar(u)}
  <div class="wrap">
    <p><button class="link-btn" id="btn-back-admin">← Voltar para o painel admin</button></p>
    ${bannerEdicao(ed)}
    <div class="card">
      <h2>Posições / instrumentos — ${esc(edicaoLabel(ed))}</h2>
      <p class="card-sub">Adicione, edite e diga se a posição é isenta de anuidade automaticamente — em ordem alfabética. Valem só para este carnaval. Depois de editar, clique em "Salvar todas as posições" uma única vez.</p>
      ${draft.map(p => `
        <div class="list-row">
          <input type="text" class="pos-name-input" data-pos-id="${p.id}" value="${esc(p.nome)}" style="flex:1; max-width:220px;" ${editavel ? "" : "disabled"}>
          <label style="display:flex; align-items:center; gap:6px; font-weight:400; font-size:12.5px; white-space:nowrap;">
            <input type="checkbox" class="pos-isenta-input" data-pos-id="${p.id}" ${p.isenta ? "checked" : ""} style="width:auto;" ${editavel ? "" : "disabled"}> Isenta automaticamente
          </label>
          ${editavel ? `<button class="btn-ghost btn-sm" data-remove-posicao="${p.id}">Remover</button>` : ""}
        </div>`).join("")}
      ${editavel ? `
      <div style="display:flex; gap:8px; margin-top:14px; align-items:center; flex-wrap:wrap;">
        <input type="text" id="new-posicao-nome" placeholder="Nova posição/instrumento" style="flex:1; min-width:180px;">
        <label style="display:flex; align-items:center; gap:6px; font-size:12.5px; white-space:nowrap;"><input type="checkbox" id="new-posicao-isenta" style="width:auto;"> Isenta</label>
        <button class="btn-secondary btn-sm" id="btn-add-posicao">Adicionar</button>
      </div>
      <button class="btn-primary btn-sm" id="btn-save-all-posicoes" style="margin-top:16px;">Salvar todas as posições</button>
      <p class="hint" style="margin-top:10px">"Outro" continua disponível no formulário de cadastro e nunca é isento automaticamente — só por isenção individual.</p>` : `<p class="hint" style="margin-top:10px">Edição encerrada — as posições ficam como registro histórico.</p>`}
    </div>
  </div>`;
}

/* Valores únicos já usados em Tom/Cantor entre as músicas do rascunho atual —
   viram as opções sugeridas (<datalist>) nos campos livres de tom e cantor,
   para reaproveitar nomes já digitados sem impedir digitar um novo. */
function valoresUnicosOrdenados(lista, campo) {
  return [...new Set(lista.map(m => (m[campo] || "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));
}

/* ============================================================
   VIEW: ADMIN — músicas
   ============================================================ */
function viewAdminMusicas() {
  const u = perfilMesclado();
  const ed = edicaoCtx();
  const editavel = edicaoEditavel(ed);
  // Mesmo padrão de rascunho local usado nas posições: evita perder edições
  // digitadas se a tela for redesenhada por outro motivo antes de salvar.
  // Mesmo cuidado das posições: só monta o rascunho depois que o cache respondeu.
  if (!session.musicasDraft && edicaoCarregou.musicas) {
    session.musicasDraft = ordenarMusicasAlfabetica(musicasCache.map(m => ({ id: m.id, nome: m.nome, tom: m.tom || "", cantor: m.cantor || "" })));
  }
  const draft = session.musicasDraft || [];
  const tonsSugeridos = valoresUnicosOrdenados(draft, "tom");
  const cantoresSugeridos = valoresUnicosOrdenados(draft, "cantor");
  return `
  ${headerBar(u)}
  <div class="wrap">
    <p><button class="link-btn" id="btn-back-admin6">← Voltar para o painel admin</button></p>
    ${bannerEdicao(ed)}
    <div class="card">
      <h2>Repertório / músicas — ${esc(edicaoLabel(ed))}</h2>
      <p class="card-sub">Cadastre aqui as músicas do repertório deste carnaval, o tom e quem canta (voz) cada uma — em ordem alfabética. Tom e Cantor(a) são campos livres: comece a digitar e os valores já usados em outras músicas aparecem como sugestão, mas você também pode digitar um novo. Elas ficam disponíveis para marcar quais foram ensaiadas em cada data (painel admin → Ensaios). Depois de editar, clique em "Salvar todas as músicas" uma única vez.</p>
      ${draft.length === 0 ? `<p class="hint">Nenhuma música cadastrada ainda.</p>` : ""}
      ${draft.map(m => `
        <div style="border-bottom:1px solid var(--gridline); padding:10px 0;">
          <div class="grid-3">
            <div class="field" style="margin-bottom:0;"><label>Música</label><input type="text" class="musica-name-input" data-musica-id="${m.id}" value="${esc(m.nome)}" ${editavel ? "" : "disabled"}></div>
            <div class="field" style="margin-bottom:0;"><label>Tom</label><input type="text" class="musica-tom-input" data-musica-id="${m.id}" value="${esc(m.tom)}" list="lista-tons" placeholder="Ex: Sol maior" ${editavel ? "" : "disabled"}></div>
            <div class="field" style="margin-bottom:0;"><label>Cantor(a) / voz</label><input type="text" class="musica-cantor-input" data-musica-id="${m.id}" value="${esc(m.cantor)}" list="lista-cantores" placeholder="Nome" ${editavel ? "" : "disabled"}></div>
          </div>
          ${editavel ? `<button class="btn-ghost btn-sm" style="margin-top:8px;" data-remove-musica="${m.id}">Remover</button>` : ""}
        </div>`).join("")}

      ${editavel ? `
      <div class="grid-3" style="margin-top:14px;">
        <div class="field" style="margin-bottom:0;"><label>Nova música</label><input type="text" id="new-musica-nome" placeholder="Nome da música"></div>
        <div class="field" style="margin-bottom:0;"><label>Tom</label><input type="text" id="new-musica-tom" placeholder="Ex: Sol maior" list="lista-tons"></div>
        <div class="field" style="margin-bottom:0;"><label>Cantor(a) / voz</label><input type="text" id="new-musica-cantor" placeholder="Nome" list="lista-cantores"></div>
      </div>
      <button class="btn-secondary btn-sm" id="btn-add-musica" style="margin-top:10px;">Adicionar</button>

      <button class="btn-primary btn-sm" id="btn-save-all-musicas" style="margin-top:16px; display:block;">Salvar todas as músicas</button>` : `<p class="hint" style="margin-top:10px">Edição encerrada — o repertório fica como registro histórico.</p>`}

      <datalist id="lista-tons">${tonsSugeridos.map(t => `<option value="${esc(t)}">`).join("")}</datalist>
      <datalist id="lista-cantores">${cantoresSugeridos.map(c => `<option value="${esc(c)}">`).join("")}</datalist>
    </div>
  </div>`;
}

/* ============================================================
   VIEW: ADMIN — cadastros
   ============================================================ */
function viewAdminPessoas() {
  const u = perfilMesclado();
  const ed = edicaoCtx();
  const editavel = edicaoEditavel(ed);
  const filtro = filtroDePosicaoValido(session.adminPessoasFiltro, vaoTocarNaEdicao());
  const todos = vaoTocarNaEdicao();
  const foraDesteCarnaval = naoVaoTocarNaEdicao();
  const posicoesPresentes = posicoesUnicasOrdenadas(todos);
  const lista = filtro === "todas" ? todos : todos.filter(p => p.posicao === filtro);
  const naoInscritos = pessoasCache.filter(p => !inscricoesCache.some(i => i.id === p.id));
  return `
  ${headerBar(u)}
  <div class="wrap">
    <p><button class="link-btn" id="btn-back-admin2">← Voltar para o painel admin</button></p>
    ${bannerEdicao(ed)}
    <div class="card">
      <div class="card-head">
        <div><h2>Quem vai desfilar — ${esc(edicaoLabel(ed))}</h2><p class="card-sub" style="margin-bottom:0">${todos.length} pessoa${todos.length === 1 ? "" : "s"}. Editar dados, marcar isenção individual de anuidade, dar acesso admin ou tirar alguém desta edição</p></div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          <button class="btn-secondary btn-sm" id="btn-exportar-xlsx">Baixar Excel (.xlsx)</button>
          <button class="btn-ghost btn-sm" id="btn-exportar-csv">Baixar CSV</button>
        </div>
        <select id="admin-pessoas-filtro" style="width:auto;">
          <option value="todas" ${filtro === "todas" ? "selected" : ""}>Todas as posições</option>
          ${posicoesPresentes.map(p => `<option value="${esc(p)}" ${filtro === p ? "selected" : ""}>${esc(p)}</option>`).join("")}
        </select>
      </div>
      ${lista.length === 0 ? '<div class="hint">Nenhuma pessoa encontrada com esse filtro.</div>' : lista.map(p => `
        <div class="list-row">
          <span class="grow"><b>${nomeComApelido(p)}</b> <span class="muted-sm">— ${esc(p.posicao)} · ${esc(p.email)} · camisa ${esc(p.camisa)} · vai tocar: ${esc(p.vaiTocar)}${isIsento(p) ? ` · <span class="badge badge-isenta">Isento — ${esc(isentoMotivo(p))}</span>` : ""}${p.adminAccess ? ` · <span class="badge badge-good">Acesso admin</span>` : ""}${!p.adminAccess && p.presencaAccess ? ` · <span class="badge badge-good">Edita presença</span>` : ""}</span></span>
          <button class="btn-secondary btn-sm" data-edit-user="${p.id}">Editar</button>
          ${editavel ? `<button class="btn-danger btn-sm" data-remove-user="${p.id}">Tirar da edição</button>` : ""}
        </div>
        <div class="add-pay-form ${session.adminEditingUser === p.id ? "open" : ""}" id="admin-edit-${p.id}">
          ${session.adminEditingUser === p.id ? renderAdminEditUserForm(p, editavel) : ""}
        </div>
      `).join("")}
      <p class="hint" style="margin-top:12px;">A planilha traz uma linha por pessoa inscrita neste carnaval — inclusive quem avisou que não vai tocar, identificado na coluna "Vai tocar", para você ter o registro de quem respondeu o quê. Vai com contato, posição, camisa, situação da anuidade e presença nos ensaios, sem o filtro de posição acima. Ela contém telefone e data de nascimento, então sai do controle de acesso do site: quem receber o arquivo passa a ver esses dados de todo mundo.</p>
    </div>

    ${foraDesteCarnaval.length > 0 ? `
    <div class="card">
      <div class="card-head">
        <div>
          <h2>Não vão tocar no ${esc(edicaoLabel(ed))}</h2>
          <p class="card-sub" style="margin-bottom:0">${foraDesteCarnaval.length} pessoa${foraDesteCarnaval.length === 1 ? "" : "s"} respondeu que não vai desfilar neste carnaval. Ficam de fora da presença, dos naipes e da encomenda de camisas, e são isentas da anuidade — mas o cadastro e o histórico delas continuam intactos, e no próximo carnaval a inscrição aparece normalmente.</p>
        </div>
      </div>
      ${foraDesteCarnaval.map(p => `
        <div class="list-row">
          <span class="grow"><b>${nomeComApelido(p)}</b> <span class="muted-sm">— ${esc(p.email)}${totalPago(p) > 0 ? ` · <span class="badge badge-warning">Pagou ${currency(totalPago(p))} — ver devolução</span>` : ""}</span></span>
          <button class="btn-secondary btn-sm" data-edit-user="${p.id}">Editar</button>
          ${editavel ? `<button class="btn-danger btn-sm" data-remove-user="${p.id}">Tirar da edição</button>` : ""}
        </div>
        <div class="add-pay-form ${session.adminEditingUser === p.id ? "open" : ""}" id="admin-edit-${p.id}">
          ${session.adminEditingUser === p.id ? renderAdminEditUserForm(p, editavel) : ""}
        </div>
      `).join("")}
      <p class="hint" style="margin-top:10px;">Se alguém mudar de ideia, quem corrige é a própria pessoa em "Meus dados" — ou você, no botão Editar acima.</p>
    </div>` : ""}

    ${naoInscritos.length > 0 ? `
    <div class="card">
      <div class="card-head">
        <div><h2>Cadastrados sem inscrição nesta edição</h2><p class="card-sub" style="margin-bottom:0">${naoInscritos.length} pessoa(s) com cadastro no site que ainda não confirmaram participação no ${esc(edicaoLabel(ed))}</p></div>
      </div>
      ${naoInscritos.map(p => `
        <div class="list-row">
          <span class="grow"><b>${nomeComApelido(p)}</b> <span class="muted-sm">— ${esc(p.email)}</span></span>
          <span class="badge badge-warning">Sem inscrição</span>
        </div>`).join("")}
      <p class="hint" style="margin-top:10px;">Elas continuam com login e cadastro; basta entrarem no site e confirmarem a inscrição nesta edição.</p>
    </div>` : ""}
  </div>`;
}

function renderAdminEditUserForm(p, editavel = true) {
  const dis = editavel ? "" : "disabled";
  return `
    <form data-admin-edit-form="${p.id}">
      <div class="grid-2">
        <div class="field"><label>Nome</label><input type="text" id="ae-nome-${p.id}" value="${esc(p.nome)}" ${dis}></div>
        <div class="field"><label>Sobrenome</label><input type="text" id="ae-sobrenome-${p.id}" value="${esc(p.sobrenome)}" ${dis}></div>
      </div>
      <div class="field"><label>Apelido / como prefere ser chamado(a)</label><input type="text" id="ae-apelido-${p.id}" value="${esc(apelidoDe(p))}"></div>
      <div class="field"><label>Celular</label><input type="tel" id="ae-celular-${p.id}" value="${esc(p.celular)}" ${dis}></div>
      <div class="field">
        <label>Data de nascimento</label>
        ${dataNascimentoFieldsHtml(`ae-datanasc-${p.id}`, p.dataNascimento)}
      </div>
      <div class="field">
        <label>Vai tocar neste carnaval?</label>
        <select id="ae-vaitocar-${p.id}" ${dis}>
          <option value="" ${!respostaVaiTocar(p) ? "selected" : ""}>Ainda não respondeu</option>
          <option value="Sim" ${respostaVaiTocar(p) === "Sim" ? "selected" : ""}>Sim</option>
          <option value="Não" ${respostaVaiTocar(p) === "Não" ? "selected" : ""}>Não</option>
        </select>
        <p class="hint">Quem não vai tocar sai da presença, dos naipes e da encomenda de camisas, e fica isento da anuidade.</p>
      </div>
      <div class="field">
        <label>Posição</label>
        <select id="ae-posicao-${p.id}" ${dis}>${posicaoOptionsHtml(p.posicao)}</select>
      </div>
      <div class="field"><label>Camisa</label>
        <select id="ae-camisa-${p.id}" ${dis}>
          <option value="" ${!CAMISAS.includes(p.camisa) ? "selected" : ""}>Sem tamanho informado</option>
          ${CAMISAS.map(x => `<option ${x === p.camisa ? "selected" : ""}>${esc(x)}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label>Forma de pagamento</label>
        <select id="ae-formapagamento-${p.id}" ${dis}>
          <option value="" ${!p.formaPagamento ? "selected" : ""}>Ainda não escolheu</option>
          ${Object.entries(PLANOS).map(([k, v]) => `<option value="${esc(k)}" ${k === p.formaPagamento ? "selected" : ""}>${esc(v.label)}</option>`).join("")}
        </select>
        <p class="hint">O próprio batuqueiro só troca isso enquanto não registrou nenhum pagamento. Você pode trocar a qualquer momento — o valor já pago continua contando, e o total devido é recalculado pelo novo plano.</p>
      </div>
      <div class="field">
        <label style="display:flex; align-items:center; gap:8px; font-weight:400; cursor:pointer;">
          <input type="checkbox" id="ae-isento-${p.id}" ${p.isentoManual ? "checked" : ""} style="width:auto;" ${dis}>
          Isenção individual de anuidade (além das posições isentas por padrão)
        </label>
      </div>
      <div class="field">
        <label style="display:flex; align-items:center; gap:8px; font-weight:400; cursor:pointer;">
          <input type="checkbox" id="ae-adminaccess-${p.id}" ${p.adminAccess ? "checked" : ""} style="width:auto;">
          Acesso ao painel admin (co-organizador — continua aparecendo normalmente na presença e nos pagamentos)
        </label>
      </div>
      <div class="field">
        <label style="display:flex; align-items:center; gap:8px; font-weight:400; cursor:pointer;">
          <input type="checkbox" id="ae-presencaaccess-${p.id}" ${p.presencaAccess ? "checked" : ""} style="width:auto;">
          Pode marcar presença nos ensaios (de qualquer batuqueiro) sem ser admin
        </label>
        <p class="hint" style="margin-top:4px;">Quem tem acesso ao painel admin já pode marcar presença automaticamente, não precisa marcar aqui também.</p>
      </div>
      <p class="hint">Nome, sobrenome, celular, nascimento e os dois acessos acima valem para todos os carnavais. Posição, camisa e isenção são só desta edição.</p>
      <button class="btn-primary btn-sm" type="submit" style="margin-top:10px;">Salvar</button>
      <button class="btn-secondary btn-sm" type="button" data-cancel-admin-edit="${p.id}">Cancelar</button>
    </form>
    ${renderAdminPagamentos(p, editavel)}`;
}

/* Comprovantes de pagamento de uma pessoa, dentro do formulário de edição do
   admin. Ficam FORA do <form> acima de propósito: são gravações independentes,
   cada uma com efeito imediato no total, e misturá-las no submit geral faria um
   clique em "Salvar" mexer em dinheiro sem que ninguém tivesse pedido. */
function renderAdminPagamentos(p, editavel) {
  const carregados = session.pagsDoEditadoDe === p.id;
  const pags = carregados ? (session.pagsDoEditado || []) : null;
  const somaComprovantes = (pags || []).reduce((s, x) => s + (x.valor || 0), 0);
  const total = totalPago(p);
  const divergencia = carregados && Math.abs(somaComprovantes - total) > 0.005;

  return `
  <div class="card" style="margin-top:14px; background:var(--surface-2);">
    <div class="card-head">
      <div>
        <h2 style="font-size:16px;">Pagamentos de ${esc(fullName(p))}</h2>
        <p class="card-sub" style="margin-bottom:0">Total lançado: <b>${currency(total)}</b>${carregados ? ` · soma dos comprovantes: <b>${currency(somaComprovantes)}</b>` : ""}</p>
      </div>
      ${carregados ? "" : `<button class="btn-secondary btn-sm" data-ver-pagamentos="${p.id}" ${session.pagsDoEditadoBusy ? "disabled" : ""}>${session.pagsDoEditadoBusy ? "Carregando..." : "Ver pagamentos"}</button>`}
    </div>

    ${!carregados ? `<p class="hint">Os comprovantes são carregados só quando você pede — são dados financeiros de outra pessoa.</p>` : `
      ${divergencia ? `
      <div class="seed-box" style="text-align:left; border-style:solid; margin-bottom:12px;">
        <b>O total não bate com os comprovantes.</b>
        <p style="margin:6px 0 0;">O total diz ${currency(total)} e os comprovantes somam ${currency(somaComprovantes)}. A diferença costuma vir da importação do site antigo, que trouxe o valor já pago sem os comprovantes atrás. Você pode acertar o total pela soma dos comprovantes — mas confira antes se o que falta não é um pagamento real que simplesmente nunca foi lançado aqui.</p>
        ${editavel ? `<button class="btn-primary btn-sm" style="margin-top:10px;" data-recalcular-total="${p.id}">Acertar total para ${currency(somaComprovantes)}</button>` : ""}
      </div>` : ""}

      ${pags.length === 0 ? `<p class="hint">Nenhum comprovante lançado por esta pessoa.</p>` : `
      <div class="table-scroll">
        <table>
          <thead><tr><th>Data</th><th>Quem pagou</th><th>Valor</th><th></th></tr></thead>
          <tbody>
            ${pags.map(pag => `
              <tr>
                <td><input type="date" class="pg-data" data-pag-id="${pag.id}" value="${esc(pag.data || "")}" ${editavel ? "" : "disabled"} style="min-width:150px;"></td>
                <td><input type="text" class="pg-pagador" data-pag-id="${pag.id}" value="${esc(pag.pix || "")}" ${editavel ? "" : "disabled"}></td>
                <td><input type="number" class="pg-valor" data-pag-id="${pag.id}" value="${pag.valor || 0}" min="0.01" step="0.01" ${editavel ? "" : "disabled"} style="min-width:110px;"></td>
                <td class="row-actions">
                  ${editavel ? `
                  <button class="btn-secondary btn-sm" data-salvar-pag="${pag.id}" data-dono="${p.id}">Salvar</button>
                  <button class="btn-ghost btn-sm" data-remover-pag="${pag.id}" data-dono="${p.id}">Remover</button>` : `<span class="muted-sm">só leitura</span>`}
                </td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`}

      ${editavel ? `
      <div class="add-pay-form open" style="margin-top:12px;">
        <p class="card-sub" style="margin:0 0 10px;">Lançar um pagamento por ela (dinheiro em mãos, Pix que você conferiu no extrato)</p>
        <div class="grid-3">
          <div class="field"><label>Data</label><input type="date" id="novo-pag-data-${p.id}" value="${hojeISO()}"></div>
          <div class="field"><label>Valor (R$)</label><input type="number" id="novo-pag-valor-${p.id}" min="0.01" step="0.01"></div>
          <div class="field"><label>Quem pagou</label><input type="text" id="novo-pag-pagador-${p.id}" placeholder="${esc(fullName(p))}"></div>
        </div>
        <button class="btn-primary btn-sm" data-add-pag="${p.id}">Lançar pagamento</button>
      </div>` : ""}
      <p class="hint" style="margin-top:10px;">Toda alteração aqui já muda o total lançado — não depende do botão "Salvar" do cadastro acima.</p>
    `}
  </div>`;
}

/* ============================================================
   MIGRAÇÃO DO FORMATO ANTIGO
   ------------------------------------------------------------
   Reorganiza os dados que estavam todos "soltos" na raiz (/users, /posicoes,
   /ensaios, /musicas, /config/precos, /presencas) para dentro de uma edição,
   separando os dados permanentes de cada pessoa (/pessoas) dos dados daquele
   carnaval (/edicoes/{id}/inscricoes). Roda uma única vez.

   Os pagamentos individuais NÃO são movidos por aqui de propósito: as regras
   de segurança só deixam cada pessoa ler os próprios comprovantes (nem o admin
   vê os dos outros), então cada um leva os seus na primeira vez que entrar —
   ver migrarMeusPagamentos(). O total pago vai junto na inscrição, então
   nenhum saldo fica errado nesse meio-tempo.
   ============================================================ */
/* Grava uma lista de [referência, dados] respeitando o limite de 500 operações
   por lote do Firestore. Cada bloco é atômico; o conjunto não é — se um bloco
   falhar, quem chama decide o que fazer com o que já entrou. */
async function gravarEmBlocos(escritas, tamanhoDoBloco = 400, mesclar = false) {
  const enviar = async (fatia) => {
    const batch = writeBatch(db);
    // Com mesclar = true o documento existente é preservado e só os campos
    // passados mudam. Sem isso, um set apagaria o resto do cadastro.
    fatia.forEach(([ref, dados]) => batch.set(ref, dados, mesclar ? { merge: true } : undefined));
    await batch.commit();
  };
  for (let i = 0; i < escritas.length; i += tamanhoDoBloco) {
    const fatia = escritas.slice(i, i + tamanhoDoBloco);
    try {
      await enviar(fatia);
    } catch (err) {
      // Cada escrita faz o Firestore consultar outros documentos para avaliar a
      // regra (quem é o autor, em que status está a edição), e há um teto
      // dessas consultas por requisição. Um lote grande normalmente passa
      // porque são sempre os MESMOS documentos, mas não é garantido. Em vez de
      // deixar a importação inteira falhar — o que faz o admin perder a edição
      // recém-criada e entrar num ciclo —, reenvia em lotes pequenos.
      if (!err || err.code !== "permission-denied" || fatia.length <= 5) throw err;
      console.warn("lote grande recusado; reenviando em blocos de 5", err);
      for (let j = 0; j < fatia.length; j += 5) await enviar(fatia.slice(j, j + 5));
    }
  }
}

/* Cadastros que ainda guardam celular ou nascimento dentro de /pessoas — ou
   seja, legíveis por qualquer pessoa logada. É o que a separação abaixo resolve. */
function contatosExpostos() {
  return pessoasCache.filter(p => (p.celular || "").trim() || (p.dataNascimento || "").trim());
}

/* Passo único: move o contato de cada cadastro para /contatos e apaga o campo
   de /pessoas. Pode ser rodado quantas vezes for preciso — se não houver nada
   exposto, não faz nada; e um cadastro já separado não aparece na lista. */
async function separarContatos() {
  const expostos = contatosExpostos();
  if (expostos.length === 0) { alert("Nenhum cadastro está com celular ou data de nascimento em local visível para todos. Nada a fazer."); return; }
  if (!confirm(`Mover o celular e a data de nascimento de ${expostos.length} cadastro${expostos.length === 1 ? "" : "s"} para uma área restrita?\n\nDepois disso, esses dados só podem ser lidos pela própria pessoa e pela organização. Nada é apagado — só sai de onde qualquer pessoa logada conseguia ler.`)) return;

  const escritas = [];
  expostos.forEach(p => {
    const atual = contatosCache[p.id] || {};
    // não sobrescreve um contato já separado que esteja mais atualizado
    escritas.push([P.contato(p.id), {
      celular: atual.celular || p.celular || "",
      dataNascimento: atual.dataNascimento || p.dataNascimento || "",
    }]);
  });
  try {
    await gravarEmBlocos(escritas);
    // só limpa a origem depois que a cópia entrou, para nunca ficar sem o dado
    await gravarEmBlocos(expostos.map(p => [P.pessoa(p.id), { celular: "", dataNascimento: "" }]), 400, true);
    showToast(`Pronto: contato de ${expostos.length} cadastro${expostos.length === 1 ? "" : "s"} agora é restrito.`);
  } catch (err) {
    alert(friendlyFirestoreError(err));
  }
}

async function migrarDoFormatoAntigo() {
  // As coleções antigas continuam existindo depois da importação (são só de
  // leitura, e o próprio SETUP.md orienta apagá-las à mão só depois de conferir
  // tudo). Por isso "existem dados antigos" NÃO serve de guarda: sem o teste
  // abaixo, um segundo clique recriaria tudo numa edição nova, sobrescreveria
  // cada /pessoas com os dados antigos — rebaixando admins promovidos depois —
  // e deixaria dois carnavais abertos ao mesmo tempo.
  const jaImportada = edicoesCache.find(e => e.migradaDoFormatoAntigo);
  if (jaImportada) {
    alert(`A importação já foi feita: os dados antigos estão no ${edicaoLabel(jaImportada)}.\n\nRodar de novo criaria uma edição duplicada e desfaria mudanças feitas depois (inclusive acessos concedidos no painel), por isso está bloqueado.\n\nSe precisar mesmo refazer, apague antes essa edição no Firebase Console.`);
    return;
  }
  // A edição importada nasce aberta. Se já houver outra aberta, o site passaria a
  // ter dois carnavais em andamento e qual deles os batuqueiros veem viraria
  // sorteio — então esse caso é barrado antes de começar.
  const aberta = edicaoAberta();
  if (aberta) {
    alert(`O ${edicaoLabel(aberta)} está aberto agora.\n\nA importação cria um carnaval já aberto, e o site não pode ter dois ao mesmo tempo. Encerre esse carnaval em "Gerenciar edições" antes de importar os dados antigos.`);
    return;
  }
  if (!confirm("Importar os dados do formato antigo para uma edição nova?\n\nIsso reorganiza os cadastros, posições, ensaios, músicas, valores e presenças que já existem. É feito uma única vez.")) return;
  try {
    const usersSnap = await getDocs(collection(db, "users"));
    if (usersSnap.docs.length === 0) {
      alert("Não encontrei nenhum cadastro no formato antigo. Nada a importar — provavelmente a migração já foi feita.");
      return;
    }

    const anoStr = prompt("De que ano é o carnaval desses dados?", String(new Date().getFullYear() + 1));
    if (!anoStr) return;
    const ano = parseInt(anoStr, 10);
    if (!ano || ano < 2000 || ano > 2100) { alert("Ano inválido."); return; }
    const eid = proximoEdicaoId(ano);

    const [posSnap, ensSnap, musSnap, precoSnap, presSnap] = await Promise.all([
      getDocs(collection(db, "posicoes")),
      getDocs(collection(db, "ensaios")),
      getDocs(collection(db, "musicas")),
      getDoc(doc(db, "config", "precos")),
      getDocs(collection(db, "presencas")),
    ]);

    const nomeEdicao = `Carnaval do Fogo e Paixão ${ano}`;

    // IMPORTANTE: a edição precisa ser criada e confirmada ANTES de gravar
    // qualquer coisa dentro dela. As regras de segurança de cada subcoleção
    // consultam o status da edição, e o Firestore avalia cada escrita de um
    // lote contra o estado anterior ao lote — se a edição fosse criada no mesmo
    // lote, essa consulta cairia num documento inexistente e tudo seria negado.
    await setDoc(P.edicao(eid), {
      ano, nome: nomeEdicao,
      dataDoCarnaval: "", status: "aberta",
      criadaEm: serverTimestamp(), migradaDoFormatoAntigo: true,
    });

    // Um writeBatch do Firestore aceita no máximo 500 operações. Uma bateria de
    // tamanho real estoura isso fácil só com as presenças (uma por pessoa por
    // ensaio: 40 pessoas × 12 ensaios já são 480), e o lote inteiro seria
    // recusado. Por isso as escritas são montadas numa lista e enviadas em
    // blocos.
    const escritas = [];
    usersSnap.docs.forEach(d => {
      const v = d.data();
      escritas.push([P.pessoa(d.id), {
        nome: v.nome || "", sobrenome: v.sobrenome || "", apelido: v.apelido || "", email: v.email || "",
        celular: "", dataNascimento: "",   // contato vai para /contatos, logo abaixo
        adminAccess: !!v.adminAccess, presencaAccess: !!v.presencaAccess,
        criadoEm: v.createdAt || serverTimestamp(),
      }]);
      escritas.push([P.contato(d.id), {
        celular: v.celular || "", dataNascimento: v.dataNascimento || "",
      }]);
      escritas.push([P.inscricao(eid, d.id), {
        vaiTocar: respostaVaiTocar(v), posicao: v.posicao || "", posicaoOutro: v.posicaoOutro || "",
        camisa: v.camisa || "", isentoManual: !!v.isentoManual,
        formaPagamento: v.formaPagamento || null, totalPago: v.totalPago || 0,
        inscritoEm: serverTimestamp(),
      }]);
    });

    posSnap.docs.forEach(d => escritas.push([P.posicao(eid, d.id), d.data()]));
    ensSnap.docs.forEach(d => escritas.push([P.ensaio(eid, d.id), d.data()]));
    musSnap.docs.forEach(d => escritas.push([P.musica(eid, d.id), d.data()]));
    if (precoSnap.exists()) escritas.push([P.precos(eid), precoSnap.data()]);
    presSnap.docs.forEach(d => escritas.push([P.presenca(eid, d.id), d.data()]));

    try {
      await gravarEmBlocos(escritas);
    } catch (err) {
      // Apagar o documento da edição desfaz a marca "já importada", deixando o
      // admin tentar de novo depois de resolver a causa. O que já tiver entrado
      // nas subcoleções é reescrito por cima na próxima tentativa, porque o id
      // da edição volta a ficar livre.
      await deleteDoc(P.edicao(eid)).catch(() => {});
      alert("A importação não foi concluída: " + friendlyFirestoreError(err) + "\n\nNada ficou valendo — pode tentar de novo.");
      return;
    }

    session.edicaoId = eid;
    ensureEdicaoListeners();
    showToast(`Dados importados para o ${nomeEdicao}!`);
    go("admin");
  } catch (err) {
    alert("Não foi possível importar: " + friendlyFirestoreError(err));
  }
}

/* Cada pessoa leva os próprios comprovantes de pagamento para a edição migrada
   na primeira vez que entra depois da migração — as regras só permitem que o
   dono leia os próprios pagamentos, então isso não pode ser feito pelo admin. */
async function migrarMeusPagamentos(eid) {
  if (!fbUser) return;
  try {
    const antigos = await getDocs(query(collection(db, "pagamentos"), where("uid", "==", fbUser.uid)));
    if (antigos.docs.length === 0) return;
    const jaMigrados = await getDocs(query(P.pagamentos(eid), where("uid", "==", fbUser.uid)));
    if (jaMigrados.docs.length > 0) return;
    // As regras exigem valor numérico e positivo em cada comprovante. Um único
    // lançamento antigo com valor em texto ("150,00") ou zerado faria o
    // Firestore recusar o LOTE INTEIRO — e a pessoa ficaria com o total
    // importado e nenhum comprovante na tela, sem ninguém perceber, porque o
    // erro só vai para o console. Por isso o valor é normalizado aqui e o que
    // não puder virar número positivo é deixado de fora, com aviso.
    const paraNumero = v => {
      if (typeof v === "number") return v;
      const n = parseFloat(String(v == null ? "" : v).replace(/\./g, "").replace(",", "."));
      return isNaN(n) ? 0 : n;
    };
    const validos = [], invalidos = [];
    antigos.docs.forEach(d => {
      const dados = { ...d.data(), valor: paraNumero(d.data().valor) };
      (dados.valor > 0 ? validos : invalidos).push({ id: d.id, dados });
    });
    if (invalidos.length) console.warn("comprovantes antigos sem valor válido, não migrados:", invalidos.map(x => x.id));
    if (validos.length === 0) return;
    const batch = writeBatch(db);
    validos.forEach(({ id, dados }) => batch.set(doc(P.pagamentos(eid), id), dados));
    await batch.commit();
  } catch (err) {
    console.warn("migração de pagamentos própria não realizada:", err);
  }
}

/* ============================================================
   EVENTOS
   ============================================================ */
function wireEvents() {
  // LANDING
  on("#btn-goto-register", "click", () => { session.draftUser = {}; go("register1"); });
  on("#btn-goto-login", "click", () => go("login"));
  // O e-mail digitado fica na sessão para não se perder quando um erro de
  // validação redesenha a tela. Senhas nunca são guardadas.
  on("#log-email", "input", e => { session.emailDigitado = e.target.value; });
  on("#reg-email", "input", e => { session.emailDigitado = e.target.value; });
  on("#back-to-landing", "click", () => go("landing"));
  on("#back-to-landing2", "click", () => go("landing"));
  on("#goto-register-from-login", "click", () => { session.draftUser = {}; go("register1"); });

  // REGISTER STEP 1 — cria a conta no Firebase Auth
  on("#form-register1", "submit", async e => {
    e.preventDefault();
    const email = $("#reg-email").value.trim().toLowerCase();
    const senha = $("#reg-senha").value;
    const senha2 = $("#reg-senha2").value;
    if (senha.length < 6) { session.errors.register1 = "A senha precisa ter pelo menos 6 caracteres."; render(); return; }
    if (senha !== senha2) { session.errors.register1 = "As senhas não coincidem."; render(); return; }
    session.busy.register1 = true; render();
    try {
      await createUserWithEmailAndPassword(auth, email, senha);
      session.errors.register1 = null;
      session.draftUser = { email };
    } catch (err) {
      session.errors.register1 = friendlyAuthError(err);
    }
    session.busy.register1 = false;
    render();
  });

  // REGISTER STEP 2 — cria só /pessoas/{uid}, com os dados que valem para sempre.
  // A participação em um carnaval específico é o passo seguinte, na tela de
  // inscrição. Cada campo alterado atualiza o rascunho local (session.draftUser)
  // para que um redesenho em segundo plano não apague o que já foi preenchido.
  Object.entries({ "c-nome": "nome", "c-sobrenome": "sobrenome", "c-apelido": "apelido", "c-celular": "celular" })
    .forEach(([id, campo]) => { on(`#${id}`, "input", e => { draftUser()[campo] = e.target.value; }); });
  ["c-datanasc-dia", "c-datanasc-mes", "c-datanasc-ano"].forEach(id => {
    on(`#${id}`, "change", () => { draftUser().dataNascimento = lerDataNascimento("c-datanasc"); });
  });
  on("#form-register2", "submit", async e => {
    e.preventDefault();
    const dataNascimento = lerDataNascimento("c-datanasc");
    if (!dataNascimento) { session.errors.register2 = "Preencha dia, mês e ano de nascimento."; render(); return; }
    const pessoa = {
      email: fbUser.email,
      nome: $("#c-nome").value.trim(), sobrenome: $("#c-sobrenome").value.trim(),
      apelido: $("#c-apelido").value.trim(),
      adminAccess: false, presencaAccess: false,
      criadoEm: serverTimestamp(),
    };
    // Celular e nascimento vão para /contatos, que só o dono e a organização
    // leem. Em /pessoas eles apareceriam para qualquer pessoa logada.
    const contato = { celular: $("#c-celular").value.trim(), dataNascimento };
    session.busy.register2 = true; render();
    try {
      const batch = writeBatch(db);
      batch.set(P.pessoa(fbUser.uid), pessoa);
      batch.set(P.contato(fbUser.uid), contato);
      await batch.commit();
      session.errors.register2 = null;
      // Marca que a próxima tela (inscrição) é a continuação do cadastro, e não a
      // renovação anual de quem já é da bateria — muda só o texto e os passinhos.
      session.acabouDeCadastrar = !!edicaoAberta();
      session.view = "batuqueiro";
    } catch (err) {
      session.errors.register2 = friendlyFirestoreError(err);
    }
    session.busy.register2 = false;
    render();
  });

  // CONFIRMAÇÃO DE INSCRIÇÃO NUMA EDIÇÃO
  // Cada campo alterado também atualiza o rascunho local (session.draftInscricao),
  // sem chamar render(). É o mesmo cuidado usado nas telas de posições e músicas:
  // se algo redesenhar a tela enquanto a pessoa preenche (por exemplo, outro
  // batuqueiro se inscrevendo naquele instante, o que chega em tempo real), o que
  // ela já escolheu não é perdido.
  on("#insc-posicao", "change", e => {
    $("#insc-wrap-posicao-outro").style.display = e.target.value === "Outro" ? "block" : "none";
    draftInscricao().posicao = e.target.value;
  });
  on("#insc-posicao-outro", "input", e => { draftInscricao().posicaoOutro = e.target.value; });
  onAll("#insc-radio-vaitocar .radio-pill", "click", el => {
    $("#insc-radio-vaitocar").querySelectorAll(".radio-pill").forEach(x => x.classList.remove("active"));
    el.classList.add("active");
    draftInscricao().vaiTocar = el.dataset.val;
  });
  onAll("#insc-radio-camisa .radio-pill", "click", el => {
    $("#insc-radio-camisa").querySelectorAll(".radio-pill").forEach(x => x.classList.remove("active"));
    el.classList.add("active");
    draftInscricao().camisa = el.dataset.val;
  });
  on("#form-inscricao", "submit", async e => {
    e.preventDefault();
    const ed = edicaoCtx();
    const vaiTocar = $("#insc-radio-vaitocar .radio-pill.active")?.dataset.val;
    const camisa = $("#insc-radio-camisa .radio-pill.active")?.dataset.val;
    if (!vaiTocar || !camisa) { session.errors.inscricao = "Preencha se vai tocar neste carnaval e o tamanho da camisa."; render(); return; }
    session.busy.inscricao = true; render();
    try {
      const dadosDoAno = {
        vaiTocar, posicao: $("#insc-posicao").value,
        posicaoOutro: $("#insc-posicao-outro") ? $("#insc-posicao-outro").value.trim() : "",
        camisa,
      };
      // Se a inscrição JÁ existe, este formulário só pode atualizar os dados do
      // ano — nunca reescrever o documento inteiro. Um setDoc completo zeraria
      // forma de pagamento e valor pago de quem já tinha pago, e essa tela chega
      // a aparecer por um instante durante o carregamento: bastava um clique
      // apressado ali para apagar o pagamento da pessoa.
      const jaEstavaInscrito = estouInscrito();
      if (jaEstavaInscrito) {
        await updateDoc(P.inscricao(ed.id, fbUser.uid), dadosDoAno);
      } else {
        await setDoc(P.inscricao(ed.id, fbUser.uid), {
          ...dadosDoAno, isentoManual: false, formaPagamento: null, totalPago: 0,
          inscritoEm: serverTimestamp(),
        });
      }
      // Se a pessoa já tinha comprovantes nesta edição (foi tirada e voltou, ou
      // o admin apagou a inscrição por engano), o total precisa voltar junto —
      // senão ela é cobrada de novo com os próprios comprovantes na tela.
      // A inscrição nasce com 0 porque as regras exigem isso; a soma entra numa
      // segunda escrita, que as regras aceitam por só aumentar o total.
      const jaPago = jaEstavaInscrito ? 0 : myPagamentos.reduce((soma, p) => soma + (p.valor || 0), 0);
      if (jaPago > 0) {
        try { await updateDoc(P.inscricao(ed.id, fbUser.uid), { totalPago: jaPago }); }
        catch (err) { console.warn("total já pago não pôde ser recomposto:", err); }
      }
      session.errors.inscricao = null;
      session.draftInscricao = null;
      session.draftInscricaoDeEdicao = null;
      session.acabouDeCadastrar = false;
      showToast(`Inscrição confirmada no ${edicaoLabel(ed)}!`);
    } catch (err) {
      session.errors.inscricao = friendlyFirestoreError(err);
    }
    session.busy.inscricao = false;
    render();
  });

  // LOGIN
  on("#form-login", "submit", async e => {
    e.preventDefault();
    const email = $("#log-email").value.trim().toLowerCase();
    const senha = $("#log-senha").value;
    session.busy.login = true; render();
    try {
      await signInWithEmailAndPassword(auth, email, senha);
      session.errors.login = null;
    } catch (err) {
      session.errors.login = friendlyAuthError(err);
    }
    session.busy.login = false;
    render();
  });
  on("#btn-forgot-password", "click", async () => {
    const email = ($("#log-email")?.value || "").trim().toLowerCase();
    if (!email) { alert("Digite seu e-mail no campo acima primeiro."); return; }
    try { await sendPasswordResetEmail(auth, email); showToast("Enviamos um e-mail para redefinir sua senha."); }
    catch (err) { alert(friendlyAuthError(err)); }
  });

  // HEADER / NAVEGAÇÃO
  on("#btn-logout", "click", async () => { await signOut(auth); go("landing"); });
  on("#btn-goto-admin", "click", () => go("admin"));
  on("#btn-back-batuqueiro", "click", () => go("batuqueiro"));
  on("#btn-goto-posicoes", "click", () => { session.posicoesDraft = null; go("admin-posicoes"); });
  on("#btn-back-admin", "click", () => { session.posicoesDraft = null; go("admin"); });
  on("#btn-goto-musicas", "click", () => { session.musicasDraft = null; go("admin-musicas"); });
  on("#btn-back-admin6", "click", () => { session.musicasDraft = null; go("admin"); });
  on("#btn-goto-pessoas", "click", () => go("admin-pessoas"));
  on("#btn-back-admin2", "click", () => go("admin"));
  on("#btn-goto-precos", "click", () => go("admin-precos"));
  on("#btn-back-admin3", "click", () => go("admin"));
  on("#btn-goto-ensaios", "click", () => go("admin-ensaios"));
  on("#btn-back-admin4", "click", () => go("admin"));
  on("#btn-goto-relatorio", "click", () => go("admin-relatorio"));
  on("#btn-back-admin5", "click", () => go("admin"));
  on("#btn-goto-edicoes", "click", () => go("admin-edicoes"));
  on("#btn-back-admin7", "click", () => { session.novaEdicaoAberta = false; go("admin"); });
  on("#btn-goto-historico-geral", "click", () => { go("admin-historico"); if (!session.histGeral) carregarHistoricoGeral(); });
  on("#btn-back-admin8", "click", () => go("admin"));
  on("#btn-recarregar-historico", "click", () => carregarHistoricoGeral());

  // Filtro do histórico geral: filtra as linhas direto no DOM, sem chamar render().
  // Redesenhar a tela a cada tecla faria o campo perder o foco e o cursor — e o
  // termo fica guardado na sessão para o caso de a tela ser redesenhada por outro
  // motivo, de modo que o filtro sobrevive a isso também.
  on("#hist-filtro", "input", e => {
    const termo = e.target.value.trim().toLowerCase();
    session.histFiltro = e.target.value;
    ["hist-pessoas-tbody", "hist-musicas-tbody"].forEach(tbodyId => {
      document.querySelectorAll(`#${tbodyId} tr[data-hist-nome]`).forEach(tr => {
        tr.style.display = tr.dataset.histNome.includes(termo) ? "" : "none";
      });
    });
    atualizarRodapesHistorico();
  });
  on("#btn-voltar-edicao-aberta", "click", () => { const a = edicaoAberta(); if (a) trocarEdicaoCtx(a.id); });
  on("#admin-pessoas-filtro", "change", e => { session.adminPessoasFiltro = e.target.value; render(); });
  on("#btn-exportar-csv", "click", exportarCSV);
  on("#btn-exportar-xlsx", "click", exportarXLSX);
  on("#relatorio-filtro-status", "change", e => { session.relatorioFiltroStatus = e.target.value; render(); });
  on("#relatorio-filtro-posicao", "change", e => { session.relatorioFiltroPosicao = e.target.value; render(); });
  on("#relatorio-filtro-pago", "change", e => { session.relatorioFiltroPago = e.target.value; render(); });
  on("#relatorio-filtro-saldo", "change", e => { session.relatorioFiltroSaldo = e.target.value; render(); });
  on("#admin-troca-edicao", "change", e => trocarEdicaoCtx(e.target.value));

  // HISTÓRICO
  on("#btn-goto-historico", "click", () => { session.historico = null; go("historico"); carregarHistorico(); });
  on("#btn-back-from-historico", "click", () => go("batuqueiro"));

  // BATUQUEIRO — meus dados
  on("#btn-edit-data", "click", () => { session.editingMyData = true; render(); });
  on("#btn-cancel-edit", "click", () => { session.editingMyData = false; render(); });
  on("#e-posicao", "change", e => { $("#edit-wrap-posicao-outro").style.display = e.target.value === "Outro" ? "block" : "none"; });
  onAll("#edit-radio-vaitocar .radio-pill", "click", el => {
    $("#edit-radio-vaitocar").querySelectorAll(".radio-pill").forEach(x => x.classList.remove("active"));
    el.classList.add("active");
  });
  onAll("#edit-radio-camisa .radio-pill", "click", el => {
    $("#edit-radio-camisa").querySelectorAll(".radio-pill").forEach(x => x.classList.remove("active"));
    el.classList.add("active");
  });
  on("#form-edit-mydata", "submit", async e => {
    e.preventDefault();
    const u = perfilMesclado();
    const eid = edicaoCtxId();
    // Os dados permanentes vão para /pessoas; os que mudam a cada carnaval vão
    // para a inscrição daquela edição.
    const pessoaPatch = {
      nome: $("#e-nome").value.trim(), sobrenome: $("#e-sobrenome").value.trim(),
      apelido: $("#e-apelido").value.trim(),
      // zera o que possa ter sobrado do formato em que o contato ficava aqui:
      // salvar os próprios dados já limpa o vazamento para este cadastro.
      celular: "", dataNascimento: "",
    };
    const contatoPatch = {
      celular: $("#e-celular").value.trim(),
      dataNascimento: lerDataNascimento("e-datanasc") || u.dataNascimento,
    };
    const inscricaoPatch = {
      vaiTocar: $("#edit-radio-vaitocar .radio-pill.active")?.dataset.val || u.vaiTocar,
      posicao: $("#e-posicao").value,
      posicaoOutro: $("#e-posicao-outro") ? $("#e-posicao-outro").value.trim() : "",
      camisa: $("#edit-radio-camisa .radio-pill.active")?.dataset.val || u.camisa,
    };
    try {
      const batch = writeBatch(db);
      if (myPessoa) {
        batch.update(P.pessoa(fbUser.uid), pessoaPatch);
      } else {
        // Cadastro ainda só no formato antigo: um update falharia por não existir
        // documento. Cria o registro novo já preservando os acessos do antigo.
        batch.set(P.pessoa(fbUser.uid), {
          ...pessoaPatch,
          email: (myLegado && myLegado.email) || fbUser.email,
          adminAccess: !!(myLegado && myLegado.adminAccess),
          // As regras só deixam alguém criar o PRÓPRIO cadastro sem privilégios
          // (é o que impede autopromoção). Copiar presencaAccess do formato
          // antigo aqui fazia o Firestore recusar a gravação inteira, e quem
          // tinha só esse acesso não conseguia salvar "Meus dados" antes da
          // importação. Não se perde nada: até importar, o acesso continua
          // valendo pelo cadastro antigo (nas regras e no app), e a importação
          // grava o valor definitivo.
          presencaAccess: souAdmin() ? !!(myLegado && myLegado.presencaAccess) : false,
          criadoEm: serverTimestamp(),
        });
      }
      batch.set(P.contato(fbUser.uid), contatoPatch, { merge: true });
      if (eid && estouInscrito()) batch.update(P.inscricao(eid, fbUser.uid), inscricaoPatch);
      await batch.commit();
      session.editingMyData = false;
    } catch (err) { alert(friendlyFirestoreError(err)); }
    render();
  });

  // BATUQUEIRO — escolha / troca de forma de pagamento
  onAll("#plan-picker .plan-pill", "click", async el => {
    const eid = edicaoCtxId();
    try { await updateDoc(P.inscricao(eid, fbUser.uid), { formaPagamento: el.dataset.plano }); }
    catch (err) { alert(friendlyFirestoreError(err)); }
  });
  on("#btn-change-plan", "click", async () => {
    // Segunda barreira, além de o botão nem ser desenhado nesse caso: trocar de
    // plano depois de já ter pago mudaria o valor devido deixando o pagamento
    // registrado no ar.
    if (totalPago(perfilMesclado()) > 0) {
      alert("Você já registrou um pagamento nesta forma de pagamento, então ela não pode mais ser trocada.");
      return;
    }
    if (!confirm("Alterar a forma de pagamento? O valor total devido será recalculado.")) return;
    const eid = edicaoCtxId();
    try { await updateDoc(P.inscricao(eid, fbUser.uid), { formaPagamento: null }); }
    catch (err) { alert(friendlyFirestoreError(err)); }
  });

  // BATUQUEIRO — pagamento
  on("#btn-copiar-pix", "click", async () => {
    const valor = chavePixDaEdicao();
    try {
      await navigator.clipboard.writeText(valor);
      showToast("Chave Pix copiada!");
    } catch {
      // Navegador sem permissão de área de transferência (acontece em alguns
      // celulares): mostra a chave para copiar à mão em vez de falhar calado.
      alert("Copie a chave Pix:\n\n" + valor);
    }
  });
  on("#btn-toggle-addpay", "click", () => {
    session.addPayOpenFor = session.addPayOpenFor === fbUser.uid ? null : fbUser.uid;
    render();
  });
  on("#btn-save-pay", "click", async (ev) => {
    const data = $("#pay-data").value, valor = parseFloat($("#pay-valor").value);
    // O campo guarda o NOME de quem fez o Pix (nem sempre é a própria pessoa —
    // muita gente paga da conta do cônjuge ou de um parente). É por esse nome
    // que a organização acha o lançamento no extrato do bloco, então vazio não
    // serve: sem ele o pagamento fica sem como ser conferido. A chave do campo
    // no banco continua "pix" para não invalidar os registros que já existem.
    const pix = $("#pay-pix").value.trim() || fullName(perfilMesclado());
    if (!data || !valor || valor <= 0) { alert("Preencha data e valor do pagamento."); return; }
    if (!pix) { alert("Diga o nome de quem fez o Pix — é por ele que a organização acha o pagamento no extrato."); return; }
    // Sem esta trava, dois toques rápidos (fácil no celular) gravavam DOIS
    // comprovantes e somavam o valor duas vezes no total. As regras proíbem
    // apagar ou editar pagamento, então o estrago só sairia no console do
    // Firebase. O botão volta ao normal no render() do fim.
    if (session.salvandoPagamento) return;
    session.salvandoPagamento = true;
    if (ev && ev.target) { ev.target.disabled = true; ev.target.textContent = "Salvando..."; }
    const eid = edicaoCtxId();
    try {
      const batch = writeBatch(db);
      const payRef = doc(P.pagamentos(eid));
      batch.set(payRef, { uid: fbUser.uid, data, valor, pix, createdAt: serverTimestamp() });
      batch.update(P.inscricao(eid, fbUser.uid), { totalPago: increment(valor) });
      await batch.commit();
      session.addPayOpenFor = null;
    } catch (err) { alert("Não foi possível salvar o pagamento: " + friendlyFirestoreError(err)); }
    session.salvandoPagamento = false;
    render();
  });

  /* ---------- ADMIN: comprovantes de outra pessoa ---------- */
  // Carregados sob demanda, num clique explícito: são dados financeiros de
  // terceiro, e abrir a lista de todo mundo junto com a tela seria varrer o
  // banco inteiro sem ninguém ter pedido.
  onAll("[data-ver-pagamentos]", "click", async el => {
    const uid = el.dataset.verPagamentos;
    session.pagsDoEditadoBusy = true; render();
    try {
      const snap = await getDocs(query(P.pagamentos(edicaoCtxId()), where("uid", "==", uid)));
      session.pagsDoEditado = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.data || "").localeCompare(b.data || ""));
      session.pagsDoEditadoDe = uid;
    } catch (err) { alert(friendlyFirestoreError(err)); }
    session.pagsDoEditadoBusy = false;
    render();
  });

  /* Relê os comprovantes do banco depois de cada mudança, para a tela e a soma
     não ficarem contando com o que estava em memória antes da gravação. */
  const recarregarPagsDoEditado = async (uid) => {
    const snap = await getDocs(query(P.pagamentos(edicaoCtxId()), where("uid", "==", uid)));
    session.pagsDoEditado = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.data || "").localeCompare(b.data || ""));
    session.pagsDoEditadoDe = uid;
  };

  /* O total é sempre ajustado pela DIFERENÇA, nunca refeito pela soma dos
     comprovantes: parte do total pode ter vindo da importação do formato antigo,
     sem comprovante atrás, e refazer a soma apagaria esse valor em silêncio.
     Quem decide acertar os dois é o admin, no botão de recalcular. */
  const ajustarTotal = async (uid, delta) => {
    const pessoa = batuqueirosDaEdicao().find(x => x.id === uid);
    const novo = Math.max(0, totalPago(pessoa || {}) + delta);
    await updateDoc(P.inscricao(edicaoCtxId(), uid), { totalPago: novo });
  };

  onAll("[data-salvar-pag]", "click", async el => {
    const id = el.dataset.salvarPag, uid = el.dataset.dono;
    const original = (session.pagsDoEditado || []).find(x => x.id === id);
    if (!original) return;
    const data = $(`.pg-data[data-pag-id="${id}"]`).value;
    const pagador = $(`.pg-pagador[data-pag-id="${id}"]`).value.trim();
    const valor = parseFloat($(`.pg-valor[data-pag-id="${id}"]`).value);
    if (!data || !(valor > 0)) { alert("Preencha a data e um valor maior que zero."); return; }
    try {
      await updateDoc(doc(P.pagamentos(edicaoCtxId()), id), { data, valor, pix: pagador, uid: original.uid });
      await ajustarTotal(uid, valor - (original.valor || 0));
      await recarregarPagsDoEditado(uid);
      showToast("Pagamento corrigido.");
    } catch (err) { alert(friendlyFirestoreError(err)); }
    render();
  });

  onAll("[data-remover-pag]", "click", async el => {
    const id = el.dataset.removerPag, uid = el.dataset.dono;
    const pag = (session.pagsDoEditado || []).find(x => x.id === id);
    if (!pag) return;
    if (!confirm(`Remover o lançamento de ${currency(pag.valor)} do dia ${dateBR(pag.data)}?\n\nO valor sai do total desta pessoa e ela volta a ser cobrada por ele.`)) return;
    try {
      await deleteDoc(doc(P.pagamentos(edicaoCtxId()), id));
      await ajustarTotal(uid, -(pag.valor || 0));
      await recarregarPagsDoEditado(uid);
      showToast("Lançamento removido.");
    } catch (err) { alert(friendlyFirestoreError(err)); }
    render();
  });

  onAll("[data-add-pag]", "click", async el => {
    const uid = el.dataset.addPag;
    const pessoa = batuqueirosDaEdicao().find(x => x.id === uid);
    const data = $(`#novo-pag-data-${uid}`).value;
    const valor = parseFloat($(`#novo-pag-valor-${uid}`).value);
    const pagador = $(`#novo-pag-pagador-${uid}`).value.trim() || fullName(pessoa || {});
    if (!data || !(valor > 0)) { alert("Preencha a data e um valor maior que zero."); return; }
    try {
      await setDoc(doc(P.pagamentos(edicaoCtxId())), {
        uid, data, valor, pix: pagador, createdAt: serverTimestamp(), lancadoPelaOrganizacao: true,
      });
      await ajustarTotal(uid, valor);
      await recarregarPagsDoEditado(uid);
      showToast("Pagamento lançado.");
    } catch (err) { alert(friendlyFirestoreError(err)); }
    render();
  });

  onAll("[data-recalcular-total]", "click", async el => {
    const uid = el.dataset.recalcularTotal;
    const soma = (session.pagsDoEditado || []).reduce((s, x) => s + (x.valor || 0), 0);
    const pessoa = batuqueirosDaEdicao().find(x => x.id === uid);
    if (!confirm(`Acertar o total de ${fullName(pessoa || {})} de ${currency(totalPago(pessoa || {}))} para ${currency(soma)}?\n\nIsso descarta qualquer valor que esteja no total sem comprovante lançado aqui — normalmente resíduo da importação do site antigo. Não dá para desfazer pelo site.`)) return;
    try {
      await updateDoc(P.inscricao(edicaoCtxId(), uid), { totalPago: soma });
      showToast("Total acertado pela soma dos comprovantes.");
    } catch (err) { alert(friendlyFirestoreError(err)); }
    render();
  });

  // Remover um lançamento próprio. É a única saída de quem digitou o valor ou a
  // data errada: o comprovante não pode ser editado (mudaria um registro por
  // baixo), e a organização não consegue nem ler o comprovante alheio para
  // corrigir. Apagar só reduz o que a própria pessoa declarou ter pago, então
  // não abre brecha para ninguém.
  onAll("[data-remove-pay]", "click", async el => {
    const id = el.dataset.removePay;
    const pag = myPagamentos.find(p => p.id === id);
    if (!pag) return;
    if (!confirm(`Remover o lançamento de ${currency(pag.valor)} do dia ${dateBR(pag.data)}?\n\nEsse valor sai da sua conta e volta a ser cobrado. Se foi só um erro de digitação, remova e registre de novo com os dados certos.`)) return;
    const eid = edicaoCtxId();
    const u = perfilMesclado();
    try {
      const batch = writeBatch(db);
      batch.delete(doc(P.pagamentos(eid), id));
      // Calculado aqui, e não com increment(-valor), para nunca deixar o total
      // negativo caso ele e os comprovantes estejam fora de sincronia (o total
      // pode ter vindo da importação do formato antigo, sem comprovante atrás).
      batch.update(P.inscricao(eid, fbUser.uid), { totalPago: Math.max(0, totalPago(u) - (pag.valor || 0)) });
      await batch.commit();
      showToast("Lançamento removido.");
    } catch (err) { alert(friendlyFirestoreError(err)); }
    render();
  });

  on("#presenca-filtro-posicao", "change", e => { session.presencaFiltro = e.target.value; render(); });
  on("#presenca-filtro-ensaio", "change", e => { session.presencaEnsaioFiltro = e.target.value; render(); });

  // BATUQUEIRO — presença (só quem tem acesso — admin ou presencaAccess — pode alterar; os
  // demais só veem a tabela, o próprio HTML nem gera o toggle clicável para eles, mas o
  // guard abaixo é uma segunda camada de proteção do lado do cliente).
  onAll(".toggle", "click", async el => {
    const u = perfilMesclado();
    const ed = edicaoCtx();
    if (!souEditorDePresenca() || !edicaoEditavel(ed)) return;
    const targetUid = el.dataset.uid, eid = el.dataset.eid;
    // O valor atual vem do cache, que só é atualizado pelo snapshot seguinte.
    // Dois cliques rápidos na mesma célula liam o mesmo "atual" e gravavam o
    // mesmo valor duas vezes — o segundo clique não desfazia o primeiro e a
    // célula parecia travada. A chave em voo segura o segundo clique.
    const chave = `${eid}_${targetUid}`;
    if (presencasEmVoo.has(chave)) return;
    presencasEmVoo.add(chave);
    const atual = !!(presencasCache[targetUid] && presencasCache[targetUid][eid]);
    try {
      await setDoc(P.presenca(ed.id, chave), {
        ensaioId: eid, uid: targetUid, presente: !atual,
        updatedAt: serverTimestamp(), updatedBy: fbUser.uid,
      });
    } catch (err) { alert("Não foi possível salvar a presença: " + friendlyFirestoreError(err)); }
    finally { presencasEmVoo.delete(chave); }
  });

  // ADMIN — edições
  on("#btn-toggle-nova-edicao", "click", () => {
    session.novaEdicaoAberta = !session.novaEdicaoAberta;
    if (!session.novaEdicaoAberta) { session.novaEdicaoAno = null; session.novaEdicaoNome = ""; session.novaEdicaoData = ""; }
    render();
  });
  // Mesmo cuidado dos demais formulários: o que já foi digitado fica guardado
  // fora do DOM, para não se perder se a tela for redesenhada no meio.
  on("#nova-edicao-ano", "input", e => { session.novaEdicaoAno = e.target.value; });
  on("#nova-edicao-nome", "input", e => { session.novaEdicaoNome = e.target.value; });
  ["nova-edicao-data-dia", "nova-edicao-data-mes", "nova-edicao-data-ano"].forEach(id => {
    on(`#${id}`, "change", () => { session.novaEdicaoData = lerDataNascimento("nova-edicao-data"); });
  });
  on("#btn-criar-edicao", "click", async () => {
    const ano = parseInt($("#nova-edicao-ano").value, 10);
    if (!ano || ano < 2024 || ano > 2100) { alert("Informe um ano válido."); return; }
    const nome = ($("#nova-edicao-nome").value || "").trim() || `Carnaval do Fogo e Paixão ${ano}`;
    const dataDoCarnaval = lerDataNascimento("nova-edicao-data");
    const copiar = $("#nova-edicao-copiar") ? $("#nova-edicao-copiar").checked : false;
    const eid = proximoEdicaoId(ano);
    const anterior = edicoesOrdenadas()[0];
    try {
      // A edição é criada e confirmada primeiro; só depois se copia o conteúdo
      // para dentro dela. As regras de segurança das subcoleções consultam o
      // status da edição, e o Firestore avalia cada escrita de um lote contra o
      // estado anterior ao lote — no mesmo lote, essa consulta cairia num
      // documento que ainda não existe e a cópia inteira seria negada.
      await setDoc(P.edicao(eid), { ano, nome, dataDoCarnaval, status: "preparando", criadaEm: serverTimestamp() });
      session.novaEdicaoAberta = false;
      session.novaEdicaoAno = null; session.novaEdicaoNome = ""; session.novaEdicaoData = "";
      trocarEdicaoCtx(eid);

      if (copiar && anterior) {
        try {
          const [posSnap, precoSnap] = await Promise.all([getDocs(P.posicoes(anterior.id)), getDoc(P.precos(anterior.id))]);
          const batch = writeBatch(db);
          posSnap.docs.forEach(d => batch.set(doc(P.posicoes(eid), d.id), d.data()));
          if (precoSnap.exists()) batch.set(P.precos(eid), precoSnap.data());
          await batch.commit();
        } catch (err) {
          alert(`A edição "${nome}" foi criada, mas não foi possível copiar as posições e os valores do ${edicaoLabel(anterior)}: ${friendlyFirestoreError(err)}\n\nVocê pode cadastrá-los manualmente ou usar o botão de carregar os padrões.`);
          return;
        }
      }
      showToast(`${nome} criada! Ela está em preparação — só você a vê por enquanto.`);
    } catch (err) { alert(friendlyFirestoreError(err)); }
  });
  onAll("[data-save-edicao]", "click", async el => {
    const id = el.dataset.saveEdicao;
    const input = document.querySelector(`.edicao-data-input[data-edicao-id="${id}"]`);
    try { await updateDoc(P.edicao(id), { dataDoCarnaval: input.value || "" }); showToast("Data do desfile atualizada."); }
    catch (err) { alert(friendlyFirestoreError(err)); }
  });
  onAll("[data-ver-edicao]", "click", el => trocarEdicaoCtx(el.dataset.verEdicao));
  onAll("[data-abrir-edicao]", "click", async el => {
    const id = el.dataset.abrirEdicao;
    const aberta = edicaoAberta();
    const msg = aberta && aberta.id !== id
      ? `Abrir esta edição para os batuqueiros?\n\nO ${edicaoLabel(aberta)}, que está aberto agora, será encerrado automaticamente e virará histórico.`
      : "Abrir esta edição para os batuqueiros? A partir de agora eles verão e preencherão os dados dela.";
    if (!confirm(msg)) return;
    try {
      const batch = writeBatch(db);
      if (aberta && aberta.id !== id) batch.update(P.edicao(aberta.id), { status: "encerrada", encerradaEm: serverTimestamp() });
      batch.update(P.edicao(id), { status: "aberta", abertaEm: serverTimestamp() });
      await batch.commit();
      trocarEdicaoCtx(id);
      showToast("Edição aberta para os batuqueiros!");
    } catch (err) { alert(friendlyFirestoreError(err)); }
  });
  onAll("[data-encerrar-edicao]", "click", async el => {
    if (!confirm("Encerrar esta edição?\n\nEla vira histórico: ninguém mais edita nada nela, nem você. Dá para reabrir depois, se precisar corrigir algo.")) return;
    try { await updateDoc(P.edicao(el.dataset.encerrarEdicao), { status: "encerrada", encerradaEm: serverTimestamp() }); showToast("Edição encerrada."); }
    catch (err) { alert(friendlyFirestoreError(err)); }
  });
  onAll("[data-reabrir-edicao]", "click", async el => {
    const id = el.dataset.reabrirEdicao;
    if (!confirm("Reabrir esta edição para correções?\n\nEla volta ao estado \"em preparação\" (visível só para você). Para os batuqueiros voltarem a usá-la, é preciso abri-la de novo.")) return;
    try { await updateDoc(P.edicao(id), { status: "preparando" }); showToast("Edição reaberta em modo de preparação."); }
    catch (err) { alert(friendlyFirestoreError(err)); }
  });
  on("#btn-migrar-legado", "click", migrarDoFormatoAntigo);
  on("#btn-separar-contatos", "click", separarContatos);
  on("#btn-backup", "click", baixarBackup);

  // ADMIN — seed de dados iniciais da edição
  on("#btn-seed-defaults", "click", async () => {
    const eid = edicaoCtxId();
    if (posicoesCache.length > 0 || precosCache) {
      alert("Esta edição já tem posições ou valores cadastrados — não vou carregar os padrões por cima.");
      return;
    }
    try {
      const batch = writeBatch(db);
      DEFAULT_POSICOES.forEach(p => { batch.set(doc(P.posicoes(eid)), p); });
      batch.set(P.precos(eid), DEFAULT_PRECOS);
      await batch.commit();
      showToast("Posições e valores padrão carregados!");
    } catch (err) { alert(friendlyFirestoreError(err)); }
  });

  // ADMIN — ensaios
  on("#btn-add-ensaio", "click", async () => {
    const val = $("#new-ensaio-data").value;
    if (!val) return;
    try { await addDoc(P.ensaios(edicaoCtxId()), { data: val, createdAt: serverTimestamp() }); }
    catch (err) { alert(friendlyFirestoreError(err)); }
  });
  // A data do ensaio grava sozinha quando muda. Antes dependia do botão
  // "Salvar" de cada linha — e como um redesenho em segundo plano repõe no campo
  // o que foi digitado, a tela continuava exibindo a data nova mesmo sem ter
  // salvado nada. O admin achava que tinha atualizado; os batuqueiros seguiam
  // vendo as datas antigas, porque a tela deles lê o banco.
  onAll(".ensaio-data-input", "change", async el => {
    const id = el.dataset.ensaioId, nova = el.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nova)) return;   // data incompleta: espera terminar
    const atual = ensaiosCache.find(x => x.id === id);
    if (atual && atual.data === nova) return;
    try {
      await updateDoc(P.ensaio(edicaoCtxId(), id), { data: nova });
      showToast(`Ensaio movido para ${dateBR(nova)}.`);
    } catch (err) { alert(friendlyFirestoreError(err)); }
  });

  onAll("[data-remove-ensaio]", "click", async el => {
    try { await deleteDoc(P.ensaio(edicaoCtxId(), el.dataset.removeEnsaio)); }
    catch (err) { alert(friendlyFirestoreError(err)); }
  });

  // ADMIN — músicas ensaiadas em cada ensaio (abre um editor por ensaio;
  // os checkboxes só mexem no rascunho local, sem render(), para não perder
  // as marcações se algo mais causar um redesenho da tela antes de salvar).
  onAll("[data-toggle-musicas-ensaio]", "click", el => {
    const id = el.dataset.toggleMusicasEnsaio;
    if (session.ensaioMusicasAberto === id) {
      session.ensaioMusicasAberto = null;
      session.ensaioMusicasDraft = null;
    } else {
      const e = ensaiosCache.find(x => x.id === id);
      session.ensaioMusicasAberto = id;
      session.ensaioMusicasDraft = [...((e && e.musicaIds) || [])];
    }
    render();
  });
  onAll(".musica-ensaio-check", "change", el => {
    if (!session.ensaioMusicasDraft) session.ensaioMusicasDraft = [];
    const id = el.dataset.musicaId;
    if (el.checked) {
      if (!session.ensaioMusicasDraft.includes(id)) session.ensaioMusicasDraft.push(id);
    } else {
      session.ensaioMusicasDraft = session.ensaioMusicasDraft.filter(x => x !== id);
    }
  });
  onAll("[data-cancel-musicas-ensaio]", "click", () => {
    session.ensaioMusicasAberto = null;
    session.ensaioMusicasDraft = null;
    render();
  });
  onAll("[data-save-musicas-ensaio]", "click", async el => {
    const id = el.dataset.saveMusicasEnsaio;
    const musicaIds = session.ensaioMusicasDraft || [];
    try {
      await updateDoc(P.ensaio(edicaoCtxId(), id), { musicaIds });
      session.ensaioMusicasAberto = null;
      session.ensaioMusicasDraft = null;
      showToast("Músicas do ensaio salvas!");
    } catch (err) { alert(friendlyFirestoreError(err)); }
  });

  // ADMIN — valores/prazos
  on("#btn-save-precos", "click", async () => {
    const novo = { avista: {}, duasVezes: {}, tresVezes: {} };
    novo.chavePix = ($("#admin-chave-pix")?.value || "").trim();
    // Valor zerado não pode ser salvo: com ele, "0 pago de 0" aparecia como
    // QUITADO para a bateria inteira e a adimplência do painel ia a 100%.
    const semValor = Object.keys(PLANOS).filter(k => {
      const digitado = parseFloat($(`#admin-preco-${k}`).value);
      return !(digitado > 0) && !(precosCache?.[k]?.valor > 0);
    });
    if (semValor.length) {
      alert(`Preencha o valor de: ${semValor.map(k => PLANOS[k].label).join(", ")}.\n\nUm plano sem valor faz todo mundo aparecer como quitado sem ter pago nada.`);
      return;
    }
    Object.keys(PLANOS).forEach(k => {
      const valor = parseFloat($(`#admin-preco-${k}`).value);
      novo[k].valor = valor > 0 ? valor : (precosCache?.[k]?.valor || 0);
      const prazos = [];
      for (let i = 0; i < PLANOS[k].parcelas; i++) {
        const el = $(`#admin-prazo-${k}-${i}`);
        prazos.push(el.value || precosCache?.[k]?.prazos?.[i] || "");
      }
      novo[k].prazos = prazos;
    });
    try { await setDoc(P.precos(edicaoCtxId()), novo, { merge: true }); showToast("Valores salvos."); }
    catch (err) { alert(friendlyFirestoreError(err)); }
  });

  // ADMIN — posições/instrumentos
  // Os campos de nome/isenção só atualizam o rascunho local (session.posicoesDraft),
  // sem chamar render() — assim o que foi digitado não é perdido se a tela for
  // redesenhada por outro motivo enquanto o admin ainda está editando.
  onAll(".pos-name-input", "input", el => {
    const row = session.posicoesDraft && session.posicoesDraft.find(p => p.id === el.dataset.posId);
    if (row) row.nome = el.value;
  });
  onAll(".pos-isenta-input", "change", el => {
    const row = session.posicoesDraft && session.posicoesDraft.find(p => p.id === el.dataset.posId);
    if (row) row.isenta = el.checked;
  });

  on("#btn-add-posicao", "click", async () => {
    const nome = $("#new-posicao-nome").value.trim();
    if (!nome) return;
    // O rascunho também entra na checagem: ele é atualizado na hora, enquanto o
    // cache só chega no snapshot seguinte — dois cliques rápidos passavam pela
    // validação e cadastravam a mesma posição duas vezes.
    const jaExiste = arr => (arr || []).some(p => (p.nome || "").toLowerCase() === nome.toLowerCase());
    if (jaExiste(posicoesCache) || jaExiste(session.posicoesDraft)) { alert("Essa posição já existe."); return; }
    const isenta = $("#new-posicao-isenta").checked;
    try {
      const ref = await addDoc(P.posicoes(edicaoCtxId()), { nome, isenta });
      if (session.posicoesDraft) {
        session.posicoesDraft = ordenarPosicoesAlfabetica([...session.posicoesDraft, { id: ref.id, nome, isenta }]);
      }
      render();
    } catch (err) { alert(friendlyFirestoreError(err)); }
  });

  on("#btn-save-all-posicoes", "click", async () => {
    const eid = edicaoCtxId();
    const draft = session.posicoesDraft || [];
    for (const row of draft) {
      row.nome = (row.nome || "").trim();
      if (!row.nome) { alert("O nome da posição não pode ficar vazio."); return; }
    }
    const nomesMinusculos = draft.map(r => r.nome.toLowerCase());
    const duplicado = nomesMinusculos.find((n, i) => nomesMinusculos.indexOf(n) !== i);
    if (duplicado) { alert(`Existe mais de uma posição chamada "${duplicado}". Ajuste os nomes antes de salvar.`); return; }
    try {
      const batch = writeBatch(db);
      let algumaMudanca = false;
      draft.forEach(row => {
        const original = posicoesCache.find(p => p.id === row.id);
        if (!original) return;
        const mudouNome = row.nome !== original.nome;
        const mudouIsenta = row.isenta !== !!original.isenta;
        if (!mudouNome && !mudouIsenta) return;
        algumaMudanca = true;
        batch.update(P.posicao(eid, row.id), { nome: row.nome, isenta: row.isenta });
        if (mudouNome) {
          // renomear a posição também atualiza quem está inscrito com ela NESTA edição
          inscricoesCache.filter(i => i.posicao === original.nome).forEach(i => { batch.update(P.inscricao(eid, i.id), { posicao: row.nome }); });
        }
      });
      if (!algumaMudanca) { showToast("Nenhuma alteração para salvar."); return; }
      await batch.commit();
      session.posicoesDraft = null;
      showToast("Posições salvas!");
    } catch (err) { alert(friendlyFirestoreError(err)); }
  });

  onAll("[data-remove-posicao]", "click", async el => {
    const id = el.dataset.removePosicao;
    const pos = posicoesCache.find(p => p.id === id);
    if (!pos) {
      // Alguém já removeu essa posição de outro navegador; tira da lista local.
      if (session.posicoesDraft) session.posicoesDraft = session.posicoesDraft.filter(p => p.id !== id);
      render();
      return;
    }
    const emUso = inscricoesCache.filter(i => i.posicao === pos.nome).length;
    if (emUso > 0 && !confirm(`${emUso} pessoa(s) estão inscritas com "${pos.nome}". Remover mesmo assim? Elas continuam com essa posição na inscrição, mas ela deixa de aparecer nas listas.`)) return;
    try {
      await deleteDoc(P.posicao(edicaoCtxId(), id));
      if (session.posicoesDraft) session.posicoesDraft = session.posicoesDraft.filter(p => p.id !== id);
      render();
    } catch (err) { alert(friendlyFirestoreError(err)); }
  });

  // ADMIN — repertório de músicas (mesmo padrão de rascunho local das posições)
  onAll(".musica-name-input", "input", el => {
    const row = session.musicasDraft && session.musicasDraft.find(m => m.id === el.dataset.musicaId);
    if (row) row.nome = el.value;
  });
  onAll(".musica-tom-input", "input", el => {
    const row = session.musicasDraft && session.musicasDraft.find(m => m.id === el.dataset.musicaId);
    if (row) row.tom = el.value;
  });
  onAll(".musica-cantor-input", "input", el => {
    const row = session.musicasDraft && session.musicasDraft.find(m => m.id === el.dataset.musicaId);
    if (row) row.cantor = el.value;
  });

  on("#btn-add-musica", "click", async () => {
    const nome = $("#new-musica-nome").value.trim();
    if (!nome) return;
    const jaNoRepertorio = arr => (arr || []).some(m => (m.nome || "").toLowerCase() === nome.toLowerCase());
    if (jaNoRepertorio(musicasCache) || jaNoRepertorio(session.musicasDraft)) { alert("Essa música já está cadastrada."); return; }
    const tom = $("#new-musica-tom").value.trim();
    const cantor = $("#new-musica-cantor").value.trim();
    try {
      const ref = await addDoc(P.musicas(edicaoCtxId()), { nome, tom, cantor });
      if (session.musicasDraft) {
        session.musicasDraft = ordenarMusicasAlfabetica([...session.musicasDraft, { id: ref.id, nome, tom, cantor }]);
      }
      render();
    } catch (err) { alert(friendlyFirestoreError(err)); }
  });

  on("#btn-save-all-musicas", "click", async () => {
    const eid = edicaoCtxId();
    const draft = session.musicasDraft || [];
    for (const row of draft) {
      row.nome = (row.nome || "").trim();
      if (!row.nome) { alert("O nome da música não pode ficar vazio."); return; }
    }
    const nomesMinusculos = draft.map(r => r.nome.toLowerCase());
    const duplicado = nomesMinusculos.find((n, i) => nomesMinusculos.indexOf(n) !== i);
    if (duplicado) { alert(`Existe mais de uma música chamada "${duplicado}". Ajuste os nomes antes de salvar.`); return; }
    try {
      const batch = writeBatch(db);
      let algumaMudanca = false;
      draft.forEach(row => {
        const original = musicasCache.find(m => m.id === row.id);
        if (!original) return;
        const tom = (row.tom || "").trim(), cantor = (row.cantor || "").trim();
        const mudou = row.nome !== original.nome || tom !== (original.tom || "") || cantor !== (original.cantor || "");
        if (!mudou) return;
        algumaMudanca = true;
        batch.update(P.musica(eid, row.id), { nome: row.nome, tom, cantor });
      });
      if (!algumaMudanca) { showToast("Nenhuma alteração para salvar."); return; }
      await batch.commit();
      session.musicasDraft = null;
      showToast("Músicas salvas!");
    } catch (err) { alert(friendlyFirestoreError(err)); }
  });

  onAll("[data-remove-musica]", "click", async el => {
    const id = el.dataset.removeMusica;
    const emUso = ensaiosCache.filter(e => (e.musicaIds || []).includes(id)).length;
    if (emUso > 0 && !confirm(`Essa música está marcada em ${emUso} ensaio(s). Remover mesmo assim? Ela deixa de aparecer nas listas, mas o histórico dos ensaios não é alterado automaticamente.`)) return;
    try {
      await deleteDoc(P.musica(edicaoCtxId(), id));
      if (session.musicasDraft) session.musicasDraft = session.musicasDraft.filter(m => m.id !== id);
      render();
    } catch (err) { alert(friendlyFirestoreError(err)); }
  });

  // ADMIN — cadastros
  onAll("[data-edit-user]", "click", el => {
    session.adminEditingUser = session.adminEditingUser === el.dataset.editUser ? null : el.dataset.editUser;
    // Os comprovantes carregados pertencem a quem estava aberto antes; deixá-los
    // em memória mostraria o financeiro de uma pessoa no cadastro de outra.
    session.pagsDoEditado = null; session.pagsDoEditadoDe = null;
    render();
  });
  onAll("[data-cancel-admin-edit]", "click", () => {
    session.adminEditingUser = null;
    session.pagsDoEditado = null; session.pagsDoEditadoDe = null;
    render();
  });
  onAll("[data-remove-user]", "click", async el => {
    const id = el.dataset.removeUser;
    const ed = edicaoCtx();
    const pessoa = batuqueirosDaEdicao().find(x => x.id === id);
    const jaPago = pessoa ? totalPago(pessoa) : 0;
    // Os comprovantes de pagamento são imutáveis por regra e NÃO são apagados
    // junto. Se a pessoa se inscrever de novo, a inscrição nasce com totalPago 0
    // e ela é cobrada outra vez, com os comprovantes antigos ainda na tela dela.
    // O site recompõe o total na reinscrição, mas o admin precisa saber disso
    // antes de clicar.
    const aviso = jaPago > 0
      ? `\n\nATENÇÃO: ela já registrou ${currency(jaPago)} nesta edição. Os comprovantes não são apagados e o valor volta a contar se ela se inscrever de novo — mas até lá ela some do relatório de pagamentos.`
      : "";
    if (!confirm(`Tirar esta pessoa do ${edicaoLabel(ed)}?\n\nO cadastro e o histórico dela em outros carnavais continuam intactos — ela só deixa de constar nesta edição.${aviso}`)) return;
    try { await deleteDoc(P.inscricao(ed.id, id)); }
    catch (err) { alert(friendlyFirestoreError(err)); }
  });
  document.querySelectorAll("[data-admin-edit-form]").forEach(form => {
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const id = form.dataset.adminEditForm;
      const eid = edicaoCtxId();
      const original = batuqueirosDaEdicao().find(x => x.id === id);
      const pessoaPatch = {
        nome: $(`#ae-nome-${id}`).value.trim(),
        sobrenome: $(`#ae-sobrenome-${id}`).value.trim(),
        apelido: $(`#ae-apelido-${id}`).value.trim(),
        celular: "", dataNascimento: "",   // o contato mora em /contatos, não aqui
        adminAccess: $(`#ae-adminaccess-${id}`).checked,
        presencaAccess: $(`#ae-presencaaccess-${id}`).checked,
      };
      // Só grava o que foi realmente preenchido. Se o listener de /contatos ainda
      // não respondeu (ou falhou), o formulário abre com telefone e nascimento em
      // branco — e gravar esse branco apagaria os dados de verdade sem aviso.
      const contatoPatch = {};
      const celularDigitado = $(`#ae-celular-${id}`).value.trim();
      const nascDigitado = lerDataNascimento(`ae-datanasc-${id}`);
      if (celularDigitado) contatoPatch.celular = celularDigitado;
      if (nascDigitado) contatoPatch.dataNascimento = nascDigitado;
      const inscricaoPatch = {
        vaiTocar: $(`#ae-vaitocar-${id}`).value,
        posicao: $(`#ae-posicao-${id}`).value,
        camisa: $(`#ae-camisa-${id}`).value,
        // O admin é a única saída quando alguém escolhe o plano errado e já
        // registrou um pagamento (aí o botão do próprio batuqueiro some).
        formaPagamento: $(`#ae-formapagamento-${id}`).value || null,
        isentoManual: $(`#ae-isento-${id}`).checked,
      };
      try {
        const batch = writeBatch(db);
        batch.update(P.pessoa(id), pessoaPatch);
        if (Object.keys(contatoPatch).length) batch.set(P.contato(id), contatoPatch, { merge: true });
        if (eid && edicaoEditavel(edicaoCtx())) batch.update(P.inscricao(eid, id), inscricaoPatch);
        await batch.commit();
        session.adminEditingUser = null;
        render();
      } catch (err) { alert(friendlyFirestoreError(err)); }
    });
  });
}

function on(sel, evt, fn) { const el = $(sel); if (el) el.addEventListener(evt, fn); }
function onAll(sel, evt, fn) { document.querySelectorAll(sel).forEach(el => el.addEventListener(evt, () => fn(el))); }

/* boot inicial: mostra tela de carregamento até o primeiro onAuthStateChanged responder */
render();
