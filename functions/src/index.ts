import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// TVCHub Cloud Functions.
//
// Email ingestion runs through the Apps Script bridge (see apps-script/Code.gs),
// which posts each new TVC referral to `ingestEmail`. The browser's manual
// "Upload PDF" flow calls `extractPdf`. There is intentionally no Square /
// payments function — payments are taken outside the app and recorded by hand.
initializeApp();

// The regex fallback parser produces objects with explicit `undefined` values
// for fields it couldn't find; without this, Firestore rejects the whole lead
// document — which turned every LLM-outage fallback into a crash/retry loop.
getFirestore().settings({ ignoreUndefinedProperties: true });

export { ingestEmail } from "./ingest.js";
export { extractPdf } from "./extract.js";
