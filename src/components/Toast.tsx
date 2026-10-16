import { useEffect } from 'react';

export interface ToastProps {
  message: string | null;
  onDone: () => void;
}

export const TOAST_MS = 1800;

export function Toast({ message, onDone }: ToastProps) {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(onDone, TOAST_MS);
    return () => clearTimeout(timer);
  }, [message, onDone]);

  if (!message) return null;
  return (
    <div id="toast" data-testid="toast" role="status">
      {message}
    </div>
  );
}
