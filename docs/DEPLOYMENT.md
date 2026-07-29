# Isolated GitHub and Vercel deployment

## Repository isolation

This application must live in the dedicated GitHub repository:

```text
WillBranam/Legal-Data-Extractor
```

Do not add this source tree to another monorepo or reuse another repository's
Git history.

## Vercel isolation

Create a new Vercel project specifically for this repository. Do not reuse:

- another project's `.vercel/project.json`
- another project's environment variables
- another project's domains
- another project's data stores
- another project's deployment history

The local `.vercel` directory is ignored by Git. After linking, confirm that
`.vercel/project.json` contains a unique `projectId` and the expected project
name before deploying.

## Required deployment defaults

Set:

```text
PHI_MODE=disabled
```

The public pilot must not receive provider keys, database credentials, or cloud
storage credentials.

Before enabling any protected processing, obtain the required contractual and
security approvals for Vercel and every PHI-touching service. Replace the
browser-only pilot boundary only through a separately reviewed production
change.
