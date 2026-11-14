@AGENTS.md

## Local privacy variant

- Maintain this variant on `privacy/no-telemetry` in `BestQ-A/cindy`. The
  `origin` remote is the fork and `upstream` is `makecindy/cindy`. Validate
  upstream updates with the privacy checks before advancing this branch.
- This variant permanently disables desktop usage analytics, plugin usage reports,
  the account-level statistics heartbeat, and remote diagnostic log uploads.
  Local logs and native crash dumps remain available for diagnosis.
- Claude, Codex, and Pi launches must retain their enforced telemetry opt-outs,
  including model-discovery probes, authentication helpers, and subagents.
- Use Node.js 22 and the repository-pinned pnpm version. Start through
  `pnpm restart:desktop:remote --region=cn --isolated=privacy` with
  `PNPM_CONFIG_NODE_LINKER=hoisted` when the packaged pnpm executable does not
  expose the repository's existing `.npmrc` to Electron Forge.
- Keep the source preview in its isolated profile. Its development-mode update
  policy prevents official application updates from replacing the running code.
  A distributable privacy build also needs a separately verified update policy.
- Privacy verification covers both Cindy and its launched engines. Record only
  destination origins and connection metadata during network checks. Exercise
  startup, idle, a model turn, and restart, and report the observed coverage.
