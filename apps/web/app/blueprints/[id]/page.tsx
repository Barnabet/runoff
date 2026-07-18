import { Topbar } from "@/components/Topbar";

// Stub for the Blueprint Builder — Task 18 replaces this with the real editor.
// It exists now so Library ledger rows route somewhere instead of 404ing.
export default async function BlueprintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <>
      <Topbar />
      <main className="mx-auto max-w-[1360px] px-10 py-7 font-serif text-[14px] italic text-ink/45">
        Blueprint builder for {id} lands in Task 18.
      </main>
    </>
  );
}
