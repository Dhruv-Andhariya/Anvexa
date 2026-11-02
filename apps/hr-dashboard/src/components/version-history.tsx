'use client';

import type { JdVersion } from '@hireflow/contracts';
import { versionLabel } from '@/lib/jd';
import { Button } from './ui';

interface Props {
  versions: JdVersion[]; // newest first
  currentId: string | null;
  approvedId: string | null;
  previewId: string | null;
  onPreview: (id: string | null) => void;
}

/** Every AI draft and HR edit is kept, so HR can compare and roll back (doc M02). */
export function VersionHistory({ versions, currentId, approvedId, previewId, onPreview }: Props) {
  return (
    <section aria-labelledby="history-heading" className="flex flex-col gap-3">
      <h2 id="history-heading" className="text-base font-semibold">
        Version history
      </h2>
      <ol className="flex flex-col divide-y divide-border text-sm">
        {versions.map((v) => {
          const current = v.id === currentId;
          const shown = previewId ? v.id === previewId : current;
          return (
            <li key={v.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="font-medium">
                  {versionLabel(v)}
                  {current && <span className="ml-2 text-xs font-normal text-accent">current</span>}
                  {v.id === approvedId && <span className="ml-2 text-xs font-normal text-success">approved</span>}
                </p>
                <p className="text-xs text-muted">{new Date(v.createdAt).toLocaleString()}</p>
              </div>
              {shown ? (
                <span className="text-xs text-muted">Showing</span>
              ) : (
                <Button variant="ghost" onClick={() => onPreview(current ? null : v.id)}>
                  View
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
