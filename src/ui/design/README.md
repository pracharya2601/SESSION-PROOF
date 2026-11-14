# Vexo design system (U1)

Import everything from `src/ui/design` (`"../design"` from pages, `"../../design"` from components).
Styles are global (`styles/tokens.css`, `styles/design.css`) and loaded once by `main.tsx` — don't import CSS from here.
Every animated component honours `prefers-reduced-motion` (App also wraps everything in `<MotionConfig reducedMotion="user">`).

## Tokens (CSS variables, `styles/tokens.css`)
Dark-first; light via `prefers-color-scheme` or `<html data-theme="light|dark">` (toggle in the identity menu / top bar).

| Group | Variables |
|---|---|
| Surfaces | `--bg --bg-elev --surface` (glass) `--surface-solid --surface-2 --surface-hover --surface-active --border --border-strong` |
| Text | `--text --text-2 --muted --subtle` (all AA on `--bg`) |
| Colour | `--accent --accent-strong --accent-2 --accent-grad --success --warning --danger --info --fixture` |
| Effects | `--glow --ring --ring-danger --shadow-sm/md/lg --blur` (use with `backdrop-filter`) |
| Scale | `--sp-1..12` (4px grid), `--r-xs/sm/md/lg/xl/full`, `--text-xs..3xl`, `--font --font-mono`, `--ease-out --dur-fast/--dur/--dur-slow` |

Utility classes: `.stack .stack-sm .stack-lg .row .row-between .muted .subtle .small .tiny .mono .tabular .grad-text .sr-only`, boxes `.error-box .warn-box .success-box .info-box`.

## Components

```tsx
import {
  Button, Card, Badge, Input, Textarea, Select, Switch, Field, Tabs, TabPanel, Dialog, Skeleton,
  EmptyState, PageHeader, AnimatedNumber, StatusPill, useToast, ErrorNotice, Spinner, Celebration,
  fadeUp, stagger, pageTransition, springy, useReducedMotion,
} from "../design";
```

**PageHeader** — renders the page `<h1>`. Put it first in every page.
```tsx
<PageHeader eyebrow="Workspace" title="Settings" subtitle="…" actions={<Button>Save</Button>} onBack={onBack} />
```

**Button** — `variant: "primary" | "secondary" (default) | "ghost" | "danger"`, `size: "sm" | "md"`, `loading`, `icon`, `iconRight`, `block`, `iconOnly` (+ `aria-label`). All native button props pass through.
```tsx
<Button variant="primary" icon={<Upload size={16} />} loading={busy} onClick={save}>Upload</Button>
<Button variant="ghost" size="sm" iconOnly aria-label="Close" icon={<X size={14} />} />
```
For a link that looks like a button: `<a className="ds-btn ds-btn-secondary ds-btn-sm" href=…>`.

**Card** — glass surface. `interactive` (lift + cursor spotlight), `glow` (animated gradient border), `padding: "none"|"sm"|"md"|"lg"`, `as: "div"|"section"|"article"|"li"|"aside"`, `motionProps` (variants/layout…).
```tsx
<Card glow padding="lg" as="section" aria-labelledby="h">…</Card>
```

**Badge** — `tone: "neutral"|"info"|"success"|"warning"|"danger"|"fixture"`, `icon`, `dot`.

**Field + Input / Textarea / Select** — Field wires `id`, `htmlFor`, `aria-describedby`, `aria-invalid` into its single child.
```tsx
<Field label="Folder path" hint="Created if missing" error={err}>
  <Input value={v} onChange={(e) => setV(e.target.value)} leading={<Folder size={14} />} />
</Field>
<Field label="Model"><Select value={m} onChange={(e) => setM(e.target.value)} options={models.map((x) => ({ value: x, label: x }))} /></Field>
<Field label="Body"><Textarea rows={6} … /></Field>
```

**Switch** — `role="switch"`; `checked`, `onChange(checked)`, `label`, `description`, `disabled` (or `aria-label` when no label).
```tsx
<Switch checked={on} onChange={setOn} label="Upload automatically" description="After each approval" />
```

**Tabs / TabPanel** — arrow/Home/End keys, gliding indicator. Use the same `idBase` on both.
```tsx
<Tabs aria-label="Settings sections" idBase="set" value={tab} onChange={setTab}
      items={[{ id: "sync", label: "Sync", icon: <RefreshCw size={14} /> }, { id: "ai", label: "AI", badge: 2 }]} />
<TabPanel idBase="set" id="sync" active={tab === "sync"}>…</TabPanel>
```

**Dialog** — portal, focus trap, Esc/backdrop close, focus restore, scroll lock; bottom sheet on phones.
```tsx
<Dialog open={open} onClose={() => setOpen(false)} title="Create email draft" description="…" size="md"
        dismissible={!busy} footer={<><Button onClick={close}>Cancel</Button><Button variant="primary">Create</Button></>}>
  …form…
</Dialog>
```

**Skeleton** — `width`, `height`, `radius`, `lines`, `circle`. Wrap the region with `aria-busy="true"`.

**EmptyState** — `icon`, `title`, `description`, `action`, `compact`.

**AnimatedNumber** — counts to `value`. `format: "integer" (default) | "cents" | "minutes" | (n) => string`. Screen readers get only the final value.
```tsx
<AnimatedNumber value={amountCents} format="cents" />  <AnimatedNumber value={minutes} format="minutes" />
```
`formatNumber(n, format)` gives the same formatting statically.

**StatusPill** — `status: SessionStatus`, `size: "sm"|"md"`, optional `layoutId`. Active statuses pulse; PROCESSING spins. Also exports `STATUS_LABELS`, `STATUS_TONES`, `ACTIVE_STATUSES`, `REASON_STATUSES`.

**Toasts** — `<ToastProvider>` is mounted in App.
```tsx
const toast = useToast();
toast.success("Uploaded", "3 files saved to Drive");
toast.error("Upload failed", `${err.message} (correlation ID ${cid})`);
toast.toast({ title: "Draft ready", tone: "info", action: { label: "Open draft", onClick: () => window.open(url, "_blank", "noopener") }, duration: 0 });
```

**Celebration** — tasteful radial burst; place inside a `position: relative` element. Plays when `trigger` changes to a new truthy value.
```tsx
<div style={{ position: "relative" }}><Celebration trigger={status === "COMPLETED" ? sessionId : null} /> …</div>
```

**ErrorNotice** — `{ error, title?, onRetry? }`; always shows code + correlation ID for `ApiClientError`. `errorMessage(err)` gives the text.

**Spinner** — `{ size?, label? }` (decorative unless `label`).

## Motion presets (`design/motion.ts`)
- `fadeUp` — variants `hidden → show` (+`exit`); `stagger` — parent that staggers children.
  ```tsx
  <motion.ul variants={stagger} initial="hidden" animate="show">{items.map((i) => <motion.li key={i.id} variants={fadeUp}>…)}</motion.ul>
  ```
- `pageTransition` — `initial → enter → exit` (App already applies it per route; pages needn't).
- `springy` (snappy spring), `softSpring`, `pressable` (`{...pressable}` on a motion element), `fadeOnly` (use instead of `fadeUp` when `useReducedMotion()` is true).

## Shell contract
- Routes: `#/`, `#/sessions/:id`, `#/files`, `#/connections`, `#/settings`. A query after the path (e.g. `#/connections?connected=google`) is preserved for pages to read from `window.location.hash`.
- Pages are lazy-loaded inside `<main id="main">` with a page transition; the top bar shows the page name, so pages render their own `PageHeader`.
- Content max width is 1120px; the bottom nav covers ~90px on phones (≤768px) — `main` already pads for it.
