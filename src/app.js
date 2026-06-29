// app.js — client entry. Owns UI, host election, intent routing, and rendering.
// Every peer runs this; exactly one peer also runs a host (lowest selfId wins).

import { createTransport, selfId } from './net.js';
import { createHost } from './host.js';
import { SUIT_SYMBOL, SUIT_NAME, SUIT_IS_RED } from './cards.js';

// --- tiny resilient store (Gather's iframe may null-origin localStorage) ------
const mem = {};
function loadName() {
  try {
    return localStorage.getItem('onecard.name') || '';
  } catch {
    return mem.name || '';
  }
}
function saveName(v) {
  try {
    localStorage.setItem('onecard.name', v);
  } catch {
    mem.name = v;
  }
}

// --- app state ----------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
let transport = null;
let hostInstance = null;
let myName = loadName();
let roomId = new URLSearchParams(location.search).get('room') || '거실';
let amHost = false;
let hostId = selfId;
let view = null; // latest personalized game view
let lobby = { players: [], hostId: null };
let aloneSince = 0;

// --- screens ------------------------------------------------------------------
function show(screen) {
  for (const s of ['enter', 'lobby', 'game']) {
    $('#screen-' + s).classList.toggle('active', s === screen);
  }
}

// --- networking lifecycle -----------------------------------------------------
function connect() {
  transport = createTransport(roomId);

  transport.on('lobby', (data) => {
    lobby = data;
    if (!view || view.phase !== 'playing') {
      renderLobby();
      show('lobby');
    }
  });

  transport.on('view', (v) => {
    view = v;
    if (v.phase === 'playing' || v.phase === 'ended') {
      renderGame();
      show('game');
    }
  });

  transport.on('toast', (data) => toast(data.msg));

  transport.onPeerJoin(() => {
    reelectHost();
    sayHello();
  });
  transport.onPeerLeave(() => {
    reelectHost();
  });

  reelectHost();
  sayHello();
  aloneSince = performance.now();
  tickAlone();

  // Re-announce presence periodically while in the lobby so the host's roster
  // always converges even if a single hello is dropped during connection setup.
  setInterval(() => {
    if (!view || view.phase !== 'playing') sayHello();
  }, 3000);
}

function sayHello() {
  transport.send('hello', { name: myName });
}

// Deterministic host = lexicographically smallest id present.
function reelectHost() {
  const ids = [selfId, ...transport.peers()].sort();
  hostId = ids[0];
  const nextAmHost = hostId === selfId;

  if (nextAmHost && !hostInstance) {
    hostInstance = createHost(transport);
    hostInstance.setName(myName);
  } else if (!nextAmHost && hostInstance) {
    hostInstance.destroy();
    hostInstance = null;
  }
  amHost = nextAmHost;
}

function sendIntent(action) {
  if (amHost && hostInstance) hostInstance.localIntent(action);
  else transport.send('intent', action, hostId);
}

// Gentle "you're alone" hint (cannot reliably detect NAT failure from here).
function tickAlone() {
  const peers = transport ? transport.peers().length : 0;
  const hint = $('#alone-hint');
  if (hint) {
    const lonely = peers === 0 && performance.now() - aloneSince > 12000;
    hint.classList.toggle('show', lonely);
  }
  setTimeout(tickAlone, 2000);
}

// --- rendering: lobby ---------------------------------------------------------
function renderLobby() {
  $('#lobby-room').textContent = roomId;
  const list = $('#lobby-players');
  list.innerHTML = '';
  for (const p of lobby.players) {
    const li = document.createElement('li');
    li.className = 'player-chip' + (p.id === hostId ? ' is-host' : '');
    li.innerHTML = `<span class="dot"></span>${escapeHtml(p.name)}${
      p.id === selfId ? ' <em>(나)</em>' : ''
    }${p.id === hostId ? ' <span class="badge">방장</span>' : ''}`;
    list.appendChild(li);
  }
  const count = lobby.players.length;
  const startBtn = $('#btn-start');
  startBtn.disabled = count < 2;
  startBtn.textContent = count < 2 ? '다른 사람을 기다리는 중…' : `게임 시작 (${count}명)`;
}

// --- rendering: game ----------------------------------------------------------
function cardEl(card, { faceUp = true, playable = false } = {}) {
  const el = document.createElement('button');
  el.className = 'card' + (faceUp ? '' : ' back') + (playable ? ' playable' : '');
  el.type = 'button';
  if (!faceUp) {
    el.disabled = true;
    el.innerHTML = '<span class="back-mark">♣</span>';
    return el;
  }
  el.classList.toggle('red', SUIT_IS_RED[card.suit]);
  el.innerHTML = `
    <span class="corner tl"><b>${card.rank}</b><i>${SUIT_SYMBOL[card.suit]}</i></span>
    <span class="pip">${SUIT_SYMBOL[card.suit]}</span>
    <span class="corner br"><b>${card.rank}</b><i>${SUIT_SYMBOL[card.suit]}</i></span>`;
  if (!playable) el.disabled = true;
  return el;
}

function renderGame() {
  // Winner overlay
  const overlay = $('#winner-overlay');
  if (view.phase === 'ended') {
    const winner =
      view.table.find((t) => t.id === view.winnerId) ||
      (view.you && view.winnerId === view.you.id ? { name: view.you.name, isYou: true } : null);
    $('#winner-text').textContent = winner
      ? `${winner.isYou ? '🎉 내가' : winner.name + '님'} 승리!`
      : '게임 종료';
    overlay.classList.add('show');
  } else {
    overlay.classList.remove('show');
  }

  // Opponents (everyone but me), ordered by seat offset from me.
  const opp = $('#opponents');
  opp.innerHTML = '';
  const others = view.table.filter((t) => !t.isYou).sort((a, b) => a.seatOffset - b.seatOffset);
  for (const p of others) {
    const seat = document.createElement('div');
    seat.className = 'seat' + (p.isTurn ? ' turn' : '');
    const fan = document.createElement('div');
    fan.className = 'fan';
    for (let i = 0; i < Math.min(p.count, 7); i++) fan.appendChild(cardEl(null, { faceUp: false }));
    seat.innerHTML = `<div class="seat-name">${escapeHtml(p.name)} <span class="cnt">${p.count}장</span></div>`;
    seat.appendChild(fan);
    opp.appendChild(seat);
  }

  // Center: draw pile + discard + status
  const top = view.top;
  $('#discard').innerHTML = '';
  $('#discard').appendChild(cardEl(top, { faceUp: true, playable: false }));
  $('#active-suit').innerHTML = `현재 무늬 <b class="${SUIT_IS_RED[view.activeSuit] ? 'red' : ''}">${SUIT_SYMBOL[view.activeSuit]} ${SUIT_NAME[view.activeSuit]}</b>`;
  $('#dir').textContent = view.direction === 1 ? '↻ 시계방향' : '↺ 반시계';
  $('#draw-count').textContent = view.drawCount;
  const pending = $('#pending');
  pending.classList.toggle('show', view.pendingDraw > 0);
  pending.textContent = `누적 공격 +${view.pendingDraw}장`;

  $('#log').textContent = view.lastAction || '';
  const turnName = view.table.find((t) => t.isTurn)?.name || '';
  $('#turn-banner').textContent = view.isYourTurn ? '내 차례!' : `${turnName}님 차례`;
  $('#turn-banner').classList.toggle('mine', view.isYourTurn);

  // My hand
  const hand = $('#hand');
  hand.innerHTML = '';
  if (view.you) {
    for (const card of view.you.hand) {
      const playable = view.isYourTurn && isPlayableNow(card);
      const el = cardEl(card, { faceUp: true, playable });
      if (playable) el.addEventListener('click', () => sendIntent({ type: 'play', cardId: card.id }));
      hand.appendChild(el);
    }
    $('#my-name').textContent = view.you.name;
    $('#my-count').textContent = view.you.hand.length + '장';
    $('#onecard-badge').classList.toggle('show', view.you.hand.length === 1 && view.phase === 'playing');
  }

  // Draw control
  const drawBtn = $('#btn-draw');
  drawBtn.disabled = !view.isYourTurn || view.mustChooseSuit;
  drawBtn.textContent = view.pendingDraw > 0 ? `+${view.pendingDraw}장 받기` : '카드 받기';

  // Suit chooser (after a wild 7)
  $('#suit-chooser').classList.toggle('show', view.mustChooseSuit && view.isYourTurn);
}

// Client-side legality mirror for highlighting (host re-validates authoritatively).
function isPlayableNow(card) {
  if (view.mustChooseSuit) return false;
  if (view.pendingDraw > 0) return card.rank === '2';
  if (card.rank === '7') return true;
  return card.suit === view.activeSuit || card.rank === view.top.rank;
}

// --- toast --------------------------------------------------------------------
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

// --- wire static controls -----------------------------------------------------
function init() {
  $('#enter-name').value = myName;
  $('#enter-room').value = roomId;

  $('#btn-enter').addEventListener('click', () => {
    myName = ($('#enter-name').value || '').trim().slice(0, 16) || '플레이어';
    roomId = ($('#enter-room').value || '').trim().slice(0, 24) || '거실';
    saveName(myName);
    const url = new URL(location.href);
    url.searchParams.set('room', roomId);
    history.replaceState(null, '', url);
    connect();
    show('lobby');
  });

  $('#btn-start').addEventListener('click', () => sendIntent({ type: 'start' }));
  $('#btn-again').addEventListener('click', () => sendIntent({ type: 'start' }));
  $('#btn-draw').addEventListener('click', () => sendIntent({ type: 'draw' }));

  for (const b of document.querySelectorAll('#suit-chooser [data-suit]')) {
    b.addEventListener('click', () => sendIntent({ type: 'suit', suit: b.dataset.suit }));
  }

  $('#btn-copy').addEventListener('click', async () => {
    const link = location.href;
    try {
      await navigator.clipboard.writeText(link);
      toast('초대 링크를 복사했어요!');
    } catch {
      toast(link);
    }
  });

  show('enter');
}

init();
