# Sloth Sync on Netlify

A static front end (`public/`) plus one Netlify Function (`netlify/functions/api.mjs`).
Shared calendars, invites and confirmations are stored in Netlify Blobs. Google Calendar
linking runs through the function, so it works for anyone, not only inside Claude.

## Deploy

1. Push this folder to a Git repo (GitHub, GitLab, Bitbucket) and choose **Add new site, Import an existing project** in Netlify. No build command is needed. `netlify.toml` already sets the publish folder and functions folder.
   Or use the CLI: `npm i -g netlify-cli && npm install && netlify deploy --prod`.
   Drag-and-drop deploys do **not** run functions, so use Git or the CLI.
2. Open the site. Everything except Google Calendar works with no configuration.

## Google Calendar (optional)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Calendar API**.
2. **APIs & Services, OAuth consent screen**: set it up. While it is in "Testing", add each person's Google address under *Test users*. Anyone else gets blocked until you publish the app (publishing a read-only calendar scope may need Google verification).
3. **Credentials, Create credentials, OAuth client ID, Web application.** Under *Authorized redirect URIs* add
   `https://YOUR-SITE.netlify.app/api/google/callback` (and your custom domain's equivalent if you use one).
4. In Netlify, **Site configuration, Environment variables**, add:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI` (optional; only if the callback URL differs from the site's own address)
   Not sure of the exact value? Open `https://YOUR-SITE.netlify.app/api/google/redirect-uri` and copy what it shows. A `redirect_uri_mismatch` error means this value and the one in Google Cloud differ (http vs https, a trailing slash, a custom domain vs `.netlify.app`, or a stale `GOOGLE_REDIRECT_URI`).
5. Redeploy. Settings, Link Google Calendar now works. The scope is read-only (`calendar.readonly`).

## How people sign in

There are no passwords. Opening an invite link (or tapping *Add a person*) asks for a display name and
creates an account tied to that browser. Clearing site data or switching devices starts a new account.

## Local development

`netlify dev` runs the site and function together (needs the Netlify CLI, which supplies Blobs locally).

## Known limits

- Updates arrive by polling every ~3 seconds, not instantly. The page pauses polling when hidden.
- Storage is Netlify Blobs with scan-based queries. That is fine for a group of friends or a small team, not thousands of users.
- Two people changing the same document in the same instant can overwrite each other (last write wins).
- Phone banners work while the page is open or in the background on desktop and Android. iPhone web notifications need a push service, which is not included.
- Tailwind and the Nunito font load from CDNs. For offline or locked-down use, vendor them into `public/`.
