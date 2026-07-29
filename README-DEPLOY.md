# The Carnival Box Office v2 — deploy guide
**All-Stripe · all-reserved · the map IS the box office.**
Built to `1140A_Reserved_Seat_Build_Spec.docx`. Status: **fully proven on the local harness (37 automated checks: atomicity, race, TTL, conflict-refund, accessible flow, door single-scan). Untested past the line of real Stripe keys — the §12 two-phone real-dollar gate is yours to run before anything goes public.**

## What's in the box
```
netlify.toml                     Netlify config (site + functions + /api/* routing)
package.json                     dependencies Netlify installs at deploy
site/                            index.html (buyer) · admin.html (console) · door.html (scan) · success.html
netlify/functions/               seats-state · claim-seats · create-checkout · stripe-webhook
                                 · order-status · scan · admin-api  (+ lib/: store, house, stripe, codes)
tests/                           the proof harness (local Redis + mock-Stripe with REAL signature crypto)
src2/ + build2.py                page sources + assembler (edit sources, rerun build2.py)
```

## Accounts you create (≈30 min of clicking, can be done in parallel)
1. **Upstash** (upstash.com) → Create Redis database (free) → copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
2. **Stripe** (stripe.com) → activate the account for THE 1140A CORPORATION (EIN, bank, identity — can take minutes to days, START THIS FIRST). Grab the **secret key** (`sk_test_…` now, `sk_live_…` later). Ask support about nonprofit pricing.
3. You already have Netlify + the domain.

## Deploy (10 minutes)
1. Push this folder to a Git repo and "Import from Git" on Netlify (recommended — auto-installs dependencies), **or** `netlify deploy` via CLI. (Plain drag-and-drop does NOT bundle functions' node_modules — use Git or CLI.)
2. Site configuration → **Environment variables**:
   - `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
   - `STRIPE_SECRET_KEY` (test key first)
   - `STRIPE_WEBHOOK_SECRET` (next step gives it)
   - `ADMIN_TOKEN` (invent a strong one — it is the console password)
   - `SITE_URL` (e.g. `https://1140a.com` — no trailing slash)
3. **Stripe webhook**: Stripe dashboard → Developers → Webhooks → Add endpoint
   `https://YOUR-SITE/api/stripe-webhook`, events: `checkout.session.completed`,
   `checkout.session.expired`, `charge.refunded`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`. Redeploy.
4. Open `/admin.html`, enter your ADMIN_TOKEN, press **“Seed the house”** once — this writes the 59 holds
   (sponsor 12 · Mom's TA-108 · marketing 16 · companion 4 · volunteer 6 · charity 20) into the live store.
   Press **“Prove the closing identity”** — it must print `closes: true` with 590 open.
5. Walk a test purchase with Stripe **test card 4242 4242 4242 4242** end to end (map → pay → success → tickets → door scan → refund in Stripe dashboard → seat reopens). *(That card number is Stripe's, not ours — the no-4 rule governs what we author.)*

## The §12 go/no-go gate (real dollars — do not skip)
Switch `STRIPE_SECRET_KEY` to the live key, then: two phones on the live map → buy one real seat on Phone A with a real card → watch it go dark on Phone B within ~10 s untouched → scan the QR at door.html (VALID, correct seat; second scan ALREADY IN) → refund in Stripe → seat reopens on both maps → then race two phones on one seat: one wins, one is told "seat taken". **Only after all of that: set `gate.enabled:false` in `src2/core2.js`, run `python3 build2.py`, redeploy. That is the switch.**

## Laws encoded (do not loosen)
- **Hold-TTL law:** hard hold 2100 s ≥ Stripe session 1800 s (`lib/house.json`). Never shorten the hold below the session.
- **One conditional write** claims seats (`lib/store.js` Lua); **one webhook** finalizes; the webhook **re-verifies and auto-refunds** on conflict — a buyer can never silently pay for a taken chair.
- **One tier per transaction**; 8 seats max; groups of nine-plus route to email.
- **Buyer-blind holds** (every unavailable seat looks simply sold); console sees categories.
- **No digit 4** in anything the system authors (codes, timers, counts). Venue seat labels and owner-locked prices are the standing exemptions.
- **$3 fee**: itemized, labeled not-ours, framed as transparency — in the cart, at Stripe, and on the receipt page.

## Day-to-day
- Console = `/admin.html` + ADMIN_TOKEN. INSPECT tells you what any seat is; category buttons release sponsor/marketing/charity/volunteer blocks (the fast/slow lever); `marksold` issues comps with real door codes.
- Door = `/door.html` — server-verified single scan across all devices; offline it falls back to checksum + per-device dedupe and says so.
- Money truth = Stripe dashboard (one settlement stream). Seat truth = the store, provable from the console.
- Seat-map edits (prices, copy, layout): edit `src2/`, run `python3 build2.py`, redeploy. Seat DATA comes from house.json — regenerate, never hand-type.

## Retire the old world
Hide/close the old Zeffy form (no sales existed) and take down any deployed v1 pages so exactly one box office is reachable. One store, one seller, one truth.
