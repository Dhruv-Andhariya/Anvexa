import { Assessment } from './assessment';

export default async function DsaAssessmentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <Assessment token={token} />;
}
