import Link from "next/link";
import type { ReactNode } from "react";

export type TopbarTab = "blueprints" | "runs";

/**
 * Shared app chrome. The Library passes a `tab`; Builder / Run / Reader reuse it
 * with a custom `center` slot (and no active tab).
 */
export function Topbar({
  tab,
  center,
  right,
}: {
  tab?: TopbarTab;
  center?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="border-b border-ink/15">
      <div className="mx-auto flex h-14 max-w-[1360px] items-stretch gap-6 px-10">
        <div className="flex items-stretch gap-6">
          <Link
            href="/"
            className="flex items-center font-serif text-[21px] font-medium italic text-ink"
          >
            Runoff
          </Link>
          <nav className="flex items-stretch gap-5">
            <TabLink href="/" label="Blueprints" active={tab === "blueprints"} />
            <TabLink href="/" label="Runs" active={tab === "runs"} />
          </nav>
        </div>
        <div className="flex flex-1 items-center justify-center">{center}</div>
        <div className="flex items-center">{right}</div>
      </div>
    </header>
  );
}

function TabLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className="relative flex items-center font-sans text-[13px] font-medium text-ink"
    >
      {label}
      {active && (
        <span className="absolute inset-x-0 bottom-[-1px] h-[2px] bg-pencil" />
      )}
    </Link>
  );
}
