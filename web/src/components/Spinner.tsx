export function Spinner({ block = false, label, large = false }: { block?: boolean; label?: string; large?: boolean }) {
  const el = <span className={large ? 'spinner spinner--lg' : 'spinner'} role="status" aria-label={label ?? 'Carregando'} />;
  if (!block) return el;
  return (
    <div className="spinner-block">
      {el}
      {label ? <span>{label}</span> : null}
    </div>
  );
}
