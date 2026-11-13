import type { Invitation, Member } from '@hireflow/contracts';
import type { ReactNode } from 'react';
import { ROLE_LABEL } from '@/lib/roles';
import { EmptyTeamArt } from './empty-art';
import { EmptyState } from './empty-state';

/** Members and pending invitations of one company (Team page and the Platform Admin company page). */
export function TeamTable({
  members,
  invitations,
  memberActions,
  invitationActions,
}: {
  members: Member[];
  invitations: Invitation[];
  memberActions?: (m: Member) => ReactNode;
  invitationActions?: (i: Invitation) => ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Name</th>
            <th scope="col" className="px-3 py-2 font-medium">Email</th>
            <th scope="col" className="px-3 py-2 font-medium">Role</th>
            <th scope="col" className="px-3 py-2 font-medium">Status</th>
            {(memberActions || invitationActions) && <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.userId} className="border-b border-border last:border-0">
              <td className="px-3 py-2 font-medium">{m.name}</td>
              <td className="px-3 py-2 text-muted">{m.email}</td>
              <td className="px-3 py-2">{ROLE_LABEL[m.role]}</td>
              <td className={`px-3 py-2 ${m.status === 'ACTIVE' ? 'text-success' : 'text-muted'}`}>{m.status === 'ACTIVE' ? 'Active' : 'Disabled'}</td>
              {(memberActions || invitationActions) && <td className="px-3 py-2 text-right">{memberActions?.(m)}</td>}
            </tr>
          ))}
          {invitations.map((i) => (
            <tr key={i.id} className="border-b border-border last:border-0">
              <td className="px-3 py-2 text-muted">—</td>
              <td className="px-3 py-2 text-muted">{i.email}</td>
              <td className="px-3 py-2">{ROLE_LABEL[i.role]}</td>
              <td className="px-3 py-2 text-muted">Invited · expires {new Date(i.expiresAt).toLocaleDateString()}</td>
              {(memberActions || invitationActions) && <td className="px-3 py-2 text-right">{invitationActions?.(i)}</td>}
            </tr>
          ))}
          {members.length + invitations.length === 0 && (
            <tr>
              <td colSpan={5} className="p-0">
                <EmptyState bare compact art={EmptyTeamArt} title="No members yet" description="Invite your teammates to start hiring together." />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
