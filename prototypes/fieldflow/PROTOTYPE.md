# FieldFlow - field-to-billing pilot prototype (Fast mode)

## Run it
Open `index.html` in a browser (double-click, or `npx serve .`). No install or build. Needs internet once for the pinned CDNs (Tailwind 3.4.17, Alpine 3.14.9). All data is in memory; reload resets the demo.
Use the top bar to switch role: Dispatcher, Technician (phone), Customer portal, Billing. Customer portal has a user picker (Tom, Maria, Dana).

## Hypothesis
We believe dispatchers, technicians and billing staff at a regional HVAC company will stop losing billable work by running one connected record from request to invoice (approvals, parts, labor, signature, PO and QuickBooks sync) instead of the dispatch app, email, WhatsApp and spreadsheets.

## Demo script
1. Dispatcher: select EMG-2050 (Mercy Hospital, 4h SLA). Read the explained recommendations (Ray is penalised for hospitals). Click "Insert into Ray's day": his Brightline job moves and its customer is auto-notified; the alert feed and audit log update.
2. Technician: open Harbor Fresh PM. Start travel, Arrived (labor clock not started), tick the three checklist items (timestamped), Start work.
3. Flip the airplane switch (offline). Choose unit and failure type, type a note, add the capacitor, add extra labor, take a photo, request approval ($400). Everything queues.
4. Switch airplane off: queued changes sync; the banner shows the field-by-field merge (dispatcher moved WO-2044, notes kept).
5. Customer portal as Tom (limit $500): Approve $400. Back on the phone, add the contactor ($650 total): "exceeds approval", request new approval. As Tom it needs procurement: Forward, then pick Dana and approve.
6. Technician: pick resolution, signer name, draw signature (or "Customer refuses to sign" with reason code), Finish job. View the generated service report.
7. Billing: WO-2041 is blocked "Missing PO". Add PO-48213, then "Send to QuickBooks". Toggle the QuickBooks-down switch to see it stay pending and retry. Also try Maria vs Tom in the portal to see location-restricted data.

## What was built (traceability)
| Transcript said | Built as | Verified |
|---|---|---|
| Assisted, not automatic, scheduling; explain why | Recommendation cards with +/- reasons, dispatcher clicks to assign | Browser: assign emergency |
| Emergency inserted between two jobs | Insert bumps later job, customer notified if over threshold | Browser |
| Arrived vs Start work, travel vs labor | Separate steps and timers | Browser |
| Configurable safety checklists, audit trail | Per-customer checklist, timestamps, audit log | Browser |
| Offline mode, field-level conflict handling | Airplane switch, queue, sync banner | Browser (simulated) |
| Approvals tied to amount, second approval when exceeded, customer limits | Q-1/Q-2, per-user limits, forward to procurement | Browser |
| Customer signature or refusal reason; PDF report | Canvas signature, reason codes, printable report | Browser (signature, report); PDF is print-to-PDF only |
| Billing readiness: PO, approval, signature | Blocker list and filters, Add PO | Browser |
| QuickBooks queue and retry | Send, down toggle, Retry | Sync success tested; the "down" toggle and retry path not driven in the smoke run |
| Multi-location customer, restricted users | Harbor with 3 stores, 3 users | Not exercised in the smoke run beyond Tom/Dana |
| Simulated AI service summary, never touches billing | "Draft service summary" (deterministic) | Browser |

## Scope
- In: dispatch board, assisted assignment, SLA display, tech mobile flow, offline simulation, approvals, portal, billing readiness, QuickBooks mock, service report, audit log.
- Out (discussed, not built): auto-assignment, real maps/GPS, SSO/MFA, inventory sync, supplier portal, barcode camera, photo AI, serial OCR, contract rules engine, report builder, migration.
- Future: AI dispatcher assistant, explainable AI suggestions, full dashboards and CSV export.

## Assumptions
1. Mocked everything: no backend, auth is a role/user picker, QuickBooks, email and push are simulated.
2. Approval limit per customer user ($500 for Tom) stands in for the customer's procurement rule.
3. Contract rate is a flat $135/h and prices come from a small seeded price list.
4. Prototype day is Monday 6 Oct with a simulated clock that advances on actions.
5. Offline merge is a scripted illustration, not a real conflict algorithm.

## Open questions
Business-hours and holiday SLA rules, GPS privacy policy, QuickBooks version/API, approval authority configuration, migration scope (from the call's own unresolved list).

## What to learn
Do dispatchers trust and use the explanations? Is Arrived / Start work / checklist friction acceptable to technicians? Is the second-approval flow understandable to customers? Does the blocked-reason list match how billing actually works?

## Notes
Transcript contained no instructions aimed at an assistant; all of it was treated as evidence.
