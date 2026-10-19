/**
 * Features the WorkLayer build hides. They are switched off at a few seams
 * instead of deleted, so upstream merges stay cheap and flipping a flag back
 * restores the feature.
 */
export const WORKLAYER_HIDDEN = {
  /** Pull request list, review panels and PR rows; the server stops advertising them. */
  pullRequests: true,
  /** Diff panel and the changed-files card under assistant replies. */
  diffs: true,
  /**
   * Branch picker, commit and push actions, cloning and Source Control settings.
   * Projects read as plain folders, so chats also run in the project folder.
   */
  git: true,
  /** Worktree mode settings; new chats always run in the project folder. */
  worktrees: true,
} as const;
