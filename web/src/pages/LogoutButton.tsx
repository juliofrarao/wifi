import { useState } from 'react';
import { useNavigate } from 'react-router';
import { describeError } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../components/Button';
import { useToast } from '../components/Toast';

/** "Sair" — refused with the QUEUE_PENDING message while the gate queue has pending items. */
export function LogoutButton() {
  const { signOut } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await signOut();
          navigate('/login', { replace: true });
        } catch (err) {
          toast.show(describeError(err), 'danger', 5000);
        } finally {
          setBusy(false);
        }
      }}
    >
      Sair
    </Button>
  );
}
