import type { Metadata } from 'next';
import { Assessment } from './assessment';

// DSA / SQL coding round. The emailed link is `${CAREERS_SITE_URL}/dsa/{token}` (apps/api round-engine/link.ts).
export const metadata: Metadata = {
  title: 'Anvexa — Coding Assessment',
  description: 'Candidate coding assessment powered by Anvexa.',
};

export default async function DsaAssessmentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <Assessment token={token} />;
}
