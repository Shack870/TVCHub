import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret, defineString } from "firebase-functions/params";
import { extractLead } from "./llm.js";

export const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const OPENAI_MODEL = defineString("OPENAI_MODEL");

// Called by the browser's New Lead -> Upload PDF flow. The client renders the
// PDF pages to PNGs and sends them here; the key never touches the browser.
export const extractPdf = onCall(
  { secrets: [OPENAI_API_KEY], memory: "512MiB", timeoutSeconds: 120 },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required.");
    const images = (req.data?.images as string[]) || [];
    if (!images.length) {
      throw new HttpsError("invalid-argument", "No page images provided.");
    }
    const model = OPENAI_MODEL.value() || "gpt-4o";
    try {
      const { fields } = await extractLead({ images }, OPENAI_API_KEY.value(), model);
      return { ok: true, fields };
    } catch (e) {
      throw new HttpsError(
        "internal",
        e instanceof Error ? e.message : "Extraction failed",
      );
    }
  },
);
