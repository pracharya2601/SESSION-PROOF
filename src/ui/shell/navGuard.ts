/**
 * In-app navigation guard for hash routes. A page that must not be left silently (e.g. while
 * recording a visit) installs a guard; App asks it before switching routes on `hashchange`.
 * The guard returns false to block: it is then responsible for putting the URL back
 * (history.replaceState, which fires no hashchange) and asking the user. To leave after
 * the user confirms, clear the guard and set location.hash again.
 */
type Guard = (targetHash: string) => boolean;

let current: Guard | null = null;

export function setNavigationGuard(guard: Guard): () => void {
  current = guard;
  return () => {
    if (current === guard) current = null;
  };
}

export function navigationAllowed(targetHash: string): boolean {
  return current ? current(targetHash) : true;
}
