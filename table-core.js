// Grand Squeeze Baccarat — the table dealer.
// One copy of the rules shared by the Node server (store apps) and the host player's
// browser (friends tables on the game page), so both always deal and pay the same way.
// Virtual chips only — nothing here handles real money.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GSTable = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const START_BANKROLL = 5000;
const START_MIN = 100, START_MAX = 10000000;   // players may pick their own starting chips in this range
// Table tiers: each table has its own limits per betting spot (must match TIERS in www/index.html)
const TIERS = {
  lounge:  { name: 'Lounge',       min: 10,   max: 500,    sideMin: 5 },
  high:    { name: 'High Limit',   min: 25,   max: 5000,   sideMin: 5 },
  vip:     { name: 'VIP Salon',    min: 100,  max: 25000,  sideMin: 50 },
  private: { name: 'Private Room', min: 1000, max: 100000, sideMin: 100 },
  diamond: { name: 'Diamond Room', min: 10000, max: 1000000000, sideMin: 100, pairMin: 100 },
};
const MAX_BANKROLL = 1e15;   // effectively no ceiling on a player's chips
const MAX_PLAYERS = 7;
// a betting round lasts one minute; the deal comes the moment everyone is ready, and anyone not ready by then sits out
const BET_WINDOW_MS = (typeof process !== 'undefined' && process.env && +process.env.BET_WINDOW_MS) || 60000;
const SQUEEZE_WINDOW_MS = 40000;  // the dealer turns over anything still face down after this
const PAYOUT = { player: 1, banker: 1, tie: 8, panda: 25, dragon: 40, nine7: 25, ppair: 11, bpair: 11 };
const SPOTS = Object.keys(PAYOUT);
const SIDE_OF = { player: 'player', panda: 'player', ppair: 'player', banker: 'banker', dragon: 'banker', bpair: 'banker' };


/* ---------------- baccarat rules (same as the single-player game) ---------------- */
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const points = c => c.rank === 'A' ? 1 : ['10', 'J', 'Q', 'K'].includes(c.rank) ? 0 : Number(c.rank);
const total = h => h.reduce((s, c) => s + points(c), 0) % 10;
function bankerDraws(bt, v) {
  if (bt <= 2) return true;
  if (bt === 3) return v !== 8;
  if (bt === 4) return v >= 2 && v <= 7;
  if (bt === 5) return v >= 4 && v <= 7;
  if (bt === 6) return v === 6 || v === 7;
  return false;
}
function freshShoe() {
  const shoe = [];
  for (let d = 0; d < 8; d++) for (const suit of SUITS) for (const rank of RANKS) shoe.push({ rank, suit });
  for (let i = shoe.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shoe[i], shoe[j]] = [shoe[j], shoe[i]]; }
  return shoe;
}

/* ---------------- rooms ---------------- */
const rooms = new Map();
let nextId = 1;
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let c;
  do { c = Array.from({ length: 4 }, () => A[Math.random() * A.length | 0]).join(''); } while (rooms.has(c));
  return c;
}
const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const broadcast = (room, msg, except) => { for (const p of room.players.values()) if (p !== except) send(p.ws, msg); };
const stake = p => Object.values(p.bets).reduce((a, b) => a + b, 0);

function snapshot(room) {
  return {
    t: 'state', code: room.code, tier: room.tier, phase: room.phase, countdownEnds: room.countdownEnds || null,
    shoeLeft: room.shoe.length,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, balance: p.balance, bets: p.bets, ready: p.ready })),
    history: room.history.slice(-60),
  };
}
const pushState = room => broadcast(room, snapshot(room));

function clearTimers(room) { for (const k of ['countdown', 'window', 'auto', 'step']) { clearTimeout(room[k]); room[k] = null; } }

/* ---------------- betting & readiness ---------------- */
// open a one-minute betting round; when it runs out the dealer deals for whoever has bet
function startBetting(room) {
  clearTimeout(room.countdown);
  room.countdownEnds = Date.now() + BET_WINDOW_MS;
  room.countdown = setTimeout(() => {
    room.countdown = null;
    if (room.phase !== 'betting') return;
    // time's up: anyone who didn't tap Ready sits this hand out and gets their chips back
    for (const p of room.players.values()) if (!p.ready && stake(p) > 0) {
      p.balance += stake(p); p.bets = {}; p.betAt = 0;
      send(p.ws, { t: 'error', msg: "Time's up — you weren't ready, so you sit out this hand. Your bet is back in your chips." });
    }
    const anyBets = [...room.players.values()].some(p => p.ready && stake(p) > 0);
    if (anyBets) { room.countdownEnds = null; deal(room); }
    else { startBetting(room); pushState(room); }   // nobody ready with a bet: a fresh minute
  }, BET_WINDOW_MS);
}
// deal early only when everyone seated has tapped Ready (or Skip hand) and at least one of them bet
function maybeDeal(room) {
  if (room.phase !== 'betting') return;
  const all = [...room.players.values()];
  if (!all.some(p => stake(p) > 0)) return;
  if (all.every(p => p.ready)) { clearTimeout(room.countdown); room.countdown = null; room.countdownEnds = null; deal(room); }
}

// whoever bet the most on Player squeezes the Player cards, and the biggest Banker bettor squeezes Banker
// (the casino custom). Only the main bet counts; side bets break a tie, then whoever bet first.
// A side nobody bet on is turned by the dealer.
let betSeq = 0;
function pickSqueezer(room, side) {
  let best = null, key = null;
  for (const p of room.players.values()) {
    const main = p.bets[side] || 0; if (main <= 0) continue;
    const extra = Object.entries(p.bets).filter(([k]) => k !== side && SIDE_OF[k] === side).reduce((a, [, v]) => a + v, 0);
    const k = [main, extra, -(p.betAt || 0)];
    if (!key || k[0] > key[0] || (k[0] === key[0] && (k[1] > key[1] || (k[1] === key[1] && k[2] > key[2])))) { best = p; key = k; }
  }
  return best ? best.id : null;
}
// Player is peeled first: Banker cards wait until every Player card is face up
const activeSide = r => r.cards.some(c => !c.up && c.side === 'player') ? 'player' : r.cards.some(c => !c.up) ? 'banker' : null;

/* ---------------- a hand ---------------- */
// Panda 8 and Dragon 7: each table's own side-bet minimum, no maximum
const NO_MAX = { panda: true, dragon: true, nine7: true };
const minFor = (room, k) => { const t = TIERS[room.tier]; return NO_MAX[k] ? t.sideMin : (k === 'ppair' || k === 'bpair' || k === 'tie') && t.pairMin ? t.pairMin : t.min; };
function underMin(room, p) {
  const lim = TIERS[room.tier];
  const k = Object.keys(p.bets).find(k => p.bets[k] > 0 && p.bets[k] < minFor(room, k));
  return k ? (NO_MAX[k] ? `Panda 8 and Dragon 7 bets at ${lim.name} must be at least $${lim.sideMin.toLocaleString()}.` : `Each bet at ${lim.name} must be at least $${lim.min.toLocaleString()}.`) : null;
}
function deal(room) {
  if (room.phase !== 'betting') return;
  const lim = TIERS[room.tier];
  for (const p of room.players.values()) for (const [k, v] of Object.entries(p.bets)) if (v < minFor(room, k)) {
    p.balance += v; delete p.bets[k];
    send(p.ws, { t: 'error', msg: `Your ${k} bet was under the $${minFor(room, k).toLocaleString()} minimum and was returned.` });
  }
  const bettors = [...room.players.values()].filter(p => stake(p) > 0);
  if (!bettors.length) return;
  if (room.shoe.length < 20) { room.shoe = freshShoe(); broadcast(room, { t: 'shuffle' }); }
  clearTimeout(room.countdown); room.countdown = null; room.countdownEnds = null;
  room.phase = 'dealing';
  for (const p of room.players.values()) p.ready = false;
  const cards = [];
  for (const side of ['player', 'banker', 'player', 'banker']) cards.push({ i: cards.length, side, ...room.shoe.pop(), up: false });
  room.round = { cards, squeezer: { player: pickSqueezer(room, 'player'), banker: pickSqueezer(room, 'banker') }, stage: 'peel' };
  broadcast(room, { t: 'deal', cards: cards.map(({ up, ...c }) => c), squeezer: room.round.squeezer });
  pushState(room);
  openWindow(room);
}

// one side at a time, Player first. The squeezer of that side gets a while to open it;
// a side nobody squeezes is turned by the dealer, one card at a time.
function openWindow(room) { const r = room.round; if (r) r.windowFor = null; scheduleDealerTurns(room); }
function scheduleDealerTurns(room) {
  clearTimeout(room.auto); clearTimeout(room.window);
  const r = room.round; if (!r) return;
  const side = activeSide(r); if (!side) return;
  if (!r.squeezer[side]) {
    room.auto = setTimeout(() => { const c = r.cards.find(x => !x.up && x.side === side); if (c) reveal(room, c.i, 'dealer'); }, 1800);
    return;
  }
  // the squeezer's clock starts when their side comes up, and keeps running across their cards
  if (r.windowFor !== side) { r.windowFor = side; r.windowEnds = Date.now() + SQUEEZE_WINDOW_MS; }
  room.window = setTimeout(() => { for (const c of r.cards) if (!c.up && c.side === side) reveal(room, c.i, 'dealer'); },
    Math.max(0, r.windowEnds - Date.now()));
}

function reveal(room, i, byId) {
  const r = room.round; if (!r) return;
  const c = r.cards[i]; if (!c || c.up) return;
  c.up = true;
  broadcast(room, { t: 'reveal', i, by: byId });
  if (r.cards.some(x => !x.up)) { scheduleDealerTurns(room); return; }
  clearTimeout(room.window); clearTimeout(room.auto);
  room.step = setTimeout(() => progress(room), 900);
}

function progress(room) {
  const r = room.round; if (!r) return;
  const P = r.cards.filter(c => c.side === 'player'), B = r.cards.filter(c => c.side === 'banker');
  const p = total(P), b = total(B);
  let drawSide = null;
  if (P.length === 2 && B.length === 2) {
    if (p >= 8 || b >= 8) drawSide = null;
    else if (p <= 5) drawSide = 'player';
    else if (b <= 5) drawSide = 'banker';
  } else if (P.length === 3 && B.length === 2) {
    if (bankerDraws(b, points(P[2]))) drawSide = 'banker';
  }
  if (!drawSide) return settle(room);
  const c = { i: r.cards.length, side: drawSide, ...room.shoe.pop(), up: false };
  r.cards.push(c);
  broadcast(room, { t: 'card', card: { i: c.i, side: c.side, rank: c.rank, suit: c.suit } });
  openWindow(room);
}

function settle(room) {
  const r = room.round;
  const P = r.cards.filter(c => c.side === 'player'), B = r.cards.filter(c => c.side === 'banker');
  const p = total(P), b = total(B);
  const result = p > b ? 'P' : b > p ? 'B' : 'T';
  const panda = result === 'P' && P.length === 3 && p === 8;
  const dragon = result === 'B' && B.length === 3 && b === 7;
  const pPair = P[0].rank === P[1].rank, bPair = B[0].rank === B[1].rank;
  const nine7 = (p === 9 && b === 7) || (b === 9 && p === 7);   // 9 over 7: the winning hand is 9 and the losing hand is 7
  const payouts = {};
  for (const pl of room.players.values()) {
    let gross = 0;
    for (const [t, amt] of Object.entries(pl.bets)) {
      if (t === 'player') gross += result === 'P' ? amt * (1 + PAYOUT.player) : result === 'T' ? amt : 0;
      if (t === 'banker') gross += result === 'B' ? (dragon ? amt : amt * (1 + PAYOUT.banker)) : result === 'T' ? amt : 0; // no commission; 3-card 7 pushes
      if (t === 'tie') gross += result === 'T' ? amt * (1 + PAYOUT.tie) : 0;
      if (t === 'panda') gross += panda ? amt * (1 + PAYOUT.panda) : 0;
      if (t === 'dragon') gross += dragon ? amt * (1 + PAYOUT.dragon) : 0;
      if (t === 'nine7') gross += nine7 ? amt * (1 + PAYOUT.nine7) : 0;
      if (t === 'ppair') gross += pPair ? amt * (1 + PAYOUT.ppair) : 0;
      if (t === 'bpair') gross += bPair ? amt * (1 + PAYOUT.bpair) : 0;
    }
    payouts[pl.id] = { gross, staked: stake(pl), bankerPush: dragon && (pl.bets.banker || 0) > 0, onPanda: (pl.bets.panda || 0) > 0, onDragon: (pl.bets.dragon || 0) > 0 };
    pl.balance += gross; pl.bets = {}; pl.ready = false;
  }
  room.history.push(result); if (room.history.length > 200) room.history.splice(0, room.history.length - 200);
  room.phase = 'result';
  broadcast(room, { t: 'result', result, p, b, panda, dragon, nine7, pPair, bPair, payouts });
  room.round = null;
  room.step = setTimeout(() => { room.phase = 'betting'; startBetting(room); pushState(room); maybeDeal(room); }, 3200);
  pushState(room);
}

/* ---------------- messages from players ---------------- */
// open tables anyone can see and join from the start screen
function listTables() {
  return [...rooms.values()].filter(r => r.open && r.players.size > 0 && r.players.size < MAX_PLAYERS).slice(0, 30)
    .map(r => ({ code: r.code, tier: r.tier, players: r.players.size, max: MAX_PLAYERS, host: [...r.players.values()][0].name, playing: !!r.round }));
}
function handle(ws, msg) {
  const me = ws.player;
  if (msg.t === 'create' || msg.t === 'join') {
    if (me) return;
    const name = String(msg.name || 'Player').trim().slice(0, 14) || 'Player';
    let room;
    if (msg.t === 'create') {
      const tier = TIERS[msg.tier] ? msg.tier : 'lounge';
      const want = String(msg.code || '').toUpperCase();
      const code = /^[A-Z]{4}$/.test(want) && !rooms.has(want) ? want : newCode();
      room = { code, tier, open: msg.open !== false, players: new Map(), phase: 'betting', shoe: freshShoe(), history: [], round: null };
      rooms.set(room.code, room);
    } else {
      room = rooms.get(String(msg.code || '').toUpperCase().trim());
      if (!room) return send(ws, { t: 'error', msg: 'No table with that code.' });
      if (room.players.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'That table is full.' });
    }
    // players bring their saved chip wallet with them (virtual chips, so the device's word is taken for it)
    const bank = Number(msg.bankroll);
    const p = { id: msg.id ? String(msg.id).slice(0, 40) : String(nextId++), name, balance: Number.isFinite(bank) && bank >= 0 ? Math.min(MAX_BANKROLL, Math.floor(bank)) : START_BANKROLL, bets: {}, ready: false, ws };
    room.players.set(p.id, p); ws.player = p; ws.room = room;
    send(ws, { t: 'welcome', you: p.id, code: room.code, tier: room.tier });
    // someone arriving mid-hand sees the cards already on the table
    if (room.round) send(ws, { t: 'deal', cards: room.round.cards.map(({ up, ...c }) => c), squeezer: room.round.squeezer, late: room.round.cards.filter(c => c.up).map(c => c.i) });
    broadcast(room, { t: 'chat', from: 'Dealer', text: `${name} sat down.` });
    if (room.phase === 'betting' && !room.countdown) startBetting(room);   // the first player opens the first betting round
    return pushState(room);
  }
  if (msg.t === 'list') return send(ws, { t: 'tables', tables: listTables() });
  if (!me) return;
  const room = ws.room;
  switch (msg.t) {
    case 'bet': { // the player's full set of bets for this hand
      if ((room.phase !== 'betting' && room.phase !== 'result') || me.ready) return;   // next-hand bets are fine while the last result shows
      const nb = {};
      const lim = TIERS[room.tier];
      for (const k of SPOTS) {
        const v = Math.floor(Number(msg.bets && msg.bets[k]) || 0);
        if (v <= 0) continue;
        if (v > lim.max && !NO_MAX[k]) { send(ws, { t: 'error', msg: `${lim.name} maximum is $${lim.max.toLocaleString()} per spot.` }); return pushState(room); }
        nb[k] = v;
      }
      if (nb.player && nb.banker) { send(ws, { t: 'error', msg: 'You can bet Player or Banker in a hand, not both.' }); return pushState(room); }
      const avail = me.balance + stake(me);
      const want = Object.values(nb).reduce((a, b) => a + b, 0);
      if (want > avail) return send(ws, { t: 'error', msg: 'Not enough chips.' }) || pushState(room);
      const had = stake(me) > 0;
      me.balance = avail - want; me.bets = nb;
      if (!want) me.betAt = 0; else if (!had) me.betAt = ++betSeq;
      pushState(room); maybeDeal(room); return;
    }
    case 'ready': { // with bets: ready to deal; with none: sitting this hand out
      if (room.phase !== 'betting' && room.phase !== 'result') return;
      const short = stake(me) > 0 && underMin(room, me);
      if (short) { send(ws, { t: 'error', msg: short }); return pushState(room); }
      me.ready = true; pushState(room); maybeDeal(room); return;
    }
    case 'unready': {
      if (room.phase !== 'betting' && room.phase !== 'result') return;
      me.ready = false; return pushState(room);
    }
    case 'reveal': { // only the squeezer of the side being peeled opens its cards
      const r = room.round; if (!r) return;
      const c = r.cards[msg.i]; if (!c) return;
      if (r.squeezer[c.side] !== me.id || activeSide(r) !== c.side) return;
      return reveal(room, c.i, me.id);
    }
    case 'peel': { // live squeeze position, so everyone else watches the bend
      const r = room.round; if (!r) return;
      const c = r.cards[msg.i]; if (!c || c.up || r.squeezer[c.side] !== me.id || activeSide(r) !== c.side) return;
      return broadcast(room, { t: 'peel', i: c.i, G: msg.G, P: msg.P, by: me.id }, me);
    }
    case 'rebuy':
      if (room.phase !== 'betting' || stake(me) > 0) return;
      { const a = Math.floor(Number(msg.amount)); me.balance = Math.max(me.balance, a >= START_MIN && a <= START_MAX ? a : START_BANKROLL); }
      return pushState(room);
    case 'chat': {
      const text = String(msg.text || '').slice(0, 120).trim(); if (!text) return;
      return broadcast(room, { t: 'chat', from: me.name, text });
    }
  }
}

function leave(ws) {
  const me = ws.player, room = ws.room; if (!me || !room) return;
  room.players.delete(me.id); ws.player = null;
  if (!room.players.size) { clearTimers(room); rooms.delete(room.code); return; }
  if (room.round) { // their squeeze passes to the dealer
    for (const s of ['player', 'banker']) if (room.round.squeezer[s] === me.id) { room.round.squeezer[s] = null; broadcast(room, { t: 'squeezer', side: s, id: null }); }
    room.round.windowFor = null; scheduleDealerTurns(room);
  }
  broadcast(room, { t: 'chat', from: 'Dealer', text: `${me.name} left the table.` });
  pushState(room);
  if (room.phase === 'betting') maybeDeal(room);
}


return { handle, leave, rooms, TIERS, START_BANKROLL, SPOTS };
});
