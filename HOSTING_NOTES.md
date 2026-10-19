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
`raw.githubusercontent.com`, because that address always has HTTPS. Once **Enforce HTTPS** is on for wormdle.me,
they can point back to `https://www.wormdle.me/assets/og-image.png`. Discord caches previews, so test a changed
preview with a new query string, such as `https://www.wormdle.me/?v=3`.
