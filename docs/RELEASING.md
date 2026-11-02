# Releasing `@abelmferreira/mcp-mysql`

This project ships two artifacts from the same git tag:

| Artifact | Where | How users run it |
|---|---|---|
| npm package | `@abelmferreira/mcp-mysql` on npmjs.com | `npx -y @abelmferreira/mcp-mysql` |
| Docker image | `abelmferreira/mcp-mysql` on Docker Hub (`linux/amd64`, `linux/arm64`) | `docker run -i --rm --env-file .env abelmferreira/mcp-mysql` |

## Workflows

| File | Trigger | What it does |
|---|---|---|
| `.github/workflows/ci.yml` | push / PR to `main` (also reused by the publish workflows) | Node 20 + 22: `npm ci`, typecheck, tests, build, package-content check; Docker `test` stage + runtime image + smoke tests |
| `.github/workflows/publish-npm.yml` | tag `vX.Y.Z`, or manual (dry-run by default) | Runs CI, checks tag == `package.json` version, `npm publish --provenance --access public` (OIDC, no token), creates a GitHub Release with generated notes |
| `.github/workflows/publish-docker.yml` | tag `vX.Y.Z` and push to `main` | Runs the `test` stage, builds multi-arch, pushes to Docker Hub with provenance + SBOM |
| `.github/dependabot.yml` | weekly | npm, GitHub Actions and Docker base image updates (minor/patch grouped) |

### Tags and dist-tags

| Git tag | npm dist-tag | Docker tags |
|---|---|---|
| `v1.2.3` | `latest` | `1.2.3`, `1.2`, `1`, `latest` |
| `v1.3.0-rc.1` (anything with `-`) | `next` | `1.3.0-rc.1` only |
| push to `main` (no tag) | nothing published | `edge`, `sha-<short>` |

`latest` only moves on stable releases, so `docker pull abelmferreira/mcp-mysql`
and `npx -y @abelmferreira/mcp-mysql` always resolve to the same version.
Use `:edge` to try unreleased changes from `main`.

## One-time setup

### 1. GitHub repository

1. Create `abelmferreira/mcp-mysql` on GitHub (public, so provenance is shown on npm).
2. Push the code:
   ```bash
   git remote add origin git@github.com:abelmferreira/mcp-mysql.git
   git push -u origin main
   ```
3. *Settings -> Actions -> General*: keep "Allow all actions"; workflow permissions can stay
   "Read repository contents" (each job requests what it needs).
4. Optional: *Settings -> Branches*: protect `main` and require the CI checks
   (`Node 20`, `Node 22`, `Docker build`).

### 2. npm account and scope

1. Sign in (or sign up) at <https://www.npmjs.com> as user **`abelmferreira`**.
   The scope `@abelmferreira` exists automatically for that user; no organization is needed.
2. Enable 2FA on the account (required to create publish tokens).
3. **No token is used in the pipeline.** Publishing from GitHub Actions authenticates with
   npm Trusted Publishing (OIDC). It can only be configured once the package exists, so
   the **first version is published manually** (next section), and the trusted publisher is
   configured afterwards.

#### First publish (manual, from the workstation) - what actually worked

1. **`publishConfig.provenance: true` breaks local publishes.** Provenance only works inside
   GitHub Actions. A local `npm publish` fails with
   `Automatic provenance generation not supported for provider: null`.
   Publish locally with `--provenance=false`.
2. **`npm login` (browser flow) did not work** in the sibling project's first publish: after
   logging in, npm answered `403 Forbidden - Two-factor authentication or granular access token
   with bypass 2fa enabled is required to publish packages.` Retrying the login did not help.
3. **What worked: a granular access token with "Bypass two-factor authentication" checked.**
   - npmjs.com -> Access Tokens -> Generate New Token -> *Granular Access Token*.
   - Permissions: read and write on packages; scope `@abelmferreira` (or all packages - the
     package does not exist yet, so it cannot be selected by name).
   - Tick **Bypass two-factor authentication**. Tokens last at most 90 days.
4. **Revoke the token right after the first publish** (npmjs.com -> Access Tokens), then
   configure the trusted publisher (next section).

The shared helper `../npm.sh` (one level above this repository, shared by the sibling MCPs) does
the publish in a throwaway container with `--provenance=false`. It looks for an `_authToken` in the
default `~/.npmrc`; if there is none, it asks for the token (no echo) and stores it with mode 600.
It does not run `npm login` and does not accept an OTP:

```bash
../npm.sh dry-run mcp-mysql   # simulate
../npm.sh publish mcp-mysql   # asks for confirmation, then publishes
../npm.sh status              # npm user and 2FA state
../npm.sh logout              # removes the token from ~/.npmrc
```

#### Configure the trusted publisher (after the first publish)

On npmjs.com: *Package `@abelmferreira/mcp-mysql` -> Settings -> Trusted Publisher -> GitHub Actions*:

- Organization or user: `abelmferreira`
- Repository: `mcp-mysql`
- Workflow filename: `publish-npm.yml`
- Environment: `npm`

Optionally set "Require two-factor authentication and disallow tokens" so only the trusted
workflow can publish. From then on, `git push --follow-tags` releases (with provenance).

### 3. Docker Hub

1. Sign in at <https://hub.docker.com> as `abelmferreira`.
2. *Create repository* -> name `mcp-mysql`, visibility **Public**.
   (Pushing would also create it, but as private on some plans.)
3. *Account settings -> Personal access tokens -> Generate*:
   - scope **Read & Write** is enough to push;
   - scope **Read, Write, Delete** is required only if you enable the optional
     "Update Docker Hub description" step in `publish-docker.yml`.
4. GitHub *Settings -> Secrets and variables -> Actions*: a **variable** (not a secret)
   `DOCKERHUB_USERNAME` = `abelmferreira`, and a **secret** `DOCKERHUB_TOKEN` = the token.

### 4. (Optional) GitHub environment `npm`

`publish-npm.yml` runs in the environment `npm`. GitHub creates it on first use;
you may configure it (*Settings -> Environments -> npm*) to require a manual approval
before publishing, or to allow only tags `v*`. The environment name must match the one
configured in the npm trusted publisher (`npm`).

## Releasing

Releases are cut from an up-to-date, green `main`. Before `npm version`, move the
changes into a new `## [X.Y.Z] - YYYY-MM-DD` section of `CHANGELOG.md` and commit it. Then:

```bash
git switch main && git pull
npm version patch            # or: minor | major | prerelease --preid=rc
git push --follow-tags       # pushes the commit and the vX.Y.Z tag
```

`npm version` bumps `package.json` + `package-lock.json`, commits and creates the
`vX.Y.Z` tag. Pushing the tag starts both publish workflows. The tag **must** match
the version in `package.json`; both workflows fail early otherwise.

For a pre-release: `npm version prerelease --preid=rc` -> `v1.3.0-rc.0` -> npm `next`,
Docker `1.3.0-rc.0`. Users opt in with `npx -y @abelmferreira/mcp-mysql@next`.

### Dry run

*Actions -> Publish npm -> Run workflow* (dry-run checked) runs CI and
`npm publish --dry-run` without publishing anything. Useful before the first release.

## Verifying a release

```bash
# npm
npm view @abelmferreira/mcp-mysql version dist-tags
READONLY=true SQL_CONNECTION_URL=mysql://user:pass@localhost:3306/db \
  npx -y @abelmferreira/mcp-mysql          # waits on stdio; Ctrl+C to quit

# Docker
docker pull abelmferreira/mcp-mysql:latest
docker buildx imagetools inspect abelmferreira/mcp-mysql:latest   # amd64 + arm64
docker run -i --rm --env-file .env abelmferreira/mcp-mysql:latest
```

The npm page shows a "Provenance" badge linking to the workflow run that built it.

Claude Code configuration examples:

```bash
claude mcp add mysql -e READONLY=true -e SQL_CONNECTION_URL=mysql://... \
  -- npx -y @abelmferreira/mcp-mysql

claude mcp add mysql -- docker run -i --rm --env-file /abs/path/.env abelmferreira/mcp-mysql
```

## Docker image notes

- The image runs as the unprivileged user **`node` (uid/gid 1000)**, not root.
- **SSH key mounts:** a key mounted read-only, e.g.
  `-v ~/.ssh/key:/run/secrets/ssh_key:ro` with `SSH_KEY_PATH=/run/secrets/ssh_key`,
  must be readable by uid 1000. Bind mounts keep the host owner and mode, so a `0600`
  key owned by another uid is unreadable inside the container (`EACCES`). Options:
  - run as your own uid: `docker run --user "$(id -u):$(id -g)" ...` (simplest);
  - or make the key owned by uid 1000 on the host (often already true on single-user
    Linux machines, where the first user is uid 1000);
  - Docker Desktop (macOS/Windows) usually maps file ownership and just works.
- `.env` files are never copied into the image (`.dockerignore`); pass configuration
  with `--env-file` / `-e`.
- MCP speaks over stdio: always use `-i` and **not** `-t` (a TTY corrupts the JSON-RPC stream).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `npm ERR! 404 Not Found - PUT .../@abelmferreira%2fmcp-mysql` | In the pipeline: trusted publisher not configured (or owner/repo/workflow/environment differ from the npm settings). Locally: the npm user is not `abelmferreira`. |
| `npm ERR! 402 Payment Required` | Scoped package published as private. Ensure `--access public` (the workflow sets it). |
| `npm ERR! 403 ... cannot publish over the previously published versions` | Version already exists. Bump with `npm version` and push a new tag; npm versions are immutable. |
| `npm ERR! code EOTP` / 2FA required | Local publish: `npm.sh` does not take an OTP; use the bypass token. Pipeline: uses OIDC, no OTP involved. |
| `Automatic provenance generation not supported for provider: null` | Local `npm publish` with `provenance: true`. Use `../npm.sh publish mcp-mysql` (adds `--provenance=false`); provenance only works in GitHub Actions. |
| `403 ... Two-factor authentication or granular access token with bypass 2fa enabled is required` | `npm login` without bypass, or an account without 2FA. Use a granular token with "Bypass two-factor authentication" (see above). |
| `Error verifying sigstore provenance bundle` / provenance error | Repo must be public and the job needs `id-token: write` (already set). Publishing from a fork or a private repo fails provenance. |
| "Tag vX does not match package.json version" | Tag created by hand without bumping. Delete the tag (`git tag -d vX && git push origin :refs/tags/vX`), use `npm version`. |
| `npm ci` fails: lockfile out of sync | Run `npm install` locally, commit `package-lock.json`. |
| Docker `unauthorized: incorrect username or password` | Wrong `DOCKERHUB_USERNAME` (it is a repository *variable*, `vars.`, not a secret) or `DOCKERHUB_TOKEN`, or the token expired. |
| Docker `denied: requested access to the resource is denied` | Token scope is read-only, or the repository `abelmferreira/mcp-mysql` does not exist / belongs to another namespace. |
| Docker Hub description step: `403 Forbidden` | Token needs "Read, Write, Delete" scope. |
| arm64 build very slow | Expected: arm64 is emulated with QEMU. The gha cache makes later builds faster. |
| Container exits immediately | Missing `READONLY` (mandatory) or other config error: read stderr. Also check you used `-i`. |
| `EACCES` reading the SSH key | See "SSH key mounts" above. |
