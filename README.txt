# iLovePaghe — Social Publisher (IG + FB) — Admin UI (Firestore)

Contenuto:
- public/social.html
- public/social.js

## Setup rapido
1) Copia `public/social.html` e `public/social.js` nella cartella `public/` del tuo hosting Firebase.
2) Apri `public/social.js` e incolla la tua `firebaseConfig`.
3) Deploy:
   - firebase deploy

## URL
- https://www.ilovepaghe.com/social.html

## Firestore
La UI salva su:
- collection: `socialJobs`

Il tuo publisher (Cloud Run) potrà leggere i documenti con:
- status = queued
- e scheduleAt <= now (se presente)
