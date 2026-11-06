import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CONTENT } from '@/content';
import { getJob } from '@/lib/api';
import { ApplyForm } from './apply-form';

// Server-rendered on every request so a closed / reopened job shows its real status at once.
// The full JD arrives as plain HTML (fast on slow phones); only the apply form is interactive JavaScript.
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ company: string; job: string }> };

const SITE_URL = (process.env.CAREERS_SITE_URL || 'http://localhost:3300').replace(/\/+$/, '');
const JOB_TYPE = { FULL_TIME: 'Full-time', PART_TIME: 'Part-time', INTERNSHIP: 'Internship', CONTRACT: 'Contract' } as const;

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { company, job } = await params;
  const data = await getJob(company, job);
  if (!data) return {};
  return {
    title: `${data.jd.title} at ${data.company.name}`,
    description: data.jd.summary.slice(0, 160),
    alternates: { canonical: `${SITE_URL}/${company}/jobs/${job}` },
  };
}

/** M08 unified apply link: the full approved JD + the apply form. */
export default async function JobPage({ params }: Params) {
  const { company, job: jobSlug } = await params;
  const job = await getJob(company, jobSlug);
  if (!job) notFound();

  const t = CONTENT.jobPage;
  const live = job.status === 'LIVE';
  const facts: [string, string | null][] = [
    [t.facts.location, job.display.location],
    [t.facts.salary, job.display.salary],
    [t.facts.whoCanApply, job.display.whoCanApply],
    [t.facts.type, JOB_TYPE[job.form.employmentType]],
    [t.facts.deadline, job.display.deadline],
  ];
  const skills = [...job.form.mustHaveSkills];
  const lists: [string, string[]][] = [
    [t.sections.responsibilities, job.jd.responsibilities],
    [t.sections.requirements, job.jd.requirements],
    [t.sections.niceToHave, job.jd.niceToHave],
    [t.sections.benefits, job.jd.benefits],
  ];

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <article className="flex flex-col gap-7 leading-relaxed">
          <header>
            <p className="text-sm font-medium text-muted">{job.company.name}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">{job.jd.title}</h1>
            {live ? (
              <a href="#apply" className="mt-4 inline-flex rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-foreground lg:hidden">
                {t.applyNow}
              </a>
            ) : (
              <p role="status" className="mt-4 rounded-md border border-border bg-accent-soft px-4 py-3 text-sm">
                {t.closed}
              </p>
            )}
          </header>

          <dl className="grid gap-3 rounded-xl border border-border bg-surface p-4 sm:grid-cols-2">
            {facts
              .filter((f): f is [string, string] => !!f[1])
              .map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
                  <dd className="mt-0.5 text-[15px]">{value}</dd>
                </div>
              ))}
          </dl>

          <section>
            <h2 className="mb-2 text-lg font-semibold">{t.sections.summary}</h2>
            <p className="text-[15px]">{job.jd.summary}</p>
          </section>

          {lists.map(([heading, items]) =>
            items.length ? (
              <section key={heading}>
                <h2 className="mb-2 text-lg font-semibold">{heading}</h2>
                <ul className="list-disc space-y-1.5 pl-5 text-[15px] marker:text-muted">
                  {items.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </section>
            ) : null,
          )}

          <section>
            <h2 className="mb-2 text-lg font-semibold">{t.sections.skills}</h2>
            <ul className="flex flex-wrap gap-2">
              {skills.map((s) => (
                <li key={s} className="rounded-full border border-border bg-surface px-3 py-1 text-sm">
                  {s}
                </li>
              ))}
            </ul>
          </section>

          {job.selectionProcess.length > 0 && (
            <section>
              <h2 className="mb-2 text-lg font-semibold">{t.sections.selection}</h2>
              <ol className="list-decimal space-y-1 pl-5 text-[15px] marker:text-muted">
                {job.selectionProcess.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </section>
          )}

          {job.company.about && (
            <section>
              <h2 className="mb-2 text-lg font-semibold">{t.sections.about(job.company.name)}</h2>
              <p className="text-[15px]">{job.company.about}</p>
            </section>
          )}

          {job.company.careersPageUrl && (
            <p className="text-sm">
              <a href={job.company.careersPageUrl} className="font-medium text-accent underline" rel="noopener" target="_blank">
                {t.companyCareers} ↗
              </a>
            </p>
          )}
          <p className="text-sm">
            <a href={`/${encodeURIComponent(company)}/my-data`} className="text-muted underline">
              {t.myData}
            </a>
          </p>
        </article>

        {live && (
          <aside id="apply" className="scroll-mt-6 rounded-xl border border-border bg-surface p-5 sm:p-6 lg:sticky lg:top-6">
            <ApplyForm companySlug={company} jobSlug={jobSlug} experience={{ min: job.form.experienceMin, max: job.form.experienceMax }} />
          </aside>
        )}
      </div>
    </main>
  );
}
