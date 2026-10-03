# CarbonX — Carbon Credit Exchange & Emission Monitoring System
## Part 4: Cinematic 3D Frontend Specification (corrected, build-ready)

**Stack:** React 18 · Vite · TypeScript · Three.js via React Three Fiber (R3F) + drei + postprocessing · **GSAP** (master timeline and camera) · Zustand · TanStack Query · Socket.IO client · Tailwind CSS · Framer Motion · Recharts · React Router 6
**Backend:** `backend/` (Express + MongoDB/Mongoose + Socket.IO). The route handlers are the source of truth for endpoint names and payloads; the frontend calls them through the `/api` base URL.

> **Read this first.** This is the corrected, self-contained frontend specification for CarbonX, derived from `02_FRONTEND_3D.md`. The design is unchanged; **12 defects found during review have been fixed in place** (a response interceptor that logged you out on a wrong password, a WebGL context leak, a skip button that never navigated, and more). Each is marked `FIX-n` and summarised in [§23 Research findings](#23-research-findings--fixes-applied).
>
> `01_DATABASE_AND_BACKEND (1).md` and `02_FRONTEND_3D.md` are kept as the original design record. This file supersedes `02_FRONTEND_3D.md` wherever they differ. The current API source of truth is the route code under `backend/src/modules/`; see the backend contract in §2.

---

## Table of contents

| § | Section | § | Section |
|---|---|---|---|
| 0 | [The core design decision](#0-the-core-design-decision-read-first) | 12 | [Auditor and Admin](#12-auditor-and-admin) |
| 1 | [App flow](#1-app-flow) | 13 | [API client, stores and sockets](#13-api-client-stores-and-sockets) |
| 2 | [Project setup](#2-project-setup) | 14 | [Assets and models](#14-assets-and-models) |
| 3 | [Folder structure](#3-folder-structure) | 15 | [Making it look professional](#15-making-it-look-professional) |
| 4 | [Visual identity](#4-visual-identity-brand-carbonx) | 16 | [Tools](#16-tools-and-how-to-use-them) |
| 5 | [The cinematic intro](#5-the-cinematic-intro-layer-a) | 17 | [Performance checklist](#17-performance-checklist) |
| 6 | [App shell](#6-app-shell-layer-b) | 18 | [Error handling and UX](#18-error-handling-and-ux) |
| 7 | [Dashboard globe](#7-dashboard-app-the-one-big-3d-scene) | 19 | [Auth](#19-auth) |
| 8 | [Market page](#8-market-page-appmarket-2d-first) | 20 | [Backend gaps](#20-backend-gaps-to-close-before-the-frontend-works-end-to-end) |
| 9 | [Wallet](#9-wallet-appwallet) | 21 | [Demo script](#21-demo-script-5-minutes) |
| 10 | [Compliance](#10-compliance-appcompliance) | 22 | [Build order](#22-build-order-and-opencode-prompts) |
| 11 | [Facility page](#11-facility-page-appfacilityid) | 23 | [Research findings](#23-research-findings--fixes-applied) |

---

## 0. The core design decision (read first)

**Do not make every screen 3D.** The frontend has two layers:

| Layer | What it is | Where |
|---|---|---|
| **A. Cinematic intro** | A 20-25 second scripted 3D story: space → Earth → CO₂ → green projects → credits → exchange → trading → zoom out → logo → "Enter" | `/` (first visit) |
| **B. The app** | A clean, fast, professional 2D dashboard UI. 3D is used in **exactly one** hero place (the live globe) plus small, optional accents | everything after login |

Why: a cinematic intro creates the "wow" and tells the project's story in 20 seconds. A normal UI is what makes the product usable, readable and fast. Judges and users remember the intro, but they judge the product by the dashboard.

**3D budget for layer B:**

- Live globe (dashboard home): yes, the one big 3D scene.
- Market depth chart, wallet coin stacks, facility plume: *optional accents*. Ship the 2D (Recharts/table) version first, add 3D only if time remains, behind a toggle.
- Auditor, admin, reports, ledger: 2D only.

---

## 1. App flow

```
/            Intro (first visit, skippable)  ──► Landing "Enter App"
/login       Login card over a calm slow-rotating globe
/app         Dashboard (live globe + KPIs + feed)          (all roles)
/app/market  Trading room (2D first, 3D depth optional)     (COMPANY, ADMIN)
/app/wallet  Balances + ledger (+ optional coin stacks)     (COMPANY)
/app/compliance  Cap vs emitted, penalties, reports        (COMPANY, ADMIN)
/app/facility/:id  Facility detail + charts                (any)
/app/auditor Verify reports                                (AUDITOR)
/app/admin   Caps, projects, batches, period close, audit  (ADMIN)
```

Intro rules:

- Plays once per browser session (`sessionStorage.cx_intro_seen`). A "Replay intro" link sits in the footer/user menu.
- A **Skip** button appears from second 1 (bottom-right) and `Esc`/`Space` also skip.
- `prefers-reduced-motion` or a low-end device: skip the cinematic, show a static hero (still Earth image + "Enter App").
- If the user is already logged in, skip the intro and go to `/app`.

---

## 2. Project setup

```bash
npm create vite@latest frontend -- --template react-ts
cd frontend
npm i three @react-three/fiber @react-three/drei @react-three/postprocessing postprocessing
npm i gsap zustand @tanstack/react-query axios socket.io-client react-router-dom
npm i framer-motion recharts clsx date-fns sonner
npm i @fontsource/inter @fontsource/jetbrains-mono @fontsource/space-grotesk
npm i -D tailwindcss postcss autoprefixer @types/three
npx tailwindcss init -p
```

`.env`

```
VITE_API_URL=http://localhost:4000/api
VITE_WS_URL=http://localhost:4000
```

Dev server port 5173 — the backend's `CORS_ORIGIN` must equal it **exactly**.

**Assets** in `public/`:

```
textures/earth-day.jpg      (2k)         textures/earth-night.jpg (2k, city lights)
textures/earth-clouds.png   (optional)
textures/glow.png           (soft radial sprite for particles)
models/solar.glb  models/wind.glb  models/tree.glb  (optional, Blender; see §14)
audio/ambient.mp3  audio/whoosh.mp3  audio/chime.mp3 (optional, muted by default)
```

Textures: NASA Visible Earth or Solar System Scope (free). Everything must degrade gracefully if a file is missing — procedural fallback sphere, simple geometry instead of `.glb`.

---

### Backend and database contract

Use this section as the API handoff when building the frontend in a separate project. `VITE_API_URL` is the API base (`http://localhost:4000/api`), so Axios paths are relative, for example `api.get('/stats/overview')`. The backend is Express + MongoDB/Mongoose; the legacy SQL notes and examples elsewhere in this specification do not define the current API.

- Authenticated routes use `Authorization: Bearer <token>`. Login is `POST /auth/login` with `{ email, password }`, returning `{ token, user }`. Public user fields are `id`, `email`, `name`, `role`, `companyId`, and `company`. Roles are `COMPANY`, `AUDITOR`, and `ADMIN`. On startup call `GET /auth/me` (returns `{ user }`); logout is `POST /auth/logout` (returns `{ ok: true }`). JWT lifetime defaults to 8 hours. Seeded local credentials are `admin@carbonx.local` / `Admin@12345`, `company@carbonx.local` / `Company@12345`, and `auditor@carbonx.local` / `Auditor@12345` unless backend environment settings override them.
- MongoDB identifiers are 24-character hexadecimal ObjectId strings in JSON. Do not cast IDs to numbers. Dates are ISO JSON date strings; quantities, prices, totals, coordinates, and aggregate values are JSON numbers. Missing prices may be `null` (for example, a day with no trades); do not convert `null` into a plotted zero.
- Errors use `{ error: string, code: string }` with HTTP statuses such as 400, 401, 403, 404, 409, 422, and 429. Show `error` where appropriate. A 401 from login should display the login error; clear a saved session only when an authenticated request receives 401.
- Lists commonly return a named array plus pagination fields (`limit`, `offset`, and sometimes `total`); consume the actual wrapper, not a bare array. Some UI lists are capped, so don't assume endpoints are unbounded.
- Company routes and wallet data are scoped to the authenticated company. Auditor and admin actions are role-restricted. A 403 means access denied; don't retry it as an expired session.

| Feature | Endpoint and response contract |
|---|---|
| Top bar | `GET /stats/overview` -> `{ totalEmitted, creditsHeld, volume24h, trades24h, lastPrice, lastPriceDate, companiesActive, facilities, sensorsOnline, unreadAlerts }` |
| Globe | `GET /facilities?year=&sector=&state=&search=&onlyOverCap=` -> `{ year, count, bounds, facilities }`; each facility has string `id`/`companyId`, numeric coordinates, `emitted`, `cap`, `pctUsed`, and descriptive fields. Only located facilities are returned; maximum 5,000. |
| Facility detail | `GET /facilities/:id` -> `{ facility, fuels, sensors, emissions, readings, capHistory }`. `GET /facilities/:id/readings?bucket=hour|day|week|month&from=&to=&limit=` returns `{ facilityId, bucket, readings }`, aggregated on demand (not a materialized-view result). |
| Market | `GET /market/depth` -> `{ bids, asks }`; `GET /market/prices?days=30` -> `{ from, to, candles }`, one candle per day and nullable OHLC on no-trade days; `GET /market/trades` -> `{ trades, limit, offset }`. |
| Orders | `POST /orders` with `{ side, price, quantity }` -> 201 `{ order, tradesExecuted }`; `GET /orders/mine` -> `{ orders, limit, offset }`; `DELETE /orders/:id` -> `{ order }`. An order may match immediately. |
| Wallet | `GET /wallet` returns account fields; `/wallet/holdings` -> `{ companyId, holdings, totalQuantity, byVintage }`; `/wallet/ledger` -> `{ companyId, entries, total, limit, offset }`; `/wallet/retirements` -> `{ companyId, retirements }`; `POST /wallet/retire` with `{ quantity, periodId? }` -> 201 `{ retirement, wallet }`. |
| Compliance and alerts | `GET /companies/:id/compliance`, `GET /alerts`, `PATCH /alerts/:id/read`, `PATCH /alerts/read-all`, `GET /penalties`, `GET /reports`. Company endpoints enforce ownership unless a role is explicitly allowed cross-company access. |
| Reporting | `GET /reports/queue` (AUDITOR/ADMIN) -> `{ queue, count }`; `POST /reports` with `{ periodId, totalTonnes }` -> 201 `{ report }`; `PATCH /reports/:id/verify` with `{ decision, remarks }`; `GET /reports/:id/audit` returns decision provenance. There is no partition-ensure endpoint. |
| Admin and projects | `GET /admin/overview`, `PUT /caps`, `POST /admin/compliance/:periodId/run`, `POST /admin/period-totals/rebuild`, `GET /audit-log`, `GET /projects`, `GET /projects/:id`, and `POST /projects/:id/batches`. Follow role checks and request validation. |
| Sensor ingest | `POST /readings` uses a sensor API key (`X-API-Key`, not JWT), body `{ sensorId, readings: [{ ts, tonnes, verified? }] }`, response 201 `{ inserted, duplicates, facilityId, readings }`. Its dedupe identity is sensor + timestamp; repeats are counted in `duplicates`. `GET /readings/recent` uses the same sensor key. This is intended for devices/simulators, not the logged-in web session. |

Realtime uses Socket.IO at `VITE_WS_URL`, authenticated with `io(url, { auth: { token } })`. Events include `connected`, `globe:update`, `reading:new` (facility room), `orderbook:update`, `trade:new`, `wallet:update` (company room), `alert:new`, `report:new`, `report:submitted`, and `compliance:update`. Use `subscribe('facility', facilityId)` for a facility feed; company users may subscribe only to their own company room. REST queries provide initial state and recovery after reconnect.

## 3. Folder structure

```
frontend/src/
├─ main.tsx  App.tsx  index.css  router.tsx
├─ lib/        api.ts  socket.ts  geo.ts  format.ts  colors.ts  device.ts  hotspots.ts
├─ types/api.ts
├─ store/      authStore.ts  liveStore.ts  uiStore.ts  introStore.ts
├─ hooks/      useFacilities.ts useDepth.ts useTrades.ts usePrices.ts useWallet.ts
│              useHoldings.ts useCompliance.ts useOverview.ts useLiveSocket.ts
├─ intro/                                   ◄── LAYER A (cinematic)
│  ├─ IntroPage.tsx          -- canvas + overlay + skip + captions
│  ├─ timeline.ts            -- GSAP master timeline (single source of truth)
│  ├─ sceneState.ts          -- mutable animation values read by 3D components
│  ├─ scenes/
│  │  ├─ Starfield.tsx          (scene 1)
│  │  ├─ ParticleEarth.tsx      (scene 2: particles converge into Earth)
│  │  ├─ Earth.tsx              (shared with the dashboard globe)
│  │  ├─ Atmosphere.tsx         (scene 3, shared)
│  │  ├─ CO2Cloud.tsx           (scene 4)
│  │  ├─ ProjectNodes.tsx       (scene 5: solar / wind / forest)
│  │  ├─ CreditFlows.tsx        (scene 6: credits → exchange)
│  │  ├─ ExchangeCore.tsx       (scene 6-7: glowing central hub)
│  │  ├─ TradeAnimation.tsx     (scene 7: buyer ↔ seller)
│  │  └─ LogoReveal.tsx         (scene 9)
│  ├─ Captions.tsx           -- short text lines synced to scenes
│  └─ introAudio.ts
├─ components/
│  ├─ layout/  AppShell.tsx Sidebar.tsx TopBar.tsx GlassPanel.tsx CanvasBoundary.tsx
│  ├─ ui/      Button Input Table Badge Modal Skeleton Toast EmptyState
│  ├─ globe/   LiveGlobe.tsx FacilityMarkers.tsx TradeArcs.tsx AlertPulses.tsx
│  │           Tooltip3D.tsx CameraRig.tsx
│  ├─ market/  OrderForm.tsx DepthChart2D.tsx DepthChart3D.tsx(optional)
│  │           PriceChart.tsx TradeTape.tsx MyOrders.tsx
│  ├─ wallet/  LedgerTable.tsx HoldingsTable.tsx CoinStacks3D.tsx(optional)
│  ├─ facility/ ReadingChart.tsx EmissionPlume.tsx(optional)
│  └─ compliance/ CapGauge.tsx ComplianceTable.tsx
└─ pages/  Login FacilityPage MarketPage WalletPage CompliancePage AuditorPage AdminPage Dashboard NotFound
```

---

## 4. Visual identity (brand: CarbonX)

Mood: deep space, calm, high-tech, hopeful. Dark navy base, glowing cyan/green accents, a warm amber for "energy/credits".

```css
:root {
  --bg:#04070d; --bg2:#0a1220;
  --panel:rgba(14,22,38,.62); --panel-border:rgba(120,180,255,.14);
  --text:#e8f1ff; --muted:#7d8fa9;
  --green:#22e6a0;   /* clean / under cap / green projects */
  --cyan:#3dd6ff;    /* data / accent / credits */
  --amber:#ffb020;   /* warning / 90% cap */
  --red:#ff4d5e;     /* exceeded / CO2 */
  --gray:#8892a6;    /* raw CO2 smoke */
  --violet:#8b7bff;
}
.glass{background:var(--panel);border:1px solid var(--panel-border);
       backdrop-filter:blur(14px);border-radius:16px}
```

Typography: **Inter** for UI, **JetBrains Mono** (tabular numbers) for figures, a wide display face (**Space Grotesk**) for the logo and intro captions, self-hosted via `@fontsource/*`.

Rules: panels are always glass over dark; never pure white; colour is never the only signal (add icons/labels); ₹ with Indian grouping; tonnes shortened above 1,000 (`1.8M t`).

Logo: a wordmark "Carbon**X**" with a small hex/ring icon where the X glows cyan, authored as SVG so it can also glow in the intro.

```ts
// lib/format.ts
export const inr = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);
export const compact = (n: number) =>
  n >= 1e7 ? `${(n / 1e7).toFixed(2)}Cr` :
  n >= 1e5 ? `${(n / 1e5).toFixed(2)}L`  :
  n >= 1e3 ? `${(n / 1e3).toFixed(1)}K`  : `${n}`;
export const tonnes = (n: number) => (n >= 1000 ? `${compact(n)} t` : `${Math.round(n)} t`);
```

---

## 5. The cinematic intro (Layer A)

### 5.1 Story and timeline (total ≈ 24.5 s)

| t (s) | Scene | What happens | Caption (fade in/out) |
|---|---|---|---|
| 0.0-2.5 | **1. Empty space** | Black. ~3,000 tiny star particles fade in and drift slowly. Camera static. | none |
| 2.5-6.0 | **2. Earth formation** | A looser cloud of ~20,000 particles spirals inward and **converges into a sphere** (the Earth made of dots). Camera slowly dollies in. | "Our planet." |
| 6.0-8.0 | **3. Climate layer** | Dots cross-fade into the textured Earth; a blue fresnel atmosphere glows in; Earth starts a slow rotation. | "A fragile balance." |
| 8.0-11.0 | **4. Carbon visualization** | Red/grey **CO₂ particles** rise from industrial regions (India, China, USA, EU) and swirl around the planet, slightly darkening the atmosphere. | "Industry emits. Every tonne counts." |
| 11.0-14.0 | **5. Green projects** | Glowing nodes pop up on the surface: solar (amber), wind (cyan), forest (green), each with a ring pulse and a soft vertical beam. CO₂ density visibly reduces. | "Clean projects fight back." |
| 14.0-17.0 | **6. Carbon credits** | From each node, glowing credit particles lift off and stream along curved paths into a **central Exchange core** (a glowing hex/orb hovering in front of the planet). | "Every tonne saved becomes a credit." |
| 17.0-20.0 | **7. Trading** | Two avatars (buyer left, seller right) appear as glowing pillars. Credits stream Seller → Exchange → Buyer; a ₹ coin stream flows the other way. A price ticker flickers. | "Buy. Sell. Offset. In real time." |
| 20.0-23.0 | **8. Transition** | Camera pulls back; Earth shrinks to a small element in the corner; the real dashboard grid (blurred glass panels) fades in behind it. | none |
| 23.0-24.5 | **9. Logo / Enter** | "CarbonX" logo glows in; an **Enter App** button pulses. Click → router navigates to `/login` or `/app`. | tagline: "The carbon market, live." |

### 5.2 Architecture: one master timeline, many dumb scenes

The pattern that keeps this maintainable:

1. `sceneState.ts` holds a plain mutable object (**not** React state) with numbers from 0 to 1 per scene.
2. `timeline.ts` builds a single **GSAP timeline** that tweens those numbers and the camera.
3. Each scene component reads `sceneState` inside `useFrame` and updates its own meshes/uniforms. No React re-render per frame.

```ts
// intro/sceneState.ts
export const S = {
  stars: 0,        // 0..1 star opacity
  morph: 0,        // 0..1 particles → sphere
  earth: 0,        // 0..1 textured Earth visible (dots fade out)
  atmo: 0,         // atmosphere intensity
  co2: 0,          // CO2 particle density/opacity
  co2Clean: 0,     // 0..1 how much CO2 has been reduced (after projects)
  projects: 0,     // node appear progress
  credits: 0,      // credit stream progress to exchange
  exchange: 0,     // exchange core glow
  trade: 0,        // buyer/seller flow progress
  zoomOut: 0,      // 0..1 camera pull back + earth shrink
  ui: 0,           // 0..1 dashboard backdrop opacity
  logo: 0,         // 0..1 logo reveal
  rotate: 0,       // earth spin speed multiplier
  cam: { x: 0, y: 0, z: 14 },   // camera position, animated by GSAP
};
export const resetS = () => { /* zero every key — call before a replay */ };
```

```ts
// intro/timeline.ts
import gsap from 'gsap';
import { S } from './sceneState';
import { introStore } from '../store/introStore';

export function buildTimeline(onDone: () => void) {
  const tl = gsap.timeline({ defaults: { ease: 'power2.inOut' }, onComplete: onDone });

  tl.to(S, { stars: 1, duration: 2.5 }, 0)                                  // scene 1
    .to(S.cam, { z: 9, duration: 6 }, 1)                                    // slow dolly during 1-2
    .to(S, { morph: 1, duration: 3.5, ease: 'power3.inOut' }, 2.5)          // scene 2
    .call(() => introStore.getState().setCaption('Our planet.'), [], 3)
    .to(S, { earth: 1, atmo: 1, rotate: 1, duration: 2 }, 6)                // scene 3
    .call(() => introStore.getState().setCaption('A fragile balance.'), [], 6)
    .to(S, { co2: 1, duration: 2.5 }, 8)                                    // scene 4
    .call(() => introStore.getState().setCaption('Industry emits. Every tonne counts.'), [], 8)
    .to(S, { projects: 1, duration: 2.5, ease: 'back.out(1.6)' }, 11)       // scene 5
    .to(S, { co2Clean: 1, duration: 3 }, 11)
    .call(() => introStore.getState().setCaption('Clean projects fight back.'), [], 11)
    .to(S, { exchange: 1, duration: 1.5 }, 13.5)                            // scene 6
    .to(S, { credits: 1, duration: 3, ease: 'none' }, 14)
    .call(() => introStore.getState().setCaption('Every tonne saved becomes a credit.'), [], 14)
    .to(S.cam, { x: 0, y: 0.6, z: 8, duration: 3 }, 14)
    .to(S, { trade: 1, duration: 3, ease: 'none' }, 17)                     // scene 7
    .call(() => introStore.getState().setCaption('Buy. Sell. Offset. In real time.'), [], 17)
    .to(S, { zoomOut: 1, ui: 1, duration: 3 }, 20)                          // scene 8
    .call(() => introStore.getState().setCaption(''), [], 20)
    .to(S.cam, { z: 22, duration: 3 }, 20)
    .to(S, { logo: 1, duration: 1.5 }, 23);                                 // scene 9
  return tl;
}
```

**Skip and replay.** All state lives in `S`, so scrubbing is free. **FIX-2:** the original suggested `tl.progress(1)` to skip, but that jumps the playhead *without* firing `onComplete`, so the intro sat on the logo screen and never navigated. Skip must be an explicit action:

```ts
// intro/IntroPage.tsx
const skip = () => {
  tlRef.current?.progress(1);       // jump to the final visual state
  finish();                         // and run the real exit: navigate + mark seen
};
const finish = () => {
  sessionStorage.setItem('cx_intro_seen', '1');
  navigate(token ? '/app' : '/login');
};
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.code === 'Space') { e.preventDefault(); skip(); }
  };
  window.addEventListener('keydown', onKey);
  return () => { window.removeEventListener('keydown', onKey); tlRef.current?.kill(); };
}, []);
```

Replay must call `resetS()` before rebuilding the timeline, otherwise the second play starts with every value already at 1 and shows nothing.

### 5.3 `IntroPage.tsx`

```tsx
export default function IntroPage() {
  // FIX-3: low-power / reduced-motion users never see the cinematic at all.
  if (tier === 'low' || prefersReducedMotion()) return <StaticHero onEnter={finish} />;

  return (
    <div className="fixed inset-0 bg-[#04070d]">
      <Canvas camera={{ position: [0, 0, 14], fov: 45 }} dpr={[1, 1.75]}
              gl={{ antialias: true, powerPreference: 'high-performance' }}>
        <color attach="background" args={['#04070d']} />
        <CameraDriver />            {/* copies S.cam into the camera each frame */}
        <Starfield />
        <ParticleEarth />
        <Earth />                   {/* fades in via S.earth */}
        <Atmosphere />
        <CO2Cloud />
        <ProjectNodes />
        <ExchangeCore />
        <CreditFlows />
        <TradeAnimation />
        <EffectComposer><Bloom intensity={1.1} luminanceThreshold={0.15} mipmapBlur /></EffectComposer>
        <Preload all />
      </Canvas>

      <Captions />                                   {/* centred, fading text */}
      <DashboardBackdrop />                          {/* blurred glass panels, opacity = S.ui */}
      <LogoReveal />                                 {/* DOM/SVG logo + Enter button, opacity = S.logo */}
      <SkipButton onClick={skip} />                  {/* visible from 1 s; Esc / Space also */}
      <ProgressBar />                                {/* thin bar at the bottom (tl.progress()) */}
      <SoundToggle />                                {/* muted by default */}
    </div>
  );
}
```

- Start the timeline only after assets are loaded (drei `useProgress`); show a minimal loader ("CarbonX" + percent) until then.
- DOM overlays (captions, logo, button) read `S` in a small `requestAnimationFrame` loop that writes CSS variables directly — **no React state per frame** — or are driven by separate GSAP tweens on refs.
- **FIX-4:** unmount the `<Canvas>` and free the WebGL context on exit. Browsers cap live WebGL contexts at ~16, and each `<Canvas>` holds one until it is released, so a replay (or an intro → dashboard double mount) otherwise leaks a context every time and eventually kills the GPU on the page.

```tsx
// components/layout/CanvasBoundary.tsx — one place that handles both problems
import { Canvas, useThree } from '@react-three/fiber';
import { Component, type ReactNode } from 'react';

function Releaser() {
  const gl = useThree((s) => s.gl);
  useEffect(() => () => gl.dispose(), [gl]);   // run on unmount
  return null;
}
export function CanvasBoundary({ children, camera, dpr }: Props) {
  return (
    <ErrorBoundary fallback={<StaticHero />}>   {/* FIX-5: WebGL failure must not blank the app */}
      <Canvas camera={camera} dpr={dpr} gl={{ antialias: true, powerPreference: 'high-performance' }}
              onCreated={({ gl }) => {
                gl.domElement.addEventListener('webglcontextlost', (e) => e.preventDefault());
              }}>
        {children}
        <Releaser />
      </Canvas>
    </ErrorBoundary>
  );
}
```

### 5.4 Scene implementations (key techniques)

**Scene 1: `Starfield`**
`<Points>` with ~3,000 random positions on a large shell (radius 30-60), size 0.06, `sizeAttenuation`, additive blending; `material.opacity = S.stars`; rotate the group very slowly.

**Scene 2: `ParticleEarth` (the signature effect: particles converge into a sphere)**
20,000 points. Two attributes: `aStart` (random in a big volume, optionally a loose spiral) and `aTarget` (Fibonacci sphere, radius 2). The vertex shader interpolates with `uMorph` and adds a swirl that fades as the cloud settles.

```glsl
// vertex
uniform float uMorph, uTime, uSize;
attribute vec3 aStart, aTarget;
varying float vFade;
void main() {
  float t = smoothstep(0.0, 1.0, uMorph);
  vec3 swirl = vec3(sin(uTime + aStart.y), cos(uTime + aStart.x),
                    sin(uTime * .7 + aStart.z)) * (1.0 - t) * 0.6;
  vec3 pos = mix(aStart, aTarget, t) + swirl;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_PointSize = uSize * (1.0 / -mv.z);
  vFade = 1.0 - uMorph;                 // dots dim as the textured Earth takes over
  gl_Position = projectionMatrix * mv;
}
```

In `useFrame`: `uMorph = S.morph`, `uTime += delta`, material opacity `= 1 - S.earth`. Colour: cyan to white, additive blending.

```ts
// Fibonacci sphere targets — evenly distributed, no polar clustering
const target = new Float32Array(N * 3);
const v = new THREE.Vector3();
for (let i = 0; i < N; i++) {
  const y = 1 - (i / (N - 1)) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const th = Math.PI * (3 - Math.sqrt(5)) * i;
  v.set(Math.cos(th) * r * 2, y * 2, Math.sin(th) * r * 2);
  target.set([v.x, v.y, v.z], i * 3);
}
```

**Scene 3: `Earth` + `Atmosphere`**
Textured sphere (the same component is reused by the dashboard globe). `material.opacity = S.earth`. The atmosphere is a back-face fresnel shader sphere (radius 2.24) with intensity `S.atmo`. Earth `rotation.y += delta * 0.08 * S.rotate`.

**Scene 4: `CO2Cloud`**
~6,000 particles around the planet, concentrated above 4-5 industrial hotspots. Each particle has a hotspot origin, rises, then orbits slowly. Colour grey-red, additive, soft (`glow.png`). Density is `S.co2 * (1 - 0.85 * S.co2Clean)`, implemented by thresholding a per-particle random in the shader (`if (aRand > density) gl_PointSize = 0.0;`). Optionally tint the atmosphere towards red while `co2Clean` is low.

```ts
// lib/hotspots.ts — the same coordinates style the globe markers
export const HOTSPOTS = [
  { name: 'India', lat: 22, lng: 79, weight: 1.0 },
  { name: 'China', lat: 35, lng: 105, weight: 1.0 },
  { name: 'USA',  lat: 38, lng: -95, weight: 0.8 },
  { name: 'EU',   lat: 50, lng: 10,  weight: 0.7 },
  { name: 'Japan',lat: 36, lng: 138, weight: 0.5 },
];
```

**Scene 5: `ProjectNodes`**
~18 nodes at fixed lat/lng: solar (amber), wind (cyan), forest (green). Each is a small emissive sphere + a thin vertical beam (cylinder, additive) + an expanding ring. They spawn staggered with a `back.out` scale from `S.projects`. Replace the spheres with `.glb` models if time allows (§14). Small icon labels via drei `<Html>` (☀️ 💨 🌲) are fine here.

**Scene 6: `ExchangeCore` + `CreditFlows`**
- Exchange core: an icosahedron wireframe + inner glowing orb + two counter-rotating rings at `(0, 0, 3.2)` (in front of Earth, towards the camera), emissive cyan; scale/glow = `S.exchange`.
- Credit flows: for each project node build a `QuadraticBezierCurve3` from node to core (control point lifted outward). Each curve carries ~40 credit particles with phase offsets; position = `curve.getPoint((phase + S.credits * 3) % 1)`. Particle colour = project colour, so you see ☀️ amber, 💨 cyan and 🌲 green streams merging into the core.
- As credits arrive, the core pulses (`scale = 1 + 0.08 * Math.sin(t)`).

**Scene 7: `TradeAnimation`**
- Two pillars (Seller at x = -4, Buyer at x = +4), each a translucent glowing cylinder with a drei `<Html>` label.
- Credit stream: Seller → Core → Buyer (cyan particles along two short curves).
- Money stream: Buyer → Core → Seller, in amber (₹ coin sprites).
- A floating `Html` ticker near the core cycling prices (₹1,450 → ₹1,462 → …) driven by a tween, not React state.
- At the end, a ring shockwave at the core marks "trade complete".

**Scene 8: Transition**
`S.cam.z` goes 8 → 22 while `S.zoomOut` scales the Earth group to ~0.35 and moves it to a corner (lower right). `DashboardBackdrop` (HTML) fades in: blurred glass cards (KPI strip, chart outlines) so the user sees the product behind the 3D. Fade the exchange/trade scenes out.

**Scene 9: `LogoReveal`**
DOM/SVG overlay: letters stagger in, the "X" glows, tagline underneath. The **Enter App** button pulses; on click run `finish()` (mark seen + navigate). The canvas unmounts on navigation, freeing the WebGL context.

### 5.5 Camera driver

```tsx
function CameraDriver() {
  useFrame(({ camera, clock }) => {
    camera.position.set(
      S.cam.x + Math.sin(clock.elapsedTime * 0.25) * 0.06,   // subtle idle motion
      S.cam.y + Math.cos(clock.elapsedTime * 0.19) * 0.04,
      S.cam.z,
    );
    camera.lookAt(0, 0, 0);
  });
  return null;
}
```

Never allocate a `Vector3` inside `useFrame` — reuse pre-allocated scratch objects.

### 5.6 Optional audio

Muted by default (browsers block autoplay). A visible speaker toggle starts a low ambient pad; trigger a soft "whoosh" at scene 2, a chime when credits hit the core, and a pulse at the logo reveal. Use `howler` or the Web Audio API, and respect the toggle. Never create an `AudioContext` before a user gesture.

### 5.7 Quality tiers (`lib/device.ts`)

```ts
const lowCores = (navigator.hardwareConcurrency ?? 8) <= 4;
const smallScreen = window.innerWidth < 700;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// FIX-6: also treat a software renderer as low tier — laptops with GPU driver
// disabled report "SwiftShader"/"llvmpipe" and cannot afford 20k particles + bloom.
const gl = document.createElement('canvas').getContext('webgl');
const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
export const softwareGL = /swiftshader|llvmpipe|software/i.test(renderer);

export const tier = (lowCores || smallScreen || reduced || softwareGL) ? 'low' : 'high';
```

| Tier | Particles | Bloom | DPR | Intro |
|---|---|---|---|---|
| high | 20k Earth dots, 6k CO₂ | on | up to 1.75 | full |
| low | 6k / 2k | off | 1 | shortened (≈10 s) or static hero image |

The tier is a plain constant, and a "Low graphics" toggle in the user menu overrides it at runtime (persisted to `uiStore`).

---

## 6. App shell (Layer B)

- `AppShell`: left `Sidebar` (icons + labels, collapsible), `TopBar` (KPI chips from `/stats/overview`, last price with ▲▼, alert bell, user menu, "Replay intro", "Low graphics" toggle).
- Content area is normal scrollable 2D UI with `GlassPanel` cards.
- Page transitions: Framer Motion fade/slide (150-250 ms). No page should feel heavier than a normal web app.
- Skeletons while loading; clear empty states ("No readings yet. Start the sensor simulator.").

---

## 7. Dashboard (`/app`): the one big 3D scene

Layout: the **LiveGlobe** fills the centre ~60% of the screen; KPI strip on top; live feed and alerts in a right column; filters on the left. On mobile, the globe shrinks to a 280 px card on top and everything else stacks. Reuse `Earth` and `Atmosphere` from the intro so the look is consistent.

### 7.1 Geometry helpers (`lib/geo.ts`)

```ts
import * as THREE from 'three';
export const R = 2;

export function latLngToVec3(lat: number, lng: number, radius = R) {
  const phi = THREE.MathUtils.degToRad(90 - lat);
  const th  = THREE.MathUtils.degToRad(lng + 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(th),
     radius * Math.cos(phi),
     radius * Math.sin(phi) * Math.sin(th),
  );
}

export function arcCurve(a: THREE.Vector3, b: THREE.Vector3) {
  const mid = a.clone().add(b).multiplyScalar(0.5)
    .normalize().multiplyScalar(R * (1 + a.distanceTo(b) * 0.25));
  return new THREE.QuadraticBezierCurve3(a, mid, b);
}
```

### 7.2 `FacilityMarkers` (performance critical)

One `InstancedMesh` for all facilities (data from `GET /facilities?year=`). Position via `latLngToVec3`, orient outward, bar height = `log10(emitted + 1) / 7`, colour from `capColor(pctUsed)`:

```ts
export const capColor = (p: number | null) =>
  p == null      ? '#5b6b85'
  : p >= 100     ? '#ff4d5e'
  : p >= 90      ? '#ffb020'
  : p >= 70      ? '#ffe066'
  :               '#22e6a0';
```

Hover → drei `<Html>` tooltip (facility, company, sector, emitted, % of cap). Click → select, `CameraRig` flies to it, side card with "Open facility". Sector filter chips dim non-matching instances. Live `reading:new` events briefly scale that instance (+30%, decaying over 1.5 s) by mutating the instance matrix in `useFrame` — never React state.

```tsx
// FIX-7: three things the original snippet did not handle, and which all produce
// visible artefacts with the real seeded data:
//  (a) emitted is NULL for a facility with no readings -> log10(null) is NaN and
//      the whole instance matrix goes NaN, blanking every marker on screen;
//  (b) lat/lng are NULL (the endpoint filters those out, but a stale cache can
//      still hold one) -> a marker at 0,0 off West Africa;
//  (c) the tooltip was rendered for all 745 instances at once, which is 745 DOM
//      nodes inside a <Canvas> and is the single biggest dashboard stutter.
const EMITTED_MAX = 8;   // log10 of the largest plausible annual total

useLayoutEffect(() => {
  facilities.forEach((f, i) => {
    if (f.latitude == null || f.longitude == null || f.emitted == null) {
      dummy.position.set(0, -100, 0);      // park it off-screen
      dummy.scale.setScalar(0.0001);
    } else {
      dummy.position.copy(latLngToVec3(+f.latitude, +f.longitude));
      const h = Math.log10(f.emitted + 1) / EMITTED_MAX;
      dummy.scale.set(0.05, Math.max(h, 0.02), 0.05);
      dummy.quaternion.setFromUnitVectors(UP, dummy.position.clone().normalize());
    }
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, color.set(capColor(f.pctUsed)));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}, [facilities]);

// one <Html> for the hovered marker only
{hovered && <Html position={hoveredPos} center distanceFactor={8}><Tooltip3D {...hovered} /></Html>}
```

### 7.3 `TradeArcs`

On `trade:executed` (payload includes `tradeId`, `quantity`, `price`, `buyerCompanyId`, and `sellerCompanyId`): update the tape and invalidate market queries. The event does not include facility coordinates, so build trade arcs only if the UI can resolve geocoded endpoints from other data; do not expect `from`/`to` in the socket payload. Cap at ~10 concurrent arcs.

### 7.4 `AlertPulses`

`alert:new` is delivered to the affected company's room and includes `id`, `type`, `message`, `isRead`, and `createdAt`; show a toast and refresh that company's alert list. The backend does not broadcast an `alert:global` event.

```ts
// FIX-8: the original searched `facilities` linearly on every pulse. With 745
// facilities and a burst of alerts during a demo that is a per-frame O(n) scan.
// Build the index once when the facility data changes.
export const useFacilityIndex = (facilities: Facility[]) => {
  const byCompany = useMemo(() => {
    const m = new Map<number, number[]>();
    facilities.forEach((f, i) => {
      const list = m.get(f.companyId) ?? [];
      list.push(i);
      m.set(f.companyId, list);
    });
    return m;
  }, [facilities]);
  return { byCompany, instanceOf: (id: number) => byCompany.get(id) ?? [] };
};
```

### 7.5 `CameraRig`

GSAP-tween the camera to `latLngToVec3(lat, lng, R * 2.2)` when `focusTarget` changes; `Esc` returns to the default view. `OrbitControls`: no pan, `minDistance 3.2`, `maxDistance 9`, damping on, auto-rotate when nothing is selected.

### 7.6 Overlays

KPI strip (total emitted, credits held, 24h volume, last price: `/stats/overview`), legend (colour = % of cap, height = emissions), live trade feed (last 10), alerts, price sparkline.

---

## 8. Market page (`/app/market`): 2D first

Three columns on desktop: order form | charts | tape and my orders.

- **`OrderForm`:** BUY/SELL toggle, quantity, price (₹). Live total, wallet cash/credits, client-side warnings. Submit → `POST /orders`. Toast `"Order {status}: filled {filledQty}/{quantity}"`. Map errors: `CX001` "Not enough credits", `CX002` "Not enough cash", `CX003` "Invalid order". Disable while pending.
- **`DepthChart2D` (ship this first):** a Recharts stepped area chart, bids green, asks red, from `GET /market/depth`. Refetch on `orderbook:dirty` or `orderbook:update` and every 10 s.
- **`DepthChart3D` (optional, behind a "3D view" toggle):** bars on a grid (x = price, height = cumulative qty), bids left, asks right, heights animated with `damp`, click a bar to prefill the price.
- **`PriceChart`:** the daily close line plus volume bars from `GET /market/prices`, with an optional 30-day MA. The response includes every calendar day; no-trade days have null OHLC and zero volume.
- **`TradeTape`:** the last trades from `GET /market/trades`, new rows slide in, green/red versus the previous price.
- **`MyOrders`:** `GET /orders/mine`, cancel button (`DELETE /orders/:id`) for `OPEN`/`PARTIAL`.

---

## 9. Wallet (`/app/wallet`)

Balance cards (animated count-up), ledger table (`GET /wallet/ledger`: ISSUE, TRADE_IN, TRADE_OUT, RETIRE, EXPIRE), holdings table by batch (`GET /wallet/holdings`), retire modal (`POST /wallet/retire`, which shows how much was **actually** retired — it can be less than requested when the company does not hold enough). **Optional** `CoinStacks3D` (one stack per batch, coin colour by project type, ≤ 40 coins per stack, `InstancedMesh`) behind a toggle.

---

## 10. Compliance (`/app/compliance`)

A 2D ring gauge per period (`capColor`), a table (cap, emitted, headroom, % used), penalties (`UNPAID`/`PAID`/`WAIVED`), alerts with mark-read, "Submit report" (`POST /reports`), and "credits needed = max(emitted − cap, 0) − creditBalance" with a shortcut to `/app/market` prefilled.

---

## 11. Facility page (`/app/facility/:id`)

Header, `ReadingChart` (day/week/month buckets from `/facilities/:id/readings` — the monthly bucket is served from the backend's materialized view), fuel mix, sensor status dots (with `lastSeenAt` so a stale sensor is obvious), and an optional small `EmissionPlume` particle smokestack that puffs on `reading:new` for that facility.

---

## 12. Auditor and Admin

Pure 2D.

- **Auditor:** `GET /reports/queue` → `SUBMITTED` reports, each row showing reported total beside the sensor-summed total and a warning flag when they differ by more than 5%. Open a drawer → Approve/Reject with remarks required (`PATCH /reports/:id/verify`).
- **Admin tabs:** caps grid (`PUT /caps`, bulk upsert), projects and batch issue (`POST /projects/:id/batches`), period close (`POST /admin/compliance/:periodId/run` behind a confirm modal, then a result table — because the function now returns one row per company, including compliant ones, with an `outcome` of `COMPLIANT` / `CREDITED` / `PENALISED`), and the audit log with JSON diffs (`GET /audit-log`).

---

## 13. API client, stores and sockets

```ts
// lib/api.ts
import axios from 'axios';
import { useAuthStore } from '../store/authStore';
import { toast } from 'sonner';

export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL });

api.interceptors.request.use((c) => {
  const t = useAuthStore.getState().token;
  if (t) c.headers.Authorization = `Bearer ${t}`;
  return c;
});

// FIX-9: the original interceptor called logout() on ANY 401. A wrong password is a
// 401 too, so a failed login wiped the stored session and the user saw a
// "session expired" redirect instead of "Invalid credentials" — and, if a stale
// token was in storage, it was destroyed by merely typing a bad password.
// Only treat a 401 as an expired session when we actually sent a token, and never
// intercept the login request itself.
const PUBLIC = ['/auth/login', '/auth/register'];
api.interceptors.response.use((r) => r, (e) => {
  const url = e.config?.url ?? '';
  const hadToken = !!e.config?.headers?.Authorization;
  if (e.response?.status === 401 && hadToken && !PUBLIC.some((p) => url.includes(p))) {
    useAuthStore.getState().logout();
    toast.error('Your session expired. Please sign in again.');
  }
  return Promise.reject(new Error(e.response?.data?.error ?? e.message));
});

// Mongo API amounts are JSON numbers. Keep nullable values such as prices null;
// zero is a real amount and must not stand in for missing data.
export const num = (x: unknown): number | null => x == null ? null : Number(x);
```

**Endpoints used:** See the backend contract above for endpoint methods, authentication, response wrappers, and role access. Use the `/api` base URL from `VITE_API_URL`.

```ts
// types/api.ts
export type Id = string; // MongoDB ObjectId serialized as 24 hexadecimal characters
export interface Facility { id:Id; name:string; latitude:number; longitude:number;
  companyId:Id; company:string; sector:string|null; emitted:number; cap:number|null; pctUsed:number|null }
export interface Depth { bids:{price:number;qty:number;cumulative:number}[]; asks:{price:number;qty:number;cumulative:number}[] }
export interface TradeExecuted { tradeId:Id; quantity:number; price:number; buyerCompanyId:Id; sellerCompanyId:Id; tradeTs:string }
export interface AlertNew { id:Id; type:string; message:string; isRead:boolean; createdAt:string }
export interface ReadingNew { facilityId:Id; sensorId:Id; ts:string; tonnes:number; verified:boolean }
export interface Order { orderId:Id; side:'BUY'|'SELL'; quantity:number; filledQty:number;
  price:number; status:'OPEN'|'PARTIAL'|'FILLED'|'CANCELLED' }
```

```ts
// store/authStore.ts  (zustand + persist)
interface AuthState { token: string|null; user: User|null;
  login: (r:{token:string;user:User}) => void; logout: () => void }
export const useAuthStore = create<AuthState>()(persist((set) => ({
  token: null, user: null,
  login: ({ token, user }) => set({ token, user }),
  logout: () => { set({ token: null, user: null }); useLiveSocket.getState().disconnect(); },
}), { name: 'cx_auth' }));
```

```ts
// lib/socket.ts
import { io, type Socket } from 'socket.io-client';
import { useAuthStore } from '../store/authStore';

let socket: Socket | null = null;
export function getSocket() {
  const token = useAuthStore.getState().token;
  if (!token) return null;
  if (!socket) {
    socket = io(import.meta.env.VITE_WS_URL, { auth: { token }, transports: ['websocket'] });
  } else if (socket.auth.token !== token) {
    // the user switched accounts in the same tab
    socket.auth = { token };
    socket.disconnect().connect();
  }
  return socket;
}
export const disconnectSocket = () => { socket?.disconnect(); socket = null; };
```

```ts
// hooks/useLiveSocket.ts  — mounted once in AppShell
export function useLiveSocket() {
  const qc = useQueryClient();
  const live = useLiveStore();

  useEffect(() => {
    const s = getSocket();
    if (!s) return;
    const bind = (ev: string, fn: (...a: any[]) => void) => { s.on(ev, fn); off.push([ev, fn]); };
    const off: [string, (...a: any[]) => void][] = [];

    bind('trade:executed', (t: TradeExecuted) => {
      live.pushTrade(t);
      qc.invalidateQueries({ queryKey: ['depth'] });
      qc.invalidateQueries({ queryKey: ['trades'] });
      qc.invalidateQueries({ queryKey: ['wallet'] });
    });
    bind('orderbook:dirty', () => qc.invalidateQueries({ queryKey: ['depth'] }));
    bind('globe:update',  (r: ReadingNew) => live.bumpFacility(r));
    bind('alert:new',    (a: AlertNew) => toast.warning(a.message));

    return () => { off.forEach(([ev, fn]) => s.off(ev, fn)); };
  }, [qc]);

  useEffect(() => {   // FIX-10: React 18 StrictMode mounts effects twice in dev.
    const s = getSocket();                 // Without this guard the dashboard
    return () => { /* do NOT disconnect here */ };  // connects two sockets and every
  }, []);                                    // event is processed twice.
}
```

| Event | Action |
|---|---|
| `trade:executed` | refresh trade tape and invalidate `depth`, `wallet`, and `trades` |
| `orderbook:dirty` | refresh market depth |
| `globe:update` / `reading:new` | bump a facility marker; `reading:new` is sent to facility subscribers |
| `wallet:update` | refresh the company's wallet |
| `alert:new` | toast and refresh alerts |

**Stores:** `authStore` (persisted), `liveStore` (trades, arcs, price ticks, bumps, pulses — all transient, never persisted), `uiStore` (selected facility, filters, year, focus target, low-graphics flag), `introStore` (caption, seen flag).

```ts
// store/liveStore.ts — keep the buffers bounded (see §17)
interface LiveState {
  trades: TradeExecuted[];        // cap 30
  arcs: Arc[];                    // cap 10
  ticks: { price:number; ts:number }[];  // cap 200
  bumps: Record<Id, number>;  // facilityId -> timestamp, pruned after 2s
  pulses: { companyId:Id; type:string; at:number }[];  // cap 20
}
```

---

## 14. Assets and models (Blender → .glb)

Use 3D models sparingly — in the intro only (scene 5) and optionally the exchange core.

- Keep each model under 300 KB: low-poly solar panel, 3-blade wind turbine, simple tree/forest cluster.
- Blender: model → apply scale → export **glTF Binary (.glb)** with Draco compression → `useGLTF('/models/solar.glb')` in drei.
- Pre-process with `npx gltf-transform optimize in.glb out.glb` to shrink further.
- Free sources: Poly Pizza, Sketchfab (CC0/CC-BY — check licences), Kenney assets.
- **Fallback:** if you have no time for models, use emissive primitives (sphere + beam + icon label). Under bloom it still looks good, and the timeline does not change.

---

## 15. How to make it look professional

1. **Restraint:** one accent colour per meaning (green = clean, red = CO₂, cyan = credits, amber = warning). No extra colours.
2. **Bloom with discipline:** `luminanceThreshold` ~0.15-0.25 so only emissive things glow; otherwise it looks muddy.
3. **Depth and motion:** slow camera drift, parallax stars, slight vignette. Everything eases (`power2.inOut`); nothing linear except particle flows.
4. **Typography in the intro:** big, wide, thin captions, 1-2 s each, never more than 6 words.
5. **Consistency:** the intro's Earth, colours and arc style are identical to the dashboard globe's, so the intro feels like the product.
6. **Real data wherever possible:** after the intro, arcs and pulses come from real trades and alerts. A live demo with the sensor simulator running looks far better than static visuals — and because the simulator now posts through the real ingest endpoint (**backend FIX-1**), the pulses genuinely appear.
7. **Micro-interactions:** count-up numbers, button press feedback, toast slide-ins, skeleton shimmer.
8. **Responsive:** test at 1440, 1024, 768 and 390 px. Mobile gets the low tier and a shorter intro.
9. **Accessibility:** skip button, reduced-motion path, keyboard focus rings, text contrast ≥ 4.5:1, and captions as real DOM text (never baked into 3D).
10. **Performance budget:** 60 fps on a mid laptop, intro assets under 5 MB total, first interaction under 3 s on the dashboard.

---

## 16. Tools and how to use them

| Need | Tool |
|---|---|
| 3D in React | Three.js + React Three Fiber + drei |
| Timeline, camera, UI tweens | **GSAP** (one master timeline, §5.2) |
| Glow, vignette | `@react-three/postprocessing` (Bloom, Vignette) |
| Models | Blender → `.glb` (optionally optimised with gltf-transform) |
| Particles | `Points` + custom shaders (§5.4) |
| UI scaffolding | v0 (React + Tailwind components for cards, tables, forms) |
| Code assistance | OpenCode / Claude for R3F code, using this file as the spec |

Use v0 only for **2D UI** (sidebar, tables, order form, modals). Write the R3F scenes with a coding assistant using the exact timeline in §5.1, because scene code needs tuning, not just generation.

---

## 17. Performance checklist

- `InstancedMesh` for markers; `Points` for particles; never one mesh per item.
- No React state inside `useFrame`. Mutate refs, uniforms and `S`.
- Pre-allocate vectors and colours; never `new` inside `useFrame`.
- One `<Canvas>` at a time, and dispose the WebGL context when it unmounts (**FIX-4**).
- `dpr` capped (1.75 intro, 2 dashboard). `frameloop="demand"` for static 3D accents.
- Lazy-load pages and the intro (`React.lazy`); preload textures with drei `<Preload all />`.
- Compress textures (2k JPG ≤ 1 MB). Use KTX2 only if needed.
- Quality tiers (§5.7) plus a visible "Low graphics" toggle.
- Cap the buffers: arcs ~10, price ticks ~200, trade feed 30, alert pulses 20. Trim expired entries on a timer, not inside the render loop.
- Only one `<Html>` tooltip mounted at a time (**FIX-7c**).
- Index facilities by company once per data change instead of scanning per event (**FIX-8**).
- Guard the socket against StrictMode double-connection (**FIX-10**).

---

## 18. Error handling and UX

- `ErrorBoundary` around every `<Canvas>`: if WebGL fails, show a static hero image and let the 2D app carry on. **The app must remain fully usable without WebGL.**
- Socket drop: show a "Reconnecting…" chip; key queries fall back to `refetchInterval: 15000`.
- Mutations always toast success/failure with the backend's own message.
- Client validation mirrors the server (positive numbers, max quantity `1e7`, max price `1e6`).
- Keyboard: `Esc` clears the selection or skips the intro, `/` focuses search.
- A 401 means "sign in again"; a 403 means "you are not allowed to" — never show one as the other.

---

## 19. Auth

`Login` (email + password → `POST /auth/login` → store `token`/`user`) over a calm slow-rotating globe (reuse `Earth` with a low particle load). Redirect by role: COMPANY → `/app`, AUDITOR → `/app/auditor`, ADMIN → `/app/admin`. `ProtectedRoute roles={[...]}`. For local demo login use the seeded credentials listed in §2, or omit credential chips if seeding has not been run.

The backend access token defaults to 8 hours. Call `GET /auth/me` on boot to validate a restored token and sign out cleanly if it is rejected. The backend reloads the active user and role for authorization.

---

## 20. Frontend integration checklist

These routes are implemented in `backend/`. Keep API paths relative to the configured `/api` base URL.

| Endpoint | Needed by |
|---|---|
| `GET /api/auth/me`, `POST /api/auth/logout` | auth bootstrap and session teardown |
| `GET /api/stats/overview` → `{ totalEmitted, creditsHeld, volume24h, trades24h, lastPrice, ... }` | TopBar |
| `GET /api/orders/mine` | MyOrders |
| `GET /api/wallet`, `/wallet/holdings`, `/wallet/ledger`, `POST /wallet/retire` | wallet |
| `GET /api/facilities/:id` | facility page |
| `GET /api/companies/:id/compliance` | compliance |
| `GET /api/alerts`, `PATCH /api/alerts/:id/read`, `GET /api/penalties` | compliance |
| `GET /api/reports/queue` | auditor queue |
| `GET /api/reports/:id/audit` | report decision provenance |
| `POST /api/readings` (sensor API key, not JWT) | sensor simulator |

Three deployment details that will silently break the demo if missed:

1. Facilities without lat/lng are omitted by `GET /facilities`, so geocode cities or facilities during seeding or the globe is empty.
2. `CORS_ORIGIN` must equal the Vite URL **exactly**, including scheme and port.
3. Treat IDs as ObjectId strings; honor each endpoint's response wrapper, pagination, and nullable fields.

---

## 21. Demo script (5 minutes)

1. Open the site: the 24 s intro plays. Let it finish once, then show Skip and Replay.
2. Enter the app, rotate the globe, hover a facility, filter by Cement.
3. Start the sensor simulator (`node src/jobs/sensorSimulator.js`): markers pulse as readings arrive, because the simulator now posts through `POST /readings` and the server emits `reading:new` (**backend FIX-1**).
4. Two browser windows (two companies): place matching SELL and BUY orders. The arc flies across the globe, the depth chart and tape update.
5. Push one company past 90% then 100%: amber then red pulse, then a toast.
6. The wallet shows updated balances; the admin runs the period close and shows the per-company outcome table and penalties.
7. End with the ledger integrity query from the backend guide — it must return 0 rows.

---

## 22. Build order and OpenCode prompts

Paste one at a time, run, test, then continue.

| Stage | Prompt | Result |
|---|---|---|
| 1. Scaffold | "Read 04_FRONTEND_README.md. Do sections 2, 3, 4: create the Vite React TS project, install deps, folder structure, CSS variables, fonts." | Dark themed empty app |
| 2. API, auth, shell | "Implement sections 6, 13, 19: api client, stores, login, protected routes, AppShell, TopBar, Sidebar. Use only endpoints from 03_BACKEND_README.md §15." | Login and role redirects |
| 3. Intro skeleton | "Implement §5.2 and §5.3: sceneState, GSAP master timeline, IntroPage with captions, skip button, progress bar, logo overlay, plus the explicit skip/finish path and WebGL disposal. Use placeholder scenes." | Timeline runs with captions |
| 4. Intro scenes 1-3 | "Implement Starfield, ParticleEarth (shader morph), Earth, Atmosphere per §5.4." | Dots become Earth |
| 5. Intro scenes 4-6 | "Implement CO2Cloud, ProjectNodes, ExchangeCore, CreditFlows per §5.4." | Pollution → projects → credits |
| 6. Intro scenes 7-9 | "Implement TradeAnimation, zoom-out transition, DashboardBackdrop, LogoReveal, quality tiers, reduced-motion and replay." | Complete 24 s intro |
| 7. Live globe | "Implement §7: LiveGlobe, instanced FacilityMarkers with null guards, single tooltip, selection, CameraRig, filters, KPI strip." | Real facility data on globe |
| 8. Live layer | "Implement useLiveSocket (StrictMode-safe), TradeArcs, AlertPulses with a company index." | Arcs and pulses from sockets |
| 9. Market | "Implement §8 with DepthChart2D first." | Orders match and update live |
| 10. Wallet, compliance, facility, auditor, admin | "Implement §9-12 in 2D." | All routes done |
| 11. Polish and optional 3D | "Apply §15, 17, 18; then add optional DepthChart3D and CoinStacks3D behind toggles." | Smooth and robust |

OpenCode tips:

- "Do not invent endpoints; use only those in 03_BACKEND_README.md §15."
- "Never use React state inside `useFrame`; mutate refs, uniforms, and the shared `S` object."
- "One `InstancedMesh` for facilities, `Points` for particles, one `<Html>` at a time."
- Ask it to run `npm run build` after each stage and fix type errors before continuing.
- Build the intro with placeholder scenes first, so you can tune the timing before polishing visuals.

---

## 23. Definition of done

- [ ] Intro plays ~24 s with all 9 scenes; skip/replay/reduced-motion work; plays once per session
- [ ] Skip button and `Esc` navigate immediately and free the WebGL context
- [ ] Intro ends on logo + Enter App, then navigates to login or dashboard
- [ ] Dashboard globe renders ≥ 700 markers at ~60 fps with hover/click/filter, and no NaN markers
- [ ] Trade arcs and alert pulses are driven by real socket events
- [ ] Market (2D), wallet, compliance, facility, auditor and admin all functional
- [ ] App fully usable without WebGL (ErrorBoundary → static hero)
- [ ] A wrong password shows "Invalid credentials" and does not sign you out
- [ ] Mobile layout and the low-graphics tier tested
- [ ] `npm run build` passes with no type errors

---

## 24. Research findings & fixes applied

The visual and architectural design of the original frontend spec was strong and is unchanged. Reviewing it against the real API contract and real device behaviour turned up the following. Backend-side findings live in `03_BACKEND_README.md` §20.

| # | Severity | Finding | Effect if unfixed | Fix |
|---|---|---|---|---|
| 1 | Medium | The spec cross-referenced `01_DATABASE_AND_BACKEND.md`, a file that does not exist (the real name has a ` (1)` suffix) | Broken cross-reference; an assistant asked to "read that file" would fail | Both new documents reference each other by their real names |
| 2 | High | Skip was defined as `tl.progress(1)` | Scrubbing the playhead does **not** fire `onComplete`, so the intro froze on the logo and never navigated | Explicit `skip()` → `finish()` that marks seen and navigates (§5.2) |
| 3 | Medium | The intro `<Canvas>` was never explicitly disposed | Each replay leaked a WebGL context; browsers cap live contexts at ~16, so the page eventually lost its GPU | `CanvasBoundary` disposes `gl` on unmount and handles `webglcontextlost` (§5.3) |
| 4 | Low | The intro had no reduced-motion / software-renderer path in the code, only in prose | On a low-end or GPU-disabled machine the intro ran at single-digit fps with no fallback | `tier` detection includes `prefers-reduced-motion`, core count, screen size and a SwiftShader/llvmpipe check (§5.7) |
| 5 | Medium | ErrorBoundary was required in prose but the marker code was written as if `emitted` were always a number | `log10(null)` is `NaN`, which poisons an `InstancedMesh` matrix and blanks **every** marker on screen, not just one | Null guards park invalid instances off-screen at scale ~0 (§7.2) |
| 6 | Medium | The tooltip was to be rendered per marker | 745 DOM nodes inside a `<Canvas>` is the largest single dashboard stutter | One `<Html>` for the hovered instance only (§7.2, §17) |
| 7 | Medium | `AlertPulses` was to find a company's facilities per pulse | O(n) scan per alert; visible jank during an alert burst | `useFacilityIndex` builds a `Map<companyId, indices>` once per data change (§7.4) |
| 8 | High | The Axios response interceptor called `logout()` on **any** 401 | A wrong password is a 401, so a failed login destroyed the session and showed a "session expired" redirect instead of "Invalid credentials" | Logout only when a token was actually sent, and never for `/auth/login` (§13) |
| 9 | Low | No guidance on React 18 StrictMode double-mounting effects | The socket connected twice in dev, so every event fired twice — duplicate arcs, duplicate toasts, doubled query invalidation | Guard in `useLiveSocket`; disconnect explicitly on logout instead of on unmount (§13) |
| 10 | Low | `replay` had no instruction to reset `sceneState` | A second play started with every value already at 1 and rendered nothing | `resetS()` before rebuilding the timeline (§5.2) |
| 11 | Low | The price chart had to cope with missing days | Missing days read as "no data" rather than "no trades" | The backend now guarantees a row per day, so the client needs no gap-filling (§8) |
| 12 | Low | The docs did not say where `NUMERIC → string` conversion must happen | A missed cast makes `cap - emitted` produce `"350-210"` and the compliance page show `NaN%` | All casts in SQL, plus `num()` as a client-side safety net (§13) |

**Deliberately unchanged:** the two-layer design decision, the 9-scene timeline and its timing, the mutable-`S`-plus-GSAP architecture, the one-big-3D-scene budget, the brand palette, the build-stage plan, and the performance rules. These are the strongest parts of the original spec.
