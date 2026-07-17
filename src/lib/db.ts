import {
  addDoc,
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '../firebase';
import { notify } from '../store/useToast';
import type { Lead, TvcMessage } from '../types';

const LEADS = 'leads';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Unknown error';
}

// Thrown internally when a guarded write detects a concurrent edit.
class ConflictError extends Error {}

// Cap the realtime subscription so memory/cost stay bounded as the collection
// grows. The newest N leads cover active work and recent reporting. At ~30-50
// leads/week this is multiple years of runway; when the cap is actually hit the
// UI shows a warning (see watchLeads `capped`) so it never silently truncates.
const LEADS_LIMIT = 5000;

export function watchLeads(
  cb: (leads: Lead[], capped: boolean) => void,
  onError?: (msg: string) => void,
): () => void {
  const q = query(
    collection(db, LEADS),
    orderBy('createdAt', 'desc'),
    limit(LEADS_LIMIT),
  );
  return onSnapshot(
    q,
    (snap) => {
      const capped = snap.docs.length >= LEADS_LIMIT;
      const leads = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as object) }) as Lead)
        // Hide soft-deleted (archived) files from every view.
        .filter((l) => !l.deletedAt);
      cb(leads, capped);
    },
    (err) => {
      console.error('watchLeads error', err);
      onError?.(errMsg(err));
    },
  );
}

// Archived (soft-deleted) files only — used by the Archived view. These are
// excluded from the main watchLeads subscription.
export function watchArchivedLeads(cb: (leads: Lead[]) => void): () => void {
  const q = query(
    collection(db, LEADS),
    where('deletedAt', '>', 0),
    orderBy('deletedAt', 'desc'),
    limit(500),
  );
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as object) }) as Lead)),
    (err) => console.error('watchArchivedLeads error', err),
  );
}

// TVC staff messages (post-it notes on the Desk). Newest first.
export function watchMessages(
  cb: (messages: TvcMessage[]) => void,
  onError?: (msg: string) => void,
): () => void {
  const q = query(collection(db, 'messages'), orderBy('receivedAt', 'desc'), limit(200));
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as object) }) as TvcMessage)),
    (err) => {
      console.error('watchMessages error', err);
      onError?.(errMsg(err));
    },
  );
}

// Takes a handled note off the desk for good (kept in the database).
export async function archiveMessage(id: string): Promise<void> {
  try {
    await updateDoc(doc(db, 'messages', id), {
      deletedAt: Date.now(),
      updatedAt: Date.now(),
    });
  } catch (e) {
    notify.error(`Couldn't archive the message — ${errMsg(e)}`);
    throw e;
  }
}

export async function setMessageHandled(
  id: string,
  handled: boolean,
  handledBy?: string | null,
): Promise<void> {
  try {
    await updateDoc(doc(db, 'messages', id), {
      handled,
      handledAt: handled ? Date.now() : null,
      handledBy: handled ? (handledBy ?? null) : null,
      updatedAt: Date.now(),
    });
  } catch (e) {
    notify.error(`Couldn't update the message — ${errMsg(e)}`);
    throw e;
  }
}

export async function createLead(data: Omit<Lead, 'id'>): Promise<string> {
  try {
    const ref = await addDoc(collection(db, LEADS), {
      ...data,
      createdAt: data.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      _serverCreatedAt: serverTimestamp(),
    });
    return ref.id;
  } catch (e) {
    notify.error(`Couldn't create the lead — ${errMsg(e)}`);
    throw e;
  }
}

export async function updateLead(id: string, patch: Partial<Lead>): Promise<void> {
  try {
    await updateDoc(doc(db, LEADS, id), {
      ...patch,
      updatedAt: Date.now(),
    } as Record<string, unknown>);
  } catch (e) {
    notify.error(`Couldn't save changes — ${errMsg(e)}`);
    throw e;
  }
}

// Thrown by a mutateLead mutator when a business rule fails against the FRESH
// document (e.g. payment exceeds balance). Carries a user-facing message; the
// caller decides how to surface it, so mutateLead doesn't toast it.
export class LeadCheckError extends Error {}

// Transactional read-modify-write: reads the CURRENT lead inside a Firestore
// transaction and applies `mutate` to it, so two users acting on the same lead
// can never clobber each other's appends (contact attempts, payments,
// follow-ups). The mutator gets the fresh doc — never a stale UI snapshot —
// and returns the patch to apply (or null to skip writing).
export async function mutateLead(
  id: string,
  mutate: (fresh: Lead) => Partial<Lead> | null,
): Promise<void> {
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, LEADS, id);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('This lead no longer exists.');
      const fresh = { id: snap.id, ...(snap.data() as object) } as Lead;
      const patch = mutate(fresh);
      if (!patch) return;
      tx.update(ref, { ...patch, updatedAt: Date.now() } as Record<string, unknown>);
    });
  } catch (e) {
    if (!(e instanceof LeadCheckError)) {
      notify.error(`Couldn't save changes — ${errMsg(e)}`);
    }
    throw e;
  }
}

// Optimistic-concurrency write for free-text field edits: if another user saved
// a change after this edit began (lead.updatedAt advanced past baseUpdatedAt),
// abort instead of silently clobbering their work. Returns conflict:true so the
// caller can keep the latest value and tell the user.
export async function updateLeadGuarded(
  id: string,
  patch: Partial<Lead>,
  baseUpdatedAt?: number,
): Promise<{ ok: boolean; conflict?: boolean }> {
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, LEADS, id);
      const snap = await tx.get(ref);
      const cur = snap.data() as Lead | undefined;
      if (cur?.updatedAt && baseUpdatedAt && cur.updatedAt > baseUpdatedAt) {
        throw new ConflictError();
      }
      tx.update(ref, { ...patch, updatedAt: Date.now() } as Record<string, unknown>);
    });
    return { ok: true };
  } catch (e) {
    if (e instanceof ConflictError) return { ok: false, conflict: true };
    notify.error(`Couldn't save changes — ${errMsg(e)}`);
    return { ok: false };
  }
}
