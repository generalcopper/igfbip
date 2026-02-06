// iLovePaghe — Social Publisher (IG + FB) — Firestore queue
// UI super semplice: salva bozze e gestisce stati.
// Il tuo Cloud Run publisher poi leggerà i doc con status=queued oppure scheduleAt <= now.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";
import {
  getFirestore,
  collection,
  addDoc,
  doc,
  updateDoc,
  serverTimestamp,
  query,
  orderBy,
  limit,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

// 1) Incolla qui la tua config Firebase (la stessa che usi nel resto del sito)
const firebaseConfig = {
  "projectId": "ilp-social-admin-2602061451",
  "appId": "1:108182410176:web:38bf497affced52cb92e25",
  "storageBucket": "ilp-social-admin-2602061451.firebasestorage.app",
  "apiKey": "AIzaSyDPyP3HgLQnoEeVd9HjQorzgON-LE8zfbM",
  "authDomain": "ilp-social-admin-2602061451.firebaseapp.com",
  "messagingSenderId": "108182410176",
  "projectNumber": "108182410176",
  "version": "2"
};


const ALLOWED_EMAILS = [
  "ludovicogiarola.com"
];

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ---- UI refs
const $ = (id) => document.getElementById(id);

const authChip = $("authChip");
const btnLogin = $("btnLogin");
const btnLogout = $("btnLogout");
const mustLogin = $("mustLogin");
const appWrap = $("app");
const uidBadge = $("uidBadge");

const pIG = $("pIG");
const pFB = $("pFB");
const format = $("format");
const caption = $("caption");
const hashtags = $("hashtags");
const mediaUrl = $("mediaUrl");
const scheduleAt = $("scheduleAt");
const initialStatus = $("initialStatus");

const btnSave = $("btnSave");
const btnClear = $("btnClear");
const btnRefresh = $("btnRefresh");
const rows = $("rows");

// ---- helpers
function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toNiceDate(dtLike) {
  if (!dtLike) return "—";
  try {
    // dtLike can be ISO string or a Firestore Timestamp-like object
    if (typeof dtLike === "string") {
      const d = new Date(dtLike);
      if (isNaN(d.getTime())) return "—";
      return d.toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
    }
    if (dtLike?.toDate) {
      const d = dtLike.toDate();
      return d.toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
    }
    return "—";
  } catch {
    return "—";
  }
}

function statusDot(status) {
  if (status === "published") return "ok";
  if (status === "queued" || status === "approved") return "warn";
  if (status === "error") return "bad";
  return "";
}

function platformsLabel(platforms) {
  const ig = platforms?.ig ? "IG" : "";
  const fb = platforms?.fb ? "FB" : "";
  const out = [ig, fb].filter(Boolean).join(" + ");
  return out || "—";
}

function normalizeLower(s = "") {
  return String(s).trim().toLowerCase();
}

function isEmailAllowed(email) {
  const e = normalizeLower(email);
  if (!e) return false;

  for (const raw of ALLOWED_EMAILS) {
    const rule = normalizeLower(raw);
    if (!rule) continue;

    // Regola: email completa (es. "nome@dominio.com")
    if (rule.includes("@")) {
      if (e === rule) return true;
      continue;
    }

    // Regola: dominio (es. "dominio.com" oppure "@dominio.com")
    const domain = rule.startsWith("@") ? rule.slice(1) : rule;
    if (e.endsWith(`@${domain}`) || e === domain) return true;
  }

  return false;
}

function requireAuth(user) {
  if (!user) return false;
  return isEmailAllowed(user.email || "");
}

function setAuthBusy(isBusy) {
  btnLogin.disabled = !!isBusy;
  btnLogin.style.opacity = isBusy ? "0.8" : "";
  btnLogin.style.pointerEvents = isBusy ? "none" : "";
}

function shouldFallbackToRedirect(err) {
  const code = normalizeLower(err?.code || "");
  const msg = normalizeLower(err?.message || "");

  if (code === "popup-timeout") return true;

  const popupCodes = new Set([
    "auth/popup-blocked",
    "auth/popup-closed-by-user",
    "auth/cancelled-popup-request",
    "auth/operation-not-supported-in-this-environment"
  ]);

  if (popupCodes.has(code)) return true;

  // Alcuni browser su GitHub Pages bloccano il controllo popup.closed/window.close per COOP.
  if (msg.includes("cross-origin-opener-policy")) return true;
  if (msg.includes("window.close") || msg.includes("window.closed")) return true;

  return false;
}

function promiseWithTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const e = new Error("POPUP_TIMEOUT");
      e.code = "popup-timeout";
      reject(e);
    }, ms);

    promise
      .then((v) => {
        clearTimeout(t);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(t);
        reject(e);
      });
  });
}

async function loginGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  authChip.textContent = "Accesso in corso…";
  setAuthBusy(true);

  try {
    // Popup first: UX migliore.
    // Su GitHub Pages alcuni browser possono bloccare window.close/closed (COOP) → fallback redirect.
    await promiseWithTimeout(signInWithPopup(auth, provider), 7000);
    // Se va a buon fine, onAuthStateChanged aggiorna la UI.
  } catch (err) {
    const code = normalizeLower(err?.code || "");

    if (code === "auth/unauthorized-domain") {
      setAuthBusy(false);
      authChip.textContent = "Dominio non autorizzato";
      alert(
        "Dominio non autorizzato su Firebase Auth.\n\n" +
          "Vai in Firebase Console → Authentication → Settings → Authorized domains e aggiungi:\n" +
          "- generalcopper.github.io"
      );
      throw err;
    }

    if (shouldFallbackToRedirect(err)) {
      authChip.textContent = "Reindirizzamento per accesso…";
      // Innesca redirect: la pagina si ricarica e poi getRedirectResult() chiude il cerchio.
      await signInWithRedirect(auth, provider);
      return;
    }

    console.error("Login error:", err);
    authChip.textContent = "Errore accesso";
    alert("Accesso non riuscito. Riprova.");
    throw err;
  } finally {
    // Se è andata in redirect la pagina cambierà; se è andata bene/persa, riabilitiamo il bottone.
    setAuthBusy(false);
  }
}

// ---- auth
btnLogin.addEventListener("click", loginGoogle);

btnLogout.addEventListener("click", async () => {
  await signOut(auth);
});

// Gestione ritorno da signInWithRedirect()
(async () => {
  try {
    await getRedirectResult(auth);
    // onAuthStateChanged gestisce il resto.
  } catch (err) {
    const code = normalizeLower(err?.code || "");
    if (code === "auth/unauthorized-domain") {
      authChip.textContent = "Dominio non autorizzato";
      console.error(err);
    } else if (code) {
      console.error("Redirect result error:", err);
    }
  }
})();

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    authChip.textContent = "Non autenticato";
    btnLogin.classList.remove("hidden");
    btnLogout.classList.add("hidden");
    mustLogin.classList.remove("hidden");
    appWrap.classList.add("hidden");
    uidBadge.textContent = "";
    rows.innerHTML = "";
    return;
  }

  if (!requireAuth(user)) {
    authChip.textContent = "Accesso non autorizzato";
    await signOut(auth);
    return;
  }

  authChip.textContent = user.email || "Autenticato";
  btnLogin.classList.add("hidden");
  btnLogout.classList.remove("hidden");
  mustLogin.classList.add("hidden");
  appWrap.classList.remove("hidden");
  uidBadge.textContent = user.uid;

  await refreshTable();
});

// ---- actions
btnClear.addEventListener("click", () => {
  caption.value = "";
  hashtags.value = "";
  mediaUrl.value = "";
  scheduleAt.value = "";
  format.value = "image";
  pIG.checked = true;
  pFB.checked = true;
  initialStatus.value = "draft";
});

btnSave.addEventListener("click", async () => {
  const user = auth.currentUser;
  if (!requireAuth(user)) return;

  const cap = caption.value.trim();
  const url = mediaUrl.value.trim();
  const sch = scheduleAt.value ? new Date(scheduleAt.value) : null;

  if (!cap) {
    alert("Inserisci la caption.");
    return;
  }
  if (!pIG.checked && !pFB.checked) {
    alert("Seleziona almeno una piattaforma.");
    return;
  }
  if (!url) {
    alert("Inserisci un Media URL HTTPS (anche temporaneo, poi lo colleghiamo a Storage).");
    return;
  }
  if (!/^https:\/\//i.test(url)) {
    alert("Il Media URL deve essere HTTPS.");
    return;
  }

  const docData = {
    ownerUid: user.uid,
    ownerEmail: (user.email || "").toLowerCase(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),

    platforms: { ig: !!pIG.checked, fb: !!pFB.checked },
    format: format.value, // image | reel | carousel
    caption: cap,
    hashtags: hashtags.value.trim(),

    media: {
      url,
      type: format.value === "reel" ? "video" : "image"
    },

    scheduleAt: sch ? sch.toISOString() : null,
    status: initialStatus.value, // draft | approved | queued
    lastError: ""
  };

  await addDoc(collection(db, "socialJobs"), docData);
  await refreshTable();
});

btnRefresh.addEventListener("click", refreshTable);

// ---- table rendering
async function refreshTable() {
  const user = auth.currentUser;
  if (!requireAuth(user)) return;

  const q = query(
    collection(db, "socialJobs"),
    orderBy("createdAt", "desc"),
    limit(50)
  );

  const snap = await getDocs(q);

  const items = [];
  snap.forEach((d) => items.push({ id: d.id, ...d.data() }));

  rows.innerHTML = items.map(renderRow).join("");

  // bind row buttons
  items.forEach((it) => {
    const btnApprove = document.querySelector(`[data-approve="${it.id}"]`);
    const btnQueue = document.querySelector(`[data-queue="${it.id}"]`);
    const btnDelete = document.querySelector(`[data-delete="${it.id}"]`);

    if (btnApprove) btnApprove.addEventListener("click", () => setStatus(it.id, "approved"));
    if (btnQueue) btnQueue.addEventListener("click", () => setStatus(it.id, "queued"));
    if (btnDelete) btnDelete.addEventListener("click", () => softDelete(it.id));
  });
}

function renderRow(it) {
  const s = it.status || "draft";
  const dot = statusDot(s);
  const when = it.scheduleAt ? toNiceDate(it.scheduleAt) : "—";
  const plats = platformsLabel(it.platforms);

  const cap = (it.caption || "").trim();
  const capShort = cap.length > 160 ? cap.slice(0, 160) + "…" : cap;

  const canApprove = s === "draft";
  const canQueue = s === "approved" || s === "draft";

  return `
    <tr>
      <td>
        <span class="status">
          <span class="dot ${dot}"></span>
          ${escapeHtml(s)}
        </span>
        ${it.lastError ? `<div class="small" style="margin-top:6px;color:#b42318">${escapeHtml(it.lastError)}</div>` : ``}
      </td>
      <td class="small">${escapeHtml(when)}</td>
      <td class="small mono">${escapeHtml(plats)}</td>
      <td>${escapeHtml(capShort)}</td>
      <td>
        <div class="inlineBtns">
          <button class="btn" ${canApprove ? "" : "disabled"} data-approve="${it.id}">Approva</button>
          <button class="btn btnPrimary" ${canQueue ? "" : "disabled"} data-queue="${it.id}">Metti in coda</button>
          <button class="btn btnDanger" data-delete="${it.id}">Rimuovi</button>
        </div>
      </td>
    </tr>
  `;
}

async function setStatus(id, status) {
  const user = auth.currentUser;
  if (!requireAuth(user)) return;

  await updateDoc(doc(db, "socialJobs", id), {
    status,
    updatedAt: serverTimestamp(),
    lastError: ""
  });

  await refreshTable();
}

async function softDelete(id) {
  const user = auth.currentUser;
  if (!requireAuth(user)) return;

  await updateDoc(doc(db, "socialJobs", id), {
    status: "deleted",
    updatedAt: serverTimestamp()
  });

  await refreshTable();
}
