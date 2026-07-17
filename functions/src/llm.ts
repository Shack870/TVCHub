// Multimodal LLM extraction of TVC referrals (OpenAI). Used by both the PDF
// upload path (page images) and the Gmail intake path (email text).

const SCHEMA_KEYS = [
  "emailKind", "messageText",
  "tvcCaseNumber", "name", "phone", "email", "address", "birthdate", "language",
  "driversLicense", "driversLicenseState", "driversLicenseType", "vehicleType",
  "violationDate", "caseOpenedOn", "familyMemberName", "familyMemberRelationship",
  "tickets", "charge", "courtName", "courtPhone", "courtAddress", "courtCity",
  "county", "state", "courtZip", "movingViolation", "preExisting",
  "accidentInvolved", "examinationReport", "nextCourtDate", "nextCourtTime",
  "nextCourtType", "attorneyNames", "firmName", "firmAddress", "firmPhone",
  "firmFax", "attorneyMobile", "attorneyEmail", "lawType", "tvcNotes",
];

const SYSTEM = `You extract structured data from a TVC Pro Driver traffic-law referral (page images or email text).
Return ONLY a JSON object with these keys: ${SCHEMA_KEYS.join(", ")}.
Rules:
- "name", "phone", "email", "address", "birthdate", "language", "driversLicense*", "vehicleType" describe the MEMBER (the client/driver) from the "Member Info" column. NEVER use the firm/attorney info for these.
- "attorney*"/"firm*"/"lawType" come from "Attorney Info" (our firm).
- "courtName","courtPhone","courtAddress","courtCity","county","state","courtZip" come from "Court Info".
- "movingViolation","preExisting","accidentInvolved","examinationReport" come from "Driver Info".
- "tickets" is an array of {number, violation, code} from the Tickets table; "charge" is a short "; "-joined summary of the violations.
- Dates as ISO yyyy-mm-dd. "nextCourtDate"/"nextCourtTime"/"nextCourtType" from the first row of "Court Dates".
- "tvcNotes" = the "Description/Entry/Date" activity log as readable text.
- "emailKind": "referral" when the content is a structured case referral (member/court/ticket data or a referral form); "message" when it is a human-written note, question, complaint, or status request from TVC staff about a case (e.g. "Member is upset... can you give him an update?"). A message may mention a case number and member name but carries no referral form data.
- "messageText": only when emailKind is "message" — the human-written body verbatim, without signature blocks, legal footers, or inline-image placeholders. Otherwise null.
- Use null for anything not present. Do not invent values. Strip the internal "FLEET" tag from city names.`;

export interface ExtractInput {
  images?: string[]; // base64 PNGs (no data: prefix)
  text?: string;
}

export interface ExtractResult {
  fields: Record<string, unknown>;
  usage?: unknown;
}

// When the email body is thin, the referral form is usually in an attached PDF.
// The Responses API can read a PDF directly (no rasterization needed).
export async function extractLeadFromPdf(
  base64Pdf: string,
  apiKey: string,
  model: string,
): Promise<ExtractResult> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: `${SYSTEM}\n\nExtract the referral into JSON.` },
            {
              type: "input_file",
              filename: "referral.pdf",
              file_data: `data:application/pdf;base64,${base64Pdf}`,
            },
          ],
        },
      ],
    }),
  });
  const json = (await res.json()) as {
    output_text?: string;
    output?: { content?: { type?: string; text?: string }[] }[];
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(json.error?.message || `OpenAI PDF error ${res.status}`);
  let raw = json.output_text || "";
  if (!raw && Array.isArray(json.output)) {
    raw = json.output
      .flatMap((o) => (o.content || []).filter((c) => c.type === "output_text").map((c) => c.text || ""))
      .join("");
  }
  const m = raw.match(/\{[\s\S]*\}/);
  let fields: Record<string, unknown>;
  try {
    fields = JSON.parse(m ? m[0] : "{}");
  } catch {
    fields = {};
  }
  for (const k of Object.keys(fields)) {
    if (fields[k] === null || fields[k] === "") delete fields[k];
  }
  return { fields };
}

export async function extractLead(
  input: ExtractInput,
  apiKey: string,
  model: string,
): Promise<ExtractResult> {
  const content: unknown[] = [
    { type: "text", text: "Extract the referral into JSON per the schema." },
  ];
  if (input.images?.length) {
    for (const b64 of input.images) {
      content.push({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${b64}`, detail: "high" },
      });
    }
  } else if (input.text) {
    content.push({ type: "text", text: input.text.slice(0, 60000) });
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content },
      ],
    }),
  });

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: unknown;
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(json.error?.message || `OpenAI error ${res.status}`);
  }
  const raw = json.choices?.[0]?.message?.content || "{}";
  let fields: Record<string, unknown>;
  try {
    fields = JSON.parse(raw);
  } catch {
    fields = {};
  }
  // Drop null/empty values so they don't overwrite defaults.
  for (const k of Object.keys(fields)) {
    if (fields[k] === null || fields[k] === "") delete fields[k];
  }
  return { fields, usage: json.usage };
}
