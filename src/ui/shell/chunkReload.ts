/**
 * Recovery from stale code-split chunks.
 *
 * After a redeploy, an already-open tab still references the old hashed chunk names
 * (/assets/Review-<oldhash>.js). Those files are gone, and the asset server answers with
 * the SPA fallback (index.html, 200 text/html), so the dynamic import fails with
 * "Failed to fetch dynamically imported module" / a MIME-type error. Without recovery
 * React unmounts the tree and the page goes blank.
 *
 * We reload the page once (fresh index.html -> new chunk names). A sessionStorage
 * timestamp stops a reload loop if the chunk is genuinely broken.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

const KEY = "vexo.chunkReloadAt";
/** A second chunk failure within this window shows the error UI instead of reloading again. */
export const RELOAD_GUARD_MS = 30_000;

const CHUNK_ERROR_RE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (CSS )?chunk [\w-]+ failed|is not a valid JavaScript MIME type|Expected a JavaScript.*module script/i;

export function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  const name = (err as { name?: unknown }).name;
  if (name === "ChunkLoadError") return true;
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : String((err as { message?: unknown }).message ?? "");
  return CHUNK_ERROR_RE.test(msg);
}

interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function session(): StorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * True when a reload is allowed now (and records the attempt). False when we already
 * reloaded for a chunk error within RELOAD_GUARD_MS, or storage is unavailable
 * (no guard means we cannot rule out a loop, so we do not reload).
 */
export function claimReload(store: StorageLike | null = session(), now = Date.now()): boolean {
  if (!store) return false;
  try {
    const last = Number(store.getItem(KEY) ?? "0");
    if (Number.isFinite(last) && now - last < RELOAD_GUARD_MS) return false;
    store.setItem(KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

/** Set once this page has asked for a reload, so a second failing import (the same stale chunk
 *  reported by both vite:preloadError and the lazy import) waits for it instead of erroring. */
let reloading = false;

/** Reloads once for a stale chunk. Returns true when a reload was started (or is already under way). */
export function reloadForChunkError(err: unknown): boolean {
  if (!isChunkLoadError(err)) return false;
  if (reloading) return true;
  if (!claimReload()) return false;
  reloading = true;
  console.warn("[vexo] stale or missing code chunk; reloading once", err);
  window.location.reload();
  return true;
}

/** `React.lazy` that reloads once when the chunk is stale instead of throwing into the tree. */
export function lazyWithReload<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() =>
    factory().catch((err: unknown) => {
      // Keep the Suspense fallback up while the page reloads.
      if (reloadForChunkError(err)) return new Promise<{ default: T }>(() => undefined);
      throw err;
    }),
  );
}

/** Vite fires `vite:preloadError` when a dependency preload (JS or CSS) fails. */
export function installPreloadRecovery(): void {
  window.addEventListener("vite:preloadError", (event) => {
    const payload = (event as Event & { payload?: unknown }).payload;
    if (reloadForChunkError(payload ?? new Error("Failed to fetch dynamically imported module"))) event.preventDefault();
  });
}
