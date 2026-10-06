export default function DotBrand({ compact = false }) {
  return (
    <span className="dot-brand">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="10" cy="10" r="4" />
        <circle cx="22" cy="10" r="4" />
        <circle cx="10" cy="22" r="4" />
        <circle cx="22" cy="22" r="4" />
      </svg>
      {!compact && (
        <span>
          dots<span className="brand-period">.</span>
        </span>
      )}
    </span>
  );
}
