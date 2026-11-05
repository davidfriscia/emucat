import { z } from 'zod';

export const PLATFORMS = ['windows', 'macos', 'linux'] as const;
export const platformSchema = z.enum(PLATFORMS);
export type Platform = z.infer<typeof platformSchema>;

export const ARCHITECTURES = ['x86_64', 'aarch64'] as const;
export const architectureSchema = z.enum(ARCHITECTURES);
export type Architecture = z.infer<typeof architectureSchema>;
