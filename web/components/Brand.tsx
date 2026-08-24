import Link from "next/link";

type BrandProps = {
  href?: string;
  inverse?: boolean;
  compact?: boolean;
  className?: string;
};

export function Brand({ href = "/", inverse = false, compact = false, className = "" }: BrandProps) {
  const content = (
    <span className={`brand ${inverse ? "brand-inverse" : ""} ${className}`.trim()}>
      <span className="brand-mark" aria-hidden="true">
        <span />
      </span>
      {!compact && <span className="brand-wordmark">Halo<span>manage</span></span>}
    </span>
  );

  return href ? (
    <Link href={href} aria-label="Halomanage home">
      {content}
    </Link>
  ) : content;
}

