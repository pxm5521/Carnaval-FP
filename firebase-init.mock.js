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

export function collection(_db, name) { return { __type: "collection", name }; }

export function doc(a, b, c) {
  if (a && a.__type === "collection") {
    const name = a.name;
    const id = b || "mockdoc" + (++docIdCounter);
    return { __type: "doc", name, id };
  }
  // doc(db, name, id)
  return { __type: "doc", name: b, id: c };
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
  return snapshotDoc(docRef.name, docRef.id);
}

export async function getDocs(ref) {
  if (ref.__type === "query") return snapshotQuery(ref.name, ref.constraints);
  return snapshotQuery(ref.name, []);
}

export function onSnapshot(ref, cb) {
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
      store.clear(); collListeners.clear(); authUsersByEmail.clear(); auth.currentUser = null; notifyAuth();
    },
    // Ajuda só para testes: simula o passo manual único (documentado no SETUP.md)
    // em que o dono do site concede adminAccess ao primeiro admin direto no
    // Firebase Console, já que ninguém ainda tem acesso para fazer isso pelo app.
    grantAdminAccessByEmail(email) {
      const authUser = authUsersByEmail.get(email.toLowerCase());
      if (!authUser) return false;
      const users = collMap("users");
      const existing = users.get(authUser.uid);
      if (!existing) return false;
      users.set(authUser.uid, { ...existing, adminAccess: true });
      notifyCollection("users");
      return true;
    },
  };
}
