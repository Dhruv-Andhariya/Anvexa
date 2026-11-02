'use client';

import type { DeleteJobResult } from '@hireflow/contracts';
import { Card } from '@/components/ui';
import { deleteJob } from '@/lib/api';

/** Red outline for destructive buttons (same look as the publish page's other delete actions). */
export const dangerButton = 'border-danger/40! text-danger! hover:bg-danger-soft!';

export type DeletedJob = { title: string; result: DeleteJobResult };

/**
 * "Delete job" (jobs list + publish page): asks first, then deletes the job for good. Returns null when HR cancels.
 * `applications` is how many applications the job has, when the page knows it.
 */
export async function confirmAndDeleteJob(job: { id: string; title: string; applications?: number }): Promise<DeletedJob | null> {
  let apps = 'Every application it received (resumes, ATS scores) is deleted too.';
  if (job.applications === 0) apps = 'It has no applications.';
  else if (job.applications === 1) apps = 'Its 1 application (resume, ATS score) is deleted too.';
  else if (job.applications) apps = `Its ${job.applications} applications (resumes, ATS scores) are deleted too.`;
  const ok = window.confirm(
    `Delete the job "${job.title}" permanently?\n\n` +
      'It is removed from your job list, your careers page and LinkedIn (the post is deleted and the apply link stops ' +
      `working). ${apps} The job description and its versions are deleted as well.\n\nThis cannot be undone.`,
  );
  if (!ok) return null;
  return { title: job.title, result: await deleteJob(job.id) };
}

/** Shown after a delete when some posts could not be removed automatically: HR must delete those by hand. */
export function PostsNotRemovedNotice({ title, result }: { title: string; result: Pick<DeleteJobResult, 'notRemoved'> }) {
  if (!result.notRemoved.length) return null;
  return (
    <Card className="flex flex-col gap-2 border-danger/40 text-sm">
      <p className="font-medium">
        “{title}” was deleted, but these posts could not be removed automatically. Please delete them by hand:
      </p>
      <ul className="flex flex-col gap-1">
        {result.notRemoved.map((n) => (
          <li key={n.channel}>
            <span className="font-medium">{n.channel}</span>: {n.error}
            {n.url && (
              <>
                {' '}
                <a href={n.url} target="_blank" rel="noopener" className="text-accent underline">
                  open post
                </a>
              </>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
