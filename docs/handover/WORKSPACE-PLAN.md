# Pickaroo: workspace plan (API + admin dashboard + Android)

This folder is the main workspace. It holds the three Pickaroo repositories side by side:

```text
C:\Users\zazuk\Pickaroo\
├── PLAN.md               this file
├── CLAUDE.md             workspace rules for every repo below
├── .claude\agents\       the agents that do the work (see §0.2)
├── PickarooAPI\          backend: GraphQL gateway + services (github.com/Carlo068/PickarooAPI)
├── PickarooFrontend\     web admin dashboard, to be built (github.com/Carlo068/PickarooFrontend)
├── Pickaroo\             Android app, Kotlin + Compose (github.com/Carlo068/Pickaroo)
└── pickaroo-skills-wt\   git worktree of Pickaroo (branch feature/claude-skills-workflow, already merged)
```

Each repo keeps its own detailed docs: `PickarooAPI/README.md`, `PickarooAPI/docs/PLAN-neo4j-scylladb.md` and `Pickaroo/docs/PLAN.md`. This file covers what each repo has today, where they disagree, and the order of work to connect them.

---

## 0. Decisions and way of working

### 0.1 Decisions (2026-11-16)

| Topic | Decision |
|---|---|
| Storefront in PickarooFrontend | Keep the public page at `/`; the dashboard lives under `/app` and shares the login. |
| Styling | Tailwind only. Bootstrap is removed as each part is rebuilt. |
| Shop owner | The API gets an **owner** concept (A7). |
| Refresh tokens | Needed (A4). |
| API changes | Done in this workspace, in `PickarooAPI/`. |
| Languages | The Android app ships in **Spanish and English** (epic L). The dashboard does too (D12). |
| Biometric login | The Android app can sign in with fingerprint or face (epic B). Signing out keeps fingerprint sign-in; "Olvidar este dispositivo" revokes it. |
| Business model | **Marketplace**: every store has its own owner, catalog and stock (A9). |

### 0.2 Who does what

| Role | Model | Agent | Does |
|---|---|---|---|
| Orchestrator ("brains") | Fable 5.2, or Opus 5.5 when Fable's limit is reached | main session | Reads the code, designs each task, writes the brief, checks the result, decides what's next, talks to the user. Does not write feature code. |
| Coding | Sonnet; Opus for hard tasks | `coder` | Implements one task with its tests on its own branch and commits locally. Opus for schema design, auth, concurrency and cross-repo refactors. |
| UI testing | Haiku; Sonnet when judgement is needed | `ui-tester` | Emulator tests and adb-driven checks with the Android skills; dashboard tests and browser checks. Never edits code. |
| Builds and unit tests | Haiku | `test-runner` | Runs unit tests, lint and type checks; reports counts and failures. |
| Review before merge | Sonnet | `code-reviewer` | Read-only review of a branch, including API ↔ client contract drift. |
| Jira | Haiku | `jira-updater` | Moves PIC issues and comments on them. |

Loop for every task: orchestrator writes the brief → `coder` implements and commits → `test-runner` and `ui-tester` verify → orchestrator reads the diff and the reports → `jira-updater` marks it → next task. The user pushes and merges.

The Android skills stay in `Pickaroo/.claude/skills/` (`pic-task`, `android-test-run`, `emulator-ui-check`, `compose-ui-tests`, `mock-endpoint`); agents read them from there. The dashboard gets its own test skill in D0.

---

## 1. What each repository has today

### 1.1 PickarooAPI (backend, GraphQL only)

| Piece | What it does |
|---|---|
| **Apollo Gateway** `:4000` | One GraphQL endpoint composing two subgraphs. Forwards the client's `Authorization`, IP and User-Agent. CORS is open (Apollo standalone default). |
| **mongoAPI** `:4001` | All business logic: users, categories, products, packages (combos with no stock of their own), discounts, stores, cart, quotes, orders, shopping lists, sales reports. |
| **auditAPI** `:4003` | Consumes RabbitMQ `eventos-seguridad` and writes an immutable audit log to ScyllaDB. Queries need `audit:view` (ADMIN only). |
| **MongoDB** | Source of truth: `users`, `categories`, `products`, `packages`, `stores`, `orders`, `shopping_lists`. |
| **Redis Stack** | JWT sessions (`session:<jti>`, 1 h TTL, logout revokes), cart, 15-min quotes, recent orders, read cache of products and users. |
| **Neo4j** | RBAC: roles with inheritance, permissions, staff ↔ store (`WORKS_AT`), per-role navigation menu with web routes. |
| **RabbitMQ → ScyllaDB** | Audit events (SECURITY, ADMIN, CATALOG, ORDER) in four query tables: by day, by actor, by target, and `logs_eventos` (event type per day, the table to inspect with cqlsh). Default keyspace `auditoria`. |

**Roles:** `CUSTOMER` → `STAFF` (`orders:prepare`, `stock:manage`) and `DELIVERY` (`orders:deliver`) → `MANAGER` (+`catalog:manage`, `reports:view`) → `ADMIN` (+`stores:manage`, `users:manage`, `audit:view`, `scope:all_stores`). Staff only see orders of their own stores.

**Order statuses:** `PENDING → CONFIRMED → PREPARING → READY → (IN_DELIVERY →) DELIVERED`, `CANCELLED` from any non-final state. Pickup goes `READY → DELIVERED`.

**Seed (`SEED=true`):** store *CARNYFRUT Centro*, 4 categories, 11 products, 1 package, 1 discount, and five users: `admin@carnyfrut.mx` / `Admin1234`, `gerente@…` / `Manager1234`, `empleado@…` / `Staff1234`, `repartidor@…` / `Delivery1234`, `cliente@demo.mx` / `Cliente1234`.

**Not there yet:** driver assignment, driver location, order status history readable by the customer, refresh tokens, password reset, notifications, automated tests (no `test` script in any package).

**Menu routes the API already hands to a web client** (`myMenu`, by role):

| Menu | Route | Roles |
|---|---|---|
| Pedidos de la sucursal | `/sucursal/pedidos` | STAFF+ |
| Inventario | `/sucursal/inventario` | STAFF+ |
| Entregas | `/reparto/entregas` | DELIVERY, ADMIN |
| Productos y paquetes | `/admin/catalogo` | MANAGER+ |
| Reportes | `/admin/reportes` | MANAGER+ |
| Sucursales | `/admin/sucursales` | ADMIN |
| Usuarios y roles | `/admin/usuarios` | ADMIN |
| Auditoría | `/admin/auditoria` | ADMIN |
| Catálogo, carrito, mis pedidos, mis listas | `/catalogo`, `/carrito`, `/mis-pedidos`, `/mis-listas` | CUSTOMER |

### 1.2 PickarooFrontend (web, to become the admin dashboard)

- React 19 + Vite 8 + TypeScript 6. Both **Bootstrap 5** and **Tailwind 4** are installed and used.
- Today it is a **customer storefront landing page**: rotating banners, categories, product cards, delivery/pickup toggle. Products are hard-coded.
- `services/api.ts` has a REST `login()` pointing at `localhost:3000/api` (doesn't exist) and a `queryGraphQL()` helper pointing at the public Rick and Morty API as a demo.
- `Login` form only logs to the console. `Sidebar` and `Home` exist but aren't rendered.
- No router, no auth state, no GraphQL client, no tests.

### 1.3 Pickaroo (Android app)

- Kotlin + Jetpack Compose, MVVM per feature (`ui/<feature>/{model,data,network,viewmodel,view}`), manual DI in `AppContainer`, `BuildConfig.USE_MOCK_API = true`.
- Talks to an **in-app mock** of a REST API (`/api/v1`, Retrofit) that was designed before this backend existed (`docs/PLAN.md` §5).
- Done: onboarding, mock auth with refresh tokens and roles, role-based navigation, cart, checkout with QR receipt, order list and timeline, live driver map (osmdroid), driver home/accept/pickup/deliver, real GPS sharing with a foreground service (PR #13).
- Remote repositories exist only as stubs that throw "PickarooAPI todavía no está conectada".

---

## 2. Where the Android mock and the real API disagree

The real API wins wherever it already covers something; the API gets new operations only for what it doesn't have.

| Topic | Android mock | PickarooAPI | Decision |
|---|---|---|---|
| Transport | REST `/api/v1` with Retrofit | GraphQL through the gateway | Android uses **Apollo Kotlin** in its `Remote*Repository` classes. Screens and ViewModels don't change. |
| Login | username + password | email + password | Android login field becomes email. |
| Session | 15-min access + rotating refresh token | 1 h JWT backed by a Redis session; no refresh | Add `refreshToken` to the API (A4, required). `AuthorizedCalls` already refreshes and retries once. |
| Roles | customer / staff / owner / driver, modes SHOP / DRIVER / CUSTOMER | CUSTOMER / STAFF / DELIVERY / MANAGER / ADMIN | The API adds **OWNER** (A7). Mode SHOP = STAFF, MANAGER or OWNER; DRIVER = DELIVERY. |
| Permissions | `order:status:update`, `delivery:accept`, … | `orders:prepare`, `orders:deliver`, `catalog:manage`, … | Android maps API permissions to its constants in one function. |
| Shops | several shops, owners own shops, each shop has its own catalog | stores; staff linked with `WORKS_AT`; no owner; **catalog and stock are global**, not per store | Marketplace: shop = store, owner = OWNER with `OWNS` (A7), catalog and stock per store (A9). |
| Language | Spanish text hard-coded in the screens | error messages and menu titles in Spanish | Clients never show API text: they translate by `extensions.code` and by menu `id` (A8). |
| Order statuses | PLACED, ACCEPTED, PREPARING, READY, PICKED_UP, DRIVER_ASSIGNED, OUT_FOR_DELIVERY, DELIVERED, CANCELLED | PENDING, CONFIRMED, PREPARING, READY, IN_DELIVERY, DELIVERED, CANCELLED | Map in one place: PLACED↔PENDING, ACCEPTED↔CONFIRMED, PICKED_UP = pickup DELIVERED, OUT_FOR_DELIVERY↔IN_DELIVERY. DRIVER_ASSIGNED = READY with a driver (needs A1). |
| Catalog | shop catalog with groups | categories + products + packages (combos) | Android shows packages as combos. Prices are MXN floats, quantities integers. |
| Driver: available / accept | `GET driver/orders/available`, `POST …/accept` (409 if taken) | any DELIVERY in the store can move an order; no assigned driver | **A1** adds it. |
| Driver location | `POST driver/location`, `GET orders/{id}/driver-location` | nothing | **A2** adds it. Android PIC-58 already sends positions. |
| Order timeline | `GET orders/{id}/events` | audit by target exists but is ADMIN-only | **A3** adds `Order.statusHistory`. |
| Pickup slots, notifications | in the Android plan (E4, E5) | nothing | Out of scope until the core is connected. |

---

## 3. Work plan

**Jira keys (project PIC).** Epics: A = PIC-71, D = PIC-72, L = PIC-73, B = PIC-74, E9 = PIC-64. Tasks: A0–A9 = PIC-75 to PIC-84 · D0–D13 = PIC-85 to PIC-98 · L1–L3 = PIC-99 to PIC-101 · B1–B3 = PIC-102 to PIC-104 · the E9 rows below E9.1–E9.6 = PIC-105 to PIC-110 (named E9.4–E9.9 in Jira, because Jira already had E9.1–E9.3), and row E9.7 is the existing PIC-66.

### Epic A: PickarooAPI additions (the app and the dashboard both need these)

| # | Task | Details |
|---|---|---|
| A0 | Test harness | Vitest (or `node:test`) for `domain/entities.js` and `domain/access.js`; integration tests against the Compose stack with the seed. There are no tests today, so this goes first. |
| A1 | Driver assignment | `Order.driver: OrderDriver { id, name }` (not the full User: customers and staff never see the driver's email or addresses), `Order.assignedAt`. Invariant: an IN_DELIVERY order always has an assigned driver. Query `availableDeliveries` (READY + DELIVERY mode + no driver, in the driver's `WORKS_AT` stores). Mutation `acceptDelivery(orderId)`, atomic `findOneAndUpdate` on `driverId: null`, error `ORDER_NOT_AVAILABLE` or `ALREADY_DELIVERING`. `READY → IN_DELIVERY` and `IN_DELIVERY → DELIVERED` only by the assigned driver (or ADMIN). Audit event `DELIVERY_ACCEPTED`. |
| A2 | Driver location | Mutation `reportDriverLocation(orderId, lat, lng)`, only the assigned driver while `IN_DELIVERY`; it fails with `NOT_YOUR_DELIVERY` or `INVALID_STATUS` so the Android service stops on its own. The latest point goes in Redis `driver:loc:<orderId>` (JSON, TTL 10 min). Query `driverLocation(orderId)` for the order's customer, store staff and ADMIN. Optional history in a ScyllaDB `locations_by_order` table via a RabbitMQ event, throttled. |
| A3 | Order status history | `Order.statusHistory: [{ status, at, by }]` pushed on every transition in MongoDB, readable by whoever can read the order. Feeds the Android timeline and the dashboard order detail. |
| A4 | Refresh token (required) | `login` also returns `refreshToken` (Redis `refresh:<id>`, 30 days, single use). Mutation `refreshToken(token)` rotates it and returns a new JWT with fresh permissions from Neo4j. `logout` revokes both; role or store changes revoke the user's refresh tokens too. Reusing a spent token revokes the whole family and logs `SECURITY` event `REFRESH_REUSED`. This is also what biometric login unlocks (epic B). |
| A5 | Client setup | Commit the composed supergraph schema (`schema/supergraph.graphql`) as the contract for both clients. Document LAN access for the emulator (`http://10.0.2.2:4000/`) and set CORS to the dashboard's origin. Add a `.env.example` for each service. |
| A6 | Seed for demos | Add to the seed: a second store with its own owner, several orders in every status (including one IN_DELIVERY with a driver and a location), so both clients have data to show. |
| A7 | Owner concept | New role `OWNER` between MANAGER and ADMIN (`ADMIN → OWNER → MANAGER`). Graph relation `(:User)-[:OWNS]->(:Store)`; an owner's scope is the stores they own. New permission `staff:manage`: assign STAFF, DELIVERY and MANAGER and their `WORKS_AT` **only within owned stores** (today that needs `users:manage`, ADMIN-only). Owners can `updateStore` on owned stores; ADMIN creates stores and sets the owner (`assignStoreOwner`). `salesReport` and `packageComponentDemand` get a `storeId` filter so an owner sees only their stores. Menu: owners get Sucursales and a "Mi personal" entry. Audit events `STORE_OWNER_CHANGED`. Opus task. |
| A9 | Marketplace: catalog and stock per store | Products and packages get a required `storeId` (stock is then per store by construction); a package can only contain products of its own store. Categories stay global, shared by every store. `products` and `packages` take a `storeId` filter and `Store` exposes its catalog. **One store per cart and per order**: adding an item from another store fails with `CART_STORE_MISMATCH`; quotes and orders reject mixed stores and take the store from the items. `catalog:manage` and `stock:manage` apply only to stores the user works at or owns (ADMIN: all). Reports are per store. Migration: existing products and packages are assigned to the first store; the seed gets a second store with its own products. Indexes on `storeId`. Opus task, after A0 so tests protect the refactor. |
| A8 | Language-neutral contract | Every error carries a stable `extensions.code` (audit the resolvers for errors that only have a Spanish message). Menu items keep stable `id`s. Document the code list in the README. API text stays Spanish; clients translate. |

### Epic D: Admin dashboard (PickarooFrontend)

The menu comes from the API (`login.menu` / `myMenu`), so the dashboard builds exactly those routes and hides what the role can't see.

| # | Task | Details |
|---|---|---|
| D0 | Clean base | Tailwind only: remove Bootstrap from the dashboard code and from the storefront as it is touched. React Router with the storefront at `/` and the dashboard under `/app` (API menu path `/admin/catalogo` → `/app/admin/catalogo`). Apollo Client, GraphQL Code Generator (types from A5's schema), Vitest + React Testing Library, MSW to mock GraphQL in tests, `react-i18next` wired from the start. Point the storefront's products at the real `products` query and delete the Rick and Morty demo. Add a `dashboard-tests` skill for the `ui-tester` agent. |
| D1 | Auth | Login with `login(email, password)`, keep `token`, `access` and `menu`. Logout calls `logout`. On `UNAUTHENTICATED` go to login, on `FORBIDDEN` show "sin permiso". Route guard by permission, not by role name. |
| D2 | Layout | Sidebar built from `menu`, header with user, role and store selector (staff with several `WORKS_AT` stores), Spanish copy. |
| D3 | Pedidos de la sucursal `/sucursal/pedidos` | Table with filters (store, status, mode, date), order detail with items, address and status history (A3), action buttons for the allowed next status, polling every 10 s. |
| D4 | Inventario `/sucursal/inventario` | Products with stock and low-stock badge, inline `setProductStock`. |
| D5 | Catálogo `/admin/catalogo` | Products and packages: create, edit, activate/deactivate, discounts (`addProductDiscount` / `removeProductDiscount`), image URL. Prices are MXN. |
| D6 | Reportes `/admin/reportes` | Date range; `salesReport` table and chart; `packageComponentDemand` table. |
| D7 | Sucursales `/admin/sucursales` | `stores`, `createStore`, `updateStore` (address, delivery fee, free delivery threshold, active). |
| D8 | Usuarios y roles `/admin/usuarios` | `users`, `roles`, `userAccess`, `assignRole`, `assignUserToStore` / `removeUserFromStore`; warn that it ends the user's sessions. |
| D9 | Auditoría `/admin/auditoria` | `auditSummary(day)`, `auditEvents` by category and day, drill-down by actor and target (e.g. a product's price history). |
| D10 | Entregas `/reparto/entregas` | Live map of orders `IN_DELIVERY` with driver positions (needs A1 + A2), Leaflet + OpenStreetMap with a proper user agent/attribution. |
| D11 | E2E | Playwright against the local stack with the seed: login per role, change an order status, edit stock, see the audit event. |
| D12 | Spanish and English | `react-i18next` with `es` and `en` files; language switch in the header, remembered per browser, first visit follows the browser language. Menu titles translated by menu `id`, errors by `extensions.code`, dates and MXN amounts with `Intl`. A test fails the build if a key exists in one language and not the other. Every D task adds its strings in both languages; D12 is the switch, the check and the sweep of what D0–D2 left. |
| D13 | Mi personal `/app/sucursal/personal` (owner) | Owner view from A7: staff of owned stores, assign and remove STAFF, DELIVERY, MANAGER. |
| D14 | Passkey sign-in (optional, not scheduled) | WebAuthn on the dashboard would need new API operations. Only if wanted after epic B. |

### Epic E9 (Android, existing epic): switch the app to the real API

| # | Task | Details |
|---|---|---|
| E9.1 | GraphQL client | Apollo Kotlin + the schema from A5. `BuildConfig.API_URL` (`http://10.0.2.2:4000/` for the emulator). An auth interceptor reuses `SessionRepository`. |
| E9.2 | Mapping layer | One file per feature mapping GraphQL types to the existing DTOs: statuses, roles → permissions, store → shop, package → combo. Unit-tested. |
| E9.3 | Auth | Email login, `logout`, `me`/`myAccess`, refresh with A4 (or back to login before A4). |
| E9.4 | Catalog and cart | `categories`, `products`, `packages`; cart through `addToCart` / `cart` / `checkoutCart` with `quoteId` and the `PRICE_CHANGED` retry flow. |
| E9.5 | Orders and timeline | `orders`, `order`, `statusHistory` (A3), `cancelOrder`. |
| E9.6 | Driver | `availableDeliveries`, `acceptDelivery`, `updateOrderStatus`, `reportDriverLocation`, `driverLocation` (A1, A2). |
| E9.7 | Contract tests | Recorded real responses parsed by the mapping layer. The mock stays for unit/UI tests and demos; release builds use the real API. |

### Epic L (Android): Spanish and English

Today the app's text is Spanish, written directly in the Compose screens and in ViewModel messages (`strings.xml` has one entry).

| # | Task | Details |
|---|---|---|
| L1 | String resources | Move every user-facing string to resources: English in `values/` (the fallback), Spanish in `values-es/`. ViewModels stop holding text: they expose a message key (a small `UiText` type) that the screen resolves, so messages follow the language. Plurals with `plurals`. The emulator tests are pinned to Spanish in the same task, so they don't depend on the device language. One commit. |
| L2 | Language choice | Follows the phone's language by default. A "Idioma / Language" setting in Usuario with Español, English and "System", using per-app language (`AppCompatDelegate.setApplicationLocales` + `locales_config.xml`), so it also appears in Android's own app settings. The choice survives restarts. |
| L3 | Formats and tests | Dates, times and amounts formatted for the chosen language; currency stays MXN. Existing tests pin Spanish so their assertions keep working; add an English pass over the main flow, and a unit test that fails if a string exists in one language and not the other. Order status and error-code labels come from resources in both languages. |

### Epic B (Android): biometric login

| # | Task | Details |
|---|---|---|
| B1 | Biometric sign-in | `androidx.biometric`. After a password login, offer "Entrar con huella o rostro". If accepted, the refresh token is encrypted with an Android Keystore key that only unlocks after a successful biometric check (`BiometricPrompt` with a `CryptoObject`); the password is never stored. Next time, the login screen shows the biometric button: success → decrypt → `refreshToken` → signed in. |
| B2 | Edge cases | Devices without biometrics or with none enrolled don't show the option. New fingerprint enrolled, or refresh token expired or revoked → the stored secret is discarded and the user logs in with the password once. A toggle in Usuario turns it off. Three failed attempts fall back to the password form. |
| B3 | Tests | Works against the in-app mock first (it already has refresh tokens), so it doesn't wait for A4. Unit tests with a fake authenticator and a fake key store. Emulator check with an enrolled fingerprint and `adb -e emu finger touch 1` (the fingerprint has to be enrolled once by hand in the emulator's settings). |

Signing out with biometrics on keeps the encrypted refresh token on the phone, so the next sign-in is a fingerprint; "Olvidar este dispositivo" in Usuario revokes it on the server. See open question 2.

---

## 4. Order of work

1. **A5 + A0 + A8** (shared schema file, env examples, tests, stable error codes): unblocks both clients.
2. **L1** on Android, before more screens are written: every later Android task then adds its text in both languages instead of being converted afterwards. **L2, L3** right after.
3. In parallel:
   - **A9** (marketplace) first on the API, because it changes the catalog, cart and order shapes both clients build on; then **A4** (refresh token), **A3**, **A1 → A2** (driver).
   - **D0 → D1 → D2 → D3 → D4** (the dashboard reaches "staff can run their store"), in both languages from D0.
   - **E9.1 → E9.2 → E9.3 → E9.4 → E9.5** (the app runs on real catalog, cart and orders).
   - **B1 → B2 → B3** (biometrics, against the mock; switches to the real refresh token with E9.3).
4. **E9.6** and **D10** once A1 and A2 are in. This is what makes the existing driver GPS work end to end.
5. **A7** (owner), then **D13** and the owner parts of D6–D8.
6. **D5–D9**, **D12** sweep, **A6**, **D11**, **E9.7**.

A milestone demo after step 4: the customer orders on Android in either language, staff move it on the dashboard, the driver signs in with a fingerprint, accepts and shares GPS, and the customer and the dashboard both see the driver move.

---

## 5. Running everything locally

```bash
# 1. Backend (from PickarooAPI): databases in Docker, Node services on the host
docker compose up -d
npm install
npm run dev            # gateway :4000, mongoAPI :4001, auditAPI :4003
```

```bash
# 2. Dashboard (from PickarooFrontend)
npm install
npm run dev            # Vite on :5173, VITE_GRAPHQL_URL=http://localhost:4000/
```

```bash
# 3. Android (from Pickaroo): emulator reaches the host's gateway at http://10.0.2.2:4000/
./gradlew :app:installDebug
```

Each service needs its `.env` as described in `PickarooAPI/README.md` §10 (`JWT_SECRET`, Mongo URI with the Compose password, `SEED=true` the first time).

---

## 6. Conventions across the three repos

- Same git rules everywhere (see `CLAUDE.md`): never push, one task = one branch (`codex/PIC-<n>-<slug>`) = one local commit, no co-author lines.
- Jira project **PIC** stays the single board. New epics: **API additions** (A0–A8), **Admin dashboard** (D0–D14), **Android languages** (L1–L3) and **Android biometric login** (B1–B3). E9 already exists for the app.
- GraphQL schema committed in the API is the contract; clients regenerate their types from it.
- Error handling: GraphQL `extensions.code` (`UNAUTHENTICATED`, `FORBIDDEN`, `PRICE_CHANGED`, `ORDER_NOT_AVAILABLE`, …) is mapped to Spanish messages in one place in each client.
- User-facing text in both clients exists in Spanish and English and is never hard-coded; code, commits and docs in English (the API README stays in Spanish as it is).

---

## 7. Open questions

None open. Answered on 2026-11-16: marketplace (A9), sign-out keeps fingerprint sign-in with "Olvidar este dispositivo" to revoke, dashboard in both languages (D12).
