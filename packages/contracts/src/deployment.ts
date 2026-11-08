import { z } from 'zod';
import { timestampSchema } from './version.js';

/**
 * Application deployment and administrator-triggered updates. The API never runs a deployment itself: it
 * forwards a small, fixed set of requests to the local deployment service, which owns every operation. None
 * of these shapes carries a Git ref, a repository URL, a command or a path chosen by the browser.
 */

/** A full, lowercase Git commit ID. Short or symbolic refs are never accepted. */
export const commitIdSchema = z.string().regex(/^[0-9a-f]{40}$/, 'Expected a full commit ID');
export type CommitId = z.infer<typeof commitIdSchema>;

export const UPDATE_STAGES = [
  'queued',
  'checking_repository',
  'fetching_source',
  'building',
  'testing',
  'backing_up_database',
  'applying_migrations',
  'starting_services',
  'health_checking',
  'completed',
  'failed',
] as const;
export const updateStageSchema = z.enum(UPDATE_STAGES);
export type UpdateStage = z.infer<typeof updateStageSchema>;

/** The stages a successful update passes through, in order, for progress displays. */
export const UPDATE_PROGRESS_STAGES = UPDATE_STAGES.filter(
  (stage) => stage !== 'queued' && stage !== 'failed',
);

export const UPDATE_OPERATION_STATUSES = ['running', 'succeeded', 'failed'] as const;
export const updateOperationStatusSchema = z.enum(UPDATE_OPERATION_STATUSES);
export type UpdateOperationStatus = z.infer<typeof updateOperationStatusSchema>;

/**
 * What happened to the application after a failure. `not_needed`: nothing had changed yet.
 * `restored_previous`: the previous release is running again. `unsafe`: migrations were applied, so the
 * previous release cannot run against the database; restore the named backup first.
 */
export const ROLLBACK_OUTCOMES = ['not_needed', 'restored_previous', 'unsafe', 'failed'] as const;
export const rollbackOutcomeSchema = z.enum(ROLLBACK_OUTCOMES);
export type RollbackOutcome = z.infer<typeof rollbackOutcomeSchema>;

export const updateStageRecordSchema = z.object({
  stage: updateStageSchema,
  startedAt: timestampSchema,
  message: z.string().max(500).nullable(),
});
export type UpdateStageRecord = z.infer<typeof updateStageRecordSchema>;

export const updateOperationSchema = z.object({
  id: z.uuid(),
  status: updateOperationStatusSchema,
  stage: updateStageSchema,
  stages: z.array(updateStageRecordSchema),
  /** The commit running when the update started, if any. */
  fromCommit: commitIdSchema.nullable(),
  /** Resolved by the deployment service from the configured branch, never chosen by the browser. */
  targetCommit: commitIdSchema.nullable(),
  requestedBy: z.string().max(64),
  requestedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
  /** `up_to_date` means the target was already deployed and nothing changed. */
  outcome: z.enum(['updated', 'up_to_date']).nullable(),
  error: z.object({ code: z.string().max(64), message: z.string().max(1000) }).nullable(),
  rollback: rollbackOutcomeSchema.nullable(),
  /** The database backup taken by this update, by file name only. */
  backup: z.string().max(255).nullable(),
});
export type UpdateOperation = z.infer<typeof updateOperationSchema>;

export const deployedReleaseSchema = z.object({
  commit: commitIdSchema,
  deployedAt: timestampSchema,
  operationId: z.uuid().nullable(),
});
export type DeployedRelease = z.infer<typeof deployedReleaseSchema>;

export const remoteCommitSchema = z.object({
  commit: commitIdSchema,
  subject: z.string().max(200),
  committedAt: timestampSchema.nullable(),
  checkedAt: timestampSchema,
});
export type RemoteCommit = z.infer<typeof remoteCommitSchema>;

export const operationSummarySchema = z.object({
  operationId: z.uuid(),
  commit: commitIdSchema.nullable(),
  finishedAt: timestampSchema,
  message: z.string().max(1000).nullable(),
});
export type OperationSummary = z.infer<typeof operationSummarySchema>;

/** What the deployment service reports about itself and the release it manages. */
export const deploymentStatusSchema = z.object({
  environment: z.string().max(64),
  branch: z.string().max(255),
  updatesEnabled: z.boolean(),
  current: deployedReleaseSchema.nullable(),
  latest: remoteCommitSchema.nullable(),
  /** `null` until the repository has been checked at least once. */
  updateAvailable: z.boolean().nullable(),
  activeOperation: updateOperationSchema.nullable(),
  lastOperation: updateOperationSchema.nullable(),
  lastSuccess: operationSummarySchema.nullable(),
  lastFailure: operationSummarySchema.nullable(),
});
export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;

/**
 * `connected`: the deployment service answered. `unavailable`: it is configured but did not answer.
 * `not_configured`: this API was started without a deployment service, as in development.
 */
export const DEPLOYMENT_SERVICE_STATES = ['connected', 'unavailable', 'not_configured'] as const;
export const deploymentServiceStateSchema = z.enum(DEPLOYMENT_SERVICE_STATES);
export type DeploymentServiceState = z.infer<typeof deploymentServiceStateSchema>;

export const buildInfoSchema = z.object({
  version: z.string(),
  commit: commitIdSchema.nullable(),
  builtAt: timestampSchema.nullable(),
});
export type BuildInfo = z.infer<typeof buildInfoSchema>;

export const applicationUpdatesResponseSchema = z.object({
  service: deploymentServiceStateSchema,
  build: buildInfoSchema,
  deployment: deploymentStatusSchema.nullable(),
});
export type ApplicationUpdatesResponse = z.infer<typeof applicationUpdatesResponseSchema>;

export const systemVersionResponseSchema = z.object({
  environment: z.string(),
  applicationVersion: z.string(),
  buildCommit: commitIdSchema.nullable(),
  buildTimestamp: timestampSchema.nullable(),
  /** From deployment metadata. `null` when the deployment service cannot be reached. */
  deployedCommit: commitIdSchema.nullable(),
  deploymentTimestamp: timestampSchema.nullable(),
  deploymentStatus: z.enum(['deployed', 'updating', 'unknown', 'not_deployed']),
  service: deploymentServiceStateSchema,
});
export type SystemVersionResponse = z.infer<typeof systemVersionResponseSchema>;

/**
 * The only thing the browser can say when starting an update: which commit it was shown. The service
 * refuses if the configured branch has moved since, so an administrator never installs something unseen.
 */
export const startUpdateRequestSchema = z.object({ expectedCommit: commitIdSchema }).strict();
export type StartUpdateRequest = z.infer<typeof startUpdateRequestSchema>;

export const updateOperationPathParamsSchema = z.object({ operationId: z.uuid() });

export const updateLogResponseSchema = z.object({
  operationId: z.uuid(),
  /** Sanitized: credentials, tokens and passwords are replaced before anything leaves the host. */
  lines: z.array(z.string()),
  truncated: z.boolean(),
});
export type UpdateLogResponse = z.infer<typeof updateLogResponseSchema>;
