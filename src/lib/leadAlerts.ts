// New-lead arrival alerts: an in-app toast plus (opt-in) a desktop browser
// notification whenever a lead lands on the desk, so reps don't have to be
// staring at the board to know someone new needs a first call.

import type { Lead } from '../types';
import { notify } from '../store/useToast';

const PREF_KEY = 'tvchub.newLeadAlerts';

// Alerts default ON; the Settings toggle can turn them off per browser.
export function alertsEnabled(): boolean {
  return localStorage.getItem(PREF_KEY) !== 'off';
}

export function setAlertsEnabled(on: boolean): void {
  localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

// Only announce genuinely fresh arrivals, not old docs shuffling around the
// subscription window (e.g. after an archive/restore).
const FRESH_WINDOW_MS = 10 * 60_000;

let known: Set<string> | null = null;

// Called with every leads snapshot. The first snapshot only seeds the known-id
// set (no alerts on page load); afterwards, any unseen id that was created
// recently triggers an alert.
export function announceNewLeads(leads: Lead[]): void {
  if (known === null) {
    known = new Set(leads.map((l) => l.id));
    return;
  }
  const unseen = leads.filter((l) => !known!.has(l.id));
  for (const l of leads) known.add(l.id);
  if (unseen.length === 0 || !alertsEnabled()) return;

  const now = Date.now();
  const arrivals = unseen.filter((l) => now - (l.createdAt ?? 0) < FRESH_WINDOW_MS);
  if (arrivals.length === 0) return;

  const label =
    arrivals.length === 1
      ? `New lead: ${arrivals[0].name}${arrivals[0].county ? ` (${arrivals[0].county})` : ''}`
      : `${arrivals.length} new leads arrived`;

  notify.success(label);

  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const body =
        arrivals.length === 1
          ? [arrivals[0].charge, arrivals[0].courtName].filter(Boolean).join(' · ')
          : arrivals.map((l) => l.name).slice(0, 5).join(', ');
      const n = new Notification(label, { body, icon: '/favicon.svg', tag: 'tvchub-new-lead' });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      // Notification construction can throw on some platforms; the toast
      // already covered the in-app case.
    }
  }
}
