import { useEffect } from 'react';
import { create } from 'zustand';
import type { Lead } from '../types';
import { watchLeads } from '../lib/db';

interface LeadState {
  leads: Lead[];
  loading: boolean;
  error: string | null;
  capped: boolean;
  subscribed: boolean;
  setLeads: (leads: Lead[], capped: boolean) => void;
  setError: (e: string | null) => void;
  setSubscribed: (b: boolean) => void;
}

export const useLeadStore = create<LeadState>((set) => ({
  leads: [],
  loading: true,
  error: null,
  capped: false,
  subscribed: false,
  // A successful snapshot also clears any prior error.
  setLeads: (leads, capped) => set({ leads, capped, loading: false, error: null }),
  setError: (error) => set({ error, loading: false }),
  setSubscribed: (subscribed) => set({ subscribed }),
}));

let unsub: (() => void) | null = null;

// Call once (from an authenticated shell) to begin the realtime subscription.
export function useLeadsSubscription(enabled: boolean): void {
  const setLeads = useLeadStore((s) => s.setLeads);
  const setError = useLeadStore((s) => s.setError);
  const setSubscribed = useLeadStore((s) => s.setSubscribed);

  useEffect(() => {
    if (!enabled) return;
    setSubscribed(true);
    try {
      unsub = watchLeads(setLeads, setError);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load leads');
    }
    return () => {
      if (unsub) unsub();
      unsub = null;
      setSubscribed(false);
    };
  }, [enabled, setLeads, setError, setSubscribed]);
}

export function useLeads(): Lead[] {
  return useLeadStore((s) => s.leads);
}

// Health of the realtime leads subscription, for surfacing problems in the UI.
// Select primitives individually — returning a new object from the selector
// would change identity every render and cause an infinite update loop.
export function useLeadsStatus(): { error: string | null; capped: boolean; loading: boolean } {
  const error = useLeadStore((s) => s.error);
  const capped = useLeadStore((s) => s.capped);
  const loading = useLeadStore((s) => s.loading);
  return { error, capped, loading };
}

export function useLead(id: string | undefined): Lead | undefined {
  return useLeadStore((s) => s.leads.find((l) => l.id === id));
}
