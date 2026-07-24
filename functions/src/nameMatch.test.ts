import { describe, expect, it } from 'vitest';
import { correctNameInText, levenshtein, nameVerdict, tokensAlike } from './nameMatch.js';

describe('levenshtein', () => {
  it('measures edits', () => {
    expect(levenshtein('dawit', 'dawit')).toBe(0);
    expect(levenshtein('dawid', 'dawit')).toBe(1);
    expect(levenshtein('dewitt', 'dawit')).toBe(2);
    expect(levenshtein('', 'abc')).toBe(3);
  });
});

describe('tokensAlike', () => {
  it('accepts small mishearings scaled to length', () => {
    expect(tokensAlike('dawid', 'dawit')).toBe(true); // 1 edit @ 5 chars
    expect(tokensAlike('dewitt', 'dawit')).toBe(true); // 2 edits @ 6 chars
    expect(tokensAlike('smith', 'dawit')).toBe(false);
  });

  it('accepts prefix relationships (Sam / Samer)', () => {
    expect(tokensAlike('samer', 'sameron')).toBe(true);
    expect(tokensAlike('sam', 'samer')).toBe(false); // 3-char tokens must be exact
  });

  it('requires exact match for very short tokens', () => {
    expect(tokensAlike('al', 'el')).toBe(false);
    expect(tokensAlike('al', 'al')).toBe(true);
  });
});

describe('nameVerdict', () => {
  it('recognizes the audit case: "Dewitt Dawid" is Dawit Mekebeb misheard', () => {
    expect(nameVerdict('Dewitt Dawid', 'Dawit Mekebeb')).toBe('match');
  });

  it('recognizes exact and partial (first-name-only) identity', () => {
    expect(nameVerdict('Rashard Anderson', 'RASHARD ANDERSON')).toBe('match');
    expect(nameVerdict('Dawit', 'Dawit Mekebeb')).toBe('match');
  });

  it('leaves clearly different people alone — wrong-person calls are signal', () => {
    expect(nameVerdict('John Smith', 'Dawit Mekebeb')).toBe('different');
    expect(nameVerdict('Maria Gonzalez', 'Parmjeet Singh')).toBe('different');
  });

  it('returns none when either side is empty', () => {
    expect(nameVerdict('', 'Dawit Mekebeb')).toBe('none');
    expect(nameVerdict('Dawit', null)).toBe('none');
    expect(nameVerdict('J.', 'Dawit Mekebeb')).toBe('none'); // no usable tokens
  });
});

describe('correctNameInText', () => {
  it('fixes a misheard spelling inside a summary', () => {
    expect(
      correctNameInText(
        'Dewitt Dawid confirmed his court date and will call back.',
        'Dawit Mekebeb',
      ),
    ).toBe('Dawit Mekebeb confirmed his court date and will call back.');
  });

  it('does not swallow neighboring capitalized words into the replacement', () => {
    expect(
      correctNameInText('The agent told Dawid he can call Tuesday.', 'Dawit Mekebeb'),
    ).toBe('The agent told Dawit Mekebeb he can call Tuesday.');
  });

  it('replaces a badly garbled second name part along with the recoverable one', () => {
    // "Award" alone resembles nothing in "Awet Hayle", but leaving it beside
    // the correction would read "Awet Hayle Award" — the whole heard span goes.
    expect(
      correctNameInText('The caller, Awev Award, agreed to hire the firm.', 'Awet Hayle'),
    ).toBe('The caller, Awet Hayle, agreed to hire the firm.');
    expect(
      correctNameInText('The caller, Ahmad Yar, is inquiring about a ticket.', 'Malyar Ahmadyar'),
    ).toBe('The caller, Malyar Ahmadyar, is inquiring about a ticket.');
  });

  it('never grows the span onto a sentence-start word', () => {
    expect(correctNameInText('Spoke with Dawid. Dawid Mekebe will pay.', 'Dawit Mekebeb')).toBe(
      'Spoke with Dawit Mekebeb. Dawit Mekebeb will pay.',
    );
  });

  it('best-span rule: a quoted OTHER name beside a stronger match survives', () => {
    // The live Antonio Carlos Munhoz case: the summary deliberately quotes
    // the WRONG name a document used — that evidence must not be rewritten.
    expect(
      correctNameInText(
        'The caller, Antonio Carlos Munoz, said his name was incorrectly listed as Pedro Munoz.',
        'Antonio Carlos Munhoz',
      ),
    ).toBe(
      'The caller, Antonio Carlos Munhoz, said his name was incorrectly listed as Pedro Munoz.',
    );
    // …and it must keep surviving on re-runs, when the strong span is
    // already spelled right (idempotence — the shield can't drop away).
    expect(
      correctNameInText(
        'The caller, Antonio Carlos Munhoz, said his name was incorrectly listed as Pedro Munoz.',
        'Antonio Carlos Munhoz',
      ),
    ).toBeNull();
  });

  it('leaves name suffixes like Jr. outside the replacement', () => {
    expect(
      correctNameInText('The caller, Antonio Carlos Munoz Jr., called back.', 'Antonio Carlos Munhoz'),
    ).toBe('The caller, Antonio Carlos Munhoz Jr., called back.');
  });

  it('leaves correctly spelled names untouched', () => {
    expect(correctNameInText('Dawit agreed to retain the firm.', 'Dawit Mekebeb')).toBeNull();
    expect(
      correctNameInText('Dawit Mekebeb agreed to retain the firm.', 'Dawit Mekebeb'),
    ).toBeNull();
  });

  it('leaves different people untouched', () => {
    expect(
      correctNameInText('His boss John Smith pays company tickets.', 'Dawit Mekebeb'),
    ).toBeNull();
  });

  it('returns null when there is nothing to work with', () => {
    expect(correctNameInText('', 'Dawit Mekebeb')).toBeNull();
    expect(correctNameInText('No names here at all.', '')).toBeNull();
  });
});
