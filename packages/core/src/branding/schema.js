import { z } from 'zod';

/**
 * Company branding = the customizable layer. Unlike vendor identity
 * (file-based, immutable), this is DB-backed and editable by an admin
 * via the Admin UI, to white-label the running UI (header/login page/
 * sidebar) with the deploying company's own name/logo.
 *
 * It never substitutes for vendor identity in About - those stay fixed.
 *
 * `logoUrl` is a reference (path or URL to an already-uploaded file),
 * not file content - actual upload/storage goes through core/files
 * (magic-bytes check, sharp re-encode for images per §4.5h), which is
 * out of scope here.
 */
export const CompanyBrandingSchema = z.object({
  name: z.string().min(1).max(100).nullable().default(null),
  logoUrl: z.string().max(2048).nullable().default(null),
  /** Optional dark-theme variant; falls back to logoUrl when not set. */
  logoUrlDark: z.string().max(2048).nullable().default(null),
  /** Uploaded logo file names (inside the branding upload directory); served at /branding/logo/<light|dark>. */
  logoFile: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).nullable().default(null),
  logoFileDark: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).nullable().default(null),
  /** Accent colors, #rrggbb; null = the theme's own accent. */
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
  accentDark: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
  updatedAt: z.string().datetime().nullable().default(null),
  updatedBy: z.string().nullable().default(null),
});
