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

/* ============================================================
   ESTADO EM MEMÓRIA (espelho local dos dados do Firestore, mantido
   sempre atualizado por listeners onSnapshot)
   ============================================================ */
let fbUser = null;          // usuário do Firebase Auth (ou null)
let profileLoaded = false;  // true assim que o listener de users/{uid} respondeu 1x
let myProfile = null;       // { id, ...campos } de users/{uid} do usuário logado
let usersCache = [];
let posicoesCache = [];
let ensaiosCache = [];
let musicasCache = [];
let precosCache = null;
let presencasCache = {};    // uid -> { ensaioId: true/false }
let myPagamentos = [];      // só os pagamentos do próprio usuário logado

const unsub = { myProfile: null, users: null, posicoes: null, ensaios: null, musicas: null, precos: null, presencas: null, myPagamentos: null };

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
  busy: {},
  toast: null,
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
function musicaNome(id) { const m = musicasCache.find(x => x.id === id); return m ? m.nome : null; }
/* Nome da música + tom/cantor entre parênteses, quando cadastrados (ex: "Vem Ni Mim (Sol maior · Carla)"). */
function musicaResumo(id) {
  const m = musicasCache.find(x => x.id === id);
  if (!m) return null;
  const extras = [m.tom, m.cantor].filter(Boolean).join(" · ");
  return extras ? `${m.nome} (${extras})` : m.nome;
}

/* ============================================================
   BOOT — autenticação dirige tudo
   ============================================================ */
onAuthStateChanged(auth, (user) => {
  fbUser = user;
  teardownUserListeners();
  if (!user) {
    myProfile = null; profileLoaded = false;
    usersCache = []; posicoesCache = []; ensaiosCache = []; musicasCache = []; precosCache = null; presencasCache = {}; myPagamentos = [];
    if (session.view && !["landing", "login", "register1"].includes(session.view)) session.view = "landing";
    render();
    return;
  }
  setupUserListeners(user.uid);
  render();
});

function setupUserListeners(uid) {
  const onErr = (label) => (err) => { console.error(label, err); showToast("Erro ao carregar dados: " + (err && err.message ? err.message : label)); };

  unsub.myProfile = onSnapshot(doc(db, "users", uid), snap => {
    myProfile = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    profileLoaded = true;
    render();
  }, onErr("perfil"));

  unsub.users = onSnapshot(collection(db, "users"), snap => {
    usersCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, onErr("lista de pessoas"));

  unsub.posicoes = onSnapshot(collection(db, "posicoes"), snap => {
    posicoesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, onErr("posições"));

  unsub.ensaios = onSnapshot(collection(db, "ensaios"), snap => {
    ensaiosCache = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.data || "").localeCompare(b.data || ""));
    render();
  }, onErr("ensaios"));

  unsub.musicas = onSnapshot(collection(db, "musicas"), snap => {
    musicasCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, onErr("músicas"));

  unsub.precos = onSnapshot(doc(db, "config", "precos"), snap => {
    precosCache = snap.exists() ? snap.data() : null;
    render();
  }, onErr("valores da anuidade"));

  unsub.presencas = onSnapshot(collection(db, "presencas"), snap => {
    const map = {};
    snap.docs.forEach(d => {
      const v = d.data();
      if (!map[v.uid]) map[v.uid] = {};
      map[v.uid][v.ensaioId] = !!v.presente;
    });
    presencasCache = map;
    render();
  }, onErr("presenças"));

  unsub.myPagamentos = onSnapshot(query(collection(db, "pagamentos"), where("uid", "==", uid)), snap => {
    myPagamentos = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.data || "").localeCompare(b.data || ""));
    render();
  }, onErr("pagamentos"));
}

function teardownUserListeners() {
  Object.keys(unsub).forEach(k => { if (unsub[k]) { unsub[k](); unsub[k] = null; } });
}

/* ============================================================
   HELPERS
   ============================================================ */
const $ = (sel, el = document) => el.querySelector(sel);
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
  let opts = ordenarPosicoesAlfabetica(posicoesCache).map(p => `<option value="${p.nome}" ${p.nome === selected ? "selected" : ""}>${p.nome}</option>`).join("");
  opts += `<option value="Outro" ${selected === "Outro" ? "selected" : ""}>Outro</option>`;
  if (selected && selected !== "Outro" && !posicoesCache.some(p => p.nome === selected)) {
    opts = `<option value="${selected}" selected>${selected} (removida da lista)</option>` + opts;
  }
  return opts;
}
function valorDoPlano(k) { return precosCache && precosCache[k] ? precosCache[k].valor : 0; }
function prazosDoPlano(k) { return precosCache && precosCache[k] ? precosCache[k].prazos : []; }
function totalDevido(u) { return u.formaPagamento ? valorDoPlano(u.formaPagamento) : null; }
function planoLabel(k) {
  const p = PLANOS[k], total = valorDoPlano(k);
  return p.parcelas === 1 ? `${p.label} — ${currency(total)}` : `${p.label} — ${currency(total)} (${p.parcelas}x de ${currency(total / p.parcelas)})`;
}
function totalPago(u) { return u.totalPago || 0; }

function parcelasInfo(u) {
  if (!u.formaPagamento || !precosCache) return [];
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
  if (!u.formaPagamento || !precosCache) return { label: "Sem plano", cls: "badge-warning" };
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

let toastTimer = null;
function showToast(msg) {
  session.toast = msg;
  render();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { session.toast = null; render(); }, 3500);
}

function go(view, extra = {}) { Object.assign(session, { view }, extra); render(); }

/* ============================================================
   RENDER — roteador principal
   ============================================================ */
function render() {
  const app = document.getElementById("app");
  let html = "";

  if (fbUser) {
    if (!profileLoaded) {
      html = viewLoading("Carregando seus dados...");
    } else if (!myProfile) {
      if (!session.draftUser) session.draftUser = { email: fbUser.email };
      html = viewRegister2();
    } else {
      const validAdminViews = ["batuqueiro", "admin", "admin-precos", "admin-ensaios", "admin-relatorio", "admin-posicoes", "admin-musicas", "admin-pessoas"];
      if (!validAdminViews.includes(session.view)) session.view = "batuqueiro";
      if (session.view.startsWith("admin") && !temAcessoAdmin(myProfile)) session.view = "batuqueiro";

      if (session.view === "batuqueiro") html = viewBatuqueiro();
      else if (session.view === "admin") html = viewAdmin();
      else if (session.view === "admin-precos") html = viewAdminPrecos();
      else if (session.view === "admin-ensaios") html = viewAdminEnsaios();
      else if (session.view === "admin-relatorio") html = viewAdminRelatorio();
      else if (session.view === "admin-posicoes") html = viewAdminPosicoes();
      else if (session.view === "admin-musicas") html = viewAdminMusicas();
      else if (session.view === "admin-pessoas") html = viewAdminPessoas();
    }
  } else {
    if (session.view === "register1") html = viewRegister1();
    else if (session.view === "login") html = viewLogin();
    else html = viewLanding();
  }

  if (session.toast) html += `<div class="toast">${session.toast}</div>`;
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
    <p>Cadastro oficial de batuqueiros para o Carnaval 2027</p>
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
   VIEW: REGISTER STEP 2 — cadastro (dados do batuqueiro)
   ============================================================ */
function viewRegister2() {
  const d = session.draftUser || { email: fbUser.email };
  const err = session.errors.register2;
  const busy = !!session.busy.register2;
  return `
  <div class="hero"><div class="hero-inner"><h1>Criar cadastro</h1><p>Passo 2 de 2 — seus dados de batuqueiro</p></div></div>
  <div class="wrap">
    <div class="center-wrap card" style="max-width:560px">
      <div class="step-dots"><div class="step-dot"></div><div class="step-dot active"></div></div>
      <h2>Complete seu cadastro</h2>
      <p class="card-sub">Logado como <b>${d.email}</b></p>
      ${err ? `<div class="error-box">${err}</div>` : ""}
      <form id="form-register2">
        <div class="grid-2">
          <div class="field"><label>Nome</label><input type="text" id="c-nome" required value="${d.nome || ""}"></div>
          <div class="field"><label>Sobrenome</label><input type="text" id="c-sobrenome" required value="${d.sobrenome || ""}"></div>
        </div>
        <div class="field"><label>Celular</label><input type="tel" id="c-celular" required placeholder="(21) 90000-0000" value="${d.celular || ""}"></div>
        <div class="field">
          <label>Data de nascimento</label>
          ${dataNascimentoFieldsHtml("c-datanasc", d.dataNascimento)}
        </div>
        <div class="field">
          <label>Vai tocar no Carnaval 2027?</label>
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
          <label>Qual?</label><input type="text" id="c-posicao-outro" value="${d.posicaoOutro || ""}">
        </div>
        <div class="field">
          <label>Tamanho da camisa</label>
          <div class="radio-row" id="radio-camisa">
            ${CAMISAS.map(c => `<div class="radio-pill ${d.camisa === c ? "active" : ""}" data-val="${c}">${c}</div>`).join("")}
          </div>
        </div>
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
   VIEW: BATUQUEIRO
   ============================================================ */
function viewBatuqueiro() {
  const u = myProfile;
  const ensaioFiltro = session.presencaEnsaioFiltro || "todos";
  const ensaios = ensaioFiltro === "todos" ? ensaiosCache : ensaiosCache.filter(e => e.id === ensaioFiltro);
  const todos = usersCache;

  return `
  ${headerBar(u)}
  <div class="wrap">

    <div class="two-col">
      <!-- BOX 1: MEUS DADOS -->
      <div class="card">
        <div class="card-head">
          <div><h2>Meus dados</h2><p class="card-sub" style="margin-bottom:0">Suas informações de cadastro</p></div>
          ${!session.editingMyData ? `<button class="btn-secondary btn-sm" id="btn-edit-data">Editar</button>` : ``}
        </div>
        ${session.editingMyData ? renderEditMyData(u) : renderViewMyData(u)}
      </div>

      <!-- BOX 2: PAGAMENTO DA ANUIDADE -->
      <div class="card">
        <div class="card-head">
          <div><h2>Pagamento da anuidade</h2><p class="card-sub" style="margin-bottom:0">${isIsento(u) ? "Situação da sua anuidade" : (u.formaPagamento ? `Forma escolhida: ${planoLabel(u.formaPagamento)}` : "Escolha como prefere pagar")}</p></div>
          ${isIsento(u) || !u.formaPagamento ? "" : `<span class="badge ${paymentStatus(u).cls}">${paymentStatus(u).label}</span>`}
        </div>
        ${renderPaymentBoxBody(u)}
      </div>
    </div>

    <!-- BOX 3: PRESENÇA EM ENSAIOS -->
    <div class="card">
      <div class="card-head">
        <div><h2>Presença em ensaios</h2><p class="card-sub" style="margin-bottom:0">Clique em SIM/NÃO para marcar a presença de qualquer batuqueiro em cada ensaio</p></div>
      </div>
      <div class="filter-row">
        <div><label>Filtrar por posição</label>
          <select id="presenca-filtro-posicao">
            <option value="todas" ${(session.presencaFiltro || "todas") === "todas" ? "selected" : ""}>Todas as posições</option>
            ${posicoesUnicasOrdenadas(todos).map(pos => `<option value="${pos}" ${session.presencaFiltro === pos ? "selected" : ""}>${pos}</option>`).join("")}
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
                <td class="name-cell">${fullName(p)}${p.id === u.id ? ' <span class="muted-sm">(você)</span>' : ""}</td>
                <td>${p.posicao}</td>
                ${ensaios.map(e => {
                  const on = !!(presencasCache[p.id] && presencasCache[p.id][e.id]);
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
  </div>`;
}

function renderPaymentBoxBody(u) {
  if (isIsento(u)) {
    return `<div class="isenta-box">🎉 Anuidade ISENTA<div class="sub">Você está isento(a) — ${isentoMotivo(u)}.</div></div>`;
  }
  if (!precosCache) {
    return `<div class="hint">O organizador ainda não configurou os valores da anuidade. Volte em breve.</div>`;
  }
  if (!u.formaPagamento) {
    return `
      <p class="card-sub" style="margin-bottom:12px">Pagando à vista sai mais barato; parcelar em 2x ou 3x custa um pouco mais. Cada parcela tem uma data-limite.</p>
      <div style="display:flex; gap:10px; flex-wrap:wrap;" id="plan-picker">
        ${Object.keys(PLANOS).map(k => `<div class="plan-pill" data-plano="${k}">
          <b>${PLANOS[k].label}</b>
          <span>${currency(valorDoPlano(k))}${PLANOS[k].parcelas > 1 ? ` (${PLANOS[k].parcelas}x de ${currency(valorDoPlano(k) / PLANOS[k].parcelas)})` : ""}</span>
          <span style="display:block; margin-top:4px;">${prazosDoPlano(k).map((d, i) => `${PLANOS[k].parcelas > 1 ? `${i + 1}ª: ` : ""}até ${dateBR(d)}`).join(" · ")}</span>
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
          <span class="muted-sm">Pix: ${p.pix || "—"}</span>
          <span class="pv">${currency(p.valor)}</span>
        </div>`).join("")}
    </div>

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
    </div>`;
}

function renderViewMyData(u) {
  return `
    <div class="grid-2">
      <div><div class="hint">Nome completo</div><div>${fullName(u)}</div></div>
      <div><div class="hint">E-mail</div><div>${u.email}</div></div>
      <div><div class="hint">Celular</div><div>${u.celular}</div></div>
      <div><div class="hint">Data de nascimento</div><div>${dateBR(u.dataNascimento)}${calcIdade(u.dataNascimento) !== null ? ` (${calcIdade(u.dataNascimento)} anos)` : ""}</div></div>
      <div><div class="hint">Vai tocar em 2027?</div><div>${u.vaiTocar}</div></div>
      <div><div class="hint">Posição / instrumento</div><div>${u.posicao}${u.posicao === "Outro" && u.posicaoOutro ? ` (${u.posicaoOutro})` : ""}</div></div>
      <div><div class="hint">Tamanho da camisa</div><div>${u.camisa}</div></div>
    </div>`;
}

function renderEditMyData(u) {
  return `
    <form id="form-edit-mydata">
      <div class="grid-2">
        <div class="field"><label>Nome</label><input type="text" id="e-nome" value="${u.nome}" required></div>
        <div class="field"><label>Sobrenome</label><input type="text" id="e-sobrenome" value="${u.sobrenome}" required></div>
      </div>
      <div class="field"><label>Celular</label><input type="tel" id="e-celular" value="${u.celular}" required></div>
      <div class="field">
        <label>Data de nascimento</label>
        ${dataNascimentoFieldsHtml("e-datanasc", u.dataNascimento)}
      </div>
      <div class="field">
        <label>Vai tocar no Carnaval 2027?</label>
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
        <label>Qual?</label><input type="text" id="e-posicao-outro" value="${u.posicaoOutro || ""}">
      </div>
      <div class="field">
        <label>Tamanho da camisa</label>
        <div class="radio-row" id="edit-radio-camisa">${CAMISAS.map(c => `<div class="radio-pill ${u.camisa === c ? "active" : ""}" data-val="${c}">${c}</div>`).join("")}</div>
      </div>
      <div style="display:flex; gap:8px;">
        <button class="btn-primary btn-sm" type="submit">Salvar alterações</button>
        <button class="btn-secondary btn-sm" type="button" id="btn-cancel-edit">Cancelar</button>
      </div>
    </form>`;
}

function headerBar(u) {
  return `
  <div class="hero" style="padding-bottom:20px;"><div class="hero-inner">
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
      <div style="display:flex; align-items:center; gap:10px;">
        <img src="logo.png" alt="Logo Carnaval do Fogo e Paixão" class="brand-logo brand-logo-sm">
        <div><h1 style="font-size:22px; margin:0;">Área do Batuqueiro</h1><p style="margin:0;">Bem-vindo(a), ${u.nome}!</p></div>
      </div>
      <div style="display:flex; gap:8px;">
        ${temAcessoAdmin(u) ? `<button class="btn-secondary" id="btn-goto-admin">Painel admin</button>` : ""}
        <button class="btn-secondary" id="btn-logout">Sair</button>
      </div>
    </div>
  </div></div>`;
}

/* ============================================================
   VIEW: ADMIN
   ============================================================ */
function viewAdmin() {
  const u = myProfile;
  const todos = usersCache;
  const pagantes = todos.filter(p => !isIsento(p));
  const isentos = todos.filter(isIsento);
  const totalInscritos = todos.length;
  const confirmados = todos.filter(p => p.vaiTocar === "Sim").length;
  const arrecadado = todos.reduce((s, p) => s + totalPago(p), 0);
  const quitados = pagantes.filter(p => p.formaPagamento && precosCache && totalPago(p) >= totalDevido(p)).length;
  const adimplencia = pagantes.length ? Math.round((quitados / pagantes.length) * 100) : 0;
  const hoje = hojeISO();
  const ensaiosRealizados = ensaiosCache.filter(e => e.data <= hoje);
  const statusCounts = contagemPorStatus(todos);
  const precisaSeed = !precosCache || posicoesCache.length === 0;

  return `
  ${headerBar(u)}
  <div class="wrap">
    <p><button class="link-btn" id="btn-back-batuqueiro">← Voltar para minha área</button></p>

    ${precisaSeed ? `
    <div class="seed-box">
      <b>Primeiro acesso:</b> ainda faltam posições e/ou valores de anuidade cadastrados.
      <div style="margin-top:8px;"><button class="btn-primary btn-sm" id="btn-seed-defaults">Carregar posições e valores padrão</button></div>
    </div>` : ""}

    <div class="stat-row">
      <div class="stat-tile"><div class="label">Inscritos</div><div class="value">${totalInscritos}</div></div>
      <div class="stat-tile"><div class="label">Confirmados p/ 2027</div><div class="value">${confirmados} <small>/ ${totalInscritos}</small></div></div>
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
          <div><h2>Valores e prazos da anuidade</h2><p class="card-sub" style="margin-bottom:0">${precosCache ? `À vista ${currency(precosCache.avista.valor)} · 2x ${currency(precosCache.duasVezes.valor)} · 3x ${currency(precosCache.tresVezes.valor)}` : "Ainda não configurado"}</p></div>
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
        <div><h2>Cadastros</h2><p class="card-sub" style="margin-bottom:0">${totalInscritos} pessoas inscritas</p></div>
        <button class="btn-secondary btn-sm" id="btn-goto-pessoas">Ver lista completa</button>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Posição</th><th>Pessoas</th></tr></thead>
          <tbody>${contagemPorPosicao(todos).map(([nome, n]) => `<tr><td>${nome}</td><td>${n}</td></tr>`).join("")}</tbody>
        </table>
      </div>
    </div>
  </div>`;
}

function viewAdminEnsaios() {
  const u = myProfile;
  const hoje = hojeISO();
  const totalPessoas = usersCache.length;
  return `
  ${headerBar(u)}
  <div class="wrap">
    <p><button class="link-btn" id="btn-back-admin4">← Voltar para o painel admin</button></p>
    <div class="card">
      <h2>Ensaios</h2>
      <p class="card-sub">Edite a data, veja quantas pessoas foram em cada ensaio e adicione novas datas</p>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Data</th><th>Situação</th><th>Presença</th><th>Músicas ensaiadas</th><th></th></tr></thead>
          <tbody>
            ${ensaiosCache.length === 0 ? `<tr><td colspan="5" class="hint">Nenhum ensaio cadastrado.</td></tr>` : ensaiosCache.map(e => {
              const realizado = e.data <= hoje;
              const presentes = usersCache.filter(p => presencasCache[p.id] && presencasCache[p.id][e.id]).length;
              const musicaIds = e.musicaIds || [];
              const nomesMusicas = musicaIds.map(musicaResumo).filter(Boolean);
              const aberto = session.ensaioMusicasAberto === e.id;
              const draftIds = aberto ? (session.ensaioMusicasDraft || []) : musicaIds;
              return `<tr>
                <td><input type="date" class="ensaio-data-input" data-ensaio-id="${e.id}" value="${e.data}"></td>
                <td><span class="badge ${realizado ? "badge-good" : "badge-warning"}">${realizado ? "Realizado" : "Agendado"}</span></td>
                <td>${presentes}/${totalPessoas} presentes</td>
                <td>
                  <div>${nomesMusicas.length ? nomesMusicas.join(", ") : '<span class="hint">Nenhuma</span>'}</div>
                  <button class="btn-ghost btn-sm" style="margin-top:4px;" data-toggle-musicas-ensaio="${e.id}">${aberto ? "Fechar" : "Editar músicas"}</button>
                </td>
                <td class="row-actions">
                  <button class="btn-secondary btn-sm" data-save-ensaio="${e.id}">Salvar</button>
                  <button class="btn-ghost btn-sm" data-remove-ensaio="${e.id}">Remover</button>
                </td>
              </tr>
              ${aberto ? `<tr><td colspan="5">
                <div class="add-pay-form open">
                  <p class="card-sub" style="margin:0 0 10px;">Marque as músicas ensaiadas em ${dateBR(e.data)}:</p>
                  ${musicasCache.length === 0 ? `<p class="hint">Nenhuma música cadastrada ainda. Cadastre no repertório (painel admin → Repertório / músicas).</p>` : `
                  <div style="display:flex; flex-direction:column; gap:8px;">
                    ${ordenarMusicasAlfabetica(musicasCache).map(m => `
                      <label style="display:flex; align-items:center; gap:6px; font-weight:400; font-size:13.5px;">
                        <input type="checkbox" class="musica-ensaio-check" data-musica-id="${m.id}" ${draftIds.includes(m.id) ? "checked" : ""} style="width:auto;"> ${m.nome}${(m.tom || m.cantor) ? ` <span class="hint">${[m.tom, m.cantor].filter(Boolean).join(" · ")}</span>` : ""}
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
      <div style="display:flex; gap:8px; margin-top:14px;">
        <input type="date" id="new-ensaio-data" style="flex:1">
        <button class="btn-primary btn-sm" id="btn-add-ensaio">Adicionar ensaio</button>
      </div>
    </div>
  </div>`;
}

function viewAdminRelatorio() {
  const u = myProfile;
  const todos = usersCache;
  return `
  ${headerBar(u)}
  <div class="wrap">
    <p><button class="link-btn" id="btn-back-admin5">← Voltar para o painel admin</button></p>
    <div class="card">
      <h2>Relatório geral de pagamentos</h2>
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
            ${posicoesUnicasOrdenadas(todos).map(pos => `<option value="${pos}" ${session.relatorioFiltroPosicao === pos ? "selected" : ""}>${pos}</option>`).join("")}
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
              if (isIsento(p)) return `<tr><td class="name-cell">${fullName(p)}</td><td>${p.posicao}</td><td>—</td><td>—</td><td>Isenta</td><td>—</td><td><span class="badge ${status.cls}">${status.label}</span></td></tr>`;
              if (!p.formaPagamento) return `<tr><td class="name-cell">${fullName(p)}</td><td>${p.posicao}</td><td colspan="4">Ainda não escolheu a forma de pagamento</td><td><span class="badge ${status.cls}">${status.label}</span></td></tr>`;
              const pago = totalPago(p), meta = totalDevido(p);
              return `<tr>
                <td class="name-cell">${fullName(p)}</td>
                <td>${p.posicao}</td>
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

function viewAdminPrecos() {
  const u = myProfile;
  const precos = precosCache || DEFAULT_PRECOS;
  return `
  ${headerBar(u)}
  <div class="wrap">
    <p><button class="link-btn" id="btn-back-admin3">← Voltar para o painel admin</button></p>
    <div class="card">
      <h2>Valores e datas-limite da anuidade</h2>
      <p class="card-sub">Preço total e prazo de cada parcela, conforme a forma de pagamento</p>
      ${Object.keys(PLANOS).map(k => pricingPlanFieldset(k, precos)).join("")}
      <button class="btn-primary btn-sm" id="btn-save-precos">Salvar valores e prazos</button>
    </div>
  </div>`;
}

function pricingPlanFieldset(planoKey, precos) {
  const plano = PLANOS[planoKey], cfg = precos[planoKey];
  return `
    <div style="border:1px solid var(--gridline); border-radius:10px; padding:12px; margin-bottom:12px;">
      <div style="font-weight:700; font-size:13.5px; margin-bottom:8px;">${plano.label}</div>
      <div class="field"><label>Valor total (R$)</label><input type="number" id="admin-preco-${planoKey}" value="${cfg.valor}" min="1" step="0.01"></div>
      <div class="${plano.parcelas > 1 ? "grid-" + plano.parcelas : ""}">
        ${cfg.prazos.map((d, i) => `<div class="field"><label>${plano.parcelas > 1 ? `Parcela ${i + 1} — ` : ""}Data-limite</label><input type="date" id="admin-prazo-${planoKey}-${i}" value="${d || ""}"></div>`).join("")}
      </div>
    </div>`;
}

function viewAdminPosicoes() {
  const u = myProfile;
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
    <div class="card">
      <h2>Posições / instrumentos</h2>
      <p class="card-sub">Adicione, edite e diga se a posição é isenta de anuidade automaticamente — em ordem alfabética. Depois de editar, clique em "Salvar todas as posições" uma única vez.</p>
      ${draft.map(p => `
        <div class="list-row">
          <input type="text" class="pos-name-input" data-pos-id="${p.id}" value="${p.nome}" style="flex:1; max-width:220px;">
          <label style="display:flex; align-items:center; gap:6px; font-weight:400; font-size:12.5px; white-space:nowrap;">
            <input type="checkbox" class="pos-isenta-input" data-pos-id="${p.id}" ${p.isenta ? "checked" : ""} style="width:auto;"> Isenta automaticamente
          </label>
          <button class="btn-ghost btn-sm" data-remove-posicao="${p.id}">Remover</button>
        </div>`).join("")}
      <div style="display:flex; gap:8px; margin-top:14px; align-items:center; flex-wrap:wrap;">
        <input type="text" id="new-posicao-nome" placeholder="Nova posição/instrumento" style="flex:1; min-width:180px;">
        <label style="display:flex; align-items:center; gap:6px; font-size:12.5px; white-space:nowrap;"><input type="checkbox" id="new-posicao-isenta" style="width:auto;"> Isenta</label>
        <button class="btn-secondary btn-sm" id="btn-add-posicao">Adicionar</button>
      </div>
      <button class="btn-primary btn-sm" id="btn-save-all-posicoes" style="margin-top:16px;">Salvar todas as posições</button>
      <p class="hint" style="margin-top:10px">"Outro" continua disponível no formulário de cadastro e nunca é isento automaticamente — só por isenção individual.</p>
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

function viewAdminMusicas() {
  const u = myProfile;
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
    <div class="card">
      <h2>Repertório / músicas</h2>
      <p class="card-sub">Cadastre aqui as músicas do repertório, o tom e quem canta (voz) cada uma — em ordem alfabética. Tom e Cantor(a) são campos livres: comece a digitar e os valores já usados em outras músicas aparecem como sugestão, mas você também pode digitar um novo. Elas ficam disponíveis para marcar quais foram ensaiadas em cada data (painel admin → Ensaios). Depois de editar, clique em "Salvar todas as músicas" uma única vez.</p>
      ${draft.length === 0 ? `<p class="hint">Nenhuma música cadastrada ainda.</p>` : ""}
      ${draft.map(m => `
        <div style="border-bottom:1px solid var(--gridline); padding:10px 0;">
          <div class="grid-3">
            <div class="field" style="margin-bottom:0;"><label>Música</label><input type="text" class="musica-name-input" data-musica-id="${m.id}" value="${m.nome}"></div>
            <div class="field" style="margin-bottom:0;"><label>Tom</label><input type="text" class="musica-tom-input" data-musica-id="${m.id}" value="${m.tom || ""}" list="lista-tons" placeholder="Ex: Sol maior"></div>
            <div class="field" style="margin-bottom:0;"><label>Cantor(a) / voz</label><input type="text" class="musica-cantor-input" data-musica-id="${m.id}" value="${m.cantor || ""}" list="lista-cantores" placeholder="Nome"></div>
          </div>
          <button class="btn-ghost btn-sm" style="margin-top:8px;" data-remove-musica="${m.id}">Remover</button>
        </div>`).join("")}

      <div class="grid-3" style="margin-top:14px;">
        <div class="field" style="margin-bottom:0;"><label>Nova música</label><input type="text" id="new-musica-nome" placeholder="Nome da música"></div>
        <div class="field" style="margin-bottom:0;"><label>Tom</label><input type="text" id="new-musica-tom" placeholder="Ex: Sol maior" list="lista-tons"></div>
        <div class="field" style="margin-bottom:0;"><label>Cantor(a) / voz</label><input type="text" id="new-musica-cantor" placeholder="Nome" list="lista-cantores"></div>
      </div>
      <button class="btn-secondary btn-sm" id="btn-add-musica" style="margin-top:10px;">Adicionar</button>

      <button class="btn-primary btn-sm" id="btn-save-all-musicas" style="margin-top:16px; display:block;">Salvar todas as músicas</button>

      <datalist id="lista-tons">${tonsSugeridos.map(t => `<option value="${t}">`).join("")}</datalist>
      <datalist id="lista-cantores">${cantoresSugeridos.map(c => `<option value="${c}">`).join("")}</datalist>
    </div>
  </div>`;
}

function viewAdminPessoas() {
  const u = myProfile;
  const filtro = session.adminPessoasFiltro || "todas";
  const todos = usersCache;
  const posicoesPresentes = posicoesUnicasOrdenadas(todos);
  const lista = filtro === "todas" ? todos : todos.filter(p => p.posicao === filtro);
  return `
  ${headerBar(u)}
  <div class="wrap">
    <p><button class="link-btn" id="btn-back-admin2">← Voltar para o painel admin</button></p>
    <div class="card">
      <div class="card-head">
        <div><h2>Cadastros — lista completa</h2><p class="card-sub" style="margin-bottom:0">Editar dados, marcar isenção individual de anuidade, dar acesso admin ou remover um cadastro</p></div>
        <select id="admin-pessoas-filtro" style="width:auto;">
          <option value="todas" ${filtro === "todas" ? "selected" : ""}>Todas as posições</option>
          ${posicoesPresentes.map(p => `<option value="${p}" ${filtro === p ? "selected" : ""}>${p}</option>`).join("")}
        </select>
      </div>
      ${lista.length === 0 ? '<div class="hint">Nenhuma pessoa encontrada com esse filtro.</div>' : lista.map(p => `
        <div class="list-row">
          <span class="grow"><b>${fullName(p)}</b> <span class="muted-sm">— ${p.posicao} · ${p.email} · camisa ${p.camisa} · toca 2027: ${p.vaiTocar}${isIsento(p) ? ` · <span class="badge badge-isenta">Isento — ${isentoMotivo(p)}</span>` : ""}${p.adminAccess ? ` · <span class="badge badge-good">Acesso admin</span>` : ""}</span></span>
          <button class="btn-secondary btn-sm" data-edit-user="${p.id}">Editar</button>
          <button class="btn-danger btn-sm" data-remove-user="${p.id}">Remover</button>
        </div>
        <div class="add-pay-form ${session.adminEditingUser === p.id ? "open" : ""}" id="admin-edit-${p.id}">
          ${session.adminEditingUser === p.id ? renderAdminEditUserForm(p) : ""}
        </div>
      `).join("")}
    </div>
  </div>`;
}

function renderAdminEditUserForm(p) {
  return `
    <form data-admin-edit-form="${p.id}">
      <div class="grid-2">
        <div class="field"><label>Nome</label><input type="text" id="ae-nome-${p.id}" value="${p.nome}"></div>
        <div class="field"><label>Sobrenome</label><input type="text" id="ae-sobrenome-${p.id}" value="${p.sobrenome}"></div>
      </div>
      <div class="field"><label>Celular</label><input type="tel" id="ae-celular-${p.id}" value="${p.celular}"></div>
      <div class="field">
        <label>Data de nascimento</label>
        ${dataNascimentoFieldsHtml(`ae-datanasc-${p.id}`, p.dataNascimento)}
      </div>
      <div class="field">
        <label>Posição</label>
        <select id="ae-posicao-${p.id}">${posicaoOptionsHtml(p.posicao)}</select>
      </div>
      <div class="field"><label>Camisa</label>
        <select id="ae-camisa-${p.id}">${CAMISAS.map(x => `<option ${x === p.camisa ? "selected" : ""}>${x}</option>`).join("")}</select>
      </div>
      <div class="field">
        <label style="display:flex; align-items:center; gap:8px; font-weight:400; cursor:pointer;">
          <input type="checkbox" id="ae-isento-${p.id}" ${p.isentoManual ? "checked" : ""} style="width:auto;">
          Isenção individual de anuidade (além das posições isentas por padrão)
        </label>
      </div>
      <div class="field">
        <label style="display:flex; align-items:center; gap:8px; font-weight:400; cursor:pointer;">
          <input type="checkbox" id="ae-adminaccess-${p.id}" ${p.adminAccess ? "checked" : ""} style="width:auto;">
          Acesso ao painel admin (co-organizador — continua aparecendo normalmente na presença e nos pagamentos)
        </label>
      </div>
      <button class="btn-primary btn-sm" type="submit">Salvar</button>
      <button class="btn-secondary btn-sm" type="button" data-cancel-admin-edit="${p.id}">Cancelar</button>
    </form>`;
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

  // REGISTER STEP 2 — cria o documento em /users com os dados de batuqueiro
  on("#c-posicao", "change", e => { $("#wrap-posicao-outro").style.display = e.target.value === "Outro" ? "block" : "none"; });
  onAll("#radio-vaitocar .radio-pill", "click", el => {
    $("#radio-vaitocar").querySelectorAll(".radio-pill").forEach(x => x.classList.remove("active"));
    el.classList.add("active");
  });
  onAll("#radio-camisa .radio-pill", "click", el => {
    $("#radio-camisa").querySelectorAll(".radio-pill").forEach(x => x.classList.remove("active"));
    el.classList.add("active");
  });
  on("#form-register2", "submit", async e => {
    e.preventDefault();
    const vaiTocar = $("#radio-vaitocar .radio-pill.active")?.dataset.val;
    const camisa = $("#radio-camisa .radio-pill.active")?.dataset.val;
    const dataNascimento = lerDataNascimento("c-datanasc");
    if (!vaiTocar || !camisa) { session.errors.register2 = "Preencha se vai tocar em 2027 e o tamanho da camisa."; render(); return; }
    if (!dataNascimento) { session.errors.register2 = "Preencha dia, mês e ano de nascimento."; render(); return; }
    const posicao = $("#c-posicao").value;
    const profileData = {
      email: fbUser.email,
      nome: $("#c-nome").value.trim(), sobrenome: $("#c-sobrenome").value.trim(),
      celular: $("#c-celular").value.trim(), dataNascimento,
      vaiTocar, posicao, posicaoOutro: $("#c-posicao-outro") ? $("#c-posicao-outro").value.trim() : "",
      camisa, isentoManual: false, formaPagamento: null, adminAccess: false, totalPago: 0,
      createdAt: serverTimestamp(),
    };
    session.busy.register2 = true; render();
    try {
      await setDoc(doc(db, "users", fbUser.uid), profileData);
      session.errors.register2 = null;
      session.view = "batuqueiro";
    } catch (err) {
      session.errors.register2 = friendlyFirestoreError(err);
    }
    session.busy.register2 = false;
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

  // HEADER
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
  on("#admin-pessoas-filtro", "change", e => { session.adminPessoasFiltro = e.target.value; render(); });
  on("#relatorio-filtro-status", "change", e => { session.relatorioFiltroStatus = e.target.value; render(); });
  on("#relatorio-filtro-posicao", "change", e => { session.relatorioFiltroPosicao = e.target.value; render(); });

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
    const patch = {
      nome: $("#e-nome").value.trim(), sobrenome: $("#e-sobrenome").value.trim(),
      celular: $("#e-celular").value.trim(), dataNascimento: lerDataNascimento("e-datanasc") || myProfile.dataNascimento,
      vaiTocar: $("#edit-radio-vaitocar .radio-pill.active")?.dataset.val || myProfile.vaiTocar,
      posicao: $("#e-posicao").value,
      posicaoOutro: $("#e-posicao-outro") ? $("#e-posicao-outro").value.trim() : "",
      camisa: $("#edit-radio-camisa .radio-pill.active")?.dataset.val || myProfile.camisa,
    };
    try { await updateDoc(doc(db, "users", fbUser.uid), patch); session.editingMyData = false; }
    catch (err) { alert(friendlyFirestoreError(err)); }
    render();
  });

  // BATUQUEIRO — escolha / troca de forma de pagamento
  onAll("#plan-picker .plan-pill", "click", async el => {
    try { await updateDoc(doc(db, "users", fbUser.uid), { formaPagamento: el.dataset.plano }); }
    catch (err) { alert(friendlyFirestoreError(err)); }
  });
  on("#btn-change-plan", "click", async () => {
    if (!confirm("Alterar a forma de pagamento? O valor total devido será recalculado.")) return;
    try { await updateDoc(doc(db, "users", fbUser.uid), { formaPagamento: null }); }
    catch (err) { alert(friendlyFirestoreError(err)); }
  });

  // BATUQUEIRO — pagamento
  on("#btn-toggle-addpay", "click", () => {
    session.addPayOpenFor = session.addPayOpenFor === myProfile.id ? null : myProfile.id;
    render();
  });
  on("#btn-save-pay", "click", async () => {
    const data = $("#pay-data").value, valor = parseFloat($("#pay-valor").value), pix = $("#pay-pix").value.trim();
    if (!data || !valor || valor <= 0) { alert("Preencha data e valor do pagamento."); return; }
    try {
      const batch = writeBatch(db);
      const payRef = doc(collection(db, "pagamentos"));
      batch.set(payRef, { uid: fbUser.uid, data, valor, pix, createdAt: serverTimestamp() });
      batch.update(doc(db, "users", fbUser.uid), { totalPago: increment(valor) });
      await batch.commit();
      session.addPayOpenFor = null;
    } catch (err) { alert("Não foi possível salvar o pagamento: " + friendlyFirestoreError(err)); }
    render();
  });

  on("#presenca-filtro-posicao", "change", e => { session.presencaFiltro = e.target.value; render(); });
  on("#presenca-filtro-ensaio", "change", e => { session.presencaEnsaioFiltro = e.target.value; render(); });

  // BATUQUEIRO — presença (qualquer pessoa pode alterar qualquer célula)
  onAll(".toggle", "click", async el => {
    const targetUid = el.dataset.uid, eid = el.dataset.eid;
    const atual = !!(presencasCache[targetUid] && presencasCache[targetUid][eid]);
    try {
      await setDoc(doc(db, "presencas", `${eid}_${targetUid}`), {
        ensaioId: eid, uid: targetUid, presente: !atual,
        updatedAt: serverTimestamp(), updatedBy: fbUser.uid,
      });
    } catch (err) { alert("Não foi possível salvar a presença: " + friendlyFirestoreError(err)); }
  });

  // ADMIN — seed de dados iniciais
  on("#btn-seed-defaults", "click", async () => {
    try {
      const batch = writeBatch(db);
      DEFAULT_POSICOES.forEach(p => { batch.set(doc(collection(db, "posicoes")), p); });
      batch.set(doc(db, "config", "precos"), DEFAULT_PRECOS);
      await batch.commit();
      showToast("Posições e valores padrão carregados!");
    } catch (err) { alert(friendlyFirestoreError(err)); }
  });

  // ADMIN — ensaios
  on("#btn-add-ensaio", "click", async () => {
    const val = $("#new-ensaio-data").value;
    if (!val) return;
    try { await addDoc(collection(db, "ensaios"), { data: val, createdAt: serverTimestamp() }); }
    catch (err) { alert(friendlyFirestoreError(err)); }
  });
  onAll("[data-save-ensaio]", "click", async el => {
    const id = el.dataset.saveEnsaio;
    const input = document.querySelector(`.ensaio-data-input[data-ensaio-id="${id}"]`);
    if (!input.value) { alert("Selecione uma data válida."); return; }
    try { await updateDoc(doc(db, "ensaios", id), { data: input.value }); }
    catch (err) { alert(friendlyFirestoreError(err)); }
  });
  onAll("[data-remove-ensaio]", "click", async el => {
    try { await deleteDoc(doc(db, "ensaios", el.dataset.removeEnsaio)); }
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
      await updateDoc(doc(db, "ensaios", id), { musicaIds });
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
    try { await setDoc(doc(db, "config", "precos"), novo, { merge: true }); showToast("Valores salvos."); }
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
      const ref = await addDoc(collection(db, "posicoes"), { nome, isenta });
      if (session.posicoesDraft) {
        session.posicoesDraft = ordenarPosicoesAlfabetica([...session.posicoesDraft, { id: ref.id, nome, isenta }]);
      }
      render();
    } catch (err) { alert(friendlyFirestoreError(err)); }
  });

  on("#btn-save-all-posicoes", "click", async () => {
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
        batch.update(doc(db, "posicoes", row.id), { nome: row.nome, isenta: row.isenta });
        if (mudouNome) {
          usersCache.filter(u => u.posicao === original.nome).forEach(u => { batch.update(doc(db, "users", u.id), { posicao: row.nome }); });
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
    const emUso = usersCache.filter(u => u.posicao === pos.nome).length;
    if (emUso > 0 && !confirm(`${emUso} pessoa(s) estão cadastradas com "${pos.nome}". Remover mesmo assim? Elas continuam com essa posição no cadastro, mas ela deixa de aparecer nas listas.`)) return;
    try {
      await deleteDoc(doc(db, "posicoes", id));
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
      const ref = await addDoc(collection(db, "musicas"), { nome, tom, cantor });
      if (session.musicasDraft) {
        session.musicasDraft = ordenarMusicasAlfabetica([...session.musicasDraft, { id: ref.id, nome, tom, cantor }]);
      }
      render();
    } catch (err) { alert(friendlyFirestoreError(err)); }
  });

  on("#btn-save-all-musicas", "click", async () => {
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
        batch.update(doc(db, "musicas", row.id), { nome: row.nome, tom, cantor });
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
      await deleteDoc(doc(db, "musicas", id));
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
    if (!confirm("Remover este cadastro? Essa ação não pode ser desfeita (o login continua existindo, mas sem cadastro).")) return;
    try { await deleteDoc(doc(db, "users", id)); }
    catch (err) { alert(friendlyFirestoreError(err)); }
  });
  document.querySelectorAll("[data-admin-edit-form]").forEach(form => {
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const id = form.dataset.adminEditForm;
      const original = usersCache.find(u => u.id === id);
      const patch = {
        nome: $(`#ae-nome-${id}`).value.trim(),
        sobrenome: $(`#ae-sobrenome-${id}`).value.trim(),
        celular: $(`#ae-celular-${id}`).value.trim(),
        dataNascimento: lerDataNascimento(`ae-datanasc-${id}`) || (original && original.dataNascimento) || "",
        posicao: $(`#ae-posicao-${id}`).value,
        camisa: $(`#ae-camisa-${id}`).value,
        isentoManual: $(`#ae-isento-${id}`).checked,
        adminAccess: $(`#ae-adminaccess-${id}`).checked,
      };
      try { await updateDoc(doc(db, "users", id), patch); session.adminEditingUser = null; render(); }
      catch (err) { alert(friendlyFirestoreError(err)); }
    });
  });
}

function on(sel, evt, fn) { const el = $(sel); if (el) el.addEventListener(evt, fn); }
function onAll(sel, evt, fn) { document.querySelectorAll(sel).forEach(el => el.addEventListener(evt, () => fn(el))); }

/* boot inicial: mostra tela de carregamento até o primeiro onAuthStateChanged responder */
render();
