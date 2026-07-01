import { create } from 'zustand';

interface UIState {
  selectedLeadId: string | null;
  // Optional sub-tab to deep-link into when opening the lead drawer (e.g. 'checks').
  selectedLeadTab: string | null;
  newLeadOpen: boolean;
  financingLeadId: string | null;
  selectLead: (id: string | null, tab?: string | null) => void;
  openNewLead: () => void;
  closeNewLead: () => void;
  openFinancing: (id: string) => void;
  closeFinancing: () => void;
}

export const useUI = create<UIState>((set) => ({
  selectedLeadId: null,
  selectedLeadTab: null,
  newLeadOpen: false,
  financingLeadId: null,
  selectLead: (id, tab = null) => set({ selectedLeadId: id, selectedLeadTab: tab }),
  openNewLead: () => set({ newLeadOpen: true }),
  closeNewLead: () => set({ newLeadOpen: false }),
  openFinancing: (id) => set({ financingLeadId: id }),
  closeFinancing: () => set({ financingLeadId: null }),
}));
