import { useId, type ReactNode } from 'react';

export function Field({ label, error, hint, children }: {
  label: string; error?: string; hint?: string;
  children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby': string | undefined }) => ReactNode;
}) {
  const id = useId();
  const msgId = `${id}-msg`;
  return (
    <div className={`field${error ? ' has-error' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children({ id, 'aria-invalid': Boolean(error), 'aria-describedby': error || hint ? msgId : undefined })}
      {error ? <p id={msgId} className="error" role="alert">{error}</p> : hint ? <p id={msgId} className="hint">{hint}</p> : null}
    </div>
  );
}
