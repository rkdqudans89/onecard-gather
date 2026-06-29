// cards.js — deck model + shuffle. Pure, transport-agnostic, browser-safe.

export const SUITS = ['S', 'H', 'D', 'C']; // ♠ ♥ ♦ ♣
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

export const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
export const SUIT_NAME = { S: '스페이드', H: '하트', D: '다이아', C: '클럽' };
export const SUIT_IS_RED = { S: false, H: true, D: true, C: false };

// Wild card: rank '7' can be played on anything and changes the active suit.
export const WILD_RANK = '7';
// +2 attack card.
export const ATTACK_RANK = '2';
// Skip-next card.
export const SKIP_RANK = 'A';
// Reverse-direction card.
export const REVERSE_RANK = 'J';

/** A fresh ordered 52-card deck. Each card: { id, suit, rank }. */
export function freshDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ id: `${suit}${rank}`, suit, rank });
    }
  }
  return deck;
}

/** Fisher–Yates shuffle. Returns a NEW array; does not mutate input. */
export function shuffle(cards) {
  const out = cards.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** True when a card carries a special effect (for UI hinting). */
export function isSpecial(card) {
  return (
    card.rank === WILD_RANK ||
    card.rank === ATTACK_RANK ||
    card.rank === SKIP_RANK ||
    card.rank === REVERSE_RANK
  );
}
