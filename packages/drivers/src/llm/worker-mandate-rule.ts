/** Shared requirement-router rule: workers never push/tag/PR; host Outbox / Milestone Release does. */
export const WORKER_MANDATE_ROUTER_RULE =
  "Workers execute in isolated worktrees where `git push`, `gh pr create`, and remote `git tag` pushing are forbidden; the host Outbox / Milestone Release handles them later. NEVER include `git push`, `git tag`, or PR creation steps in `singleSpec.description`, `acceptanceCriteria`, or `epicPlan.subtasks`; if the requirement mentions pushing or tagging, plan only the code/version/doc/test changes.";
