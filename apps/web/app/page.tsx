import { Topbar } from "@/components/Topbar";

export default function Home() {
  return (
    <>
      <Topbar tab="blueprints" />
      {/* Library ledger lands here in Task 16. */}
      <main className="mx-auto max-w-[1360px] px-10 py-7" />
    </>
  );
}
