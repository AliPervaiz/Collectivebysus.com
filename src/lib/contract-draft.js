/* Seed contract template (draft only) and the merge fields the admin UI offers. */

export const MERGE_FIELDS = [
  { key: "client_name", label: "Client name" },
  { key: "client_email", label: "Client email" },
  { key: "guardian_name", label: "Parent/guardian name" },
  { key: "session_type", label: "Session type" },
  { key: "session_date", label: "Session date" },
  { key: "session_time", label: "Session start time" },
  { key: "session_hours", label: "Booked hours" },
  { key: "session_location", label: "Location" },
  { key: "hourly_rate", label: "Hourly rate" },
  { key: "quoted_total", label: "Quoted total" },
  { key: "retainer_amount", label: "Retainer amount" },
  { key: "balance_due", label: "Balance due" },
  { key: "balance_due_date", label: "Balance due date" },
  { key: "turnaround", label: "Delivery turnaround" },
  { key: "edited_image_count", label: "Number of edited images" },
  { key: "business_name", label: "Business name" },
  { key: "today", label: "Today's date" },
];

export const CONTRACT_DRAFT = `**DRAFT — have this reviewed by a Texas attorney before using. This template is not legal advice.**

# Photography Session Agreement

This agreement is between {{business_name}} ("Photographer") and {{client_name}} ("Client"), email {{client_email}}. It is dated {{today}}. Please read it all the way through. If anything is unclear, ask me before you sign. I'm happy to explain.

## 1. Session details

- Session type: {{session_type}}
- Date: {{session_date}}
- Start time: {{session_time}}
- Booked time: {{session_hours}} hour(s)
- Location: {{session_location}}

The Client is responsible for any location permits, entry fees, or permission needed to photograph on private property, unless we agree otherwise in writing (a text, DM, or email counts).

## 2. Fees, hourly billing and overtime

Sessions are billed by the hour at {{hourly_rate}}. The quoted total for this session is {{quoted_total}}, based on the booked time above.

The session clock starts at the agreed start time, even if the Client or guests arrive late. If the session runs past the booked time at the Client's request, the extra time is billed at the same hourly rate, in half-hour blocks, and is added to the balance. I will always check with you before going over time.

Payments are accepted by Venmo, Zelle, or another method we agree on. Please include your name and session date in the payment note so I can match it.

## 3. Retainer and balance

A retainer of {{retainer_amount}} is due to reserve the date. The date is not held until the retainer is received. The retainer is **non-refundable** because it holds a date that I turn other clients away for, and it is applied to the quoted total.

The remaining balance of {{balance_due}} is due by {{balance_due_date}}. Edited images are delivered once the balance, including any overtime, is paid in full.

## 4. Cancellation and rescheduling

**By the Client.** You may reschedule once at no charge with at least 72 hours' notice, subject to my availability. The retainer moves to the new date. If you cancel, or reschedule with less than 72 hours' notice, the retainer is kept. Any amount paid beyond the retainer will be refunded.

**By the Photographer.** If I have to cancel, I will offer a new date first. If no new date works for you, I will refund everything you have paid, including the retainer. My responsibility is limited to that refund.

**Illness and emergencies.** Life happens. If you, a key person in your session, or I become sick or have a genuine emergency, we'll work together to reschedule without a fee, even on short notice. Please tell me as soon as you can.

## 5. Weather

For outdoor sessions, I will keep an eye on the forecast. If the weather is unsafe or would seriously affect the photos (for example lightning, heavy rain, extreme heat, or ice), either of us may reschedule without a fee. Overcast skies or light wind are usually fine and are not, by themselves, a reason to reschedule. We'll decide together, ideally by the day before.

## 6. Delivery and turnaround

{{turnaround}} Delivery time starts once the session is complete and the balance is paid. Images are delivered through a private online gallery. Busy seasons (such as graduation season) may take a little longer, and I'll let you know if that applies.

## 7. Edited images and editing style

You will receive approximately {{edited_image_count}} edited images. I choose the final images and edit them in my own style, which includes color correction, exposure, and light cleanup (for example, a stray blemish or flyaway hair).

Extensive retouching, such as body reshaping, removing objects or people, or heavy skin work, is not included unless we agree on it in writing beforehand, and it may cost extra.

## 8. No RAW or unedited files

RAW files and unedited images are not delivered or sold. The edited images are the finished product.

## 9. Copyright and your personal-use license

I keep the copyright to all images from the session. Once paid in full, you receive a personal-use license, which means you may:

- print the images for yourself, family, and friends;
- share them online and on social media, with credit to {{business_name}} where possible.

You may not sell the images, use them for commercial purposes or advertising, enter them in contests, or alter them (including applying filters or editing apps) without my written permission. If you'd like commercial use, ask me and we can work something out.

## 10. Posting and model release (opt-in)

I only share photos from your session on my website, Instagram, or other marketing if you say yes below. **If no box is checked, I will not post.** You can change your mind at any time by letting me know; I'll stop using the images going forward (anything already printed or posted before then may stay up).

- [ ] Yes, you may post my photos.
- [ ] Please ask me first before posting any specific photo.
- [ ] Please do not post my photos.

## 11. Minors

Anyone under 18 must have a parent or legal guardian's consent to be photographed. A parent or guardian ({{guardian_name}}) must sign this agreement on the minor's behalf, and their choices in the posting section apply to the minor's photos. A parent or guardian should be reachable during the session, and is welcome to attend.

## 12. Limitation of liability

I bring professional equipment, backup memory cards, and take care to protect your images. In the rare case that photos are lost or damaged because of equipment failure, data loss, illness, accident, or anything else outside my control, my total liability is limited to a refund of the amounts you have paid under this agreement. I am not responsible for missed shots caused by guests, venue rules, lighting restrictions, or schedule changes outside my control.

## 13. Gallery hosting and backups

Your online gallery will stay available for at least 60 days after delivery, unless I tell you a different date in writing. It is your responsibility to download and back up your images during that time. After the gallery expires, I may not keep copies, and I can't guarantee I'll be able to recover them.

## 14. The whole agreement

This is the entire agreement between us. Changes must be agreed in writing (text, DM, or email is fine). If any part of this agreement isn't enforceable, the rest still applies. This agreement is governed by the laws of the State of Texas.

## Signatures

By signing, you confirm that you have read and agree to this agreement.

Client: {{client_name}}

Signature: ______________________________  Date: ______________

Parent/guardian (required if the client is under 18): {{guardian_name}}

Signature: ______________________________  Date: ______________

Photographer: {{business_name}}

Signature: ______________________________  Date: ______________
`;
