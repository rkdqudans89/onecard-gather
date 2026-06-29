// host.js — authoritative game controller. Runs ONLY on the elected host peer.
// Owns the full game state; clients send intents and receive personalized views.
//
// Transport contract (injected, see net.js). send() with target===selfId loops
// back locally, so the host receives its own lobby/view updates like any client:
//   transport.selfId
//   transport.send(channel, data, targetPeerId?)   // no target = broadcast+loopback
//   transport.on(channel, (data, peerId) => {})
//   transport.onPeerJoin(cb) / transport.onPeerLeave(cb)
//   transport.peers() -> string[]   (other peers, excluding self)

import { startGame, playCard, drawAction, chooseSuit, viewFor } from './rules.js';

export function createHost(transport) {
  const roster = new Map(); // id -> name (everyone, including host)
  let state = null; // authoritative game state, or null while in lobby

  function rosterList() {
    return [...roster.entries()].map(([id, name]) => ({ id, name }));
  }

  function everyone() {
    return [transport.selfId, ...transport.peers()];
  }

  function broadcastLobby() {
    // Drop roster entries for peers who have left.
    const present = new Set(everyone());
    for (const id of [...roster.keys()]) {
      if (!present.has(id)) roster.delete(id);
    }
    transport.send('lobby', { players: rosterList(), hostId: transport.selfId });
  }

  function broadcastViews() {
    if (!state) return;
    for (const id of everyone()) {
      transport.send('view', viewFor(state, id), id);
    }
  }

  function handleIntent(action, fromId) {
    if (!action || typeof action.type !== 'string') return;

    if (action.type === 'start') {
      const seats = rosterList().filter((p) => everyone().includes(p.id));
      if (seats.length < 2) {
        transport.send('toast', { msg: '2명 이상이어야 시작할 수 있어요.' }, fromId);
        return;
      }
      state = startGame(seats);
      broadcastViews();
      return;
    }

    if (!state || state.phase !== 'playing') return;

    let result;
    if (action.type === 'play') result = playCard(state, fromId, action.cardId);
    else if (action.type === 'draw') result = drawAction(state, fromId);
    else if (action.type === 'suit') result = chooseSuit(state, fromId, action.suit);
    else return;

    if (result.ok) {
      state = result.state;
      broadcastViews();
    } else {
      transport.send('toast', { msg: result.error }, fromId); // private to offender
    }
  }

  // --- wire transport events ------------------------------------------------

  transport.on('hello', (data, peerId) => {
    if (data && typeof data.name === 'string') {
      roster.set(peerId, data.name.slice(0, 16) || '플레이어');
      broadcastLobby();
      if (state) broadcastViews(); // keep a mid-game spectator's name fresh
    }
  });

  transport.on('intent', (data, peerId) => handleIntent(data, peerId));

  transport.onPeerJoin(() => broadcastLobby());

  transport.onPeerLeave((peerId) => {
    roster.delete(peerId);
    if (state && state.phase === 'playing') {
      state = null; // V1 policy: a mid-game drop aborts the round back to lobby
      transport.send('toast', { msg: '플레이어가 나가 판이 종료되었습니다.' });
    }
    broadcastLobby();
  });

  return {
    setName(name) {
      roster.set(transport.selfId, (name || '').slice(0, 16) || '방장');
      broadcastLobby();
    },
    localIntent(action) {
      handleIntent(action, transport.selfId); // host's own move, no network hop
    },
    destroy() {
      state = null;
      roster.clear();
    },
  };
}
