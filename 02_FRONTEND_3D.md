# CarbonX: Carbon Credit Exchange & Emission Monitoring System
## Part 2: Cinematic 3D Frontend Guide (v2)

**Stack:** React 18 · Vite · TypeScript · Three.js via React Three Fiber (R3F) + drei + postprocessing · **GSAP** (master timeline and camera) · Zustand · TanStack Query · Socket.IO client · Tailwind CSS · Framer Motion · Recharts · React Router 6
**Backend:** the API in `01_DATABASE_AND_BACKEND.md` (Express + PostgreSQL + Socket.IO). Every endpoint, camelCase field and socket event used here comes from that file.

> **How to use this file with OpenCode:** put both `.md` files in the project root and prompt in stages (section 22). Build one stage, run it, then continue. Never ask for the whole app at once.

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
/app         Dashboard (live globe + KPIs + feed)         (all roles)
/app/market  Trading room (2D first, 3D depth optional)    (COMPANY, ADMIN)
/app/wallet  Balances + ledger (+ optional coin stacks)    (COMPANY)
/app/compliance  Cap vs emitted, penalties, reports        (COMPANY, ADMIN)
/app/facility/:id  Facility detail + charts                (any)
/app/auditor Verify reports                                (AUDITOR)
/app/admin   Caps, projects, batches, period close, audit  (ADMIN)
```

Intro rules:
- Plays once per browser session (`sessionStorage.cx_intro_seen`). A "Replay intro" link sits in the footer/user menu.
- A **Skip** button appears from second 1 (bottom-right) and `Esc`/`Space` also skip.
- `prefers-reduced-motion` or low-end device: skip the cinematic, show a static hero (still Earth image + "Enter App").
- If the user is already logged in, skip the intro and go to `/app`.

---

## 2. Project setup

```bash
npm create vite@latest frontend -- --template react-ts
cd frontend
npm i three @react-three/fiber @react-three/drei @react-three/postprocessing postprocessing
npm i gsap zustand @tanstack/react-query axios socket.io-client react-router-dom
npm i framer-motion recharts clsx date-fns sonner
npm i -D tailwindcss postcss autoprefixer @types/three
npx tailwindcss init -p
```

`.env`
```
VITE_API_URL=http://localhost:4000/api
VITE_WS_URL=http://localhost:4000
```
Dev server port 5173 (backend `CORS_ORIGIN` expects it).

**Assets** in `public/`:
```
textures/earth-day.jpg      (2k)         textures/earth-night.jpg (2k, city lights)
textures/earth-clouds.png   (optional)
textures/glow.png           (soft radial sprite for particles)
models/solar.glb  models/wind.glb  models/tree.glb  (optional, Blender; see 14)
audio/ambient.mp3  audio/whoosh.mp3  audio/chime.mp3 (optional, muted by default)
```
Textures: NASA Visible Earth or Solar System Scope (free). Everything must degrade gracefully if a file is missing (procedural fallback sphere, simple geometry instead of `.glb`).

---

## 3. Folder structure

```
frontend/src/
├─ main.tsx  App.tsx  index.css
├─ lib/        api.ts  socket.ts  geo.ts  format.ts  colors.ts  device.ts
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
│  ├─ layout/  AppShell.tsx Sidebar.tsx TopBar.tsx GlassPanel.tsx
│  ├─ ui/      Button Input Table Badge Modal Skeleton Toast
│  ├─ globe/   LiveGlobe.tsx FacilityMarkers.tsx TradeArcs.tsx AlertPulses.tsx
│  │           Tooltip3D.tsx CameraRig.tsx
│  ├─ market/  OrderForm.tsx DepthChart2D.tsx DepthChart3D.tsx(optional)
│  │           PriceChart.tsx TradeTape.tsx MyOrders.tsx
│  ├─ wallet/  LedgerTable.tsx CoinStacks3D.tsx(optional)
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
.glass{background:var(--panel);border:1px solid var(--panel-border);backdrop-filter:blur(14px);border-radius:16px}
```

Typography: **Inter** for UI, **JetBrains Mono** (tabular numbers) for figures, a wide display face (e.g. *Space Grotesk* or *Sora*) for the logo and intro captions. Self-host or load via `@fontsource/*`.

Rules: panels are always glass over dark; never pure white; colour is never the only signal (add icons/labels); ₹ with Indian grouping; tonnes shortened above 1,000 (`1.8M t`).

Logo: simple wordmark "Carbon**X**" with a small hex/ring icon; X glows cyan. Make it as SVG so it can also be extruded or glow in the intro.

---

## 5. The cinematic intro (Layer A)

### 5.1 Story and timeline (total ≈ 24 s)

| t (s) | Scene | What happens | Caption (fade in/out) |
|---|---|---|---|
| 0.0-2.5 | **1. Empty space** | Black. ~3,000 tiny star particles fade in and drift slowly. Camera static. | none |
| 2.5-6.0 | **2. Earth formation** | A looser cloud of ~20,000 particles spirals inward and **converges into a sphere** (the Earth made of dots). Camera slowly dollies in. | "Our planet." |
| 6.0-8.0 | **3. Climate layer** | Dots cross-fade into the textured Earth; blue fresnel atmosphere glows in; Earth starts a slow rotation. | "A fragile balance." |
| 8.0-11.0 | **4. Carbon visualization** | Red/grey **CO₂ particles** rise from industrial regions (India, China, USA, EU) and swirl around the planet, slightly darkening the atmosphere. | "Industry emits. Every tonne counts." |
| 11.0-14.0 | **5. Green projects** | Glowing nodes pop up on the surface: ☀️ solar (amber), 💨 wind (cyan), 🌲 forest (green), each with a ring pulse and a soft vertical beam. CO₂ density visibly reduces. | "Clean projects fight back." |
| 14.0-17.0 | **6. Carbon credits** | From each node, glowing credit particles lift off and stream along curved paths into a **central Exchange core** (a glowing hex/orb hovering in front of the planet). | "Every tonne saved becomes a credit." |
| 17.0-20.0 | **7. Trading** | Two avatars (buyer on the left, seller on the right) appear as glowing pillars. Credits stream Seller → Exchange → Buyer; a ₹ coin stream flows the other way. A price ticker flickers. | "Buy. Sell. Offset. In real time." |
| 20.0-23.0 | **8. Transition** | Camera pulls back; Earth shrinks to a small element at the corner; the real dashboard grid (blurred glass panels) fades in behind it. | none |
| 23.0-24.5 | **9. Logo / Enter** | "CarbonX" logo glows in; an **Enter App** button pulses. Click → router navigates to `/login` or `/app`. | tagline: "The carbon market, live." |

### 5.2 Architecture: one master timeline, many dumb scenes

Pattern that keeps this maintainable:

1. `sceneState.ts` holds a plain mutable object (not React state) with numbers from 0 to 1 per scene.
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

Skip / replay: `tl.progress(1)` jumps to the end state (logo + Enter button visible), or navigate straight into the app. Because all state is in `S`, scrubbing and skipping are free.

### 5.3 `IntroPage.tsx`

```tsx
<div className="fixed inset-0 bg-[#04070d]">
  <Canvas camera={{ position: [0, 0, 14], fov: 45 }} dpr={[1, 1.75]} gl={{ antialias: true, powerPreference: 'high-performance' }}>
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

  <Captions />                                   {/* centered, fading text */}
  <DashboardBackdrop />                          {/* blurred glass panels, opacity = S.ui (CSS) */}
  <LogoReveal />                                 {/* DOM/SVG logo + Enter button, opacity = S.logo */}
  <SkipButton />                                 {/* visible from 1 s; Esc / Space also */}
  <ProgressBar />                                {/* thin bar at the bottom (tl.progress()) */}
  <SoundToggle />                                {/* muted by default */}
</div>
```
- Start the timeline only after assets are loaded (drei `useProgress`); show a minimal loader ("CarbonX" + percent) until then.
- DOM overlays (captions, logo, button) read `S` via a small `requestAnimationFrame` loop that sets CSS variables/opacity directly (no React state per frame), or are driven by separate GSAP tweens on refs.

### 5.4 Scene implementations (key techniques)

**Scene 1: `Starfield`**
`<Points>` with ~3,000 random positions on a large shell (radius 30-60), size 0.06, `sizeAttenuation`, additive blending; `material.opacity = S.stars`; rotate the group very slowly.

**Scene 2: `ParticleEarth` (the signature effect: particles converge into a sphere)**
- `N = 20000` points. Two attributes: `aStart` (random in a big volume, optionally a loose spiral) and `aTarget` (Fibonacci sphere, radius 2).
- Vertex shader interpolates with `uMorph` and adds noise swirl that fades as it settles.

```glsl
// vertex
uniform float uMorph, uTime, uSize;
attribute vec3 aStart, aTarget;
void main() {
  float t = smoothstep(0.0, 1.0, uMorph);
  vec3 swirl = vec3(sin(uTime + aStart.y), cos(uTime + aStart.x), sin(uTime * .7 + aStart.z)) * (1.0 - t) * 0.6;
  vec3 pos = mix(aStart, aTarget, t) + swirl;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_PointSize = uSize * (1.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
```
In `useFrame`: `uMorph = S.morph`, `uTime += delta`, material opacity `= 1 - S.earth` (dots dissolve into the textured Earth). Colour: cyan to white. Additive blending.

Fibonacci sphere targets:
```ts
for (let i = 0; i < N; i++) {
  const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), th = Math.PI * (3 - Math.sqrt(5)) * i;
  target.set([Math.cos(th) * r * 2, y * 2, Math.sin(th) * r * 2], i * 3);
}
```

**Scene 3: `Earth` + `Atmosphere`**
Textured sphere (same component later reused by the dashboard globe). `material.opacity = S.earth`. Atmosphere is a back-face fresnel shader sphere (radius 2.24) with intensity `S.atmo`. Earth `rotation.y += delta * 0.08 * S.rotate`.

**Scene 4: `CO2Cloud`**
~6,000 particles around the planet, concentrated above 4-5 industrial hotspots (lat/lng for India, China, USA, EU). Each particle has a hotspot origin, rises, then orbits slowly. Colour grey-red, additive, slightly large and soft (`glow.png`). Density = `S.co2 * (1 - 0.85 * S.co2Clean)`: implement by thresholding per-particle random `aRand < density` in the shader (discard or size = 0). Optionally tint the atmosphere towards red while `co2Clean` is low.

**Scene 5: `ProjectNodes`**
~18 nodes at fixed lat/lng: solar (amber), wind (cyan), forest (green). Each = small emissive sphere + a thin vertical beam (cylinder, additive) + an expanding ring. Spawn staggered with `back.out` scale from `S.projects`. Replace spheres with `.glb` models (optional, section 14). Small floating icon labels via drei `<Html>` (☀️ 💨 🌲) are fine here.

**Scene 6: `ExchangeCore` + `CreditFlows`**
- Exchange core: an icosahedron wireframe + inner glowing orb + two counter-rotating rings, positioned at `(0, 0, 3.2)` (in front of Earth, towards camera), emissive cyan; scale/glow = `S.exchange`.
- Credit flows: for each project node build a `QuadraticBezierCurve3` from node to core (control point lifted outward). Each curve has ~40 credit particles (a `Points` or instanced small spheres) with phase offsets; position = `curve.getPoint((phase + S.credits * 3) % 1)`. Particle colour = project colour, so you see ☀️ amber, 💨 cyan and 🌲 green streams merging into the core.
- As credits arrive, the core pulses (`scale = 1 + 0.08 * sin(...)`).

**Scene 7: `TradeAnimation`**
- Two pillars (Seller left x=-4, Buyer right x=+4), each a translucent glowing cylinder with a small label (drei `Html`: "Seller", "Buyer").
- Credit stream: Seller → Core → Buyer (cyan particles along two short curves).
- Money stream: Buyer → Core → Seller, in amber (₹ coin sprites or small discs).
- A floating `Html` ticker near the core cycling prices (₹1,450 → ₹1,462 → ...), updated by a tween, not React state.
- At the end, a ring shockwave at the core marks "trade complete".

**Scene 8: Transition**
`S.cam.z` goes 8 → 22 while `S.zoomOut` scales the Earth group to ~0.35 and moves it to a corner (e.g. lower right). `DashboardBackdrop` (HTML) fades in: blurred glass cards (KPI strip, chart outlines) so the user sees the product behind the 3D. Fade the exchange/trade scenes out (`S.exchange`, `S.trade` → 0 via an extra tween if needed).

**Scene 9: `LogoReveal`**
DOM/SVG overlay: letters stagger in (Framer Motion or GSAP), "X" glows. Tagline underneath. **Enter App** button pulses; on click `navigate(token ? '/app' : '/login')` and `sessionStorage.cx_intro_seen = '1'`. Ensure the 3D canvas unmounts after navigation to free the WebGL context.

### 5.5 Camera driver
```tsx
function CameraDriver() {
  useFrame(({ camera }) => {
    camera.position.set(S.cam.x, S.cam.y, S.cam.z);
    camera.lookAt(0, 0, 0);
  });
  return null;
}
```
Add subtle idle motion (a tiny sin offset) so the shot never feels frozen.

### 5.6 Optional audio
Muted by default (browsers block autoplay). A visible speaker toggle starts a low ambient pad; trigger a soft "whoosh" at scene 2, a chime when credits hit the core, and a pulse at logo reveal. Use `howler` or the Web Audio API. Respect the toggle.

### 5.7 Quality tiers (`lib/device.ts`)
```ts
export const tier = (() => {
  const low = navigator.hardwareConcurrency <= 4 || innerWidth < 700 ||
              matchMedia('(prefers-reduced-motion: reduce)').matches;
  return low ? 'low' : 'high';
})();
```
| Tier | Particles | Bloom | DPR | Intro |
|---|---|---|---|---|
| high | 20k Earth dots, 6k CO₂ | on | up to 1.75 | full |
| low | 6k / 2k | off | 1 | shortened (≈10 s) or static hero image |

---

## 6. App shell (Layer B)

- `AppShell`: left `Sidebar` (icons + labels, collapsible), `TopBar` (KPI chips from `/stats/overview`, last price with ▲▼, alert bell, user menu, "Replay intro", "Low graphics" toggle).
- Content area is normal scrollable 2D UI with `GlassPanel` cards.
- Page transitions: Framer Motion fade/slide (150-250 ms). No page should feel heavier than a normal web app.
- Skeletons while loading; clear empty states ("No readings yet. Start the sensor simulator.").

---

## 7. Dashboard (`/app`): the one big 3D scene

Layout: the **LiveGlobe** fills the centre ~60% of the screen; KPI strip on top; live feed and alerts in a right column; filters on the left. On mobile, the globe shrinks to a 280 px card on top and everything else stacks.

Reuse `Earth` and `Atmosphere` from the intro (same components, so it looks consistent).

### 7.1 Geometry helpers (`lib/geo.ts`)
```ts
import * as THREE from 'three';
export const R = 2;
export function latLngToVec3(lat: number, lng: number, radius = R) {
  const phi = THREE.MathUtils.degToRad(90 - lat), th = THREE.MathUtils.degToRad(lng + 180);
  return new THREE.Vector3(-radius * Math.sin(phi) * Math.cos(th), radius * Math.cos(phi), radius * Math.sin(phi) * Math.sin(th));
}
export function arcCurve(a: THREE.Vector3, b: THREE.Vector3) {
  const mid = a.clone().add(b).multiplyScalar(0.5).normalize().multiplyScalar(R * (1 + a.distanceTo(b) * 0.25));
  return new THREE.QuadraticBezierCurve3(a, mid, b);
}
```

### 7.2 `FacilityMarkers` (performance critical)
One `InstancedMesh` for all facilities (data from `GET /facilities?year=`). Position via `latLngToVec3`, orient outward, bar height = `log10(emitted+1)/7`, colour from `capColor(pctUsed)`:
```ts
export const capColor = (p: number|null) =>
  p == null ? '#5b6b85' : p >= 100 ? '#ff4d5e' : p >= 90 ? '#ffb020' : p >= 70 ? '#ffe066' : '#22e6a0';
```
Hover → drei `Html` tooltip (facility, company, sector, emitted, % of cap). Click → select, `CameraRig` flies to it, side card with "Open facility". Sector filter chips dim non-matching instances. Live `reading:new` events briefly scale that instance (+30%, decays over 1.5 s) by mutating the instance matrix in `useFrame` (never React state).

### 7.3 `TradeArcs`
On `trade:executed` (payload has `from`/`to` with lat/lng): draw a curved line, animate a glowing coin along it (≈2.5 s), burst ring at the destination, fade out by ~4 s, label "`{quantity} cr @ ₹{price}`". Cap at ~10 concurrent arcs. If `from` or `to` is null, skip the arc but still add to the tape. This is the same visual idea as scene 7 of the intro, but with real data.

### 7.4 `AlertPulses`
On `alert:global` expand a ring on every facility of that company (red for `CAP_EXCEEDED`, amber for `CAP_90`), ~6 s loop. `alert:new` (company room only) shows a toast.

### 7.5 `CameraRig`
GSAP tween camera to `latLngToVec3(lat,lng,R*2.2)` when `focusTarget` changes; `Esc` returns to the default view. OrbitControls: no pan, `minDistance 3.2`, `maxDistance 9`, damping on, auto-rotate when nothing is selected.

### 7.6 Overlays
KPI strip (total emissions, credits in circulation, 24h volume, last price: `/stats/overview` + live `price:tick`), legend (colour = % of cap, height = emissions), live trade feed (last 10), alerts, price sparkline.

---

## 8. Market page (`/app/market`): 2D first

Three columns on desktop: order form | charts | tape and my orders.

- **`OrderForm`:** BUY/SELL toggle, quantity, price (₹). Live total, wallet cash/credits, client-side warnings. Submit → `POST /orders`. Toast `"Order {status}: filled {filledQty}/{quantity}"`. Map errors: `CX001` "Not enough credits", `CX002` "Not enough cash", `CX003` "Invalid order". Disable while pending.
- **`DepthChart2D` (ship this first):** Recharts stepped area chart: bids green, asks red, from `GET /market/depth`. Refetch on `trade:executed` and every 10 s.
- **`DepthChart3D` (optional, behind a "3D view" toggle):** bars on a grid (x = price, height = cumulative qty), bids left, asks right, animated heights with `damp`, click a bar to prefill the price.
- **`PriceChart`:** daily close line + volume bars from `GET /market/prices`, live `price:tick` appended as a dotted segment, optional 30-day MA.
- **`TradeTape`:** last 50 from `GET /market/trades`, new rows slide in; green/red vs the previous price.
- **`MyOrders`:** `GET /orders/mine`, cancel button (`DELETE /orders/:id`) for `OPEN`/`PARTIAL`.

---

## 9. Wallet (`/app/wallet`)
Balance cards (animated count-up), ledger table (`GET /wallet/ledger`: ISSUE, TRADE_IN, TRADE_OUT, RETIRE, EXPIRE), holdings table by batch (`GET /wallet/holdings`), retire modal (`POST /wallet/retire`, shows how much was actually retired). **Optional** `CoinStacks3D` (one stack per batch, coin colour by project type, ≤ 40 coins per stack, `InstancedMesh`) as a toggle.

## 10. Compliance (`/app/compliance`)
2D ring gauge per period (`capColor`), table (cap, emitted, headroom, % used), penalties (`UNPAID`/`PAID`/`WAIVED`), alerts with mark-read, "Submit report" (`POST /reports`), and "credits needed = max(emitted − cap, 0) − creditBalance" with a shortcut to `/app/market` prefilled.

## 11. Facility page (`/app/facility/:id`)
Header, `ReadingChart` (day/week/month buckets from `/facilities/:id/readings`), fuel mix, sensor status dots, and an optional small `EmissionPlume` particle smokestack that puffs on `reading:new` for that facility.

## 12. Auditor and Admin
Pure 2D. Auditor: `SUBMITTED` reports → drawer → Approve/Reject with required remarks (`PATCH /reports/:id/verify`), flag if reported vs sensor-summed differs by > 5%. Admin tabs: caps grid (`PUT /caps`), projects and batch issue (`POST /projects/:id/batches`), period close (`POST /admin/compliance/:periodId/run`, confirm modal, result table), audit log with JSON diff.

---

## 13. API client, stores and sockets

```ts
// lib/api.ts
import axios from 'axios';
import { useAuthStore } from '../store/authStore';
export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL });
api.interceptors.request.use(c => { const t = useAuthStore.getState().token; if (t) c.headers.Authorization = `Bearer ${t}`; return c; });
api.interceptors.response.use(r => r, e => {
  if (e.response?.status === 401) useAuthStore.getState().logout();
  return Promise.reject(new Error(e.response?.data?.error ?? e.message));   // backend: { error, code? }
});
const num = (x: unknown) => (x == null ? 0 : Number(x));   // pg NUMERIC arrives as string → always convert
```
Endpoints used: `POST /auth/login`, `GET /auth/me`, `GET /stats/overview`, `GET /facilities?year=`, `GET /facilities/:id`, `GET /facilities/:id/readings?bucket=`, `GET /market/depth|trades|prices`, `POST /orders`, `GET /orders/mine`, `DELETE /orders/:id`, `GET /wallet`, `/wallet/holdings`, `/wallet/ledger`, `POST /wallet/retire`, `GET /companies/:id/compliance`, `GET /alerts`, `PATCH /alerts/:id/read`, `GET /penalties`, `POST /reports`, `PATCH /reports/:id/verify`, `PUT /caps`, `POST /projects/:id/batches`, `POST /admin/compliance/:periodId/run`, `GET /audit-log`.

Types (important ones):
```ts
export interface Facility { id:number; name:string; latitude:number|string; longitude:number|string;
  companyId:number; company:string; sector:string|null; emitted:number|null; pctUsed:number|null }
export interface Depth { bids:{price:number;qty:number;cumulative:number}[]; asks:{price:number;qty:number;cumulative:number}[] }
export interface TradeExecuted { tradeId:number; quantity:number; price:number;
  from:{company:string;lat:number;lng:number}|null; to:{company:string;lat:number;lng:number}|null }
export interface AlertNew { companyId:number; type:'CAP_90'|'CAP_EXCEEDED'; pct:number }
```

Socket (`useLiveSocket`, mounted once in `AppShell`, JWT in `auth.token`):
| Event | Action |
|---|---|
| `trade:executed` | push to `liveStore` (arcs + tape), invalidate `depth`, `wallet`, `trades` |
| `price:tick` | update last price + sparkline |
| `reading:new` | bump that facility's marker |
| `alert:global` | pulse that company's markers |
| `alert:new` | toast |

Stores: `authStore` (persisted), `liveStore` (trades, arcs, price ticks, bumps, pulses), `uiStore` (selected facility, filters, year, focus target, low-graphics flag), `introStore` (caption, seen flag).

---

## 14. Assets and models (Blender → .glb)

Use 3D models sparingly, in the intro only (scene 5) and optionally the exchange core.
- Keep each model < 300 KB: low-poly solar panel, 3-blade wind turbine, simple tree/forest cluster.
- Blender: model → apply scale → export **glTF Binary (.glb)** with Draco compression → `useGLTF('/models/solar.glb')` in drei.
- Pre-process with `npx gltf-transform optimize in.glb out.glb` to shrink further.
- Free sources: Poly Pizza, Sketchfab (CC0/CC-BY, check licences), Kenney assets.
- **Fallback:** if you have no time for models, use emissive primitives (sphere + beam + icon label). It still looks good under bloom.

---

## 15. How to make it look professional (ideas)

1. **Restraint:** one accent colour per meaning (green = clean, red = CO₂, cyan = credits, amber = warning). Do not add extra colours.
2. **Bloom with discipline:** `luminanceThreshold` ~0.15-0.25 so only emissive things glow; otherwise it looks muddy.
3. **Depth and motion:** slow camera drift, parallax stars, slight depth-of-field/vignette. Everything eases (`power2.inOut`), nothing linear except particle flows.
4. **Typography in the intro:** big, wide, thin captions, 1-2 s each, never more than 6 words.
5. **Consistency:** the intro's Earth, colours and arc style are the same as the dashboard globe's, so the intro feels like the product.
6. **Real data wherever possible:** after the intro, arcs and pulses come from real trades/alerts. A live demo with the sensor simulator running looks far better than static visuals.
7. **Micro-interactions:** count-up numbers, button press feedback, toast slide-ins, skeleton shimmer.
8. **Responsive:** test at 1440, 1024, 768 and 390 px wide. Mobile gets the low tier and a shorter intro.
9. **Accessibility:** skip button, reduced-motion path, keyboard focus rings, text contrast ≥ 4.5:1, captions are real DOM text (not baked into 3D).
10. **Performance budget:** 60 fps on a mid laptop, intro assets < 5 MB total, first interaction < 3 s on the dashboard.

---

## 16. Tools and how to use them

| Need | Tool |
|---|---|
| 3D in React | Three.js + React Three Fiber + drei |
| Timeline, camera, UI tweens | **GSAP** (one master timeline, section 5.2) |
| Glow, vignette | `@react-three/postprocessing` (Bloom, Vignette) |
| Models | Blender → `.glb` (optionally optimised with gltf-transform) |
| Particles | `Points` + custom shaders (section 5.4) |
| UI scaffolding | v0 (React + Tailwind components for cards, tables, forms) |
| Code assistance | OpenCode / Claude for R3F code, using this file as the spec |

Tip: use v0 only for **2D UI** (sidebar, tables, order form, modals). Write the R3F scenes with your coding assistant, using the exact timeline in 5.1, because scene code needs tuning, not just generation.

---

## 17. Performance checklist

- `InstancedMesh` for markers; `Points` for particles; never one mesh per item.
- No React state inside `useFrame`. Mutate refs, uniforms and `S`.
- Pre-allocate vectors and colours; do not `new` inside `useFrame`.
- One `<Canvas>` at a time. Unmount the intro canvas when entering the app (frees the WebGL context).
- `dpr` capped (1.75 intro, 2 dashboard). `frameloop="demand"` for static 3D accents.
- Lazy-load pages and the intro (`React.lazy`); preload textures with drei `<Preload all />`.
- Compress textures (2k JPG ≤ 1 MB). Use KTX2 only if needed.
- Quality tiers (5.7) and a visible "Low graphics" toggle.
- Cap arcs (~10), price ticks (~200), trade feed (30).

## 18. Error handling and UX
- `ErrorBoundary` around every `<Canvas>`: if WebGL fails, show a static hero image + the 2D app. The app must remain fully usable without WebGL.
- Socket drop: "Reconnecting..." chip; key queries fall back to `refetchInterval: 15000`.
- Mutations always toast success/failure with the backend message.
- Client validation mirrors the server (positive numbers, max qty `1e7`, max price `1e6`).
- Keyboard: `Esc` clears selection or skips intro, `/` focuses search.

## 19. Auth
`Login` (email + password → `POST /auth/login` → store `token`/`user`) over a calm slow-rotating globe (reuse `Earth` with low particle load). Redirect by role: COMPANY → `/app`, AUDITOR → `/app/auditor`, ADMIN → `/app/admin`. `ProtectedRoute roles={[...]}` + a 403 page. Show demo accounts (`admin@demo.com`, `auditor@demo.com`, `company1@demo.com`, password `demo123`) as clickable chips.

## 20. Backend gaps to close before the frontend works end to end

The backend guide lists but does not fully code these. Implement them first (same pattern as the market routes):

| Endpoint | Needed by |
|---|---|
| `GET /api/auth/me` | auth bootstrap |
| `GET /api/stats/overview` → `{ totalEmissions, creditsInCirculation, volume24h, lastPrice }` | TopBar |
| `GET /api/orders/mine` | MyOrders |
| `GET /api/wallet`, `/wallet/holdings`, `/wallet/ledger`, `POST /wallet/retire` | wallet (SQL in backend section 12.8) |
| `GET /api/facilities/:id` | facility page |
| `GET /api/companies/:id/compliance` | compliance |
| `GET /api/alerts`, `PATCH /api/alerts/:id/read`, `GET /api/penalties` | compliance |
| `POST /api/readings` mounted under `/api` | simulator |

Also: facilities without lat/lng are omitted, so make sure cities or facilities are geocoded in seeding or the globe is empty. `CORS_ORIGIN` must equal the Vite URL exactly. Normalise NUMERIC strings to numbers.

## 21. Demo script (5 minutes)
1. Open the site: the 24 s intro plays. Let it finish once, then show Skip and Replay.
2. Enter app, rotate the globe, hover a facility, filter by Cement.
3. Start the sensor simulator: markers pulse as readings arrive.
4. Two browser windows (two companies): place matching SELL and BUY orders. The arc flies across the globe, the depth chart and tape update.
5. Push one company past 90% then 100%: amber then red pulse, toast.
6. Wallet shows updated balances; Admin runs the period close and shows penalties.
7. End with the ledger integrity query (0 rows) from the backend guide.

---

## 22. Build order and OpenCode prompts

Paste one at a time, run, test, then continue.

| Stage | Prompt | Result |
|---|---|---|
| 1. Scaffold | "Read 02_FRONTEND_3D.md. Do sections 2, 3, 4: create the Vite React TS project, install deps, folder structure, CSS variables, fonts." | Dark themed empty app |
| 2. API, auth, shell | "Implement sections 6, 13, 19: api client, stores, login, protected routes, AppShell, TopBar, Sidebar. Use only endpoints from 01_DATABASE_AND_BACKEND.md and section 20." | Login and role redirects |
| 3. Intro skeleton | "Implement section 5.2 and 5.3: sceneState, GSAP master timeline, IntroPage with captions, skip button, progress bar, logo overlay. Use placeholder scenes." | Timeline runs with captions |
| 4. Intro scenes 1-3 | "Implement Starfield, ParticleEarth (shader morph), Earth, Atmosphere per 5.4." | Dots become Earth |
| 5. Intro scenes 4-6 | "Implement CO2Cloud, ProjectNodes, ExchangeCore, CreditFlows per 5.4." | Pollution → projects → credits |
| 6. Intro scenes 7-9 | "Implement TradeAnimation, zoom-out transition, DashboardBackdrop, LogoReveal, quality tiers, reduced-motion and replay." | Complete 24 s intro |
| 7. Live globe | "Implement section 7: LiveGlobe, instanced FacilityMarkers, tooltip, selection, CameraRig, filters, KPI strip." | Real facility data on globe |
| 8. Live layer | "Implement useLiveSocket, TradeArcs, AlertPulses." | Arcs and pulses from sockets |
| 9. Market | "Implement section 8 with DepthChart2D first." | Orders match and update live |
| 10. Wallet, compliance, facility, auditor, admin | "Implement sections 9-12 in 2D." | All routes done |
| 11. Polish and optional 3D | "Apply sections 15, 17, 18; then add optional DepthChart3D and CoinStacks3D behind toggles." | Smooth and robust |

OpenCode tips:
- "Do not invent endpoints; use only those in 01_DATABASE_AND_BACKEND.md section 13 plus the gaps in section 20."
- "Never use React state inside useFrame; mutate refs, uniforms, and the shared `S` object."
- "One InstancedMesh for facilities, Points for particles."
- Ask it to run `npm run build` after each stage and fix type errors before continuing.
- Build the intro with placeholder scenes first, so you can tune the timing before polishing visuals.

## 23. Definition of done
- [ ] Intro plays ~24 s with all 9 scenes, skip/replay/reduced-motion work, plays once per session
- [ ] Intro ends on logo + Enter App, then navigates to login or dashboard
- [ ] Dashboard globe ≥ 700 markers at ~60 fps, hover/click/filter work
- [ ] Trade arcs and alert pulses driven by real socket events
- [ ] Market (2D), wallet, compliance, facility, auditor, admin all functional
- [ ] App fully usable without WebGL
- [ ] Mobile layout and low-graphics tier tested
- [ ] `npm run build` passes with no type errors
