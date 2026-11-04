export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="brand-mark">
      <path
        className="brand-mark-head"
        d="M5 3l6 5h10l6-5v14a11 11 0 0 1-11 12A11 11 0 0 1 5 17z"
      />
      <rect className="brand-mark-screen" x="9" y="12" width="14" height="10" rx="2" />
      <rect className="brand-mark-eye" x="11.5" y="15" width="3" height="3" />
      <rect className="brand-mark-eye" x="17.5" y="15" width="3" height="3" />
    </svg>
  );
}
