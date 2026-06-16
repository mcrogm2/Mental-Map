# Mental Map

An interactive mental health knowledge explorer built with React + Vite.

## Deploy to Vercel (step by step)

### What you need
- A free [GitHub](https://github.com) account
- A free [Vercel](https://vercel.com) account (sign up with GitHub — one click)

---

### Step 1 — Put this folder on GitHub

**Option A: GitHub Desktop (easiest, no terminal)**
1. Download [GitHub Desktop](https://desktop.github.com) and sign in
2. Click **File → Add Local Repository**
3. Point it at this folder (`mental-map-app`)
4. Click **Publish repository** → name it `mental-map` → click **Publish**

**Option B: Terminal**
```bash
cd mental-map-app
git init
git add .
git commit -m "first commit"
# Create a new repo on github.com first, then:
git remote add origin https://github.com/YOUR_USERNAME/mental-map.git
git push -u origin main
```

---

### Step 2 — Connect to Vercel

1. Go to [vercel.com](https://vercel.com) → **Sign up with GitHub**
2. Click **Add New → Project**
3. Find `mental-map` in the list → click **Import**
4. Vercel auto-detects Vite. Leave all settings as-is.
5. Click **Deploy**

That's it. In ~60 seconds you get a URL like `mental-map-abc123.vercel.app`.

---

### Step 3 — Add to your phone home screen

**iPhone (Safari only — doesn't work in Chrome)**
1. Open your Vercel URL in Safari
2. Tap the **Share** button (box with arrow pointing up)
3. Scroll down → tap **Add to Home Screen**
4. Name it "Mental Map" → tap **Add**

**Android (Chrome)**
1. Open your Vercel URL in Chrome
2. Tap the three-dot menu → **Add to Home screen**
3. Tap **Add**

It will appear as a full-screen app with its own icon — no browser bar.

---

### Step 4 — Updating the app

Whenever you want to update content:
1. Replace `src/App.jsx` with the new version from Claude
2. In GitHub Desktop: write a commit message → click **Commit** → **Push**
3. Vercel auto-deploys in ~30 seconds — your URL updates automatically

---

## Run locally (optional)

```bash
npm install
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173)
