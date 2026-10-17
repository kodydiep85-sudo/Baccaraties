# Grand Squeeze Baccarat

Squeeze-style baccarat in the browser. Bend your cards open edge by edge, play solo, or sit at a table with friends.
Virtual chips only — no real money.

## What's in here

| File | What it does |
|---|---|
| `index.html` | The whole game: table, cards, squeeze, chips, music and sounds |
| `table-core.js` | The dealer for friends tables: betting, ready-up, who peels, payouts |
| `server.js` | The table server: hosts the game and runs friends tables (no packages needed) |
| `render.yaml` | Tells Render how to run the server |
| `package.json` | Tells Render this is a Node app |
| `sw.js` | Lets the game install as an app and play solo offline |
| `manifest.webmanifest` | App name, colors and icons for "Add to Home Screen" |
| `privacy.html` | Privacy policy (needed for the App Store) |
| `icons/` | App icons |

## Put it online with Render (solo **and** friends tables)

1. Upload every file in this folder to the **top level** of your GitHub repository. `render.yaml` must sit at the root,
   not inside another folder, or Render says "blueprint file render.yaml not found".
2. On [render.com](https://render.com), choose **New → Blueprint**, pick your repository, then **Apply**.
3. When the deploy finishes, open the `https://…onrender.com` address Render gives you. Friends join from the same address.

The free plan sleeps after about 15 minutes with nobody on it; the first visit after that takes up to a minute to wake.
A table in progress is lost if the server restarts or sleeps. Chips are safe: each player's wallet is saved on their own device.

Run it on your own computer with `node server.js`, then open http://localhost:3000.

## GitHub Pages (solo only)

GitHub Pages can host the game, but it can't run the server, so only solo play works there:
**Settings → Pages → Deploy from a branch → `main` / `(root)`**.
To use friends tables from GitHub Pages or the app stores, point the game at your Render server with the `gs-server` line near the top of `index.html`:
```html
<meta name="gs-server" content="wss://your-app.onrender.com/ws">
```

On the claude.ai page, friends tables use the page's built-in live room and need no server.

## Table rules

- **Ready:** the dealer deals the moment everyone at the table taps Ready (or Skip hand).
  Anyone not ready when the one-minute clock runs out sits that hand out and gets their bet back.
- **Who peels:** the biggest Player bettor squeezes the Player cards, and the biggest Banker bettor squeezes the Banker cards.
  Ties go to side bets, then to whoever bet first. A side nobody bet on is turned by the dealer.
- **Order:** the Player side is peeled first. Banker cards stay put until every Player card is open.
- **Payouts:** Player 1:1 · Banker 1:1, no commission (Banker winning with a three-card 7 pushes) · Tie 8:1 ·
  Panda 8 25:1 · Dragon 7 40:1 · 9 over 7 25:1 · Pairs 11:1.

## Before publishing to the App Store

- Replace `your-email@example.com` in `privacy.html` with your real contact email.
- For 18+ only. Chips have no cash value and can't be bought, sold or redeemed.
