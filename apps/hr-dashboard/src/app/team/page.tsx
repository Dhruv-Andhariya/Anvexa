import type { Metadata } from 'next';
import { TeamManager } from './team-manager';

export const metadata: Metadata = { title: 'Team · Anvexa' };

export default function TeamPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Team</h1>
        <p className="mt-1 text-sm text-muted">Invite HR members, change roles, and disable access for your company.</p>
      </div>
      <TeamManager />
    </main>
  );
}
