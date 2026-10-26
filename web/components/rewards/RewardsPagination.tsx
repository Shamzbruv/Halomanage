import Link from "next/link";
export function RewardsPagination({
  page,
  total,
  size,
  href,
}: {
  page: number;
  total: number;
  size: number;
  href: (page: number) => string;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <nav
      className="flex flex-wrap items-center gap-3 py-3"
      aria-label="Results pages"
    >
      <span>
        {total.toLocaleString()} results · Page {page} of {pages}
      </span>
      {page > 1 && (
        <Link className="btn-secondary" href={href(page - 1)}>
          Previous
        </Link>
      )}
      {page < pages && (
        <Link className="btn-secondary" href={href(page + 1)}>
          Next
        </Link>
      )}
      {page > pages && (
        <Link className="btn-secondary" href={href(1)}>
          First page
        </Link>
      )}
    </nav>
  );
}
