import { useEffect } from 'react';
import { create } from 'zustand';
import type { Letter } from '../types';
import { watchLetters } from '../lib/db';

interface LetterState {
  letters: Letter[];
  setLetters: (letters: Letter[]) => void;
}

export const useLetterStore = create<LetterState>((set) => ({
  letters: [],
  setLetters: (letters) => set({ letters }),
}));

let unsub: (() => void) | null = null;

// Call once (from an authenticated shell) to begin the realtime subscription.
export function useLettersSubscription(enabled: boolean): void {
  const setLetters = useLetterStore((s) => s.setLetters);
  useEffect(() => {
    if (!enabled) return;
    try {
      unsub = watchLetters(setLetters);
    } catch (e) {
      console.error('letters subscription failed', e);
    }
    return () => {
      if (unsub) unsub();
      unsub = null;
    };
  }, [enabled, setLetters]);
}

export function useLetters(): Letter[] {
  return useLetterStore((s) => s.letters);
}
