/** Static mesh/aurora backdrop (see styles/app.css). Deliberately not animated: it sat under every translucent surface. */
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
