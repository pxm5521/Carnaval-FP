// ============================================================
// MOCK do Firebase (Auth + Firestore) — usado só em test.html, para testar
// toda a lógica do app.js sem precisar de um projeto Firebase real nem de
// internet. Implementa, em memória, o mesmo formato de funções que o SDK
// real do Firebase exporta em firebase-init.js — então app.js não sabe (e
// não precisa saber) se está falando com o Firebase de verdade ou com isso.
//
// Também expõe window.__mock para os testes automatizados inspecionarem e
// manipularem o estado (ex: confirmar e-mail de verificação sem precisar
// clicar num link de e-mail de verdade).
// ============================================================

let uidCounter = 0;
const authUsersByEmail = new Map(); // email -> { uid, email, password, emailVerified, ... }
const authListeners = new Set();

export const auth = { currentUser: null };

function notifyAuth() {
  const u = auth.currentUser;
  authListeners.forEach(cb => cb(u));
}

function makeAuthUser(email, password) {
  const uid = "mockuid" + (++uidCounter);
  const u = {
    uid, email, password, emailVerified: false,
    reload: async () => {},
    getIdToken: async () => "mock-token",
  };
  authUsersByEmail.set(email.toLowerCase(), u);
  return u;
}

export async function createUserWithEmailAndPassword(_auth, email, password) {
  email = email.toLowerCase();
  if (authUsersByEmail.has(email)) { const e = new Error("email in use"); e.code = "auth/email-already-in-use"; throw e; }
  if (!password || password.length < 6) { const e = new Error("weak password"); e.code = "auth/weak-password"; throw e; }
  const user = makeAuthUser(email, password);
  auth.currentUser = user;
  notifyAuth();
  return { user };
}

export async function signInWithEmailAndPassword(_auth, email, password) {
  const user = authUsersByEmail.get(email.toLowerCase());
  if (!user || user.password !== password) { const e = new Error("invalid credential"); e.code = "auth/invalid-credential"; throw e; }
  auth.currentUser = user;
  notifyAuth();
  return { user };
}

export async function signOut(_auth) {
  auth.currentUser = null;
  notifyAuth();
}

export function onAuthStateChanged(_auth, cb) {
  authListeners.add(cb);
  Promise.resolve().then(() => cb(auth.currentUser));
  return () => authListeners.delete(cb);
}

export async function sendEmailVerification(user) {
  console.log(`[mock] e-mail de verificação "enviado" para ${user.email}. Use window.__mock.verifyEmail("${user.email}") para simular a confirmação.`);
}

export async function sendPasswordResetEmail(_auth, email) {
  console.log(`[mock] e-mail de redefinição de senha "enviado" para ${email}.`);
}

/* ============================================================
   FIRESTORE MOCK
   ============================================================ */
const store = new Map(); // collectionName -> Map(id -> data)
const collListeners = new Map(); // collectionName -> Set({cb, kind:'doc'|'collection'|'query', id?, constraints?})
let docIdCounter = 0;

function collMap(name) {
  if (!store.has(name)) store.set(name, new Map());
  return store.get(name);
}

function resolveSentinels(data, existing) {
  const out = { ...data };
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (v && typeof v === "object" && "__increment" in v) {
      out[k] = (existing && typeof existing[k] === "number" ? existing[k] : 0) + v.__increment;
    } else if (v && typeof v === "object" && v.__serverTimestamp) {
      out[k] = new Date().toISOString();
    }
  }
  return out;
}

export const db = { __mockFirestore: true };

// Aceita caminhos com subcoleções, igual ao SDK real:
//   collection(db, "pessoas")
//   collection(db, "edicoes", "2027-1", "inscricoes")
// Internamente o "nome" da coleção é o caminho inteiro ("edicoes/2027-1/inscricoes"),
// o que basta para o mock isolar uma coleção da outra.
export function collection(_db, ...segs) { return { __type: "collection", name: segs.join("/") }; }

export function doc(a, ...rest) {
  if (a && a.__type === "collection") {
    // doc(collectionRef) -> id automático; doc(collectionRef, id)
    const id = rest[0] || "mockdoc" + (++docIdCounter);
    return { __type: "doc", name: a.name, id };
  }
  // doc(db, ...segmentos, id)
  const segs = [...rest];
  const id = segs.pop();
  return { __type: "doc", name: segs.join("/"), id };
}

export function query(collectionRef, ...constraints) {
  return { __type: "query", name: collectionRef.name, constraints };
}

export function where(field, op, value) { return { field, op, value }; }

function matchesConstraints(data, constraints) {
  return (constraints || []).every(c => {
    if (c.op === "==") return data[c.field] === c.value;
    return true;
  });
}

function snapshotDoc(name, id) {
  const data = collMap(name).get(id);
  return { id, exists: () => data !== undefined, data: () => data, ref: { __type: "doc", name, id } };
}

function snapshotQuery(name, constraints) {
  const map = collMap(name);
  const docs = [];
  map.forEach((data, id) => {
    if (matchesConstraints(data, constraints)) docs.push({ id, data: () => data, exists: () => true, ref: { __type: "doc", name, id } });
  });
  return { docs, size: docs.length, empty: docs.length === 0, forEach: fn => docs.forEach(fn) };
}

function notifyCollection(name) {
  const set = collListeners.get(name);
  if (!set) return;
  set.forEach(listener => {
    if (listener.kind === "doc") listener.cb(snapshotDoc(name, listener.id));
    else listener.cb(snapshotQuery(name, listener.constraints));
  });
}

export async function setDoc(docRef, data, opts) {
  const map = collMap(docRef.name);
  const existing = map.get(docRef.id);
  const resolved = resolveSentinels(data, existing);
  map.set(docRef.id, opts && opts.merge ? { ...existing, ...resolved } : resolved);
  notifyCollection(docRef.name);
}

export async function updateDoc(docRef, data) {
  const map = collMap(docRef.name);
  const existing = map.get(docRef.id) || {};
  map.set(docRef.id, { ...existing, ...resolveSentinels(data, existing) });
  notifyCollection(docRef.name);
}

export async function deleteDoc(docRef) {
  collMap(docRef.name).delete(docRef.id);
  notifyCollection(docRef.name);
}

export async function addDoc(collectionRef, data) {
  const id = "mockdoc" + (++docIdCounter);
  collMap(collectionRef.name).set(id, resolveSentinels(data, undefined));
  notifyCollection(collectionRef.name);
  return { id };
}

export async function getDoc(docRef) {
  if (!podeLer(docRef)) throw erroDePermissao(docRef);
  return snapshotDoc(docRef.name, docRef.id);
}

/* ------------------------------------------------------------
   A ÚNICA REGRA DE SEGURANÇA QUE O MOCK REPRODUZ
   ------------------------------------------------------------
   O mock não é um simulador de firestore.rules — os testes exercitam a lógica
   do app, não o servidor. A exceção é /contatos, porque ali o cumprimento da
   regra depende de o APP escolher o listener certo: um batuqueiro comum pode
   ler o próprio contato (doc), mas listar a coleção inteira é privilégio de
   admin. Se o app abrisse a listagem para todo mundo, contra o Firestore de
   verdade isso viraria erro de permissão em produção — e nenhum outro teste
   pegaria. Espelha match /contatos/{uid} em firestore.rules.
   ------------------------------------------------------------ */
let leiturasNegadas = 0;

function ehAdminNoMock() {
  const u = auth.currentUser;
  if (!u) return false;
  const p = collMap("pessoas").get(u.uid);
  if (p && p.adminAccess) return true;
  const legado = collMap("users").get(u.uid);
  return !!(legado && legado.adminAccess);
}

function podeLer(ref) {
  if (ref.name !== "contatos") return true;
  if (ehAdminNoMock()) return true;
  const u = auth.currentUser;
  if (ref.__type === "doc") return !!u && ref.id === u.uid;
  return false; // listar /contatos inteira exige admin
}

function erroDePermissao(ref) {
  leiturasNegadas++;
  const e = new Error(`Missing or insufficient permissions: ${ref.name}`);
  e.code = "permission-denied";
  return e;
}

export async function getDocs(ref) {
  if (!podeLer(ref)) throw erroDePermissao(ref);
  if (ref.__type === "query") return snapshotQuery(ref.name, ref.constraints);
  return snapshotQuery(ref.name, []);
}

export function onSnapshot(ref, cb, errCb) {
  if (!podeLer(ref)) {
    const err = erroDePermissao(ref);
    Promise.resolve().then(() => { if (errCb) errCb(err); });
    return () => {};
  }
  const name = ref.name;
  const listener = ref.__type === "doc" ? { kind: "doc", id: ref.id, cb } : { kind: ref.__type, constraints: ref.constraints || [], cb };
  if (!collListeners.has(name)) collListeners.set(name, new Set());
  collListeners.get(name).add(listener);
  if (ref.__type === "doc") Promise.resolve().then(() => cb(snapshotDoc(name, ref.id)));
  else Promise.resolve().then(() => cb(snapshotQuery(name, ref.constraints || [])));
  return () => collListeners.get(name).delete(listener);
}

export function writeBatch(_db) {
  const ops = [];
  return {
    set(ref, data, opts) { ops.push({ type: "set", ref, data, opts }); return this; },
    update(ref, data) { ops.push({ type: "update", ref, data }); return this; },
    delete(ref) { ops.push({ type: "delete", ref }); return this; },
    async commit() {
      const touched = new Set();
      for (const op of ops) {
        const map = collMap(op.ref.name);
        if (op.type === "delete") { map.delete(op.ref.id); }
        else {
          const existing = map.get(op.ref.id);
          const resolved = resolveSentinels(op.data, existing);
          map.set(op.ref.id, op.type === "set" && !(op.opts && op.opts.merge) ? resolved : { ...existing, ...resolved });
        }
        touched.add(op.ref.name);
      }
      touched.forEach(notifyCollection);
    },
  };
}

export function increment(n) { return { __increment: n }; }
export function serverTimestamp() { return { __serverTimestamp: true }; }

/* ============================================================
   HOOKS PARA TESTES (Playwright etc.)
   ============================================================ */
if (typeof window !== "undefined") {
  window.__mock = {
    verifyEmail(email) {
      const u = authUsersByEmail.get(email.toLowerCase());
      if (u) { u.emailVerified = true; notifyAuth(); }
    },
    dumpStore() {
      const out = {};
      store.forEach((map, name) => { out[name] = Object.fromEntries(map); });
      return out;
    },
    reset() {
      store.clear(); collListeners.clear(); authUsersByEmail.clear(); leiturasNegadas = 0; auth.currentUser = null; notifyAuth();
    },
    // Quantas leituras foram recusadas pela regra de /contatos até agora.
    leiturasNegadas() { return leiturasNegadas; },
    // Ajuda só para testes: simula o passo manual único (documentado no SETUP.md)
    // em que o dono do site concede adminAccess ao primeiro admin direto no
    // Firebase Console, já que ninguém ainda tem acesso para fazer isso pelo app.
    grantAdminAccessByEmail(email) {
      const authUser = authUsersByEmail.get(email.toLowerCase());
      if (!authUser) return false;
      const pessoas = collMap("pessoas");
      const existing = pessoas.get(authUser.uid);
      if (!existing) return false;
      pessoas.set(authUser.uid, { ...existing, adminAccess: true });
      notifyCollection("pessoas");
      return true;
    },
    // Ajuda só para testes: monta dados no FORMATO ANTIGO (tudo solto na raiz,
    // como era antes da separação por edições) para exercitar a migração.
    seedFormatoAntigo(dados) {
      Object.entries(dados).forEach(([nomeColecao, docs]) => {
        const map = collMap(nomeColecao);
        Object.entries(docs).forEach(([id, valor]) => map.set(id, valor));
        notifyCollection(nomeColecao);
      });
    },
    uidPorEmail(email) {
      const u = authUsersByEmail.get(email.toLowerCase());
      return u ? u.uid : null;
    },
  };
}
