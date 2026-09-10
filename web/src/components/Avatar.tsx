export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Photo or initials; shows a red "SEM FOTO" badge when `noPhotoBadge` and there is no photo. */
export function Avatar({
  name,
  photoUrl,
  size = 'sm',
  square = false,
  noPhotoBadge = false,
  className = '',
}: {
  name: string;
  photoUrl: string | null | undefined;
  size?: AvatarSize;
  square?: boolean;
  noPhotoBadge?: boolean;
  className?: string;
}) {
  const cls = ['avatar', size !== 'sm' ? `avatar--${size}` : '', square ? 'avatar--square' : '', className].filter(Boolean).join(' ');
  return (
    <span className={cls} aria-hidden={photoUrl ? undefined : true} title={name}>
      {photoUrl ? <img src={photoUrl} alt={`Foto de ${name}`} loading="lazy" decoding="async" /> : <span>{initials(name)}</span>}
      {!photoUrl && noPhotoBadge ? <span className="avatar__nophoto">SEM FOTO</span> : null}
    </span>
  );
}
