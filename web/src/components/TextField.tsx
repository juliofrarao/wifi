import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';

interface Common {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Optional class for the input element (e.g. "field__input--code"). */
  inputClassName?: string;
}

export function TextField({ label, hint, error, inputClassName = '', id, className = '', ...rest }: Common & InputHTMLAttributes<HTMLInputElement>) {
  const auto = useId();
  const inputId = id ?? auto;
  const hintId = `${inputId}-hint`;
  const errId = `${inputId}-err`;
  return (
    <div className={`field ${className}`.trim()}>
      <label className="field__label" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        className={`field__input ${inputClassName}`.trim()}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hint ? hintId : null, error ? errId : null].filter(Boolean).join(' ') || undefined}
        {...rest}
      />
      {hint ? (
        <div className="field__hint" id={hintId}>
          {hint}
        </div>
      ) : null}
      {error ? (
        <div className="field__error" id={errId} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function TextArea({ label, hint, error, inputClassName = '', id, className = '', ...rest }: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const auto = useId();
  const inputId = id ?? auto;
  const hintId = `${inputId}-hint`;
  const errId = `${inputId}-err`;
  return (
    <div className={`field ${className}`.trim()}>
      <label className="field__label" htmlFor={inputId}>
        {label}
      </label>
      <textarea
        id={inputId}
        className={`field__input ${inputClassName}`.trim()}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hint ? hintId : null, error ? errId : null].filter(Boolean).join(' ') || undefined}
        {...rest}
      />
      {hint ? (
        <div className="field__hint" id={hintId}>
          {hint}
        </div>
      ) : null}
      {error ? (
        <div className="field__error" id={errId} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function SelectField({
  label,
  hint,
  error,
  id,
  className = '',
  children,
  ...rest
}: Common & React.SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <div className={`field ${className}`.trim()}>
      <label className="field__label" htmlFor={inputId}>
        {label}
      </label>
      <select id={inputId} className="field__input" aria-invalid={error ? true : undefined} {...rest}>
        {children}
      </select>
      {hint ? <div className="field__hint">{hint}</div> : null}
      {error ? (
        <div className="field__error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
