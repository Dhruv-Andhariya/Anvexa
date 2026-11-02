import type { CompanyProfile } from '@hireflow/contracts';
import type { ReactNode } from 'react';

/** Read-only view of the company facts the AI received (step 2: loaded profile; step 4: snapshot to verify). */
export function CompanyFacts({ profile }: { profile: CompanyProfile }) {
  const rows: [string, ReactNode][] = [
    ['Industry', profile.industry],
    ['Description', profile.description],
    ['Products or services', profile.productsServices],
    [
      'Website',
      profile.website && (
        <a href={profile.website} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
          {profile.website}
        </a>
      ),
    ],
    [
      'Careers page',
      profile.careersUrl && (
        <a href={profile.careersUrl} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
          {profile.careersUrl}
        </a>
      ),
    ],
    ['Headquarters', profile.headquarters],
    ['Size', profile.companySize && `${profile.companySize} employees`],
    ['Founded', profile.foundedYear],
    ['Culture', profile.culture],
    ['Benefits', profile.benefits.length ? profile.benefits.join(' · ') : undefined],
  ];

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-base font-semibold">{profile.name}</p>
      <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[8.5rem_minmax(0,1fr)]">
        {rows
          .filter(([, value]) => value !== undefined && value !== '')
          .map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd className="whitespace-pre-line break-words">{value}</dd>
            </div>
          ))}
      </dl>
    </div>
  );
}
