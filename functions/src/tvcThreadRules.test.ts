import { describe, expect, it } from 'vitest';
import {
  classifyReply,
  extractBareCaseNumbers,
  extractCaseNumbers,
  isPleasantry,
  planLeadWrites,
  stripQuotedHistory,
  buildNameIndex,
  findNamedLeads,
  type TvcMessageFacts,
} from './tvcThreadRules.js';

// --- Case-number extraction: every REAL format from the corpus -------------

describe('extractCaseNumbers', () => {
  const formats: [string, string][] = [
    ['Case:1564563', '1564563'],
    ['TVC 25% Case 1559857', '1559857'],
    ['Case# 1444463', '1444463'],
    // The dashed format a manual audit's first regex MISSED — a decline was
    // silently dropped because of it.
    ['CASE - 1554711 - RIDDELL, DANIEL', '1554711'],
    ['Case ID 1559178', '1559178'],
    ['TVC Legal Case: 1526639', '1526639'],
    ['Regarding the case for this member, 1563109, he retained', '1563109'],
    ['Re: TVC 1563144 Dessie', '1563144'],
  ];
  for (const [text, expected] of formats) {
    it(`extracts "${expected}" from "${text}"`, () => {
      expect(extractCaseNumbers(text)).toEqual([expected]);
    });
  }

  it('finds numbers in subject and body text together', () => {
    expect(
      extractCaseNumbers('Re: Case# 1444463\nWe cannot proceed on TVC case 1559178.'),
    ).toEqual(['1444463', '1559178']);
  });

  it('dedupes repeats of the same number', () => {
    expect(extractCaseNumbers('Case 1564563 ... again Case:1564563')).toEqual(['1564563']);
  });

  it('ignores 7-digit runs with no case/TVC anchor nearby', () => {
    expect(extractCaseNumbers('our fee is $1125.00 and my number is 5015551234567890')).toEqual([]);
    expect(extractCaseNumbers('invoice 1559857 attached')).toEqual([]);
  });

  it('never slices 7 digits out of a longer number', () => {
    expect(extractCaseNumbers('case ref 15598571 (8 digits)')).toEqual([]);
  });

  it('rejects out-of-range 7-digit runs (TVC member ids like "(9032788)")', () => {
    expect(extractCaseNumbers('Re: TVC Case:1551630 - Pablo Guillen (9032788)//AR// Coverage:25%')).toEqual([
      '1551630',
    ]);
  });
});

describe('extractBareCaseNumbers', () => {
  it('finds in-range 7-digit runs without a keyword (for known-case matching)', () => {
    // Real subject with no "case"/"TVC" anywhere.
    expect(extractBareCaseNumbers('Re: Alberta King - 1525899')).toEqual(['1525899']);
    expect(extractBareCaseNumbers('member id (9032788) only')).toEqual([]);
    expect(extractBareCaseNumbers('longer 15598571 run')).toEqual([]);
  });
});

// --- Phrase-anchored classification ----------------------------------------

describe('classifyReply', () => {
  it('DECLINED anchor', () => {
    const c = classifyReply('This member has declined our services at this time.');
    expect(c.kind).toBe('declined');
    expect(c.anchor).toMatch(/declined our services/i);
  });

  it('RETAINED anchors — past tense, "decided to retain", singular "service"', () => {
    expect(classifyReply('He has retained our services and paid in full.').kind).toBe('retained');
    expect(classifyReply('This member has decided to retain our services.').kind).toBe('retained');
    expect(classifyReply('This client retained our service').kind).toBe('retained');
    expect(classifyReply('This client retained our services today.').kind).toBe('retained');
  });

  it('a conditional fee quote never reads as retained', () => {
    const c = classifyReply(
      'With the 25% discount, the retainer fee would be $1,125 to retain our services in the beginning of the case and a potential $750 trial fee.',
    );
    expect(c.kind).toBe('none'); // negotiation traffic → timeline only
  });

  it('negated anchors go to review, never auto-act', () => {
    expect(classifyReply('The member has not retained our services.').kind).toBe('review');
    expect(classifyReply("He hasn't declined our services yet.").kind).toBe('review');
  });

  it('CORRECTION anchors — mix-up, correction, apology', () => {
    expect(classifyReply('Apologies — we mixed this member up with another driver.').kind).toBe('correction');
    expect(classifyReply('Please disregard, a correction to our earlier note.').kind).toBe('correction');
    expect(classifyReply('We apologize, that update was for a different case.').kind).toBe('correction');
    expect(classifyReply('Sorry, we mix these two up sometimes.').kind).toBe('correction');
  });

  it('CORRECTION wins over other anchors (retractions never auto-route)', () => {
    const c = classifyReply(
      'Correction: this member has NOT declined our services — that was another driver.',
    );
    expect(c.kind).toBe('correction');
  });

  it('NOT-VIABLE anchors — every variant', () => {
    for (const text of [
      'We cannot assist with this matter.',
      'The charges were dismissed before we were engaged.',
      'The charge was dismissed at arraignment.',
      'His charges already dismissed per the clerk.',
      'He already entered a guilty plea on his own.',
      'She already paid the fine herself.',
      'The member already paid the citation before contacting us.',
      'He already paid the ticket at the courthouse.',
      'They reached a plea deal with the prosecutor.',
      'There is nothing currently pending on his record.',
    ]) {
      expect(classifyReply(text).kind, text).toBe('not_viable');
    }
  });

  it('disposition-ish words without an anchor go to review, never auto', () => {
    for (const text of [
      'The member is declining to move forward for now.',
      'We believe he retained different counsel.',
      'The court dismissed part of it, unclear on the rest.',
      'He hired someone else.',
    ]) {
      expect(classifyReply(text).kind, text).toBe('review');
    }
  });

  it('two anchors in one reply is ambiguity — review', () => {
    expect(
      classifyReply('He declined our services because the charges were dismissed.').kind,
    ).toBe('review');
  });

  it('ordinary negotiation traffic classifies as none', () => {
    expect(
      classifyReply('Our fee for this covered case would be $1,125 less the 25% TVC discount.').kind,
    ).toBe('none');
    expect(classifyReply('Okay, thank you so much!').kind).toBe('none');
  });

  it('fee quotes with "retainer fee" + dollars are none, not review', () => {
    expect(
      classifyReply(
        'After the 25% discount, the retainer fee is $1,125.00. If the case proceeds to trial, there will be an additional trial fee of $750.00. We do not collect that unless it goes to trial.',
      ).kind,
    ).toBe('none');
  });
});

// --- Quoted-history stripping / pleasantries --------------------------------

describe('stripQuotedHistory', () => {
  it('keeps only the fresh reply above "On ... wrote:"', () => {
    const t = stripQuotedHistory(
      'He retained our services.\n\nOn Jul 17, 2026, at 9:01 AM, TVC Legal <cases@prodriver.com> wrote:\n> Please advise on Case:1563109',
    );
    expect(t).toBe('He retained our services.');
  });

  it('cuts at >-quoted lines, Original Message, and From: blocks', () => {
    expect(stripQuotedHistory('Declined our services.\n> old text')).toBe('Declined our services.');
    expect(stripQuotedHistory('Declined our services.\n----- Original Message -----\nold')).toBe(
      'Declined our services.',
    );
    expect(stripQuotedHistory('Declined our services.\nFrom: TVC <cases@prodriver.com>\nold')).toBe(
      'Declined our services.',
    );
  });

  it('drops standard signatures', () => {
    expect(stripQuotedHistory('Will do.\n-- \nJody Shackelford\nIron Rock Law')).toBe('Will do.');
  });

  it('classification never sees the quoted history', () => {
    const raw =
      'Thank you, we will follow up.\n\nOn Jul 2, 2026 TVC wrote:\n> The member declined our services';
    expect(classifyReply(stripQuotedHistory(raw)).kind).toBe('none');
  });
});

describe('isPleasantry', () => {
  it('short thank-you replies are pleasantries; real content is not', () => {
    expect(isPleasantry('Okay, thank you so much!')).toBe(true);
    expect(isPleasantry('')).toBe(true);
    expect(
      isPleasantry('The member has declined our services at this time, please close the referral.'),
    ).toBe(false);
  });
});

// --- Other-lead name detection ----------------------------------------------

describe('name index', () => {
  const index = buildNameIndex([
    { id: 'a', name: 'Parmjeet Singh' },
    { id: 'b', name: 'Dessie Tekle Abera' },
    { id: 'c', name: 'Al Bo' }, // too short — never indexed
  ]);

  it('finds a lead named mid-reply, normalized', () => {
    const hits = findNamedLeads('we mixed him up with PARMJEET SINGH’s case', index);
    expect([...hits.keys()]).toEqual(['a']);
  });

  it('matches first+last skipping middle names', () => {
    const hits = findNamedLeads('regarding Dessie Abera, disregard', index);
    expect([...hits.keys()]).toEqual(['b']);
  });

  it('no false hits on unrelated text or too-short names', () => {
    expect(findNamedLeads('our fee is $1,125 for Al Bo', index).size).toBe(0);
  });
});

// --- Per-lead write plans -----------------------------------------------------

const TS = new Date('2026-07-15T16:00:00Z').getTime();

const facts = (over: Partial<TvcMessageFacts> = {}): TvcMessageFacts => ({
  gmailMessageId: 'gm1',
  ts: TS,
  subject: 'Re: TVC 25% Case 1559857',
  replyText: 'The member has declined our services at this time, please close the referral.',
  caseNumber: '1559857',
  classification: classifyReply(
    over.replyText ??
      'The member has declined our services at this time, please close the referral.',
  ),
  otherLeadNames: [],
  ...over,
});

const lead = (over: Record<string, unknown> = {}) => ({
  name: 'Mohamed Abdo',
  stage: 'callback',
  saleStatus: null,
  contactAttempts: [],
  followUps: [
    { id: 'a', type: 'chase', dueAt: TS + 86400_000, done: false },
    { id: 'b', type: 'week_before', dueAt: TS + 5 * 86400_000, done: false },
    { id: 'c', type: 'day_before', dueAt: TS + 10 * 86400_000, done: false },
    { id: 'd', type: 'billing', dueAt: TS + 86400_000, done: false },
  ],
  ...over,
});

describe('planLeadWrites — DECLINED', () => {
  it('routes an active unsold lead to lost, mirroring noSaleRouting semantics', () => {
    const plan = planLeadWrites(lead(), facts());
    expect(plan.action).toBe('declined_routed_lost');
    expect(plan.patch!.stage).toBe('lost');
    expect(plan.patch!.lostAt).toBe(TS); // business date = the reply
    expect(plan.patch!.lostReason).toMatch(/declined our services/i);
    expect(plan.patch!.lostReason).toMatch(/1559857/);
    // Sales follow-ups close; court reminders survive (resurrection path).
    const fus = plan.patch!.followUps as { id: string; done: boolean }[];
    expect(fus.find((f) => f.id === 'a')!.done).toBe(true);
    expect(fus.find((f) => f.id === 'b')!.done).toBe(false);
    expect(fus.find((f) => f.id === 'c')!.done).toBe(false);
    expect(fus.find((f) => f.id === 'd')!.done).toBe(true);
    // The declined attempt quotes the reply + case number + provenance.
    expect(plan.attempt!.outcome).toBe('declined');
    expect(plan.attempt!.via).toBe('email');
    expect(plan.attempt!.by).toBe('TVC thread sync');
    expect(plan.attempt!.notes).toMatch(/from the firm's reply to TVC/);
    expect(plan.postIt).toBeNull();
  });

  it('already-lost lead: recognizes state, writes only the timeline entry', () => {
    const plan = planLeadWrites(lead({ stage: 'lost', lostAt: TS - 86400_000 }), facts());
    expect(plan.action).toBe('declined_already_lost');
    expect(plan.patch).toBeNull();
    expect(plan.attempt).not.toBeNull();
    expect(plan.postIt).toBeNull();
  });

  it('never re-loses a revived lead — contradiction post-it instead', () => {
    const plan = planLeadWrites(lead({ lostRevivedAt: TS - 1 }), facts());
    expect(plan.action).toBe('declined_needs_review');
    expect(plan.patch).toBeNull();
    expect(plan.postIt!.subject).toMatch(/needs review/);
  });

  it('never touches paid or off-board leads — contradiction post-it instead', () => {
    for (const over of [
      { saleStatus: 'paid_full' },
      { saleStatus: 'paid_partial' },
      { stage: 'intake_complete' },
      { stage: 'financed' },
    ]) {
      const plan = planLeadWrites(lead(over), facts());
      expect(plan.action, JSON.stringify(over)).toBe('declined_needs_review');
      expect(plan.patch).toBeNull();
    }
  });

  it('a reply older than the current lost stamp cannot act', () => {
    const plan = planLeadWrites(lead({ lostAt: TS + 1 }), facts());
    expect(plan.action).toBe('declined_needs_review');
  });
});

describe('planLeadWrites — RETAINED', () => {
  const retainedFacts = () =>
    facts({ replyText: 'This member has retained our services, thank you.' });

  it('pauses the chase and asks a human — never guesses money', () => {
    const plan = planLeadWrites(lead(), retainedFacts());
    expect(plan.action).toBe('retained_flagged');
    expect(plan.patch).toEqual({ possibleExistingClientAt: TS });
    expect(plan.postIt!.subject).toBe('Retained per TVC thread but unsold in app — Mohamed Abdo');
    expect(plan.postIt!.message).toMatch(/retained our services/i);
  });

  it('already sold in the app: marker + timeline only', () => {
    for (const over of [
      { saleStatus: 'paid_full' },
      { stage: 'intake_complete' },
      { stage: 'financed' },
    ]) {
      const plan = planLeadWrites(lead(over), retainedFacts());
      expect(plan.action).toBe('retained_already_sold');
      expect(plan.patch).toBeNull();
      expect(plan.postIt).toBeNull();
    }
  });

  it('already flagged possible-existing-client: no re-stamp, no new post-it', () => {
    const plan = planLeadWrites(lead({ possibleExistingClientAt: TS - 1 }), retainedFacts());
    expect(plan.action).toBe('retained_already_flagged');
    expect(plan.patch).toBeNull();
    expect(plan.postIt).toBeNull();
  });

  it('retained but the app says lost — contradiction post-it', () => {
    const plan = planLeadWrites(lead({ stage: 'lost' }), retainedFacts());
    expect(plan.action).toBe('retained_but_lost_needs_review');
    expect(plan.patch).toBeNull();
    expect(plan.postIt).not.toBeNull();
  });
});

describe('planLeadWrites — NOT-VIABLE / CORRECTION / review', () => {
  it('not-viable flags for review, never auto-closes', () => {
    const plan = planLeadWrites(
      lead(),
      facts({ replyText: 'We cannot assist — his charges were already handled by the court.' }),
    );
    expect(plan.action).toBe('not_viable_flagged');
    expect(plan.patch).toEqual({ needsReview: true });
    expect(plan.patch!.stage).toBeUndefined();
    expect(plan.postIt!.subject).toBe('Not viable per TVC thread — Mohamed Abdo');
  });

  it('not-viable on an already-flagged or lost lead: timeline only', () => {
    const nv = facts({ replyText: 'We cannot assist with this matter, nothing we can do here.' });
    expect(planLeadWrites(lead({ needsReview: true }), nv).action).toBe('not_viable_already_flagged');
    expect(planLeadWrites(lead({ stage: 'lost' }), nv).action).toBe('not_viable_already_lost');
    expect(planLeadWrites(lead({ needsReview: true }), nv).patch).toBeNull();
  });

  it('correction is ALWAYS a human post-it, never an action', () => {
    const plan = planLeadWrites(
      lead(),
      facts({ replyText: 'Apologies, we mixed this member up with another driver — please disregard.' }),
    );
    expect(plan.action).toBe('correction_needs_review');
    expect(plan.patch).toBeNull();
    expect(plan.postIt!.subject).toBe('Correction/retraction in TVC thread — Mohamed Abdo');
  });

  it('a reply naming ANOTHER lead is a post-it, no auto-action — even a clean decline', () => {
    const plan = planLeadWrites(
      lead(),
      facts({ otherLeadNames: ['Parmjeet Singh (case 1563109)'] }),
    );
    expect(plan.action).toBe('declined_names_other_lead');
    expect(plan.patch).toBeNull();
    expect(plan.postIt!.subject).toBe('TVC thread names another lead — Mohamed Abdo');
    expect(plan.postIt!.message).toMatch(/Parmjeet Singh/);
  });
});

describe('planLeadWrites — timeline visibility & dedupe', () => {
  it('plain negotiation traffic still lands on the timeline as non-contact', () => {
    const plan = planLeadWrites(
      lead(),
      facts({ replyText: 'Our fee for this covered case would be $1,125 less the TVC discount.' }),
    );
    expect(plan.action).toBe('logged');
    expect(plan.attempt!.outcome).toBe('no_answer'); // never fakes a connection
    expect(plan.attempt!.notes).toMatch(/^TVC thread \(not member contact\):/);
    expect(plan.attempt!.gmailMessageId).toBe('gm1');
    expect(plan.patch).toBeNull();
  });

  it('dedupes by gmailMessageId stored on a prior attempt', () => {
    const plan = planLeadWrites(
      lead({ contactAttempts: [{ ts: TS - 999, via: 'email', gmailMessageId: 'gm1' }] }),
      facts({ replyText: 'Our fee for this covered case would be $1,125 less the TVC discount.' }),
    );
    expect(plan.action).toBe('already_logged');
    expect(plan.attempt).toBeNull();
  });

  it('dedupes against a manually reconstructed email entry at the same timestamp', () => {
    const plan = planLeadWrites(
      lead({ contactAttempts: [{ ts: TS + 30_000, via: 'email', notes: 'reconstructed' }] }),
      facts({ replyText: 'Our fee for this covered case would be $1,125 less the TVC discount.' }),
    );
    expect(plan.attempt).toBeNull();
  });

  it('skips pure pleasantries', () => {
    const plan = planLeadWrites(lead(), facts({ replyText: 'Okay, thank you so much!' }));
    expect(plan.action).toBe('pleasantry_skipped');
    expect(plan.attempt).toBeNull();
    expect(plan.patch).toBeNull();
    expect(plan.postIt).toBeNull();
  });

  it('a SHORT disposition reply is never treated as a pleasantry', () => {
    // "Client retained our services" is 28 chars — but it IS the ground truth.
    const plan = planLeadWrites(
      lead({ stage: 'intake_complete' }),
      facts({ replyText: 'Client retained our services' }),
    );
    expect(plan.action).toBe('retained_already_sold');
    expect(plan.attempt).not.toBeNull();
  });

  it('review-kind on a lead already in Needs Review adds no second post-it', () => {
    const plan = planLeadWrites(
      lead({ needsReview: true }),
      facts({ replyText: 'Both violations from this stop were dismissed, so there is nothing for us to work.' }),
    );
    expect(plan.action).toBe('review_already_flagged');
    expect(plan.postIt).toBeNull();
    expect(plan.attempt).not.toBeNull();
  });

  it('an action still applies when the timeline entry already exists', () => {
    const plan = planLeadWrites(
      lead({ contactAttempts: [{ ts: TS, via: 'email', gmailMessageId: 'gm1' }] }),
      facts(),
    );
    expect(plan.action).toBe('declined_routed_lost');
    expect(plan.attempt).toBeNull();
    expect(plan.patch!.stage).toBe('lost');
  });
});
