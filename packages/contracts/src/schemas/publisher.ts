import { z } from 'zod';
import { jdContentSchema, jobFormSchema } from './job';

/** M06/M07 job publisher contracts. Owner: publisher module (apps/api/src/modules/publisher). */

/** A channel is just a string key (e.g. 'careers', 'linkedin'), never a hard-coded union, so new platforms need no contract change. */
export const channelKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/); // 'x' (X/Twitter) is a valid key

export const channelAvailabilitySchema = z.enum(['live', 'coming_soon']);
export type ChannelAvailability = z.infer<typeof channelAvailabilitySchema>;

export const postStatusSchema = z.enum(['PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'NOT_CONFIGURED']);
export type PostStatus = z.infer<typeof postStatusSchema>;

export const SELECTION_PROCESS_LIMITS = { stepMax: 120, stepsMax: 10 } as const;

/**
 * Body of POST /api/v1/publisher/jobs/:jobId/preview and /publish.
 * Only HR's extra input: the job and its JD are read by the API from the database (the version HR
 * APPROVED in job_approvals), so a client can never publish a draft or an edited copy.
 */
export const publishJobRequestSchema = z.object({
  /** Steps HR enters (later: read from M05 round config). Never invented by the publisher. */
  selectionProcess: z
    .array(z.string().trim().min(1).max(SELECTION_PROCESS_LIMITS.stepMax))
    .max(SELECTION_PROCESS_LIMITS.stepsMax)
    .default([]),
});
export type PublishJobRequest = z.infer<typeof publishJobRequestSchema>;

/**
 * The two links every post carries - exactly these, nothing else.
 * `careers` is the company link: the company website, or its careers page link when it has no website.
 */
export const postLinksSchema = z.object({ apply: z.string().url(), careers: z.string().url() });
export type PostLinks = z.infer<typeof postLinksSchema>;

export const channelPreviewSchema = z.object({
  channel: channelKeySchema,
  label: z.string(),
  availability: channelAvailabilitySchema,
  /** Plain-text post as it will appear on this channel (absent for coming-soon channels). */
  text: z.string().optional(),
  links: postLinksSchema.optional(),
  /** Why this channel cannot publish right now (e.g. bot token missing). Empty = ready. */
  blockers: z.array(z.string()).default([]),
});
export type ChannelPreview = z.infer<typeof channelPreviewSchema>;

export const publishPreviewSchema = z.object({
  /** Problems that block publishing everywhere (JD errors, missing company careers URL...). */
  errors: z.array(z.string()),
  /** Non-blocking notes (e.g. the AI validator was unreachable, only basic checks ran). */
  warnings: z.array(z.string()),
  channels: z.array(channelPreviewSchema),
});
export type PublishPreview = z.infer<typeof publishPreviewSchema>;

export const channelPostResultSchema = z.object({
  channel: channelKeySchema,
  status: postStatusSchema,
  url: z.string().nullable(),
  error: z.string().nullable(),
  /**
   * true = this channel already had a post from an earlier publish and it was left as it was (posts are never edited;
   * only the careers page shows the new version).
   */
  unchanged: z.boolean().optional(),
});
export type ChannelPostResult = z.infer<typeof channelPostResultSchema>;

export const publishResultSchema = z.object({
  jobId: z.string(),
  slug: z.string(),
  version: z.number().int().positive(),
  applyUrl: z.string().url(),
  posts: z.array(channelPostResultSchema),
});
export type PublishResult = z.infer<typeof publishResultSchema>;

/**
 * "Delete" on the HR publish page: the job is taken off the careers page and every channel, and goes back to
 * "Not published" (still approved, so it can be published again as a fresh post). Applications are kept.
 */
export const unpublishResultSchema = z.object({
  jobId: z.string(),
  /** Channels whose post is gone. */
  removed: z.array(channelKeySchema),
  /** Posts we could not take down automatically: HR must delete these by hand (url = where the post is). */
  notRemoved: z.array(z.object({ channel: channelKeySchema, url: z.string().nullable(), error: z.string() })),
});
export type UnpublishResult = z.infer<typeof unpublishResultSchema>;

/**
 * "Delete job" (jobs list / publish page): the job is gone for good - posts, careers page, every application with
 * its resume and ATS result, the JD versions and the job itself. Posts a channel could not delete are reported.
 */
export const deleteJobResultSchema = z.object({
  jobId: z.string(),
  deletedApplications: z.number().int().nonnegative(),
  notRemoved: unpublishResultSchema.shape.notRemoved,
});
export type DeleteJobResult = z.infer<typeof deleteJobResultSchema>;

/**
 * "Update apply links" on the HR publish page: posts already made are edited in place (same post, same likes) so
 * they carry the CURRENT apply link - e.g. after the public careers-site URL changed (temporary tunnel restarted).
 */
export const refreshLinksResultSchema = z.object({
  jobId: z.string(),
  /** The apply link the posts now carry. */
  applyUrl: z.string().url(),
  /** Channels whose post now has the current link. */
  updated: z.array(channelKeySchema),
  /** Posts we could not edit (url = where the post is, to fix by hand). */
  notUpdated: z.array(z.object({ channel: channelKeySchema, url: z.string().nullable(), error: z.string() })),
});
export type RefreshLinksResult = z.infer<typeof refreshLinksResultSchema>;

/** Public (careers site) view of a live job. Only approved data, never drafts. */
export const publicJobSchema = z.object({
  jobId: z.string(),
  slug: z.string(),
  version: z.number().int().positive(),
  /** careersPageUrl is null only if the company removed it after publishing. */
  company: z.object({ slug: z.string(), name: z.string(), about: z.string().nullable(), careersPageUrl: z.string().nullable() }),
  form: jobFormSchema,
  jd: jdContentSchema,
  selectionProcess: z.array(z.string()),
  approvedAt: z.string(),
  status: z.enum(['LIVE', 'CLOSED']),
  /** Plain-words text made by the same formatter as the posts, so the page and posts never disagree. */
  display: z.object({
    location: z.string(),
    salary: z.string().nullable(),
    whoCanApply: z.string(),
    deadline: z.string().nullable(),
  }),
});
export type PublicJob = z.infer<typeof publicJobSchema>;

export const listingStatusSchema = z.enum(['LIVE', 'CLOSED']);

/** GET /api/v1/publisher/jobs - every APPROVED job of the company, with its publish state (HR "Publish" page). */
export const publishableJobSchema = z.object({
  jobId: z.string(),
  title: z.string(),
  /** The approved jd_versions.version - what gets published. */
  version: z.number().int().positive(),
  approvedAt: z.string(),
  approvedBy: z.string(),
  deadline: z.string().nullable(),
  /** null = approved but not published yet. */
  listing: z
    .object({
      slug: z.string(),
      status: listingStatusSchema,
      applyUrl: z.string().url(),
      selectionProcess: z.array(z.string()),
      /** The listing shows an older approved version than the job's current approval. */
      outdated: z.boolean(),
      /**
       * The public careers-site URL changed since the posts were made, and they may still carry the old apply link
       * (the automatic update at API start did not finish). "Update apply link in posts" fixes it.
       */
      linksOutdated: z.boolean().default(false),
    })
    .nullable(),
  posts: z.array(channelPostResultSchema),
  applications: z.number().int().nonnegative(),
});
export type PublishableJob = z.infer<typeof publishableJobSchema>;

export const channelInfoSchema = z.object({
  channel: channelKeySchema,
  label: z.string(),
  availability: channelAvailabilitySchema,
  enabled: z.boolean(),
  /** Non-secret per-company settings (e.g. LinkedIn organizationId). */
  config: z.record(z.unknown()),
  /** OAuth connection made with the dashboard "Connect" button (no token, ever). null = not connected. */
  connection: z
    .object({
      connected: z.boolean(),
      expiresAt: z.string().nullable(),
      expired: z.boolean(),
      /** whose account it is (LinkedIn profile name); null when not recorded */
      accountName: z.string().nullable().optional(),
    })
    .nullable()
    .default(null),
});
export type ChannelInfo = z.infer<typeof channelInfoSchema>;
