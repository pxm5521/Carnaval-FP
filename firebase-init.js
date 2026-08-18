// ============================================================
// Configuração do Firebase — PREENCHA com os dados do SEU projeto.
//
// Onde encontrar: Firebase Console → ⚙️ Configurações do projeto →
// role até "Seus apps" → app Web → "Configuração do SDK".
//
// Veja o passo a passo completo em SETUP.md.
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  writeBatch,
  increment,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBH-i32SpHulQzxZEvdtqsJM-Hmz3H7VGs",
  authDomain: "carnaval-fp.firebaseapp.com",
  projectId: "carnaval-fp",
  storageBucket: "carnaval-fp.firebasestorage.app",
  messagingSenderId: "792678285440",
  appId: "1:792678285440:web:5aa6c25cb78579b8852665",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  writeBatch,
  increment,
  serverTimestamp,
};
