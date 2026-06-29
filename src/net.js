// net.js — transport abstraction over Trystero (WebRTC, default Nostr strategy).
// Zero account, no signaling server of our own. Pinned version for stability.
//
// This is the ONLY file that knows about Trystero. To move to an authoritative
// server later (PartyKit / Cloudflare Durable Objects / a Node ws server), write
// another module exposing the same shape and swap it in app.js — game logic and
// host.js do not change.
//
// Key extension over raw Trystero: send(channel, data, target) supports a local
// LOOPBACK. target === selfId (or an omitted target / broadcast) also delivers to
// our own handlers, so the host can treat itself as just another client.

// MQTT relay strategy (zero account) — swapped from Nostr after the public Nostr
// relays failed to connect peers reliably. Still WebRTC data channels under the hood.
import { joinRoom, selfId } from 'https://esm.sh/@trystero-p2p/mqtt@0.25.2';

// Globally-unique app id namespaces our Nostr rooms away from other Trystero apps.
const APP_ID = 'onecard-gather-bm-2026';

export { selfId };

export function createTransport(roomId) {
  const room = joinRoom({ appId: APP_ID }, roomId);

  const handlers = new Map(); // channel -> Set<fn>
  const senders = new Map(); // channel -> trystero send fn
  const joinCbs = new Set();
  const leaveCbs = new Set();

  // Track connected peers ourselves — reliable across Trystero versions and
  // not subject to getPeers() timing during the join callback.
  const livePeers = new Set();

  // Trystero exposes these as assignable setters (NOT methods to call).
  // Update livePeers BEFORE firing callbacks so host election sees the new peer.
  room.onPeerJoin = (id) => {
    livePeers.add(id);
    joinCbs.forEach((fn) => fn(id));
  };
  room.onPeerLeave = (id) => {
    livePeers.delete(id);
    leaveCbs.forEach((fn) => fn(id));
  };

  function dispatch(channel, data, peerId) {
    const set = handlers.get(channel);
    if (set) for (const fn of set) fn(data, peerId);
  }

  // Trystero requires makeAction once per channel; create lazily, wire receive.
  function ensureChannel(channel) {
    if (senders.has(channel)) return;
    // Trystero 0.25 makeAction returns { send, onMessage, onReceiveProgress };
    // onMessage is an assignable setter (NOT a function to call).
    const action = room.makeAction(channel); // names must be <=12 bytes
    senders.set(channel, action.send);
    action.onMessage = (data, peerId) => dispatch(channel, data, peerId);
  }

  function peerIds() {
    return [...livePeers];
  }

  // Pre-create every channel at join so Trystero negotiates all actions during
  // connection setup. Avoids a race where a lazily-created action's first
  // message (e.g. the client's "hello") is dropped before the channel exists.
  ['hello', 'intent', 'lobby', 'view', 'toast'].forEach(ensureChannel);

  return {
    selfId,

    on(channel, fn) {
      ensureChannel(channel);
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel).add(fn);
    },

    send(channel, data, target) {
      ensureChannel(channel);
      const send = senders.get(channel);

      if (target === undefined) {
        // Broadcast to all remote peers, plus local loopback.
        if (peerIds().length > 0) send(data);
        queueMicrotask(() => dispatch(channel, data, selfId));
      } else if (target === selfId) {
        // Pure loopback to ourselves.
        queueMicrotask(() => dispatch(channel, data, selfId));
      } else {
        send(data, target); // unicast to one remote peer
      }
    },

    onPeerJoin(fn) {
      joinCbs.add(fn);
    },
    onPeerLeave(fn) {
      leaveCbs.add(fn);
    },
    peers() {
      return peerIds();
    },
    leave() {
      room.leave();
    },
  };
}
