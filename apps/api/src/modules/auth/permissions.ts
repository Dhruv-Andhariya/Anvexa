import type { CompanyRole } from '@hireflow/contracts';

/**
 * Company-level permission matrix (M28). Checked by AuthGuard on every company-scoped route.
 * Platform Admin is not in this table: platform routes use @PlatformAdminOnly() and get no company data.
 */
export const PERMISSIONS = {
  'company.read': ['COMPANY_ADMIN', 'HR_MEMBER'],
  'company.update': ['COMPANY_ADMIN'],
  'jobs.read': ['COMPANY_ADMIN', 'HR_MEMBER'],
  'jobs.write': ['COMPANY_ADMIN', 'HR_MEMBER'], // create a job, change its requirements
  'jd.generate': ['COMPANY_ADMIN', 'HR_MEMBER'],
  'jd.edit': ['COMPANY_ADMIN', 'HR_MEMBER'],
  'jd.approve': ['COMPANY_ADMIN', 'HR_MEMBER'], // doc M28: hr "create/approve jobs"
  'team.manage': ['COMPANY_ADMIN'], // members, roles, invitations
} as const satisfies Record<string, readonly CompanyRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export const can = (role: CompanyRole, permission: Permission) =>
  (PERMISSIONS[permission] as readonly CompanyRole[]).includes(role);
