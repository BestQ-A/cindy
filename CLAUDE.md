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
- Packaged applications use the `CindyPrivacy` identity family, with distinct
  regional app IDs, install directories and user data. Register the
  `cindy-privacy` protocol and preserve existing default file associations.
- Application updates are permanently disabled by the shared app update policy.
  Packages omit the native updater and its runtime. Update the application by
  installing a verified privacy build manually. Engine runtime maintenance
  remains independent of application replacement.
- Build a Windows installer with `pnpm release:package --platform win32 --arch x64
  --region cn --version <x.y.z>`. Use `--no-sign` for an intentionally unsigned
  local package. The privacy packaging path needs no private log-upload config.
- Privacy verification covers both Cindy and its launched engines. Record only
  destination origins and connection metadata during network checks. Exercise
  startup, idle, a model turn, and restart, and report the observed coverage.
