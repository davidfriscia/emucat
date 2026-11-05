import { z } from 'zod';
import { timestampSchema } from './version.js';

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 64;
export const PASSWORD_MIN_LENGTH = 12;
/** Bounds the work an attacker can demand from the password hash. */
export const PASSWORD_MAX_LENGTH = 256;
export const USER_DISPLAY_NAME_MAX_LENGTH = 255;
export const CSRF_HEADER = 'x-csrf-token';

export const USER_ROLES = ['admin', 'user'] as const;
export const userRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof userRoleSchema>;

const USERNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** ASCII only, so that accent-insensitive database comparison cannot make two names collide. */
export function isValidUsername(username: string): boolean {
  return (
    username.length >= USERNAME_MIN_LENGTH &&
    username.length <= USERNAME_MAX_LENGTH &&
    USERNAME_PATTERN.test(username)
  );
}

export const usernameSchema = z
  .string()
  .refine(
    isValidUsername,
    'Use 3 to 64 letters, digits, ".", "_" or "-", starting and ending with a letter or digit',
  );

/** Passwords are never trimmed or normalized: every character the user typed counts. */
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`);

const CONTROL_CHARACTERS = /\p{Cc}/u;

export const userDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(USER_DISPLAY_NAME_MAX_LENGTH)
  .refine((value) => !CONTROL_CHARACTERS.test(value), 'Control characters are not allowed');

export const setupStatusResponseSchema = z.object({ setupRequired: z.boolean() });
export type SetupStatusResponse = z.infer<typeof setupStatusResponseSchema>;

export const setupRequestSchema = z.strictObject({
  setupToken: z.string().min(1).max(512),
  username: usernameSchema,
  displayName: userDisplayNameSchema,
  password: newPasswordSchema,
});
export type SetupRequest = z.infer<typeof setupRequestSchema>;

/** Deliberately loose: a login never explains which rule a wrong guess failed. */
export const loginRequestSchema = z.strictObject({
  username: z.string().min(1).max(1024),
  password: z.string().min(1).max(1024),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const changePasswordRequestSchema = z.strictObject({
  currentPassword: z.string().min(1).max(1024),
  newPassword: newPasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const currentUserSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  role: userRoleSchema,
});
export type CurrentUser = z.infer<typeof currentUserSchema>;

export const authenticatedSessionSchema = z.object({
  user: currentUserSchema,
  /** Send as the `X-CSRF-Token` header on every state-changing request. */
  csrfToken: z.string(),
  sessionId: z.uuid(),
  expiresAt: timestampSchema,
});
export type AuthenticatedSession = z.infer<typeof authenticatedSessionSchema>;

/** The anonymous-friendly form the web app reads on page load. */
export const sessionStateResponseSchema = z.object({
  session: authenticatedSessionSchema.nullable(),
});
export type SessionStateResponse = z.infer<typeof sessionStateResponseSchema>;

export const sessionInfoSchema = z.object({
  id: z.uuid(),
  createdAt: timestampSchema,
  lastSeenAt: timestampSchema,
  expiresAt: timestampSchema,
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

export const sessionListResponseSchema = z.object({ sessions: z.array(sessionInfoSchema) });
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

export const revokedSessionsResponseSchema = z.object({ revoked: z.number().int().nonnegative() });
export type RevokedSessionsResponse = z.infer<typeof revokedSessionsResponseSchema>;
