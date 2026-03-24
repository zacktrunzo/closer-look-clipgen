# How to Push an Update to All Users

This document explains how releasing works in plain terms,
and gives you the exact commands to run each time.

---

## How the whole thing works

When you push a **version tag** to GitHub, it automatically:

1. Triggers a build on GitHub's servers (Windows + Mac)
2. Creates a **GitHub Release** with the installer files attached
3. Puts a tiny file called `latest.yml` in that release — it just says "the newest version is 1.0.5"
4. Every running copy of the app checks that file 8 seconds after launch
5. If the version there is newer than what the user has installed, it downloads and installs quietly in the background
6. A gold banner slides in at the top of the app saying "Restart & Update"
7. User clicks it → app restarts with the new version

**You don't need to email anyone or send download links. It all happens automatically.**

---

## What does "1.0.1" mean?

Version numbers follow this pattern: **MAJOR . MINOR . PATCH**

| Number | When to change it | Example |
|--------|-------------------|---------|
| MAJOR (first) | Complete redesign or breaking changes | 1.0.0 → 2.0.0 |
| MINOR (middle) | New feature added | 1.0.0 → 1.1.0 |
| PATCH (last) | Bug fix or small tweak | 1.0.0 → 1.0.1 |

**For day-to-day updates, you'll almost always just bump the last number:**
- Fix a bug → 1.0.0 → 1.0.1
- Fix another bug → 1.0.1 → 1.0.2
- Add a new feature → 1.0.2 → 1.1.0

---

## One-time setup (do this once)

### Step 1 — Create a GitHub account if you don't have one
Go to https://github.com and sign up.

### Step 2 — Create a new repository
1. Click the **+** icon → New repository
2. Name it: `closer-look-clipgen`
3. Set it to **Private** (only you can see the code)
4. Click **Create repository**

### Step 3 — Create a GitHub token (so the build can publish releases)
1. Go to: https://github.com/settings/tokens
2. Click **Generate new token (classic)**
3. Give it a name like `clipgen-releases`
4. Check the **repo** box (gives full repo access)
5. Click **Generate token**
6. **Copy the token** — you won't see it again!

### Step 4 — Add the token as a secret
1. Go to your repository on GitHub
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name: `GH_TOKEN`
5. Value: paste the token you copied
6. Click **Add secret**

### Step 5 — Update package.json with your GitHub username
Open `package.json` and find this section:
```json
"publish": {
  "provider": "github",
  "owner": "YOUR_GITHUB_USERNAME",   ← change this
  "repo": "closer-look-clipgen"
}
```
Replace `YOUR_GITHUB_USERNAME` with your actual GitHub username.

### Step 6 — Push the code for the first time
Run the commands in `FIRST_PUSH_COMMANDS.md` (generated separately).

---

## Every time you release an update

**This is all you need to do:**

### 1. Make your changes to the code (as normal)

### 2. Open `package.json` and bump the version number
```
"version": "1.0.0"   →   "version": "1.0.1"
```

### 3. Run these 4 commands in the app folder:

```bash
git add .
git commit -m "v1.0.1 — describe what changed here"
git tag v1.0.1
git push && git push --tags
```

That's it. GitHub takes over from here:
- Builds the Windows `.exe` installer and Mac `.dmg` installer
- Creates a GitHub Release (visible at github.com/YOUR_USERNAME/closer-look-clipgen/releases)
- Users' apps detect the update within 8 seconds of next launch

### The build takes about 5–10 minutes on GitHub's servers.

---

## How to check if a release worked

Go to: `https://github.com/YOUR_USERNAME/closer-look-clipgen/releases`

You should see your new version listed with two files attached:
- `Closer Look ClipGen Setup 1.0.1.exe` (Windows)
- `Closer Look ClipGen-1.0.1.dmg` (macOS)

If you see those, users will receive the update automatically.

---

## Quick reference — release checklist

- [ ] Made the code changes
- [ ] Bumped version in `package.json` (last number + 1)
- [ ] `git add .`
- [ ] `git commit -m "v1.0.X — what changed"`
- [ ] `git tag v1.0.X`
- [ ] `git push && git push --tags`
- [ ] Waited ~8 minutes, then checked GitHub Releases page
