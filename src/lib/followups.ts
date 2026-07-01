import type { ContactOutcome, FollowUpType, Lead } from '../types';

export const DAY = 24 * 3600 * 1000;

// Escalating nurture cadence (days from now). Each completed touch advances to
// the next interval so a warm lead never goes silent after a single follow-up.
const CADENCE_DAYS = [1, 2, 3, 7, 14, 30];

// Given how many touches have already happened, the next nurture follow-up.
// Returns null once the cadence is exhausted (operator should mark Lost).
export function nextTouch(
  lead: Lead,
  priorTouches: number,
): { at: number; type: FollowUpType; note: string } | null {
  // A court date always takes priority — drive toward the pre-court call.
  if (lead.nextCourtDate) {
    const court = new Date(lead.nextCourtDate);
    const weekBefore = court.getTime() - 7 * DAY;
    const dayBefore = court.getTime() - 1 * DAY;
    const now = Date.now();
    if (now < weekBefore) return { at: weekBefore, type: 'week_before', note: 'Week-before-court call' };
    if (now < dayBefore) return { at: dayBefore, type: 'day_before', note: 'Day-before-court call' };
  }
  if (priorTouches >= CADENCE_DAYS.length) return null;
  const days = CADENCE_DAYS[priorTouches];
  return { at: Date.now() + days * DAY, type: 'nurture', note: `Nurture touch #${priorTouches + 1}` };
}

// The next follow-up for a contact outcome. A manually chosen date always wins;
// otherwise pick a sensible default per outcome (pre-court if we have a date).
// Lives outside any component so the render-purity lint doesn't flag Date.now().
export function computeFollow(
  o: ContactOutcome,
  nextCourtDate: string | null | undefined,
  followDate = '',
  followType: FollowUpType | null = null,
): { at: number; type: FollowUpType; note: string } | null {
  if (followDate) {
    return {
      at: new Date(followDate + 'T09:00:00').getTime(),
      type: followType || 'callback',
      note: 'Manual follow-up',
    };
  }
  const now = Date.now();
  if (o === 'no_answer' || o === 'voicemail')
    return { at: now + DAY, type: 'callback', note: 'Call back' };
  if (o === 'thinking')
    return { at: now + 3 * DAY, type: 'nurture', note: 'Check back' };
  if (o === 'spoke')
    return { at: now + 2 * DAY, type: 'callback', note: 'Follow up on decision' };
  if (o === 'declined') {
    if (nextCourtDate) {
      const d = new Date(nextCourtDate);
      d.setDate(d.getDate() - 7);
      return {
        at: Math.max(now + DAY, d.getTime()),
        type: 'week_before',
        note: 'Pre-court check-in',
      };
    }
    return { at: now + 7 * DAY, type: 'nurture', note: 'Follow up' };
  }
  return null;
}
