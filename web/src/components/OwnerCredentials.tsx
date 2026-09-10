import { listCredentials } from '../api/endpoints';
import { useAsync } from '../lib/useAsync';
import { CredentialList, type CredentialOwner } from './CredentialList';
import { QueryState } from './QueryState';

/**
 * Credentials of one owner, loaded with `includeRevoked` so the revoked
 * history is visible (the child/user DTOs only carry active ones).
 */
export function OwnerCredentials({ owner, onChanged }: { owner: CredentialOwner; onChanged?: () => void }) {
  const creds = useAsync(() => listCredentials({ ownerType: owner.type, ownerId: owner.id, includeRevoked: true }), [owner.type, owner.id]);
  return (
    <QueryState loading={creds.loading} error={creds.error} onRetry={creds.reload} hasData={creds.data !== null}>
      <CredentialList
        credentials={creds.data ?? []}
        owner={owner}
        onChanged={() => {
          creds.reload();
          onChanged?.();
        }}
      />
    </QueryState>
  );
}
