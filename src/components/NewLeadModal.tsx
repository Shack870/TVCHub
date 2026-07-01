import { useMemo, useState } from 'react';
import { Modal } from './ui/Modal';
import { Badge } from './ui/Badge';
import { useUI } from '../store/useUI';
import { useLeads } from '../store/useLeads';
import { httpsCallable } from 'firebase/functions';
import { parseTvc } from '../lib/tvcParser';
import { functions } from '../firebase';
import { addLead } from '../lib/actions';
import { updateLead } from '../lib/db';
import { notify } from '../store/useToast';
import { validateLead } from '../lib/validation';
import type { Lead } from '../types';

type Tab = 'paste' | 'pdf' | 'manual';

export function NewLeadModal() {
  const open = useUI((s) => s.newLeadOpen);
  const close = useUI((s) => s.closeNewLead);
  const [tab, setTab] = useState<Tab>('paste');

  return (
    <Modal open={open} onClose={close} width="max-w-2xl">
      <div className="legal-pad rounded-lg p-6 pl-14 shadow-card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-hand text-3xl ink">New Lead</h2>
          <button className="btn-ghost text-pad-ink" onClick={close}>
            ✕
          </button>
        </div>
        <div className="mb-4 flex rounded-lg bg-black/10 p-1">
          <TabBtn active={tab === 'paste'} onClick={() => setTab('paste')}>
            Paste Email
          </TabBtn>
          <TabBtn active={tab === 'pdf'} onClick={() => setTab('pdf')}>
            Upload PDF
          </TabBtn>
          <TabBtn active={tab === 'manual'} onClick={() => setTab('manual')}>
            Manual Entry
          </TabBtn>
        </div>
        {tab === 'paste' && <PasteForm onDone={close} />}
        {tab === 'pdf' && <PdfForm onDone={close} />}
        {tab === 'manual' && <ManualForm onDone={close} initial={{}} />}
      </div>
    </Modal>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-md px-3 py-1.5 font-type text-sm font-semibold transition ${
        active ? 'bg-pad-ink text-pad-paper' : 'text-pad-ink'
      }`}
    >
      {children}
    </button>
  );
}

function PasteForm({ onDone }: { onDone: () => void }) {
  const [raw, setRaw] = useState('');
  const [parsed, setParsed] = useState<Partial<Lead> | null>(null);
  const [count, setCount] = useState(0);

  const run = () => {
    const res = parseTvc(raw);
    setParsed(res.fields);
    setCount(res.matchedCount);
  };

  if (parsed) {
    return (
      <div>
        <div className="mb-3 flex items-center gap-2">
          <Badge tone="green">{count} fields parsed</Badge>
          <button
            className="text-xs text-pad-inkSoft underline"
            onClick={() => setParsed(null)}
          >
            ← back to paste
          </button>
        </div>
        <ManualForm
          onDone={onDone}
          initial={{ ...parsed, source: 'paste', rawEmail: raw }}
        />
      </div>
    );
  }

  return (
    <div>
      <p className="mb-2 font-type text-xs text-pad-inkSoft">
        Paste the full TVC referral email (or the attachment text). Fields are
        auto-extracted; you can review before saving.
      </p>
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        rows={10}
        placeholder="TVC Legal Case: 1540425 …"
        className="w-full rounded-md border border-black/10 bg-white/80 p-3 font-type text-sm text-pad-ink"
      />
      <div className="mt-3 flex justify-end">
        <button className="btn-primary" disabled={!raw.trim()} onClick={run}>
          Parse →
        </button>
      </div>
    </div>
  );
}

function PdfForm({ onDone }: { onDone: () => void }) {
  const [parsed, setParsed] = useState<Partial<Lead> | null>(null);
  const [count, setCount] = useState(0);
  const [fileName, setFileName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    setBusy(true);
    setError(null);
    setFileName(file.name);
    setFile(file);
    try {
      // Loaded on demand so pdf.js (~1 MB) isn't in the main bundle.
      const { pdfToImages } = await import('../lib/pdfImages');
      const images = await pdfToImages(file);
      const fn = httpsCallable(functions, 'extractPdf');
      const res = await fn({ images });
      const data = res.data as { ok: boolean; fields: Partial<Lead> };
      const fields = data.fields || {};
      setParsed(fields);
      setCount(Object.keys(fields).length);
    } catch (e) {
      setError(
        e instanceof Error
          ? `Could not read PDF: ${e.message}`
          : 'Could not read this PDF.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (parsed) {
    return (
      <div>
        <div className="mb-3 flex items-center gap-2">
          <Badge tone="green">{count} fields parsed</Badge>
          <span className="truncate font-type text-xs text-pad-inkSoft">
            {fileName}
          </span>
          <button
            className="ml-auto text-xs text-pad-inkSoft underline"
            onClick={() => setParsed(null)}
          >
            ← upload another
          </button>
        </div>
        <ManualForm
          onDone={onDone}
          initial={{ ...parsed, source: 'manual' }}
          attachFile={file}
        />
      </div>
    );
  }

  return (
    <div>
      <p className="mb-3 font-type text-xs text-pad-inkSoft">
        Upload the TVC referral (email saved as PDF, or the attachment PDF). The
        AI reads the pages and fills the fields; you can review before saving.
      </p>
      <label
        className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-black/20 bg-white/50 px-6 py-10 text-center transition hover:border-pad-ink/40 hover:bg-white/70"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files?.[0];
          if (file) handleFile(file);
        }}
      >
        <span className="font-hand text-2xl ink">
          {busy ? 'Reading PDF…' : 'Drop a PDF here'}
        </span>
        <span className="mt-1 font-type text-xs text-pad-inkSoft">
          or click to choose a file
        </span>
        <input
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
      </label>
      {error && (
        <p className="mt-3 font-type text-xs font-semibold text-pad-red">{error}</p>
      )}
    </div>
  );
}

function ManualForm({
  onDone,
  initial,
  attachFile,
}: {
  onDone: () => void;
  initial: Partial<Lead>;
  attachFile?: File | null;
}) {
  const leads = useLeads();
  const [f, setF] = useState<Partial<Lead>>(initial);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Lead) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  // Flag a likely duplicate by TVC case # (or exact phone match).
  const dupe = useMemo(() => {
    const tvc = (f.tvcCaseNumber ?? '').trim();
    const phone = (f.phone ?? '').replace(/[^\d]/g, '');
    return leads.find(
      (l) =>
        (tvc && l.tvcCaseNumber?.trim() === tvc) ||
        (phone.length >= 7 && (l.phone ?? '').replace(/[^\d]/g, '') === phone),
    );
  }, [leads, f.tvcCaseNumber, f.phone]);

  // Lightweight validation — don't let obviously malformed data save.
  const errors = useMemo(() => validateLead(f), [f]);
  const canSave = errors.length === 0 && !busy;

  const save = async () => {
    if (errors.length > 0) return;
    setBusy(true);
    const id = await addLead({
      ...f,
      name: f.name || 'Unknown',
      source: f.source ?? 'manual',
    });
    // Persist the uploaded PDF so the source document isn't lost.
    if (attachFile) {
      try {
        const { uploadLeadAttachment } = await import('../lib/storage');
        const att = await uploadLeadAttachment(id, attachFile);
        await updateLead(id, { attachments: [att], pdfUrl: att.url });
      } catch {
        notify.error("Lead saved, but the PDF couldn't be attached.");
      }
    }
    setBusy(false);
    onDone();
  };

  return (
    <div className="max-h-[55vh] overflow-y-auto pr-1 scrollbar-thin">
      {dupe && (
        <div className="mb-3 rounded-md bg-amber-500/15 p-2 font-type text-xs text-amber-900">
          ⚠ Possible duplicate of <strong>{dupe.name}</strong>
          {dupe.tvcCaseNumber ? ` (TVC #${dupe.tvcCaseNumber})` : ''} — already in the
          system. Check before adding again.
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 font-type text-sm">
        <Input label="Name" value={f.name} onChange={set('name')} span />
        <Input label="TVC Case #" value={f.tvcCaseNumber} onChange={set('tvcCaseNumber')} />
        <Input label="Phone" value={f.phone} onChange={set('phone')} />
        <Input label="Alt Phone" value={f.altPhone} onChange={set('altPhone')} />
        <Input label="Email" value={f.email} onChange={set('email')} />
        <Input label="Address" value={f.address} onChange={set('address')} span />
        <Input label="Charge" value={f.charge} onChange={set('charge')} span />
        <Input label="Court Name" value={f.courtName} onChange={set('courtName')} span />
        <Input label="County" value={f.county} onChange={set('county')} />
        <Input label="State" value={f.state} onChange={set('state')} />
        <Input
          label="Next Court Date"
          type="date"
          value={f.nextCourtDate ?? ''}
          onChange={set('nextCourtDate')}
        />
        <Input label="Court Time" value={f.nextCourtTime} onChange={set('nextCourtTime')} />
      </div>
      {errors.length > 0 && (
        <ul className="mt-3 list-disc rounded-md bg-pad-red/10 p-2 pl-6 font-type text-xs text-pad-red">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost text-pad-ink" onClick={onDone}>
          Cancel
        </button>
        <button className="btn-primary" disabled={!canSave} onClick={save}>
          {busy ? 'Saving…' : 'Add to Desk'}
        </button>
      </div>
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  span,
  type = 'text',
}: {
  label: string;
  value?: string | null;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  span?: boolean;
  type?: string;
}) {
  return (
    <label className={`block ${span ? 'col-span-2' : ''}`}>
      <span className="field-label">{label}</span>
      <input
        type={type}
        value={value ?? ''}
        onChange={onChange}
        className="mt-1 w-full rounded-md border border-black/10 bg-white/80 p-2 text-pad-ink"
      />
    </label>
  );
}
