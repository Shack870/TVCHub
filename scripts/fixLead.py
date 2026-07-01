import sys, json, base64, urllib.request, subprocess

DOC_ID = sys.argv[1]
PROJECT = "tvchub-f2401"
BASE = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents/leads/{DOC_ID}"

token = subprocess.check_output(["gcloud", "auth", "print-access-token"]).decode().strip()
key = ""
for line in open("/Users/jodyshackelford/TVCHub/.env.local"):
    if line.startswith("OPENAI_API_KEY="):
        key = line.split("=", 1)[1].strip()

# 1. Read the lead to get its PDF URL.
req = urllib.request.Request(BASE, headers={"Authorization": f"Bearer {token}", "x-goog-user-project": PROJECT})
doc = json.load(urllib.request.urlopen(req))
atts = doc["fields"].get("attachments", {}).get("arrayValue", {}).get("values", [])
pdf_path = None
for a in atts:
    af = a["mapValue"]["fields"]
    if af.get("name", {}).get("stringValue", "").lower().endswith(".pdf"):
        pdf_path = af.get("path", {}).get("stringValue")
        break
if not pdf_path:
    print("no pdf attachment"); sys.exit(1)

subprocess.check_call(["gcloud", "storage", "cp",
                       f"gs://tvchub-f2401.firebasestorage.app/{pdf_path}", "/tmp/_fixlead.pdf",
                       "--project", PROJECT])
pdf_b64 = base64.b64encode(open("/tmp/_fixlead.pdf", "rb").read()).decode()

SYSTEM = """You extract structured data from a TVC Pro Driver traffic-law referral PDF.
Return ONLY a JSON object with these keys: tvcCaseNumber, name, phone, email, address, birthdate, language, driversLicense, driversLicenseState, driversLicenseType, vehicleType, violationDate, caseOpenedOn, familyMemberName, familyMemberRelationship, tickets, charge, courtName, courtPhone, courtAddress, courtCity, county, state, courtZip, movingViolation, preExisting, accidentInvolved, examinationReport, nextCourtDate, nextCourtTime, nextCourtType, attorneyNames, firmName, firmAddress, firmPhone, firmFax, attorneyMobile, attorneyEmail, lawType, tvcNotes.
member fields describe the client; attorney/firm fields are the law firm. Dates ISO yyyy-mm-dd. tickets is an array of {number, violation, code}; charge is a "; "-joined summary. Strip the internal "FLEET" tag from city. Use null for missing."""

payload = {"model": "gpt-4o", "input": [{"role": "user", "content": [
    {"type": "input_text", "text": SYSTEM + "\n\nExtract the referral into JSON."},
    {"type": "input_file", "filename": "r.pdf", "file_data": "data:application/pdf;base64," + pdf_b64}]}]}
req = urllib.request.Request("https://api.openai.com/v1/responses", data=json.dumps(payload).encode(),
                             headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
resp = json.load(urllib.request.urlopen(req))
raw = resp.get("output_text") or "".join(
    c.get("text", "") for o in resp.get("output", []) for c in o.get("content", []) if c.get("type") == "output_text")
import re
m = re.search(r"\{[\s\S]*\}", raw)
fields = json.loads(m.group(0)) if m else {}
fields = {k: v for k, v in fields.items() if v not in (None, "", [])}
print("extracted:", {k: fields[k] for k in ("name", "courtName", "county", "state", "charge") if k in fields})

def fv(v):
    if isinstance(v, bool): return {"booleanValue": v}
    if isinstance(v, str): return {"stringValue": v}
    if isinstance(v, int): return {"integerValue": str(v)}
    if isinstance(v, float): return {"doubleValue": v}
    if isinstance(v, list): return {"arrayValue": {"values": [fv(x) for x in v]}}
    if isinstance(v, dict): return {"mapValue": {"fields": {k: fv(x) for k, x in v.items()}}}
    return {"nullValue": None}

mask = "&".join(f"updateMask.fieldPaths={k}" for k in fields)
body = json.dumps({"fields": {k: fv(v) for k, v in fields.items()}}).encode()
req = urllib.request.Request(BASE + "?" + mask, data=body, method="PATCH",
                             headers={"Authorization": f"Bearer {token}", "x-goog-user-project": PROJECT, "Content-Type": "application/json"})
urllib.request.urlopen(req)
print("Lead updated.")
