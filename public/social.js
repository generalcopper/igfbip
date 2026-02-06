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

// Completa eventuale login via redirect (in caso di fallback)
getRedirectResult(auth).catch((err) => {
  if (err) console.warn("[auth] redirect result error:", err);
});

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

function requireAuth(user) {
  if (!user) return false;

  const email = (user.email || "").trim().toLowerCase();
  if (!email) return false;

  const domain = email.includes("@") ? email.split("@")[1] : "";

  const allowed = (ALLOWED_EMAILS || [])
    .map(e => String(e || "").trim().toLowerCase())
    .filter(Boolean);

  return allowed.some(entry => {
    // entry può essere:
    // - email completa: "nome@dominio.com"
    // - dominio: "dominio.com" (abilita qualunque @dominio.com)
    if (entry.includes("@")) return email === entry;
    return domain === entry || domain === entry.replace(/^@/, "");
  });
}

// ---- auth
let lastAuthMessage = "";

btnLogin.addEventListener("click", async () => {
  const provider = new GoogleAuthProvider();

  // Su hosting statici (es. GitHub Pages) alcuni browser bloccano i controlli su window.close/closed
  // e il popup può restare "appeso". Facciamo:
  // - popup come prima scelta
  // - se non risponde entro poco o fallisce → fallback a redirect (sempre affidabile)
  authChip.textContent = "Apertura accesso…";

  const POPUP_TIMEOUT_MS = 3500;

  try {
    await Promise.race([
      signInWithPopup(auth, provider),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("popup-timeout")), POPUP_TIMEOUT_MS)
      )
    ]);
  } catch (err) {
    console.warn("[auth] popup non disponibile, fallback redirect:", err);
    authChip.textContent = "Apertura accesso…";
    await signInWithRedirect(auth, provider);
  }
});

btnLogout.addEventListener("click", async () => {
  await signOut(auth);
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    authChip.textContent = lastAuthMessage || "Non autenticato";
    // Mantieni il messaggio (es. Accesso non autorizzato) finché l’utente non riprova
    

    btnLogin.classList.remove("hidden");
    btnLogout.classList.add("hidden");
    mustLogin.classList.remove("hidden");
    appWrap.classList.add("hidden");
    uidBadge.textContent = "";
    rows.innerHTML = "";
    return;
  }

  if (!requireAuth(user)) {
    lastAuthMessage = "Accesso non autorizzato: " + (user.email || "");
    authChip.textContent = lastAuthMessage;
    await signOut(auth);
    return;
  }

  lastAuthMessage = "";

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
