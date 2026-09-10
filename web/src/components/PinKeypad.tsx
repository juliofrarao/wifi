import { Button } from './Button';

/** Numeric keypad for the guard PIN (4–6 digits). */
export function PinKeypad({
  value,
  onChange,
  onSubmit,
  disabled = false,
  maxLength = 6,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  maxLength?: number;
}) {
  const press = (d: string) => {
    if (disabled || value.length >= maxLength) return;
    onChange(value + d);
  };
  return (
    <div>
      <div className="pin-dots" aria-label={`${value.length} dígitos digitados`} role="status">
        {Array.from({ length: Math.max(4, value.length) }).map((_, i) => (
          <span key={i} className={`pin-dot${i < value.length ? ' pin-dot--on' : ''}`} />
        ))}
      </div>
      <div className="keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <Button key={d} variant="neutral" onClick={() => press(d)} disabled={disabled} aria-label={`Dígito ${d}`}>
            {d}
          </Button>
        ))}
        <Button variant="neutral" onClick={() => onChange(value.slice(0, -1))} disabled={disabled || value.length === 0} aria-label="Apagar">
          ⌫
        </Button>
        <Button variant="neutral" onClick={() => press('0')} disabled={disabled} aria-label="Dígito 0">
          0
        </Button>
        <Button variant="primary" onClick={onSubmit} disabled={disabled || value.length < 4} aria-label="Confirmar PIN">
          OK
        </Button>
      </div>
    </div>
  );
}
