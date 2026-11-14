/** Animated mesh/aurora backdrop. Pure CSS transforms (see styles/app.css); static under reduced motion. */
export function Aurora() {
  return (
    <div className="aurora" aria-hidden="true">
      <div className="aurora-blob b1" />
      <div className="aurora-blob b2" />
      <div className="aurora-blob b3" />
      <div className="aurora-grid" />
    </div>
  );
}
