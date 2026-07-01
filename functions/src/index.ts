import { initializeApp } from "firebase-admin/app";

// TVCHub Cloud Functions.
//
// Email ingestion runs through the Apps Script bridge (see apps-script/Code.gs),
// which posts each new TVC referral to `ingestEmail`. The browser's manual
// "Upload PDF" flow calls `extractPdf`. There is intentionally no Square /
// payments function — payments are taken outside the app and recorded by hand.
initializeApp();

export { ingestEmail } from "./ingest.js";
export { extractPdf } from "./extract.js";
