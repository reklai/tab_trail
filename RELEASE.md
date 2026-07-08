# Releasing Current Tab History - In-Page Trail

Release artifacts are produced by `npm run release:package`, which builds both
targets and zips them into `release/`.

## Steps

1. Bump `version` in `package.json` and in both manifests
   (`esBuildConfig/manifest_v2.json`, `esBuildConfig/manifest_v3.json`). All
   three must match; `npm run verify:compat` checks the manifests and the
   compatibility test checks them against `package.json`.
2. Run the full suite:
   ```bash
   npm run ci
   ```
3. Build the release archives:
   ```bash
   npm run release:package
   ```
   This produces, for version `X.Y.Z`:
   - `release/tabtrail-firefox-vX.Y.Z.xpi` - the MV2 build (Firefox / Zen).
   - `release/tabtrail-chrome-vX.Y.Z.zip` - the MV3 build (Chrome).
   - `release/tabtrail-source-vX.Y.Z.zip` - the source bundle for reviewers.

   The `zip` CLI must be installed.

## Store submission

- **Firefox (AMO):** upload the `.xpi` and the source `.zip`. The MV2 manifest
  carries `browser_specific_settings.gecko.id` (`@tabtrail.reklai`) and the
  `data_collection_permissions` declaration required for signing.
- **Chrome Web Store:** upload the `.zip` MV3 build. Use the listing title from
  `STORE.md` ("Current Tab History - In-Page Trail").

Keep `STORE.md` and `PRIVACY.md` in sync with the submitted listing. The
`verify:store` check enforces that names, summary lengths, and permission docs
match the manifests.

## Schema migrations

If a release changes stored data, bump `STORAGE_SCHEMA_VERSION` in
`src/lib/common/utils/storageMigrations.ts`, add the migration step, and add a
fixture under `test/fixtures/upgrade/`. `npm run verify:upgrade` runs every
fixture through the migration.
