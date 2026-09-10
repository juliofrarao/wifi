import { cardUrl, formatCode, shortName, type CredentialDTO } from '@creche/shared';

/** CR80 cards per A4 sheet (2 × 5). */
export const CARDS_PER_PAGE = 10;

export interface PrintCard {
  id: string;
  ownerType: CredentialDTO['ownerType'];
  ownerId: string;
  /** "Ana S." */
  displayName: string;
  fullName: string;
  className: string | null;
  /** XXXX-XXXX */
  codeText: string;
  /** QR content. */
  url: string;
  photoUrl: string | null;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Parses `?ids=a,b&className=X&photo=1` (ids win over className). */
export function parsePrintQuery(search: string): { ids: string[]; className: string | null; photo: boolean } {
  const params = new URLSearchParams(search);
  const ids = (params.get('ids') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const className = params.get('className')?.trim() || null;
  const photo = ['1', 'true', 'sim'].includes((params.get('photo') ?? '').toLowerCase());
  return { ids, className, photo };
}

/** Builds the printable model; credentials without a code (NFC-only) are skipped. */
export function buildPrintCards(
  credentials: CredentialDTO[],
  appUrl: string,
  photos: Map<string, string | null>,
  withPhoto: boolean
): PrintCard[] {
  return credentials
    .filter((c) => c.active && c.code)
    .map((c) => ({
      id: c.id,
      ownerType: c.ownerType,
      ownerId: c.ownerId,
      displayName: shortName(c.ownerName),
      fullName: c.ownerName,
      className: c.ownerType === 'child' ? c.ownerClassName : null,
      codeText: formatCode(c.code!),
      url: cardUrl(appUrl, c.code!),
      photoUrl: withPhoto ? (photos.get(`${c.ownerType}:${c.ownerId}`) ?? null) : null,
    }));
}
