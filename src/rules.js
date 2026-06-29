// rules.js — 원카드 game rules. Pure functions. No I/O, no network, no mutation.
// The host runs these to advance authoritative state; clients never call them.
//
// Rule set (V1, documented in the in-game help panel):
//   - Play a card matching the active SUIT (무늬) or the top card's RANK (숫자).
//   - 7  = 만능(wild): play on anything, then choose a new suit.
//   - 2  = +2 공격: next player draws 2 and is skipped — unless they stack another 2.
//   - A  = 한 번 쉬기 (skip next player).
//   - J  = 방향 전환 (reverse). In a 2-player game, reverse acts as a skip.
//   - Can't (or won't) play: draw 1 card, turn passes.
//   - First player to empty their hand wins.

import {
  freshDeck,
  shuffle,
  WILD_RANK,
  ATTACK_RANK,
  SKIP_RANK,
  REVERSE_RANK,
} from './cards.js';

export const HAND_SIZE = 7;

/**
 * Build the initial authoritative game state from a lobby roster.
 * @param {{id:string,name:string}[]} roster seating order
 * @returns authoritative state object
 */
export function startGame(roster) {
  let deck = shuffle(freshDeck());

  const players = roster.map((p) => ({ id: p.id, name: p.name, hand: [] }));
  // Deal HAND_SIZE cards round-robin.
  for (let n = 0; n < HAND_SIZE; n++) {
    for (const player of players) {
      player.hand = [...player.hand, deck[0]];
      deck = deck.slice(1);
    }
  }

  // Flip the first non-special card as the starting discard so the opening
  // turn isn't immediately under attack/skip/wild effects.
  let starterIdx = deck.findIndex((c) => !isOpeningProblem(c));
  if (starterIdx === -1) starterIdx = 0;
  const starter = deck[starterIdx];
  deck = [...deck.slice(0, starterIdx), ...deck.slice(starterIdx + 1)];

  return {
    phase: 'playing',
    players,
    seating: players.map((p) => p.id),
    turnIndex: 0,
    direction: 1,
    drawPile: deck,
    discard: [starter],
    activeSuit: starter.suit,
    pendingDraw: 0,
    mustChooseSuit: false,
    winnerId: null,
    lastAction: `${players[0].name}님부터 시작합니다.`,
  };
}

function isOpeningProblem(card) {
  return (
    card.rank === WILD_RANK ||
    card.rank === ATTACK_RANK ||
    card.rank === SKIP_RANK ||
    card.rank === REVERSE_RANK
  );
}

/** Top card of the discard pile. */
export function topCard(state) {
  return state.discard[state.discard.length - 1];
}

/**
 * Is `card` legal to play right now, for the player whose turn it is?
 * Considers active suit, top rank, wild, and pending +2 stacks.
 */
export function isLegalPlay(state, card) {
  if (state.mustChooseSuit) return false; // waiting on a suit choice
  const top = topCard(state);

  // Under a +2 attack, you may only stack another 2 (or take the cards).
  if (state.pendingDraw > 0) {
    return card.rank === ATTACK_RANK;
  }

  if (card.rank === WILD_RANK) return true; // wild plays on anything
  return card.suit === state.activeSuit || card.rank === top.rank;
}

/** Does this player have any legal move available right now? */
export function hasLegalMove(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return false;
  return player.hand.some((c) => isLegalPlay(state, c));
}

function indexOfPlayer(state, playerId) {
  return state.seating.indexOf(playerId);
}

function currentPlayerId(state) {
  return state.seating[state.turnIndex];
}

/** Advance the turn pointer by `steps`, honoring direction and wrap-around. */
function advance(state, steps) {
  const n = state.seating.length;
  let idx = state.turnIndex;
  for (let s = 0; s < steps; s++) {
    idx = (idx + state.direction + n) % n;
  }
  return idx;
}

// Reshuffle the discard (keeping the top) back into the draw pile when empty.
function refillIfNeeded(drawPile, discard) {
  if (drawPile.length > 0) return { drawPile, discard };
  if (discard.length <= 1) return { drawPile, discard }; // nothing to recycle
  const keep = discard[discard.length - 1];
  const recycled = shuffle(discard.slice(0, -1));
  return { drawPile: recycled, discard: [keep] };
}

function drawCards(state, playerId, count) {
  let { drawPile, discard } = state;
  const players = state.players.map((p) =>
    p.id === playerId ? { ...p, hand: [...p.hand] } : p,
  );
  const target = players.find((p) => p.id === playerId);
  for (let i = 0; i < count; i++) {
    const refilled = refillIfNeeded(drawPile, discard);
    drawPile = refilled.drawPile;
    discard = refilled.discard;
    if (drawPile.length === 0) break; // truly out of cards
    target.hand.push(drawPile[0]);
    drawPile = drawPile.slice(1);
  }
  return { ...state, players, drawPile, discard };
}

/**
 * Apply a validated PLAY action. Returns { ok, state, error }.
 * Does not advance the turn when the play is a wild awaiting a suit choice.
 */
export function playCard(state, playerId, cardId) {
  if (state.phase !== 'playing') return fail(state, '게임이 진행 중이 아닙니다.');
  if (currentPlayerId(state) !== playerId) return fail(state, '당신의 차례가 아닙니다.');

  const player = state.players.find((p) => p.id === playerId);
  const card = player?.hand.find((c) => c.id === cardId);
  if (!card) return fail(state, '가지고 있지 않은 카드입니다.');
  if (!isLegalPlay(state, card)) return fail(state, '낼 수 없는 카드입니다.');

  // Remove card from hand, push to discard.
  const players = state.players.map((p) =>
    p.id === playerId ? { ...p, hand: p.hand.filter((c) => c.id !== cardId) } : p,
  );
  let next = {
    ...state,
    players,
    discard: [...state.discard, card],
    activeSuit: card.rank === WILD_RANK ? state.activeSuit : card.suit,
  };

  const mover = players.find((p) => p.id === playerId);

  // Win check first — emptying your hand wins immediately.
  if (mover.hand.length === 0) {
    return ok({
      ...next,
      phase: 'ended',
      winnerId: playerId,
      lastAction: `${mover.name}님이 마지막 카드를 냈습니다. 승리!`,
    });
  }

  // Apply special effects.
  switch (card.rank) {
    case WILD_RANK:
      // Wait for the same player to choose a suit; turn does not advance yet.
      return ok({
        ...next,
        mustChooseSuit: true,
        lastAction: `${mover.name}님이 만능 7을 냈습니다. 무늬 선택 중...`,
      });
    case ATTACK_RANK: {
      const pendingDraw = next.pendingDraw + 2;
      return ok({
        ...next,
        pendingDraw,
        turnIndex: advance(next, 1),
        lastAction: `${mover.name}님이 2 공격! 누적 +${pendingDraw}장.`,
      });
    }
    case SKIP_RANK:
      return ok({
        ...next,
        turnIndex: advance(next, 2),
        lastAction: `${mover.name}님이 A로 다음 사람을 건너뜁니다.`,
      });
    case REVERSE_RANK: {
      const flipped = { ...next, direction: next.direction * -1 };
      // In 2-player, reverse behaves like a skip (returns to mover) → advance 2.
      const steps = flipped.seating.length === 2 ? 2 : 1;
      return ok({
        ...flipped,
        turnIndex: advance(flipped, steps),
        lastAction: `${mover.name}님이 J로 방향을 바꿉니다.`,
      });
    }
    default:
      return ok({
        ...next,
        turnIndex: advance(next, 1),
        lastAction: `${mover.name}님이 ${card.suit}${card.rank}를 냈습니다.`,
      });
  }
}

/** Apply a suit choice after a wild (7). */
export function chooseSuit(state, playerId, suit) {
  if (!state.mustChooseSuit) return fail(state, '무늬를 선택할 상황이 아닙니다.');
  if (currentPlayerId(state) !== playerId) return fail(state, '당신의 차례가 아닙니다.');
  if (!['S', 'H', 'D', 'C'].includes(suit)) return fail(state, '잘못된 무늬입니다.');
  const mover = state.players.find((p) => p.id === playerId);
  const next = { ...state, activeSuit: suit, mustChooseSuit: false };
  return ok({
    ...next,
    turnIndex: advance(next, 1),
    lastAction: `${mover.name}님이 무늬를 ${suit}(으)로 바꿨습니다.`,
  });
}

/**
 * Apply a DRAW action. Under a pending +2 the player takes the accumulated
 * penalty and is skipped; otherwise they draw a single card and pass.
 */
export function drawAction(state, playerId) {
  if (state.phase !== 'playing') return fail(state, '게임이 진행 중이 아닙니다.');
  if (currentPlayerId(state) !== playerId) return fail(state, '당신의 차례가 아닙니다.');
  if (state.mustChooseSuit) return fail(state, '먼저 무늬를 선택하세요.');

  const mover = state.players.find((p) => p.id === playerId);

  if (state.pendingDraw > 0) {
    const taken = state.pendingDraw;
    let next = drawCards(state, playerId, taken);
    next = { ...next, pendingDraw: 0 };
    return ok({
      ...next,
      turnIndex: advance(next, 1),
      lastAction: `${mover.name}님이 +${taken}장을 받고 차례를 넘깁니다.`,
    });
  }

  let next = drawCards(state, playerId, 1);
  return ok({
    ...next,
    turnIndex: advance(next, 1),
    lastAction: `${mover.name}님이 한 장을 가져갑니다.`,
  });
}

/**
 * Build the personalized view a given peer is allowed to see: their own hand
 * in full, everyone else only as a count. Prevents hand leakage over the wire.
 */
export function viewFor(state, peerId) {
  const meIdx = indexOfPlayer(state, peerId);
  const me = state.players.find((p) => p.id === peerId) || null;
  return {
    phase: state.phase,
    activeSuit: state.activeSuit,
    direction: state.direction,
    pendingDraw: state.pendingDraw,
    mustChooseSuit: state.mustChooseSuit,
    winnerId: state.winnerId,
    lastAction: state.lastAction,
    top: topCard(state),
    drawCount: state.drawPile.length,
    turnPlayerId: currentPlayerId(state),
    isYourTurn: currentPlayerId(state) === peerId && state.phase === 'playing',
    you: me ? { id: me.id, name: me.name, hand: me.hand } : null,
    youCanPlay: me ? me.hand.some((c) => isLegalPlay(state, c)) : false,
    // Seating starting from this player so each client renders itself at the bottom.
    table: state.seating.map((id, i) => {
      const p = state.players.find((pp) => pp.id === id);
      return {
        id,
        name: p ? p.name : '?',
        count: p ? p.hand.length : 0,
        isTurn: i === state.turnIndex,
        isYou: id === peerId,
        seatOffset: meIdx >= 0 ? (i - meIdx + state.seating.length) % state.seating.length : i,
      };
    }),
  };
}

function ok(state) {
  return { ok: true, state, error: null };
}
function fail(state, error) {
  return { ok: false, state, error };
}
