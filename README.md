# Vardex — landing page

Static one-page website for Vardex. No build step: everything is in `index.html`, with fonts loaded from Google Fonts.

## Structure

```
index.html              The page (HTML, CSS and a few lines of JS)
assets/favicon.svg      Browser icon
assets/favicon-32.png   Fallback browser icon
assets/apple-touch-icon.png  Home-screen icon on iOS
assets/vardex-logo*.svg/png  Logo files
```

## Preview locally

Open `index.html` in a browser, or run a small server:

```
python3 -m http.server 8000
```

## Publish with GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, branch `main`, folder `/ (root)`.
4. The site is published at `https://<user>.github.io/<repo>/` after a minute or two.

## Still to fill in

- Roles and one-line backgrounds for Even Falkenberg Langås and Martin Økter
- Organisation number in the footer
- Names and roles for the three references
- Confirm the email address (currently `hello@vardex.io`)
