/**
 * Features the WorkLayer build hides. They are switched off at a few seams
 * instead of deleted, so upstream merges stay cheap and flipping a flag back
 * restores the feature.
 */
export const WORKLAYER_HIDDEN = {
  /** Pull request list, review panels and PR rows; the server stops advertising them. */
  pullRequests: true,
} as const;
