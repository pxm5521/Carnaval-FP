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
  avista:    { valor: 210, prazos: [""] },
  duasVezes: { valor: 230, prazos: ["", ""] },
  tresVezes: { valor: 250, prazos: ["", "", ""] },
};

/* Estados possíveis de uma edição do carnaval. */
const EDICAO_STATUS = {
  preparando: { label: "Em preparação", cls: "badge-warning", sub: "Só o admin vê — os batuqueiros ainda não têm acesso" },
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
let edicoesCache = [];      // todas as edições do carnaval
let inscricoesCache = [];   // inscrições da edição em contexto
let posicoesCache = [];
let ensaiosCache = [];
let musicasCache = [];
let precosCache = null;
let presencasCache = {};    // uid -> { ensaioId: true/false }
let myPagamentos = [];      // só os pagamentos do próprio usuário logado, na edição em contexto

const unsub = { myPessoa: null, pessoas: null, edicoes: null };
const unsubEd = { inscricoes: null, posicoes: null, ensaios: null, musicas: null, precos: null, presencas: null, myPagamentos: null };
let edicaoListenersFor = null;  // id da edição para a qual os listeners acima estão ativos
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
  historico: null,            // carregado sob demanda em "Meu histórico"
  historicoBusy: false,
  histGeral: null,            // carregado sob demanda no "Histórico geral" do admin
  histGeralBusy: false,
  histFiltro: "",
  draftInscricao: null,           // pré-preenchimento da tela de confirmar inscrição
  draftInscricaoDeEdicao: null,   // de qual edição veio esse pré-preenchimento
  draftInscricaoCarregadaPara: null,
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
  return aberta ? aberta.id : null;
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
  if (!user || user.uid !== uidAnterior) limparEstadoDeSessao();
  uidAnterior = user ? user.uid : null;

  if (!user) {
    myPessoa = null; pessoaLoaded = false; myLegado = null; legadoConsultado = false;
    pessoasCache = []; edicoesCache = [];
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
  render();
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
    historico: null,
    historicoBusy: false,
    histGeral: null,
    histGeralBusy: false,
    histFiltro: "",
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
    render();
  }, onErr("perfil"));

  unsub.pessoas = onSnapshot(P.pessoas(), snap => {
    pessoasCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, onErr("lista de pessoas"));

  unsub.edicoes = onSnapshot(P.edicoes(), snap => {
    edicoesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    ensureEdicaoListeners();
    render();
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
  if (!eid || !fbUser) return;

  unsubEd.inscricoes = onSnapshot(P.inscricoes(eid), snap => {
    inscricoesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Se esta edição veio de uma migração do formato antigo, cada pessoa leva os
    // próprios comprovantes de pagamento na primeira vez que entra (as regras não
    // deixam o admin ler os pagamentos alheios, então isso não pôde ir na migração).
    const ed = edicoesCache.find(e => e.id === eid);
    if (ed && ed.migradaDoFormatoAntigo && !pagamentosMigradosPara.has(eid) && inscricoesCache.some(i => i.id === fbUser.uid)) {
      pagamentosMigradosPara.add(eid);
      migrarMeusPagamentos(eid);
    }
    render();
  }, onErr("inscrições"));

  unsubEd.posicoes = onSnapshot(P.posicoes(eid), snap => {
    posicoesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, onErr("posições"));

  unsubEd.ensaios = onSnapshot(P.ensaios(eid), snap => {
    ensaiosCache = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.data || "").localeCompare(b.data || ""));
    render();
  }, onErr("ensaios"));

  unsubEd.musicas = onSnapshot(P.musicas(eid), snap => {
    musicasCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, onErr("músicas"));

  unsubEd.precos = onSnapshot(P.precos(eid), snap => {
    precosCache = snap.exists() ? snap.data() : null;
    render();
  }, onErr("valores da anuidade"));

  unsubEd.presencas = onSnapshot(P.presencas(eid), snap => {
    const map = {};
    snap.docs.forEach(d => {
      const v = d.data();
      if (!map[v.uid]) map[v.uid] = {};
      map[v.uid][v.ensaioId] = !!v.presente;
    });
    presencasCache = map;
    render();
  }, onErr("presenças"));

  unsubEd.myPagamentos = onSnapshot(query(P.pagamentos(eid), where("uid", "==", fbUser.uid)), snap => {
    myPagamentos = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.data || "").localeCompare(b.data || ""));
    render();
  }, onErr("pagamentos"));
}

/* Troca a edição que está sendo visualizada (só o admin faz isso). */
function trocarEdicaoCtx(eid) {
  session.edicaoId = eid;
  session.posicoesDraft = null; session.musicasDraft = null;
  session.ensaioMusicasAberto = null; session.ensaioMusicasDraft = null;
  session.adminEditingUser = null;
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
  return insc ? { ...base, ...insc, id } : { ...base, id };
}
/* Lista de batuqueiros inscritos na edição em contexto (pessoa + inscrição). */
function batuqueirosDaEdicao() {
  return inscricoesCache
    .map(i => {
      const pes = pessoasCache.find(x => x.id === i.id);
      return pes ? { ...pes, ...i, id: i.id } : null;
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
const dateBR = iso => { if (!iso) return "—"; const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };
const fullName = u => `${u.nome || ""} ${u.sobrenome || ""}`.trim();
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
function dataNascimentoFieldsHtml(idPrefix, isoValue) {
  const [anoAtual, mesAtual, diaAtual] = (isoValue || "").split("-");
  const diaOpts = Array.from({ length: 31 }, (_, i) => i + 1)
    .map(n => { const v = String(n).padStart(2, "0"); return `<option value="${v}" ${diaAtual === v ? "selected" : ""}>${n}</option>`; }).join("");
  const mesOpts = MESES.map((nome, i) => { const v = String(i + 1).padStart(2, "0"); return `<option value="${v}" ${mesAtual === v ? "selected" : ""}>${nome}</option>`; }).join("");
  return `
    <div class="grid-3">
      <div class="field"><label>Dia</label><select id="${idPrefix}-dia"><option value="">Dia</option>${diaOpts}</select></div>
      <div class="field"><label>Mês</label><select id="${idPrefix}-mes"><option value="">Mês</option>${mesOpts}</select></div>
      <div class="field"><label>Ano</label><input type="number" id="${idPrefix}-ano" placeholder="aaaa" value="${anoAtual || ""}" min="1920" max="${new Date().getFullYear()}"></div>
    </div>`;
}
function lerDataNascimento(idPrefix) {
  const dia = $(`#${idPrefix}-dia`)?.value, mes = $(`#${idPrefix}-mes`)?.value, ano = $(`#${idPrefix}-ano`)?.value;
  if (!dia || !mes || !ano) return "";
  return `${ano}-${mes}-${dia}`;
}

function temAcessoAdmin(u) { return !!(u && u.adminAccess); }
/* Admins sempre podem editar presença; além deles, só quem recebeu o acesso individual (presencaAccess). */
function temAcessoPresenca(u) { return !!(u && (u.adminAccess || u.presencaAccess)); }
function posicaoInfo(nome) { return posicoesCache.find(p => p.nome === nome); }
function isIsento(u) {
  const info = posicaoInfo(u.posicao);
  return !!(info && info.isenta) || !!u.isentoManual;
}
function isentoMotivo(u) {
  const info = posicaoInfo(u.posicao);
  if (info && info.isenta) return `isento pela função de ${u.posicao}`;
  if (u.isentoManual) return "isenção especial concedida pela organização";
  return "";
}
function posicaoOptionsHtml(selected) {
  let opts = ordenarPosicoesAlfabetica(posicoesCache).map(p => `<option value="${esc(p.nome)}" ${p.nome === selected ? "selected" : ""}>${esc(p.nome)}</option>`).join("");
  opts += `<option value="Outro" ${selected === "Outro" ? "selected" : ""}>Outro</option>`;
  if (selected && selected !== "Outro" && !posicoesCache.some(p => p.nome === selected)) {
    opts = `<option value="${esc(selected)}" selected>${esc(selected)} (removida da lista)</option>` + opts;
  }
  return opts;
}
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

function parcelasInfo(u) {
  if (!planoValido(u.formaPagamento) || !precosCache) return [];
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
  if (!planoValido(u.formaPagamento) || !precosCache) return { label: "Sem plano", cls: "badge-warning" };
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
function showToast(msg) {
  const host = toastHost();
  host.textContent = msg;   // textContent, não innerHTML: nada de marcação vinda de texto digitado
  host.style.display = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { host.style.display = "none"; }, 3500);
}

function go(view, extra = {}) { Object.assign(session, { view }, extra); render(); }

/* ============================================================
   RENDER — roteador principal
   ============================================================ */
const VIEWS_ADMIN = ["admin", "admin-edicoes", "admin-historico", "admin-precos", "admin-ensaios", "admin-relatorio", "admin-posicoes", "admin-musicas", "admin-pessoas"];

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
      else if (!edicaoCtx()) html = viewSemEdicao(u);
      else if (!estouInscrito()) { prepararDraftInscricao(); html = viewConfirmarInscricao(u); }
      else html = viewBatuqueiro();
    }
  } else {
    if (session.view === "register1") html = viewRegister1();
    else if (session.view === "login") html = viewLogin();
    else html = viewLanding();
  }

  app.innerHTML = html;
  wireEvents();
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
  <div class="hero"><div class="hero-inner"><h1>Criar cadastro</h1><p>Passo 1 de 2 — seu login individual</p></div></div>
  <div class="wrap">
    <div class="center-wrap card">
      <div class="step-dots"><div class="step-dot active"></div><div class="step-dot"></div></div>
      <h2>Crie seu login e senha</h2>
      <p class="card-sub">Escolha um e-mail e uma senha para acessar sua área de batuqueiro.</p>
      ${err ? `<div class="error-box">${err}</div>` : ""}
      <form id="form-register1">
        <div class="field"><label>E-mail</label><input type="email" id="reg-email" required placeholder="seuemail@exemplo.com" ${busy ? "disabled" : ""}></div>
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
  return `
  <div class="hero"><div class="hero-inner"><h1>Criar cadastro</h1><p>Passo 2 de 2 — seus dados de batuqueiro</p></div></div>
  <div class="wrap">
    <div class="center-wrap card" style="max-width:560px">
      <div class="step-dots"><div class="step-dot"></div><div class="step-dot active"></div></div>
      <h2>Complete seu cadastro</h2>
      <p class="card-sub">Logado como <b>${esc(d.email)}</b></p>
      ${err ? `<div class="error-box">${err}</div>` : ""}
      ${!ed ? `<div class="seed-box" style="text-align:left;">As inscrições para o próximo carnaval ainda não estão abertas. Você pode deixar seu cadastro pronto agora — quando a organização abrir, é só entrar e confirmar sua inscrição.</div>` : ""}
      <form id="form-register2">
        <div class="grid-2">
          <div class="field"><label>Nome</label><input type="text" id="c-nome" required value="${esc(d.nome)}"></div>
          <div class="field"><label>Sobrenome</label><input type="text" id="c-sobrenome" required value="${esc(d.sobrenome)}"></div>
        </div>
        <div class="field"><label>Celular</label><input type="tel" id="c-celular" required placeholder="(21) 90000-0000" value="${esc(d.celular)}"></div>
        <div class="field">
          <label>Data de nascimento</label>
          ${dataNascimentoFieldsHtml("c-datanasc", d.dataNascimento)}
        </div>
        ${ed ? `
        <div class="field">
          <label>Vai tocar no ${esc(edicaoLabel(ed))}?</label>
          <div class="radio-row" id="radio-vaitocar">
            <div class="radio-pill ${d.vaiTocar === "Sim" ? "active" : ""}" data-val="Sim">Sim</div>
            <div class="radio-pill ${d.vaiTocar === "Não" ? "active" : ""}" data-val="Não">Não</div>
          </div>
        </div>
        <div class="field">
          <label>Posição / instrumento</label>
          <select id="c-posicao">${posicaoOptionsHtml(d.posicao)}</select>
        </div>
        <div class="field" id="wrap-posicao-outro" style="display:${d.posicao === "Outro" ? "block" : "none"}">
          <label>Qual?</label><input type="text" id="c-posicao-outro" value="${esc(d.posicaoOutro)}">
        </div>
        <div class="field">
          <label>Tamanho da camisa</label>
          <div class="radio-row" id="radio-camisa">
            ${CAMISAS.map(c => `<div class="radio-pill ${d.camisa === c ? "active" : ""}" data-val="${c}">${c}</div>`).join("")}
          </div>
        </div>` : ""}
        <button class="btn-primary" style="width:100%" type="submit" ${busy ? "disabled" : ""}>${busy ? "Salvando..." : "Finalizar cadastro"}</button>
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
      ${err ? `<div class="error-box">${err}</div>` : ""}
      <form id="form-login">
        <div class="field"><label>E-mail</label><input type="email" id="log-email" required ${busy ? "disabled" : ""}></div>
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
    return `
    ${headerBar(u)}
    <div class="wrap">
      <div class="center-wrap card">
        <h2 style="text-align:center">Você não participou desta edição</h2>
        <p class="card-sub" style="text-align:center">O ${esc(edicaoLabel(ed))} está encerrado e você não tinha inscrição nele.</p>
        <div style="display:flex; justify-content:center; gap:8px;">
          <button class="btn-secondary btn-sm" id="btn-goto-historico">Ver meu histórico</button>
        </div>
      </div>
    </div>`;
  }

  return `
  ${headerBar(u)}
  <div class="wrap">
    <div class="center-wrap card" style="max-width:560px">
      <h2>Confirmar inscrição — ${esc(edicaoLabel(ed))}</h2>
      <p class="card-sub">${jaParticipou
        ? `Preenchemos abaixo com os seus dados do ${esc(edicaoLabel(session.draftInscricaoDeEdicao))}. Confira, ajuste o que mudou e confirme para participar deste carnaval.`
        : `Preencha os dados da sua participação neste carnaval.`}</p>
      ${ed.dataDoCarnaval ? `<p class="hint" style="margin-top:-10px;">Desfile em ${dateBR(ed.dataDoCarnaval)}</p>` : ""}
      ${err ? `<div class="error-box">${err}</div>` : ""}
      <form id="form-inscricao">
        <div class="field">
          <label>Vai tocar no ${esc(edicaoLabel(ed))}?</label>
          <div class="radio-row" id="insc-radio-vaitocar">
            <div class="radio-pill ${d.vaiTocar === "Sim" ? "active" : ""}" data-val="Sim">Sim</div>
            <div class="radio-pill ${d.vaiTocar === "Não" ? "active" : ""}" data-val="Não">Não</div>
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
  const ensaioFiltro = session.presencaEnsaioFiltro || "todos";
  const ensaios = ensaioFiltro === "todos" ? ensaiosCache : ensaiosCache.filter(e => e.id === ensaioFiltro);
  const todos = batuqueirosDaEdicao();
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
            <option value="todas" ${(session.presencaFiltro || "todas") === "todas" ? "selected" : ""}>Todas as posições</option>
            ${posicoesUnicasOrdenadas(todos).map(pos => `<option value="${esc(pos)}" ${session.presencaFiltro === pos ? "selected" : ""}>${esc(pos)}</option>`).join("")}
          </select>
        </div>
        <div><label>Filtrar por ensaio</label>
          <select id="presenca-filtro-ensaio">
            <option value="todos" ${(session.presencaEnsaioFiltro || "todos") === "todos" ? "selected" : ""}>Todos os ensaios</option>
            ${ensaiosCache.map(e => `<option value="${e.id}" ${session.presencaEnsaioFiltro === e.id ? "selected" : ""}>${ensaioLabel(e)}</option>`).join("")}
          </select>
        </div>
      </div>
      ${ensaiosCache.length === 0 ? `<div class="hint">Nenhum ensaio cadastrado ainda.</div>` : (() => {
        const pessoasFiltradas = todos.filter(p => !session.presencaFiltro || session.presencaFiltro === "todas" || p.posicao === session.presencaFiltro);
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
                <td class="name-cell">${esc(fullName(p))}${p.id === u.id ? ' <span class="muted-sm">(você)</span>' : ""}</td>
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
    return `<div class="isenta-box">🎉 Anuidade ISENTA<div class="sub">Você está isento(a) — ${esc(isentoMotivo(u))}.</div></div>`;
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
          <span>📅 ${dateBR(p.data)}</span>
          <span class="muted-sm">Pix: ${esc(p.pix) || "—"}</span>
          <span class="pv">${currency(p.valor)}</span>
        </div>`).join("")}
    </div>

    ${editavel ? `
    <div style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap;">
      <button class="btn-secondary btn-sm" id="btn-toggle-addpay">+ Adicionar pagamento</button>
      <button class="btn-ghost btn-sm" id="btn-change-plan">Alterar forma de pagamento</button>
    </div>
    <div class="add-pay-form ${session.addPayOpenFor === u.id ? "open" : ""}" id="add-pay-form">
      <div class="grid-3">
        <div class="field"><label>Data</label><input type="date" id="pay-data"></div>
        <div class="field"><label>Valor (R$)</label><input type="number" id="pay-valor" min="1" step="0.01"></div>
        <div class="field"><label>Chave / comprovante Pix</label><input type="text" id="pay-pix" placeholder="ex: nome@pix"></div>
      </div>
      <button class="btn-primary btn-sm" id="btn-save-pay">Salvar pagamento</button>
    </div>` : ""}`;
}

function renderViewMyData(u, ed) {
  return `
    <div class="grid-2">
      <div><div class="hint">Nome completo</div><div>${esc(fullName(u))}</div></div>
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
      <div class="field"><label>Celular</label><input type="tel" id="e-celular" value="${esc(u.celular)}" required></div>
      <div class="field">
        <label>Data de nascimento</label>
        ${dataNascimentoFieldsHtml("e-datanasc", u.dataNascimento)}
      </div>
      <div class="field">
        <label>Vai tocar no ${esc(edicaoLabel(ed))}?</label>
        <div class="radio-row" id="edit-radio-vaitocar">
          <div class="radio-pill ${u.vaiTocar === "Sim" ? "active" : ""}" data-val="Sim">Sim</div>
          <div class="radio-pill ${u.vaiTocar === "Não" ? "active" : ""}" data-val="Não">Não</div>
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
          <p style="margin:0;">Bem-vindo(a), ${esc(u.nome)}!${ed ? ` · ${esc(edicaoLabel(ed))}` : ""}</p>
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
  if (!fbUser) return;
  session.historicoBusy = true;
  render();
  const out = [];
  try {
    for (const ed of edicoesOrdenadas()) {
      const inscSnap = await getDoc(P.inscricao(ed.id, fbUser.uid));
      if (!inscSnap.exists()) continue;
      const inscricao = { id: fbUser.uid, ...inscSnap.data() };

      const [posSnap, precoSnap, ensaiosSnap, presSnap] = await Promise.all([
        getDocs(P.posicoes(ed.id)),
        getDoc(P.precos(ed.id)),
        getDocs(P.ensaios(ed.id)),
        getDocs(query(P.presencas(ed.id), where("uid", "==", fbUser.uid))),
      ]);
      const posicoes = posSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const precos = precoSnap.exists() ? precoSnap.data() : null;
      const totalEnsaios = ensaiosSnap.docs.length;
      const presencas = presSnap.docs.filter(d => d.data().presente).length;

      out.push({
        edicao: ed,
        inscricao,
        totalEnsaios,
        presencas,
        statusPagamento: statusPagamentoHistorico(inscricao, posicoes, precos),
      });
    }
    session.historico = out;
  } catch (err) {
    console.error("histórico", err);
    session.historico = [];
    showToast("Não foi possível carregar o histórico: " + friendlyFirestoreError(err));
  }
  session.historicoBusy = false;
  render();
}

/* Mesma regra de paymentStatus(), mas calculada com as posições/preços de uma
   edição específica (que não é necessariamente a que está carregada em memória). */
function statusPagamentoHistorico(insc, posicoes, precos) {
  const info = posicoes.find(p => p.nome === insc.posicao);
  if ((info && info.isenta) || insc.isentoManual) return "Isenta";
  if (!planoValido(insc.formaPagamento) || !precos) return "Sem plano";
  const cfg = precos[insc.formaPagamento];
  if (!cfg) return "Sem plano";
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
   VIEW: ADMIN — painel principal
   ============================================================ */
function viewAdmin() {
  const u = perfilMesclado();
  const ed = edicaoCtx();
  const todos = batuqueirosDaEdicao();
  const pagantes = todos.filter(p => !isIsento(p));
  const isentos = todos.filter(isIsento);
  const totalInscritos = todos.length;
  const confirmados = todos.filter(p => p.vaiTocar === "Sim").length;
  const arrecadado = todos.reduce((s, p) => s + totalPago(p), 0);
  const quitados = pagantes.filter(p => planoValido(p.formaPagamento) && precosCache && totalPago(p) >= totalDevido(p)).length;
  const adimplencia = pagantes.length ? Math.round((quitados / pagantes.length) * 100) : 0;
  const hoje = hojeISO();
  const ensaiosRealizados = ensaiosCache.filter(e => e.data <= hoje);
  const statusCounts = contagemPorStatus(todos);
  const precisaSeed = ed && (!precosCache || posicoesCache.length === 0);

  if (!ed) {
    return `
    ${headerBar(u)}
    <div class="wrap">
      <p><button class="link-btn" id="btn-back-batuqueiro">← Voltar para minha área</button></p>
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
      <div class="stat-tile"><div class="label">Inscritos</div><div class="value">${totalInscritos}</div></div>
      <div class="stat-tile"><div class="label">Confirmados p/ desfilar</div><div class="value">${confirmados} <small>/ ${totalInscritos}</small></div></div>
      <div class="stat-tile"><div class="label">Arrecadado</div><div class="value">${currency(arrecadado)}</div></div>
      <div class="stat-tile"><div class="label">Adimplência (pagantes)</div><div class="value">${adimplencia}<small>%</small></div></div>
    </div>
    <p class="hint" style="margin:-10px 0 22px;">${isentos.length} de ${totalInscritos} inscritos são isentos de anuidade (não entram no cálculo de adimplência).</p>

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
        <div><h2>Cadastros</h2><p class="card-sub" style="margin-bottom:0">${totalInscritos} pessoas inscritas nesta edição</p></div>
        <button class="btn-secondary btn-sm" id="btn-goto-pessoas">Ver lista completa</button>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Posição</th><th>Pessoas</th></tr></thead>
          <tbody>${contagemPorPosicao(todos).map(([nome, n]) => `<tr><td>${esc(nome)}</td><td>${n}</td></tr>`).join("")}</tbody>
        </table>
      </div>
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
          <div class="field"><label>Data do desfile</label>${dataNascimentoFieldsHtml("nova-edicao-data", session.novaEdicaoData || "")}</div>
        </div>
        ${anterior ? `
        <label style="display:flex; align-items:center; gap:8px; font-weight:400; font-size:13px; cursor:pointer; margin-bottom:10px;">
          <input type="checkbox" id="nova-edicao-copiar" checked style="width:auto;">
          Copiar posições e valores de anuidade do ${edicaoLabel(anterior)} como ponto de partida
        </label>` : ""}
        <p class="hint" style="margin-bottom:10px;">A edição nasce "em preparação": só você a enxerga, então dá para ajustar posições, valores e ensaios com calma antes de liberar para os batuqueiros. A data do desfile pode ser alterada depois quando quiser.</p>
        <button class="btn-primary btn-sm" id="btn-criar-edicao">Criar edição</button>
      </div>` : ""}

      ${lista.length === 0 ? `<div class="hint">Nenhuma edição cadastrada ainda.</div>` : `
      <div class="table-scroll">
        <table>
          <thead><tr><th>Edição</th><th>Data do desfile</th><th>Situação</th><th>Inscritos</th><th></th></tr></thead>
          <tbody>
            ${lista.map(e => {
              const emCtx = e.id === edicaoCtxId();
              return `<tr class="${emCtx ? "me" : ""}">
                <td class="name-cell">${esc(edicaoLabel(e))} <span class="muted-sm">(${esc(e.id)})</span></td>
                <td><input type="date" class="edicao-data-input" data-edicao-id="${e.id}" value="${e.dataDoCarnaval || ""}" ${e.status === "encerrada" ? "disabled" : ""}></td>
                <td><span class="badge ${statusInfo(e).cls}">${statusInfo(e).label}</span></td>
                <td>${emCtx ? inscricoesCache.length : "—"}</td>
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

    session.histGeral = {
      edicoes: eds,
      porPessoa,
      musicas: [...musicasPorNome.values()].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" })),
    };
  } catch (err) {
    console.error("histórico geral", err);
    session.histGeral = null;
    showToast("Não foi possível carregar o histórico geral: " + friendlyFirestoreError(err));
  }
  session.histGeralBusy = false;
  render();
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
  const pessoasFiltradas = termo ? pessoas.filter(p => fullName(p).toLowerCase().includes(termo)) : pessoas;
  const musicasFiltradas = termo ? dados.musicas.filter(m => m.nome.toLowerCase().includes(termo)) : dados.musicas;

  const tocou = (uid, edId) => {
    const reg = dados.porPessoa[uid] && dados.porPessoa[uid][edId];
    return !!(reg && reg.vaiTocar === "Sim");
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
              return `<tr data-hist-nome="${esc(fullName(p).toLowerCase())}">
                <td class="name-cell">${esc(fullName(p))}</td>
                ${eds.map(e => {
                  const reg = dados.porPessoa[p.id] && dados.porPessoa[p.id][e.id];
                  if (!reg) return `<td><span class="hint">—</span></td>`;
                  if (reg.vaiTocar === "Sim") return `<td><span class="badge badge-good">${esc(reg.posicao) || "Tocou"}</span></td>`;
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
  const totalPessoas = inscricoesCache.length;
  return `
  ${headerBar(u)}
  <div class="wrap">
    <p><button class="link-btn" id="btn-back-admin4">← Voltar para o painel admin</button></p>
    ${bannerEdicao(ed)}
    <div class="card">
      <h2>Ensaios — ${esc(edicaoLabel(ed))}</h2>
      <p class="card-sub">Edite a data, veja quantas pessoas foram em cada ensaio, registre as músicas ensaiadas e adicione novas datas</p>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Data</th><th>Situação</th><th>Presença</th><th>Músicas ensaiadas</th><th></th></tr></thead>
          <tbody>
            ${ensaiosCache.length === 0 ? `<tr><td colspan="5" class="hint">Nenhum ensaio cadastrado.</td></tr>` : ensaiosCache.map(e => {
              const realizado = e.data <= hoje;
              const presentes = inscricoesCache.filter(p => presencasCache[p.id] && presencasCache[p.id][e.id]).length;
              const musicaIds = e.musicaIds || [];
              const nomesMusicas = musicaIds.map(musicaResumo).filter(Boolean);
              const aberto = session.ensaioMusicasAberto === e.id;
              const draftIds = aberto ? (session.ensaioMusicasDraft || []) : musicaIds;
              return `<tr>
                <td><input type="date" class="ensaio-data-input" data-ensaio-id="${e.id}" value="${e.data}" ${editavel ? "" : "disabled"}></td>
                <td><span class="badge ${realizado ? "badge-good" : "badge-warning"}">${realizado ? "Realizado" : "Agendado"}</span></td>
                <td>${presentes}/${totalPessoas} presentes</td>
                <td>
                  <div>${nomesMusicas.length ? esc(nomesMusicas.join(", ")) : '<span class="hint">Nenhuma</span>'}</div>
                  ${editavel ? `<button class="btn-ghost btn-sm" style="margin-top:4px;" data-toggle-musicas-ensaio="${e.id}">${aberto ? "Fechar" : "Editar músicas"}</button>` : ""}
                </td>
                <td class="row-actions">
                  ${editavel ? `
                  <button class="btn-secondary btn-sm" data-save-ensaio="${e.id}">Salvar</button>
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
  const todos = batuqueirosDaEdicao();
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
            <option value="todas" ${(session.relatorioFiltroPosicao || "todas") === "todas" ? "selected" : ""}>Todas as posições</option>
            ${posicoesUnicasOrdenadas(todos).map(pos => `<option value="${esc(pos)}" ${session.relatorioFiltroPosicao === pos ? "selected" : ""}>${esc(pos)}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Nome</th><th>Posição</th><th>Forma pagto</th><th>Pago</th><th>Devido</th><th>Saldo</th><th>Status</th></tr></thead>
          <tbody>
            ${todos.filter(p => {
              const st = paymentStatus(p).label;
              const okStatus = !session.relatorioFiltroStatus || session.relatorioFiltroStatus === "todos" || st === session.relatorioFiltroStatus;
              const okPos = !session.relatorioFiltroPosicao || session.relatorioFiltroPosicao === "todas" || p.posicao === session.relatorioFiltroPosicao;
              return okStatus && okPos;
            }).map(p => {
              const status = paymentStatus(p);
              if (isIsento(p)) return `<tr><td class="name-cell">${esc(fullName(p))}</td><td>${esc(p.posicao)}</td><td>—</td><td>—</td><td>Isenta</td><td>—</td><td><span class="badge ${status.cls}">${status.label}</span></td></tr>`;
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
        </table>
      </div>
    </div>
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
      ${Object.keys(PLANOS).map(k => pricingPlanFieldset(k, precos, editavel)).join("")}
      ${editavel ? `<button class="btn-primary btn-sm" id="btn-save-precos">Salvar valores e prazos</button>` : `<p class="hint">Edição encerrada — os valores ficam como registro histórico.</p>`}
    </div>
  </div>`;
}

function pricingPlanFieldset(planoKey, precos, editavel = true) {
  const plano = PLANOS[planoKey], cfg = precos[planoKey];
  const dis = editavel ? "" : "disabled";
  return `
    <div style="border:1px solid var(--gridline); border-radius:10px; padding:12px; margin-bottom:12px;">
      <div style="font-weight:700; font-size:13.5px; margin-bottom:8px;">${plano.label}</div>
      <div class="field"><label>Valor total (R$)</label><input type="number" id="admin-preco-${planoKey}" value="${cfg.valor}" min="1" step="0.01" ${dis}></div>
      <div class="${plano.parcelas > 1 ? "grid-" + plano.parcelas : ""}">
        ${cfg.prazos.map((d, i) => `<div class="field"><label>${plano.parcelas > 1 ? `Parcela ${i + 1} — ` : ""}Data-limite</label><input type="date" id="admin-prazo-${planoKey}-${i}" value="${d || ""}" ${dis}></div>`).join("")}
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
  if (!session.posicoesDraft) {
    session.posicoesDraft = ordenarPosicoesAlfabetica(posicoesCache.map(p => ({ id: p.id, nome: p.nome, isenta: !!p.isenta })));
  }
  const draft = session.posicoesDraft;
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
  if (!session.musicasDraft) {
    session.musicasDraft = ordenarMusicasAlfabetica(musicasCache.map(m => ({ id: m.id, nome: m.nome, tom: m.tom || "", cantor: m.cantor || "" })));
  }
  const draft = session.musicasDraft;
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
  const filtro = session.adminPessoasFiltro || "todas";
  const todos = batuqueirosDaEdicao();
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
        <div><h2>Cadastros — ${esc(edicaoLabel(ed))}</h2><p class="card-sub" style="margin-bottom:0">Editar dados, marcar isenção individual de anuidade, dar acesso admin ou tirar alguém desta edição</p></div>
        <select id="admin-pessoas-filtro" style="width:auto;">
          <option value="todas" ${filtro === "todas" ? "selected" : ""}>Todas as posições</option>
          ${posicoesPresentes.map(p => `<option value="${esc(p)}" ${filtro === p ? "selected" : ""}>${esc(p)}</option>`).join("")}
        </select>
      </div>
      ${lista.length === 0 ? '<div class="hint">Nenhuma pessoa encontrada com esse filtro.</div>' : lista.map(p => `
        <div class="list-row">
          <span class="grow"><b>${esc(fullName(p))}</b> <span class="muted-sm">— ${esc(p.posicao)} · ${esc(p.email)} · camisa ${esc(p.camisa)} · vai tocar: ${esc(p.vaiTocar)}${isIsento(p) ? ` · <span class="badge badge-isenta">Isento — ${esc(isentoMotivo(p))}</span>` : ""}${p.adminAccess ? ` · <span class="badge badge-good">Acesso admin</span>` : ""}${!p.adminAccess && p.presencaAccess ? ` · <span class="badge badge-good">Edita presença</span>` : ""}</span></span>
          <button class="btn-secondary btn-sm" data-edit-user="${p.id}">Editar</button>
          ${editavel ? `<button class="btn-danger btn-sm" data-remove-user="${p.id}">Tirar da edição</button>` : ""}
        </div>
        <div class="add-pay-form ${session.adminEditingUser === p.id ? "open" : ""}" id="admin-edit-${p.id}">
          ${session.adminEditingUser === p.id ? renderAdminEditUserForm(p, editavel) : ""}
        </div>
      `).join("")}
    </div>

    ${naoInscritos.length > 0 ? `
    <div class="card">
      <div class="card-head">
        <div><h2>Cadastrados sem inscrição nesta edição</h2><p class="card-sub" style="margin-bottom:0">${naoInscritos.length} pessoa(s) com cadastro no site que ainda não confirmaram participação no ${esc(edicaoLabel(ed))}</p></div>
      </div>
      ${naoInscritos.map(p => `
        <div class="list-row">
          <span class="grow"><b>${esc(fullName(p))}</b> <span class="muted-sm">— ${esc(p.email)}</span></span>
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
      <div class="field"><label>Celular</label><input type="tel" id="ae-celular-${p.id}" value="${esc(p.celular)}" ${dis}></div>
      <div class="field">
        <label>Data de nascimento</label>
        ${dataNascimentoFieldsHtml(`ae-datanasc-${p.id}`, p.dataNascimento)}
      </div>
      <div class="field">
        <label>Posição</label>
        <select id="ae-posicao-${p.id}" ${dis}>${posicaoOptionsHtml(p.posicao)}</select>
      </div>
      <div class="field"><label>Camisa</label>
        <select id="ae-camisa-${p.id}" ${dis}>${CAMISAS.map(x => `<option ${x === p.camisa ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>
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
    </form>`;
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
async function migrarDoFormatoAntigo() {
  if (!confirm("Importar os dados do formato antigo para uma edição nova?\n\nIsso reorganiza os cadastros, posições, ensaios, músicas, valores e presenças que já existem. Rode só uma vez.")) return;
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

    const batch = writeBatch(db);
    usersSnap.docs.forEach(d => {
      const v = d.data();
      batch.set(P.pessoa(d.id), {
        nome: v.nome || "", sobrenome: v.sobrenome || "", email: v.email || "",
        celular: v.celular || "", dataNascimento: v.dataNascimento || "",
        adminAccess: !!v.adminAccess, presencaAccess: !!v.presencaAccess,
        criadoEm: v.createdAt || serverTimestamp(),
      });
      batch.set(P.inscricao(eid, d.id), {
        vaiTocar: v.vaiTocar || "", posicao: v.posicao || "", posicaoOutro: v.posicaoOutro || "",
        camisa: v.camisa || "", isentoManual: !!v.isentoManual,
        formaPagamento: v.formaPagamento || null, totalPago: v.totalPago || 0,
        inscritoEm: serverTimestamp(),
      });
    });

    posSnap.docs.forEach(d => batch.set(P.posicao(eid, d.id), d.data()));
    ensSnap.docs.forEach(d => batch.set(P.ensaio(eid, d.id), d.data()));
    musSnap.docs.forEach(d => batch.set(P.musica(eid, d.id), d.data()));
    if (precoSnap.exists()) batch.set(P.precos(eid), precoSnap.data());
    presSnap.docs.forEach(d => batch.set(P.presenca(eid, d.id), d.data()));

    try {
      await batch.commit();
    } catch (err) {
      // Se o conteúdo falhar, não deixa uma edição vazia para trás — assim é
      // seguro tentar de novo depois de resolver o motivo da falha.
      await deleteDoc(P.edicao(eid)).catch(() => {});
      throw err;
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
    const batch = writeBatch(db);
    antigos.docs.forEach(d => batch.set(doc(P.pagamentos(eid), d.id), d.data()));
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

  // REGISTER STEP 2 — cria /pessoas/{uid} e, se houver edição aberta, a inscrição nela.
  // Assim como na tela de inscrição, cada campo alterado atualiza o rascunho local
  // (session.draftUser) para que um redesenho em segundo plano não apague o que já
  // foi preenchido.
  Object.entries({ "c-nome": "nome", "c-sobrenome": "sobrenome", "c-celular": "celular", "c-posicao-outro": "posicaoOutro" })
    .forEach(([id, campo]) => { on(`#${id}`, "input", e => { draftUser()[campo] = e.target.value; }); });
  ["c-datanasc-dia", "c-datanasc-mes", "c-datanasc-ano"].forEach(id => {
    on(`#${id}`, "change", () => { draftUser().dataNascimento = lerDataNascimento("c-datanasc"); });
  });
  on("#c-posicao", "change", e => {
    $("#wrap-posicao-outro").style.display = e.target.value === "Outro" ? "block" : "none";
    draftUser().posicao = e.target.value;
  });
  onAll("#radio-vaitocar .radio-pill", "click", el => {
    $("#radio-vaitocar").querySelectorAll(".radio-pill").forEach(x => x.classList.remove("active"));
    el.classList.add("active");
    draftUser().vaiTocar = el.dataset.val;
  });
  onAll("#radio-camisa .radio-pill", "click", el => {
    $("#radio-camisa").querySelectorAll(".radio-pill").forEach(x => x.classList.remove("active"));
    el.classList.add("active");
    draftUser().camisa = el.dataset.val;
  });
  on("#form-register2", "submit", async e => {
    e.preventDefault();
    const ed = edicaoAberta();
    const dataNascimento = lerDataNascimento("c-datanasc");
    if (!dataNascimento) { session.errors.register2 = "Preencha dia, mês e ano de nascimento."; render(); return; }
    let inscricao = null;
    if (ed) {
      const vaiTocar = $("#radio-vaitocar .radio-pill.active")?.dataset.val;
      const camisa = $("#radio-camisa .radio-pill.active")?.dataset.val;
      if (!vaiTocar || !camisa) { session.errors.register2 = "Preencha se vai tocar neste carnaval e o tamanho da camisa."; render(); return; }
      inscricao = {
        vaiTocar, posicao: $("#c-posicao").value,
        posicaoOutro: $("#c-posicao-outro") ? $("#c-posicao-outro").value.trim() : "",
        camisa, isentoManual: false, formaPagamento: null, totalPago: 0,
        inscritoEm: serverTimestamp(),
      };
    }
    const pessoa = {
      email: fbUser.email,
      nome: $("#c-nome").value.trim(), sobrenome: $("#c-sobrenome").value.trim(),
      celular: $("#c-celular").value.trim(), dataNascimento,
      adminAccess: false, presencaAccess: false,
      criadoEm: serverTimestamp(),
    };
    session.busy.register2 = true; render();
    try {
      const batch = writeBatch(db);
      batch.set(P.pessoa(fbUser.uid), pessoa);
      if (ed && inscricao) batch.set(P.inscricao(ed.id, fbUser.uid), inscricao);
      await batch.commit();
      session.errors.register2 = null;
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
      await setDoc(P.inscricao(ed.id, fbUser.uid), {
        vaiTocar, posicao: $("#insc-posicao").value,
        posicaoOutro: $("#insc-posicao-outro") ? $("#insc-posicao-outro").value.trim() : "",
        camisa, isentoManual: false, formaPagamento: null, totalPago: 0,
        inscritoEm: serverTimestamp(),
      });
      session.errors.inscricao = null;
      session.draftInscricao = null;
      session.draftInscricaoDeEdicao = null;
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
  on("#relatorio-filtro-status", "change", e => { session.relatorioFiltroStatus = e.target.value; render(); });
  on("#relatorio-filtro-posicao", "change", e => { session.relatorioFiltroPosicao = e.target.value; render(); });
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
      batch.update(P.pessoa(fbUser.uid), pessoaPatch);
      if (eid) batch.update(P.inscricao(eid, fbUser.uid), inscricaoPatch);
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
    if (!confirm("Alterar a forma de pagamento? O valor total devido será recalculado.")) return;
    const eid = edicaoCtxId();
    try { await updateDoc(P.inscricao(eid, fbUser.uid), { formaPagamento: null }); }
    catch (err) { alert(friendlyFirestoreError(err)); }
  });

  // BATUQUEIRO — pagamento
  on("#btn-toggle-addpay", "click", () => {
    session.addPayOpenFor = session.addPayOpenFor === fbUser.uid ? null : fbUser.uid;
    render();
  });
  on("#btn-save-pay", "click", async () => {
    const data = $("#pay-data").value, valor = parseFloat($("#pay-valor").value), pix = $("#pay-pix").value.trim();
    if (!data || !valor || valor <= 0) { alert("Preencha data e valor do pagamento."); return; }
    const eid = edicaoCtxId();
    try {
      const batch = writeBatch(db);
      const payRef = doc(P.pagamentos(eid));
      batch.set(payRef, { uid: fbUser.uid, data, valor, pix, createdAt: serverTimestamp() });
      batch.update(P.inscricao(eid, fbUser.uid), { totalPago: increment(valor) });
      await batch.commit();
      session.addPayOpenFor = null;
    } catch (err) { alert("Não foi possível salvar o pagamento: " + friendlyFirestoreError(err)); }
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
    const atual = !!(presencasCache[targetUid] && presencasCache[targetUid][eid]);
    try {
      await setDoc(P.presenca(ed.id, `${eid}_${targetUid}`), {
        ensaioId: eid, uid: targetUid, presente: !atual,
        updatedAt: serverTimestamp(), updatedBy: fbUser.uid,
      });
    } catch (err) { alert("Não foi possível salvar a presença: " + friendlyFirestoreError(err)); }
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

  // ADMIN — seed de dados iniciais da edição
  on("#btn-seed-defaults", "click", async () => {
    const eid = edicaoCtxId();
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
  onAll("[data-save-ensaio]", "click", async el => {
    const id = el.dataset.saveEnsaio;
    const input = document.querySelector(`.ensaio-data-input[data-ensaio-id="${id}"]`);
    if (!input.value) { alert("Selecione uma data válida."); return; }
    try { await updateDoc(P.ensaio(edicaoCtxId(), id), { data: input.value }); }
    catch (err) { alert(friendlyFirestoreError(err)); }
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
  on("[data-cancel-musicas-ensaio]", "click", () => {
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
    if (posicoesCache.some(p => p.nome.toLowerCase() === nome.toLowerCase())) { alert("Essa posição já existe."); return; }
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
    if (musicasCache.some(m => m.nome.toLowerCase() === nome.toLowerCase())) { alert("Essa música já está cadastrada."); return; }
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
    render();
  });
  onAll("[data-cancel-admin-edit]", "click", () => { session.adminEditingUser = null; render(); });
  onAll("[data-remove-user]", "click", async el => {
    const id = el.dataset.removeUser;
    const ed = edicaoCtx();
    if (!confirm(`Tirar esta pessoa do ${edicaoLabel(ed)}?\n\nO cadastro e o histórico dela em outros carnavais continuam intactos — ela só deixa de constar nesta edição.`)) return;
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
        celular: $(`#ae-celular-${id}`).value.trim(),
        dataNascimento: lerDataNascimento(`ae-datanasc-${id}`) || (original && original.dataNascimento) || "",
        adminAccess: $(`#ae-adminaccess-${id}`).checked,
        presencaAccess: $(`#ae-presencaaccess-${id}`).checked,
      };
      const inscricaoPatch = {
        posicao: $(`#ae-posicao-${id}`).value,
        camisa: $(`#ae-camisa-${id}`).value,
        isentoManual: $(`#ae-isento-${id}`).checked,
      };
      try {
        const batch = writeBatch(db);
        batch.update(P.pessoa(id), pessoaPatch);
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
