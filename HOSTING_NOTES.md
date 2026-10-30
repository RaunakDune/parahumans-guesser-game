# Hosting notes

Setup notes for running Wormdle on GitHub Pages with the wormdle.me domain. These are kept out of the
README because they only matter when setting up or changing the hosting.

## One-time setup: turn on GitHub Pages

1. In this repository, open **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Open the **Actions** tab, pick the latest **Build and deploy** run, and choose **Re-run all jobs**.

After about a minute the game is live. Every push to `main` redeploys it.

## Custom domain: wormdle.me

The domain is registered with Cloudflare, which also runs its DNS. GitHub Pages serves the site.

| Type | Name | Points to | Proxy status |
|---|---|---|---|
| A | `wormdle.me` | `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` (one record each) | DNS only |
| CNAME | `www` | `raunakdune.github.io` | DNS only |

In this repository's **Settings → Pages**, **Custom domain** is set to `www.wormdle.me` and **Enforce HTTPS** is on.
GitHub sends `wormdle.me` and the old `raunakdune.github.io/parahumans-guesser-game/` address to `www.wormdle.me`.
Because the site is published by GitHub Actions, no `CNAME` file is needed in the repo.

If you ever turn on Cloudflare's proxy (orange cloud) for these records, set Cloudflare's **SSL/TLS** mode to
**Full** first, or browsers will get stuck in a redirect loop.

## Link-preview image

The `og:image` and `twitter:image` tags in `site/index.html` load the preview picture from
`https://www.wormdle.me/assets/og-image.png?v=3`. When you replace the picture, bump the `?v=` number in both tags so
sites fetch the new one. Discord and other sites cache previews, so after changing the
picture or its tags, test with a new query string on the link, such as `https://www.wormdle.me/?v=3`.

## Analytics (GoatCounter)

Anonymous, cookieless counts at https://ronindune.goatcounter.com. The script tag is in
`site/index.html`; game events are sent by `site/js/analytics.js`.

- **Visits:** pages, referrers (Discord, Reddit…), countries, browsers, systems and screen sizes.
  GoatCounter does not measure page speed.
- **Game events:** daily files only (not archive or practice), each sent once per player per file.
  For puzzle #12: `lineup-12-finished`, `-solved`, `-solved-in-N`, `-within-8`, `-revealed`,
  `-revealed-after-N`, `-shared`; `power-12-finished`, `-solved`, `-solved-in-N`, `-failed`, `-shared`.
  The `lineup-12-sum-1/2/4/…` events are the guess count split into powers of two, so the site can
  add up the exact average; ignore them in the dashboard.
- **"How other agents did"** on the Lineup report reads these totals back through GoatCounter's public
  counter. It needs **Settings → "Allow adding visitor counts on your website"** turned on, appears once
  5 players have finished a file, and lags by up to about four hours (GoatCounter caches the numbers).
- To stop counting your own visits, open https://www.wormdle.me/#toggle-goatcounter once in each
  browser you use (open it again to undo).
- Ad blockers stop some players from being counted, so treat the numbers as a lower bound.
