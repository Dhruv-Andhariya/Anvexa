import type { Metadata } from 'next';
import { SqlBankBoard } from './sql-bank-board';

export const metadata: Metadata = { title: 'SQL questions · Anvexa' };

export default function SqlQuestionsPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <SqlBankBoard />
    </main>
  );
}
