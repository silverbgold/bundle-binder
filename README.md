# Bundle Binder (hosted)

A trading card shop with **real cart holds**: when a buyer adds a card, it's reserved for them and other buyers see
*"In someone's cart"* until the timer runs out (15 minutes by default) or they check out. Buyers pay by card (Stripe)
or Cash App / Venmo / PayPal / Zelle, and every order lands in the seller dashboard automatically.

| Part | What it is |
|---|---|
| `web/index.html` | The shop buyers use |
| `web/admin.html` | The seller dashboard (orders, live holds, inventory, settings) |
| `supabase/schema.sql` | The database and all the rules (holds, totals, permissions) |
| `supabase/functions/` | Two small server functions for Stripe card payments |
| `migration/` | Your current inventory exported from the claude.ai shop |

Everything runs on free tiers: **Supabase** (database, logins, photo storage) and **GitHub Pages** (the web pages).
Stripe charges its normal card fees (about 2.9% + 30¢ in the US).

## This shop's live setup

- **Database:** Supabase project `bundle-binder` (`emvggzohvtokuvwzizdr`). The schema, five bundles, the Mystery Mailer and
  the first 8 cards are already loaded, and `web/config.js` already points at it. Both Stripe functions are deployed.
- **Website:** every push to `main` publishes `web/` to GitHub Pages (`.github/workflows/pages.yml`).
  In the repo, set **Settings → Pages → Source** to **GitHub Actions** once.
- Still to do in the dashboard: steps 2 and 3 below, and step 6 if you want card payments (skip the `deploy` commands; just set the secrets).

The full steps below are for setting up a brand-new copy.

---

## Setup (about 30 minutes)

### 1. Create the database
1. Make a free account at [supabase.com](https://supabase.com) and create a new project. Save the database password somewhere.
2. Open **SQL Editor → New query**, paste the whole of `supabase/schema.sql`, and click **Run**.
   It creates the tables, the hold rules, a public `card-photos` storage bucket, and your five bundles plus the Mystery Mailer.

### 2. Turn on buyer carts
Buyers get an invisible "guest" login so their cart can be held.
**Authentication → Sign In / Providers → Anonymous sign-ins → turn on.**
(Optional but recommended: **Authentication → Attack Protection → CAPTCHA** to stop bots from holding cards.)

### 3. Create the seller account
1. **Authentication → Users → Add user → Create new user**. Enter the seller's email and a password, tick *Auto confirm*.
2. Copy that user's **UID**, then in the SQL Editor run:
   ```sql
   insert into admins values ('PASTE-THE-UID-HERE');
   ```
   Repeat for anyone else who should manage the shop.

### 4. Connect the pages
In Supabase open **Project Settings → API** and copy the **Project URL** and the **anon public** key into `web/config.js`.
(The anon key is meant to be public; the database rules protect everything.)

### 5. Put the site online
Easiest: go to [app.netlify.com/drop](https://app.netlify.com/drop) and drag the **`web` folder** onto the page.
You get an address like `https://your-shop.netlify.app`. (You can connect your own domain later in Netlify.)

- The shop is that address. The seller dashboard is that address + `/admin.html`.
- Sign in to the dashboard, open **Settings**, and fill in your shop name, contact, payment usernames, bundles and add-ons.
- Add cards in **Inventory** (drop photos, or import `migration/inventory-from-claude-shop.csv`).

At this point the shop works with Cash App / Venmo / PayPal / Zelle payments. Card payments are step 6.

### 6. Card payments with Stripe (optional)
1. Create a [Stripe](https://stripe.com) account and finish its business setup. Copy your **Secret key** (Developers → API keys).
2. Install the [Supabase CLI](https://supabase.com/docs/guides/cli), then from this folder:
   ```bash
   supabase login
   ```
   ```bash
   supabase link --project-ref YOUR-PROJECT-REF
   ```
   ```bash
   supabase secrets set STRIPE_SECRET_KEY=sk_live_... SITE_URL=https://your-shop.netlify.app STRIPE_CURRENCY=usd
   ```
   ```bash
   supabase functions deploy create-checkout
   ```
   ```bash
   supabase functions deploy stripe-webhook --no-verify-jwt
   ```
3. In Stripe: **Developers → Webhooks → Add endpoint**
   - URL: `https://YOUR-PROJECT-REF.supabase.co/functions/v1/stripe-webhook`
   - Events: `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`
   - Copy the **Signing secret** and run:
   ```bash
   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
   ```
4. In the seller dashboard → **Settings → Payment**, tick **Card payments through Stripe**.

Tip: do a test run first with Stripe's *test mode* keys (`sk_test_...`) and card number `4242 4242 4242 4242`.

---

## How holds work

- **Adding a card** reserves one copy for that buyer. Other buyers see *"In someone's cart"* and can't add it.
  Cards with several copies stay available until every copy is held.
- **The whole cart shares one timer** (Settings → *Cart holds cards for*, default 15 minutes). When it ends, the cards go back to the shop.
- **Paying by card:** cards stay held for 35 minutes while the buyer is on Stripe. Paid → the cards come off the shelf automatically.
  Backed out → the cards go back into their cart.
- **Pay later (Cash App, Venmo, etc.):** the order is saved and its cards stay held for 24 hours (changeable). The seller taps
  **Mark paid** when the money arrives. If the hold runs out first, the order shows as *Expired* and the cards return to the shop;
  marking it paid then checks the cards are still free.
- Two buyers tapping **Add** on the last copy at the same moment can't both get it: the database handles them one at a time.
- Buyers can't change prices, totals or holds by tampering with the page; all of it is checked in the database.

## Seller dashboard

- **Orders:** to-do list of orders awaiting payment and paid-to-ship, with buyer details, shipping address, a pull list
  with box locations, and buttons for *Mark paid*, *Mark shipped*, *Copy address* and *Cancel*. Also shows which cards are
  sitting in carts right now and how long is left.
- **Inventory:** drop photos to add cards in bulk (one card per photo, or one photo of many cards that gets split into separate listings), straighten or re-crop any photo with **Adjust** (auto-fits the card; re-crops from the original photo when there is one) or turn it with **Rotate**, read card names and numbers from the photos for free (in the browser, no account needed), export everything to a CSV, import a spreadsheet, and edit name, set, number, game, condition, price,
  quantity, status and box. Changes save as you type.
- **Settings:** shop details, hold times, payment usernames, card payments, bundles and add-ons.

## Not in this version yet

These are still in the claude.ai version, which you can keep using alongside this one, or ask Claude to bring over:
Claude reading cards from photos, market prices, the Stacks claim sheet and invoices,
and buyer stack-code logins.

## Tests

- `supabase/tests/` — the hold and order rules, run against a real Postgres 16 (`./supabase/tests/run_tests.sh`).
- `tests/e2e/` — the real shop and dashboard in a browser with two buyers and a seller, against a real Postgres
  (`cd tests/e2e && npm install && node run.js`, with `PGHOST`/`PGPORT` pointing at a Postgres 16 server).
