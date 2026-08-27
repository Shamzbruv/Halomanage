import Link from "next/link";

type BrandProps = {
  href?: string;
  inverse?: boolean;
  compact?: boolean;
  tagline?: boolean;
  className?: string;
};

// The Halomanage mark: two figures — one navy, one teal — connected at the
// center, together tracing the shape of an "H". This is the single place
// the mark is drawn; every logo anywhere in the product renders through
// this component so the identity only ever needs to change here. The exact
// same geometry (as plain positioned divs instead of SVG shapes, since
// that's what Satori/next-og can render) drives the generated favicon,
// apple-touch-icon, and social preview image — see lib/brand-mark.tsx.
function Mark({ inverse }: { inverse: boolean }) {
  const navy = inverse ? "currentColor" : "var(--brand-navy)";
  const teal = inverse ? "currentColor" : "var(--brand-teal)";
  return (
    <svg className="brand-mark" viewBox="0 0 40 40" role="img" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <circle cx="11" cy="7" r="4" fill={navy} />
      <rect x="7" y="12" width="8" height="16" rx="4" fill={navy} />
      <rect x="15" y="18" width="5" height="4" rx="2" fill={navy} />
      <circle cx="11" cy="33" r="4" fill={navy} />
      <circle cx="29" cy="7" r="4" fill={teal} />
      <rect x="25" y="12" width="8" height="16" rx="4" fill={teal} />
      <rect x="20" y="18" width="5" height="4" rx="2" fill={teal} />
      <circle cx="29" cy="33" r="4" fill={teal} />
      <circle cx="20" cy="20" r="3.1" fill={teal} />
    </svg>
  );
}

export function Brand({ href = "/", inverse = false, compact = false, tagline = false, className = "" }: BrandProps) {
  const content = (
    <span className={`brand ${inverse ? "brand-inverse" : ""} ${compact ? "brand-compact" : ""} ${className}`.trim()}>
      <Mark inverse={inverse} />
      {!compact && (
        <span className="brand-copy">
          <span className="brand-wordmark">
            <span className="brand-wordmark-halo">Halo</span>
            <span className="brand-wordmark-manage">manage</span>
          </span>
          {tagline && <span className="brand-tagline">HR &amp; Employee Management Software</span>}
        </span>
      )}
    </span>
  );

  return href ? (
    <Link href={href} aria-label="Halomanage home">
      {content}
    </Link>
  ) : (
    content
  );
}
