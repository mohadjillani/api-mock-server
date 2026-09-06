# Changesets

Every change that should reach npm gets a changeset:

```bash
npx changeset
```

It writes a Markdown file describing the change and the version bump it needs.
The release workflow collects them into a version bump and a changelog, so the
published version and the release notes come from the same source and cannot
disagree.
