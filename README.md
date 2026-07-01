# TVCHub — Intake & Sales Command Center

A multi-user web app that turns TVC Pro Driver referral leads into a "notepad /
video-game" intake and sales command center for a traffic-law practice. It tracks
every lead through contact, pitch, retain/decline, multi-touch follow-up, and
financing — ending at a **Client Intake Complete** handoff to the next
department.

Court filings, motions, and deadlines are intentionally **out of scope**; this
tool is laser-focused on intake and sales.

## Stack

- React + TypeScript + Vite
- Tailwind CSS (legal-pad aesthetic) + Framer Motion (card flip / stamp animations)
- Firebase: Auth, Firestore (real-time), Hosting, Storage, Cloud Functions
- `date-fns` for court-date / reminder math, Zustand for app state

## Phases

| Phase | What | Status |
| ----- | ---- | ------ |
| 1 | Notepad UI + full lead lifecycle on real Firestore. Leads added manually, by pasting a TVC email, or by uploading the referral PDF (AI extraction). | ✅ |
| 2 | Gmail auto-ingestion via an Apps Script bridge — TVC emails become lead cards automatically; attachments saved to Storage. | ✅ (deploy + config to go live) |

Payments are **not** processed in-app. The firm takes payment on its own
terminal (or by cash/check) and records the amount + method here so the
financing tracker and reporting stay accurate. There is intentionally no Square
or other gateway integration.

## Local Development

```bash
npm install
cp .env.example .env.local   # fill in Firebase web app keys
npm run dev
```

Until `.env.local` has valid Firebase keys, the app boots to a "Firebase not
configured" screen.

## Firebase Setup

1. Create a Firebase project; enable **Authentication (Email/Password)**,
   **Firestore**, **Storage**, and (for Phase 2/3) **Functions** (Blaze plan).
2. Add a Web App; copy its config into `.env.local`.
3. Put your project id in `.firebaserc`.
4. Create your firm staff users in the Auth console.
5. Deploy rules + hosting:

```bash
npm run build
firebase deploy --only firestore:rules,storage,hosting
```

## Phase 2 — Gmail Ingestion (Apps Script bridge)

A small Google Apps Script runs inside the intake mailbox, polls for new TVC
referral emails, and POSTs each one to the `ingestEmail` Cloud Function. The
function extracts the fields (LLM, with a regex fallback), saves any attachments
to Storage with tokenized download URLs, dedupes by message id / TVC case
number, and drops a new card on the desk.

The pieces:

- `functions/src/ingest.ts` — the `ingestEmail` HTTP endpoint.
- `functions/src/extract.ts` — the `extractPdf` callable used by the in-app
  "Upload PDF" flow.
- `functions/src/llm.ts` — OpenAI extraction (shared by both).
- `functions/src/parser.ts` — regex parser / fallback.
- `apps-script/Code.gs` — the mailbox bridge (full setup steps in its header).

Setup:

```bash
firebase functions:secrets:set INGEST_TOKEN    # shared secret with Apps Script
firebase functions:secrets:set OPENAI_API_KEY
firebase deploy --only functions
```

Then follow the SETUP comment at the top of `apps-script/Code.gs` (set
`FUNCTION_URL` + `INGEST_TOKEN` script properties, authorize, install the
trigger). `OPENAI_MODEL` is a non-secret param in `functions/.env`.

## Payments

Payments are recorded, not processed. In the Retain panel and the Financing
modal, enter the amount taken and the method (Card / Cash / Check / Other). No
external gateway is contacted.

## Project Layout

```
src/
  components/        UI: notepad card, drawers, modals, shell, primitives
  pages/             The Desk, Command Center, Retained, Financing
  lib/               parser, dates, lead flow, actions, payments, validation
  store/             Zustand stores (leads, UI) + Firestore subscription
  context/           Auth context
  firebase.ts        Firebase client init (env-driven, boots without config)
functions/
  src/ingest.ts      ingestEmail HTTP endpoint (Apps Script bridge)
  src/extract.ts     extractPdf callable (in-app PDF upload)
  src/llm.ts         OpenAI extraction
  src/parser.ts      TVC referral parser / fallback
  src/index.ts       Function exports
apps-script/
  Code.gs            Gmail → ingestEmail bridge
```
# TVCHub
