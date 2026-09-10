import { useConfig } from '../config/ConfigProvider';
import { Banner } from './Banner';

/** "Nova versão — toque para atualizar" (shown when the server serves a newer bundle). */
export function UpdateBanner() {
  const { updateAvailable, applyUpdate } = useConfig();
  if (!updateAvailable) return null;
  return (
    <div className="update-banner no-print">
      <Banner kind="info" icon="🔄" onClick={() => void applyUpdate()}>
        Nova versão — toque para atualizar
      </Banner>
    </div>
  );
}
