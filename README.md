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
| 1 | Notepad UI + full lead lifecycle on real Firestore. Payments **simulated**, retainer is a checkbox. Leads added manually or by pasting a TVC email. | ✅ |
| 2 | Gmail auto-ingestion (Cloud Functions + Pub/Sub) — TVC emails become lead cards automatically; PDFs saved to Storage. | ✅ (deploy + config to go live) |
| 3 | Square payments (keyed card-not-present + payment link) behind the `PaymentProvider` interface. | ✅ (set `VITE_PAYMENTS=square` + secrets to go live) |

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

## Phase 2 — Gmail Ingestion

The pieces live in `functions/`:

- `registerGmailWatch` (callable) — registers a Gmail push watch on the inbox.
- `renewGmailWatch` (scheduled daily) — Gmail watches expire ~7 days.
- `onGmailNotification` (Pub/Sub) — fetches new messages, parses TVC referrals
  (`functions/src/parser.ts`), saves PDF attachments to Storage, creates leads.

Setup:

1. Create a Pub/Sub topic `gmail-incoming` and grant
   `gmail-api-push@system.gserviceaccount.com` the Publisher role.
2. Create a service account with **domain-wide delegation** authorized for the
   `gmail.readonly` scope, able to impersonate the intake inbox.
3. Configure params/secrets:

```bash
firebase functions:secrets:set GMAIL_SA_KEY      # paste the SA JSON key
firebase deploy --only functions \
  --set-env-vars GMAIL_USER=intake@yourfirm.com,GMAIL_TOPIC=projects/<id>/topics/gmail-incoming
```

4. Call `registerGmailWatch` once (signed in) to start the watch.

## Phase 3 — Square Payments

Default is the **simulated** provider. To go live:

```bash
firebase functions:secrets:set SQUARE_ACCESS_TOKEN
firebase deploy --only functions \
  --set-env-vars SQUARE_LOCATION_ID=<loc>,SQUARE_ENV=sandbox
```

Then set `VITE_PAYMENTS=square` in `.env.local` and rebuild. Card-not-present
("keyed") charges require a card token from the Square Web Payments SDK passed as
`sourceId`; payment links are generated server-side.

## Project Layout

```
src/
  components/        UI: notepad card, drawers, modals, shell, primitives
  pages/             The Desk, Command Center, Retained, Financing
  lib/               parser, dates, lead flow, actions, payments
  store/             Zustand stores (leads, UI) + Firestore subscription
  context/           Auth context
  firebase.ts        Firebase client init (env-driven, boots without config)
functions/
  src/parser.ts      TVC referral parser (server copy)
  src/gmail.ts       Gmail client + attachment handling
  src/square.ts      Square payment Cloud Functions
  src/index.ts       Function exports + ingestion pipeline
```
# TVCHub
