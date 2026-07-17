import { useEffect } from 'react';
import { create } from 'zustand';
import type { TvcMessage } from '../types';
import { watchMessages } from '../lib/db';

interface MessageState {
  messages: TvcMessage[];
  setMessages: (messages: TvcMessage[]) => void;
}

export const useMessageStore = create<MessageState>((set) => ({
  messages: [],
  setMessages: (messages) => set({ messages }),
}));

let unsub: (() => void) | null = null;

// Call once (from an authenticated shell) to begin the realtime subscription.
export function useMessagesSubscription(enabled: boolean): void {
  const setMessages = useMessageStore((s) => s.setMessages);
  useEffect(() => {
    if (!enabled) return;
    try {
      unsub = watchMessages(setMessages);
    } catch (e) {
      console.error('messages subscription failed', e);
    }
    return () => {
      if (unsub) unsub();
      unsub = null;
    };
  }, [enabled, setMessages]);
}

export function useMessages(): TvcMessage[] {
  return useMessageStore((s) => s.messages);
}
