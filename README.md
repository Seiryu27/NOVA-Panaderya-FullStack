# NOVA Panaderya — Full Stack v2

Storefront (animated 3D) + Express API + Turso/SQLite. Ang server na ang nagkakalkula ng presyo, promo, loyalty, stock at slot, kaya hindi na ito mababago sa browser.

## Run
1. Node.js 20.12+ (22 ang inirerekomenda).
2. `npm install`
3. Kopyahin ang `.env.example` papuntang `.env`, ilagay ang `SESSION_SECRET` at ang `ADMIN_EMAIL` mo. Iwanang blangko ang `TURSO_*`: lokal na file (`data/nova.sqlite`) ang gagamitin.
4. `npm start` → http://localhost:3000
5. Mag-register gamit ang `novastudents@gmail.com` (built-in admin) o ang `ADMIN_EMAIL` mo para maging admin (lalabas ang **Admin** button).

## Online (Render Free) nang hindi nawawala ang data
Ephemeral ang filesystem ng Render Free, kaya gumamit ng libreng Turso database (walang credit card).
1. Mag-sign up sa https://turso.tech at gumawa ng database (hal. `nova`).
2. Kunin ang **Database URL** (`libsql://nova-xxxx.turso.io`) at gumawa ng **Auth Token** (Dashboard → database → Generate Token).
3. Sa Render → Environment: `NODE_ENV=production`, `SESSION_SECRET`, `ADMIN_EMAIL`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`.
4. I-push ang code sa GitHub at hayaang mag-redeploy. Mag-register gamit ang `ADMIN_EMAIL`.
Kasama sa database ang mga session, kaya hindi ka rin malo-logout kapag nag-restart ang server.

Docker: `docker build -t nova . && docker run -p 3000:3000 -e NODE_ENV=production -e SESSION_SECRET=... -e ADMIN_EMAIL=... -e TURSO_DATABASE_URL=... -e TURSO_AUTH_TOKEN=... nova`

## Kasama na
- **Checkout sa server**: `POST /api/orders` (guest o naka-login). Validated ang PH number, petsa/oras, items; server ang nagpepresyo; may transaction para sa stock, slot at loyalty.
- **Promo codes** (NOVA10, BIYERNES), **loyalty** (ika-10 order libre), **slot capacity**, **delivery fee** — lahat server-side.
- **Order tracking** (`/api/orders/:id/status`), **reorder** at **history** sa Account modal.
- **Notify me** → naka-save sa DB; awtomatikong SMS (kung may Semaphore key) kapag na-restock.
- **Reviews** na naka-save sa DB.
- **Admin**: orders, status (Bago/Niluluto/Handa na/Tapos/Kanselado; ang kansela ay nagbabalik ng stock at slot), production list at benta, menu/presyo/stock, special, slot cap, GCash/Maya number, social links, **CSV export** (`/api/admin/orders.csv`), notify list.
- **SMS** (opsyonal): Semaphore, kapag Handa na o Kanselado ang order.
- **Seguridad**: SESSION_SECRET kailangan sa production, same-origin + JSON-only na mutating requests (CSRF), rate limits, CSV formula-injection guard, session regenerate sa login/register, role na binabasa sa DB.
- **PWA** (installable, may offline fallback) at **Dockerfile**.

## API
Public: `GET /api/state`, `GET /api/menu`, `GET /api/loyalty/:phone10`, `GET /api/orders/:id/status`, `POST /api/orders`, `POST /api/notify`, `POST /api/reviews`
Auth: `POST /api/auth/register|login|logout`, `GET /api/auth/me`, `GET /api/orders` (sariling orders)
Admin: `GET /api/admin/orders(.csv)`, `PATCH /api/admin/orders/:id`, `PUT /api/admin/menu`, `PUT /api/admin/config/shop|pay`, `GET|PATCH /api/admin/notify`

## Hindi pa kasama (kailangan ng account/keys mo)
- **GCash/Maya online payment** (PayMongo/Xendit): kailangan ng merchant account at webhook. Sa ngayon, manual pa rin ang reference number.
- **Password reset / email verification**: kailangan ng email provider (SMTP).
- Upload ng gallery at QR code (inalis muna dahil galing ito sa lumang runtime).
- Delivery fee kada barangay, staff roles, at CSP (kailangan munang ilipat sa labas ang inline scripts).

## Mga paalala
- Kapag may lumang schema, ire-rename ang lumang `orders`/`menu` tables sa `orders_v1`/`menu_v1` (hindi buburahin). Mananatili ang users.
- Hindi awtomatikong lilipat ang data sa lokal na `data/nova.sqlite` papunta sa Turso; magsisimula ito sa bagong database.
- Ang presyo ng Box at Combo sa page ay nakasulat pa sa HTML; sa server na nakabase ang aktwal na singil.
- Sa production, gumamit ng HTTPS at `NODE_ENV=production` (secure cookies). Libre ang Turso Free plan, pero may limit ito (5 GB at buwanang rows read/written); sapat para sa isang panaderya.
- Natutulog pa rin ang Render Free pagkatapos ng 15 minutong walang bisita (mga 1 minuto bago gumising), pero hindi na mawawala ang data.
- Nasuri ang syntax ng server at ng lahat ng script, pero hindi ito na-run-test sa environment ng gumawa (walang network). Subukan ang isang buong order pagkatapos mag-deploy.
