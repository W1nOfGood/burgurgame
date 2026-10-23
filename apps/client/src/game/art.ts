/**
 * Root of the Blender-built art (apps/client/public/art, see docs/ASSET_PIPELINE.md). Art files
 * keep stable names across builds, so they are served with revalidation rather than the
 * immutable caching used for Vite's fingerprinted /assets/ output.
 */
export const ART_BASE = `${import.meta.env.BASE_URL}art/`;
