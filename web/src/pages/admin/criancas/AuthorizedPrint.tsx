import { useEffect } from 'react';
import { relationshipLabel, type ChildAdminDTO, type PickupAuthorizationDTO } from '@creche/shared';
import { Avatar } from '../../../components/Avatar';
import { Button } from '../../../components/Button';
import { useConfig } from '../../../config/ConfigProvider';
import { useFormat } from '../../../lib/format';

/** "Imprimir lista de autorizados": the people who may pick the child up, for the folder at the gate. */
export function AuthorizedPrint({ child, authorizations, onBack }: { child: ChildAdminDTO; authorizations: PickupAuthorizationDTO[]; onBack: () => void }) {
  const { config } = useConfig();
  const fmt = useFormat();
  const today = fmt.today();
  useEffect(() => {
    const t = setTimeout(() => window.print(), 300);
    return () => clearTimeout(t);
  }, []);
  const current = authorizations.filter((a) => !a.revokedAt && a.validUntil >= today);
  return (
    <div className="stack print-doc">
      <div className="row no-print">
        <Button variant="neutral" onClick={onBack}>
          ‹ Voltar
        </Button>
        <Button variant="primary" icon="🖨️" onClick={() => window.print()}>
          Imprimir
        </Button>
      </div>
      <section className="print-page card">
        <h1>
          {config.daycareName} — Pessoas autorizadas a retirar
        </h1>
        <div className="row">
          <Avatar name={child.name} photoUrl={child.photoUrl} size="lg" square />
          <div>
            <div className="big-text">{child.name}</div>
            <div className="small">
              {child.className ?? 'Sem turma'}
              {child.birthDate ? ` · nascimento ${fmt.civil(child.birthDate)}` : ''}
            </div>
            <div className="tiny muted">Emitido em {fmt.dateTime(new Date())}</div>
          </div>
        </div>
        {child.gateAlert ? <p className="print-alert">AVISO DE PORTARIA: {child.gateAlert}</p> : null}
        <h2 className="mt">Responsáveis</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Parentesco</th>
                <th>Pode retirar</th>
                <th>Validade</th>
                <th>Telefone</th>
              </tr>
            </thead>
            <tbody>
              {child.guardians.map((g) => (
                <tr key={g.id}>
                  <td>
                    <strong>{g.name}</strong>
                    {g.isPrimary ? ' (principal)' : ''}
                  </td>
                  <td>{g.relationshipLabel || relationshipLabel(g.relationship)}</td>
                  <td>{g.blocked ? <strong>NÃO LIBERAR — chame a direção</strong> : g.pickupAllowedNow ? 'Sim' : g.canPickup ? 'Fora da validade' : 'Não'}</td>
                  <td>
                    {g.validFrom ? `de ${fmt.civil(g.validFrom)} ` : ''}
                    {g.validUntil ? `até ${fmt.civil(g.validUntil)}` : g.validFrom ? '' : 'sem prazo'}
                  </td>
                  <td>{g.phone ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h2 className="mt">Autorizações avulsas em vigor ou futuras</h2>
        {current.length === 0 ? <p className="small">Nenhuma.</p> : null}
        {current.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Relação</th>
                  <th>Documento</th>
                  <th>Validade</th>
                  <th>Autorizada por</th>
                </tr>
              </thead>
              <tbody>
                {current.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.personName}</strong>
                    </td>
                    <td>{a.relationshipLabel}</td>
                    <td>{a.personDocument ?? ''}</td>
                    <td>{a.validFrom === a.validUntil ? fmt.civil(a.validFrom) : `${fmt.civil(a.validFrom)} a ${fmt.civil(a.validUntil)}`}</td>
                    <td>
                      {a.createdBy.name}
                      {a.createdBy.relationshipLabel ? ` (${a.createdBy.relationshipLabel.toLowerCase()})` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="tiny mt">Qualquer outra pessoa só pode retirar a criança com autorização registrada pela creche ou por um responsável, e sempre com documento conferido.</p>
      </section>
    </div>
  );
}
