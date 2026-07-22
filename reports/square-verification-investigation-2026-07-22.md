# Square Payment Verification — RESOLVED (July 22, 2026)

The investigation is complete, and the news is good: **9 of the 10 "claimed paid but no Square charge" leads were found in Square** and their money is confirmed collected. Every one of those alerts was a false alarm caused by how the charges are keyed in, not by missing money. All 9 leads have now been credited in the system (payment logged, sale marked paid, alerts cleared), and only ONE item still needs a human decision (see the bottom of this page).

## Why the system missed these payments

When staff key a card manually during a call, the Square customer record comes through **completely blank** — no name, no email, no phone. The client's identity only exists in the payment's free-text note (e.g. "Khup Sum Retainer Payment"). Our sync was matching payments to leads by phone, email, or the customer's name, so these note-only payments looked like strangers. **The matcher has been fixed**: it now reads the payment note, matches client names inside it (in either name order), and cross-checks the charge time against the client's call history. Future manual charges will reconcile automatically.

## The 9 confirmed payments

| Client | Amount | Date (CT) | Card |
|---|---|---|---|
| Haroon Shahzad | $1,125 (paid in full) | Jun 30, 10:57 AM | Mastercard •8829 |
| Alemseged Woldu Yohannes | $1,125 (paid in full) | Jul 2, 11:39 AM | Discover •2267 |
| Dawit Mekebeb | $1,125 (paid in full) | Jul 8, 10:18 AM | Visa •2508 |
| Zeru Eyob | $563 (partial — balance $562) | Jul 9, 12:51 PM | Visa •3165 |
| Khup Sum | $1,125 (paid in full) | Jul 9, 1:45 PM | Mastercard •1529 |
| MARK A BRADFORD | $1,125 (paid in full) | Jul 9, 4:50 PM | Mastercard •2769 |
| Cesar Gonzalez | $826 (paid in full — TVC covers the remaining $299) | Jul 14, 11:56 AM | Mastercard •3464 |
| FUAD MAKHTAL AHMED | $1,125 (paid in full) | Jul 14, 12:08 PM | Visa •1195 |
| Philorius Joseph | $375 (partial — balance $750) | Jul 20, 8:29 AM | Mastercard •9456 |

Every payment above landed within minutes-to-hours of a recorded call with that client, corroborating the match. Bonus: the same note-matching also resolved one of the older "unmatched payment" alerts — **Sekou Kaba's $700** partial payment (Jul 22, Visa •8756, balance $425) is now credited to his file.

## ONE item for human review — Dessie Ashenafi Assmamaw / "Parmjeet Singh" $1,125

Dessie was marked paid in full on his **Fri, Jul 17 call**, and a perfectly timed charge DOES exist: **$1,125, payment `pi7shqJ6XFOIoa0etXktOYp26FJZY`, Jul 17 at 4:45:17 PM CT, Visa •3482** — keyed in mid-call with Dessie. But the payment note reads **"Parmjeet Singh Retainer Fee"**, and there is also a lead named Parmjeet Singh in our system.

What we checked: Parmjeet Singh had **no call activity anywhere near July 17** — his calls with us were all on July 21–22. That strongly suggests the note was mislabeled during Dessie's call and the money is Dessie's, but we did not credit it to anyone automatically.

**What to do:** listen to the end of Dessie's Jul 17 call ([recording](https://app.callrail.com/calls/CAL019f7203546a7462b39486d6b9c32317/recording?access_key=65b635d32af2fc84d352)) and/or check whose card ends in 3482. If it's Dessie's money, mark Dessie paid and fix the Square note; if it truly belongs to Parmjeet, then Dessie's claimed payment is still missing and his alert should stay open. His alert card in the app has been updated with these details and remains open until someone decides.
