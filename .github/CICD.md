# CI/CD Pipeline Guide

## Overview

This project uses GitHub Actions for automated builds and releases. The pipeline automatically:

1. **Builds all platforms** (Windows Desktop, Android APK, Web PWA)
2. **Runs all tests** (unit, integration, E2E)
3. **Creates GitHub releases** with all artifacts attached

## How It Works

### Trigger Methods

#### 1. Tag-based Release (Recommended)
Push a tag starting with `v` to trigger automated build and release:

```bash
git tag -a v0.1.0 -m "Release version 0.1.0"
git push origin v0.1.0
```

This will:
- Build all platforms
- Run all tests
- Create a **draft** release on GitHub with all artifacts

#### 2. Manual Trigger
Go to **Actions** tab → Select **"Build & Release"** workflow → Click **"Run workflow"**

You can choose the release type:
- **Draft**: Creates a draft release (visible only to collaborators)
- **Prerelease**: Creates a public prerelease
- **Release**: Creates a full public release

### What Gets Built

| Platform | Artifact | Size | Runner |
|----------|----------|------|--------|
| Windows Desktop | `Quran Platform_*.exe` | ~8.5 MB | windows-latest |
| Android | `app-release.apk` | ~49 MB | ubuntu-latest |
| Web PWA | `quran-web.zip` | ~5.7 MB | ubuntu-latest |

### Build Process

Each platform goes through these stages:

1. **Checkout**: Clone repository
2. **Setup**: Install dependencies (Node.js, Flutter, Rust, etc.)
3. **Test**: Run relevant test suites
4. **Build**: Compile and package
5. **Upload**: Save artifact to GitHub

After all platforms complete:
6. **Release**: Create GitHub release with all artifacts attached

## Viewing Progress

### Check Build Status

1. Go to **Actions** tab on GitHub
2. Click on the running workflow (e.g., "Build & Release #123")
3. Watch real-time logs for each job

### Download Artifacts

While build is running or after completion:
1. Click on the workflow run
2. Scroll to **"Artifacts"** section at bottom
3. Click to download any artifact

Artifacts are available for 90 days.

## Release Creation

When all builds succeed, the workflow automatically:

1. Downloads all artifacts
2. Reads release notes from `docs/changelog.md`
3. Creates a GitHub release with:
   - Tag name (e.g., `v0.1.0`)
   - Release title
   - Body from changelog
   - All three artifacts attached
   - Draft/prerelease status based on input

### Release Types

- **Draft**: Only visible to repository collaborators, can be edited before publishing
- **Prerelease**: Public but marked as pre-release, good for beta testing
- **Release**: Full public release, appears in latest releases

## Troubleshooting

### Build Fails

Check the workflow logs:
1. Go to **Actions** tab
2. Click failed workflow
3. Click failed job (red X)
4. Read error messages in logs

Common issues:
- **Test failures**: Fix code and push new commit, then re-tag
- **Dependency errors**: Check `package.json` or `pubspec.yaml`
- **Timeout**: Retry the workflow (sometimes transient)

### Re-running Failed Builds

Option 1: Re-run entire workflow
- Go to Actions → Click workflow → "Re-run jobs"

Option 2: Re-run specific failed job
- Go to Actions → Click workflow → Click failed job → "Re-run job"

### Tag Already Exists

If you pushed a tag that already exists:

```bash
# Delete local tag
git tag -d v0.1.0

# Delete remote tag
git push origin --delete v0.1.0

# Create new tag with same name
git tag -a v0.1.0 -m "New message"
git push origin v0.1.0
```

## Manual Release (Fallback)

If CI/CD fails and you need to release manually:

1. Build locally:
   ```bash
   # Desktop
   npm run desktop:tauri build
   
   # Android
   cd mobile && flutter build apk --release
   
   # Web
   cd desktop && npm run build
   ```

2. Go to GitHub → Releases → "Create a new release"
3. Select tag
4. Upload artifacts manually
5. Add release notes
6. Publish

## Configuration

The workflow is defined in: `.github/workflows/build-and-release.yml`

Key settings:
- **Node version**: 20
- **Flutter version**: 3.47.2
- **Java version**: 17 (for Android)
- **Rust**: Latest stable (for Tauri)

To modify build behavior, edit this file and commit to `master`.

## Secrets

The workflow uses these GitHub secrets (automatically provided):
- `GITHUB_TOKEN`: Auto-generated for each workflow run

No additional secrets need to be configured for basic builds.

## Cost & Limits

GitHub Actions free tier includes:
- 2,000 minutes/month for private repositories
- 50,000 minutes/month for public repositories

This workflow typically uses ~15-20 minutes per run:
- Desktop build: ~10 minutes (Rust compilation)
- Android build: ~3 minutes
- Web build: ~2 minutes
- Tests: ~2 minutes

## Best Practices

1. **Test locally first**: Run `npm test` before pushing tags
2. **Use semantic versioning**: `vMAJOR.MINOR.PATCH` (e.g., `v0.1.0`)
3. **Update changelog**: Keep `docs/changelog.md` current
4. **Draft first**: Use draft releases to verify artifacts before publishing
5. **Monitor builds**: Check Actions tab after pushing tags

## Support

For issues with the CI/CD pipeline:
1. Check workflow logs for error messages
2. Review recent commits that might have broken the build
3. Try re-running the workflow
4. If persistent, open an issue on GitHub

---

**Last updated**: 2026-10-05
**Workflow file**: `.github/workflows/build-and-release.yml`
