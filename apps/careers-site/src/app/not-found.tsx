import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-2 text-muted">This job or company does not exist, or the link is incomplete.</p>
      <Link href="/" className="mt-6 inline-block text-sm font-medium text-accent underline">
        Go to the home page
      </Link>
    </main>
  );
}
