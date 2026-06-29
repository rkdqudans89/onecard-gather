// net.js — transport over Supabase Realtime (WebSocket). No WebRTC → no NAT/relay
// failures. Same interface as before, so host.js / app.js are unchanged.
//
// IMPORTANT: this project's Supabase Realtime BROADCAST works cross-client, but
// PRESENCE does not sync reliably — so peer discovery is done with broadcast
// HEARTBEATS instead of presence. Every client periodically broadcasts a ping;
// we learn peers from any message's `from` field and expire silent ones.
//
//   transport.selfId
//   transport.send(channel, data, targetPeerId?)   // no target = broadcast
//   transport.on(channel, (data, peerId) => {})
//   transport.onPeerJoin(cb) / transport.onPeerLeave(cb)
//   transport.peers() -> string[]
//
// NOTE: broadcast has no true per-recipient delivery, so per-player "view"
// payloads reach everyone and are filtered client-side by `to`. Hands are thus
// visible to a network snooper — fine for a friendly game.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://ganlqftyyvuahfneruxt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_erk-6v_AmWeNbeHBkMGyIg_weFaqrdp'; // publishable: safe in browser
const APP_PREFIX = 'onecard-';

const HEARTBEAT_MS = 2000;
const PEER_TIMEOUT_MS = 6500;

export const selfId =
  globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : 'p' + Math.random().toString(36).slice(2);

export function createTransport(roomId) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    realtime: { params: { eventsPerSecond: 20 } },
  });

  const handlers = new Map(); // channel -> Set<fn>
  const joinCbs = new Set();
  const leaveCbs = new Set();
  const lastSeen = new Map(); // peerId -> timestamp (excludes self)
  const outbox = [];
  let subscribed = false;

  const channel = supabase.channel(APP_PREFIX + encodeURIComponent(roomId), {
    config: { broadcast: { self: true } },
  });

  function dispatch(ch, data, from) {
    const set = handlers.get(ch);
    if (set) for (const fn of set) fn(data, from);
  }

  function markSeen(id) {
    if (!id || id === selfId) return;
    if (!lastSeen.has(id)) {
      lastSeen.set(id, Date.now());
      joinCbs.forEach((fn) => fn(id));
    } else {
      lastSeen.set(id, Date.now());
    }
  }

  channel.on('broadcast', { event: 'm' }, ({ payload }) => {
    if (!payload) return;
    const { ch, data, from, to } = payload;
    markSeen(from); // learn/refresh peer liveness from any message
    if (ch === '__hb') return; // heartbeat only carries presence
    if (to && to !== selfId) return; // addressed to someone else
    dispatch(ch, data, from);
  });

  function rawSend(payload) {
    channel.send({ type: 'broadcast', event: 'm', payload });
  }

  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      subscribed = true;
      rawSend({ ch: '__hb', from: selfId, to: null }); // announce immediately
      for (const p of outbox.splice(0)) rawSend(p);
    }
  });

  // Heartbeat so idle peers stay discovered, and reaper to expire the gone.
  setInterval(() => {
    if (subscribed) rawSend({ ch: '__hb', from: selfId, to: null });
  }, HEARTBEAT_MS);

  setInterval(() => {
    const now = Date.now();
    for (const [id, ts] of [...lastSeen]) {
      if (now - ts > PEER_TIMEOUT_MS) {
        lastSeen.delete(id);
        leaveCbs.forEach((fn) => fn(id));
      }
    }
  }, HEARTBEAT_MS);

  return {
    selfId,

    on(ch, fn) {
      if (!handlers.has(ch)) handlers.set(ch, new Set());
      handlers.get(ch).add(fn);
    },

    send(ch, data, target) {
      const payload = { ch, data, from: selfId, to: target ?? null };
      if (subscribed) rawSend(payload);
      else outbox.push(payload);
    },

    onPeerJoin(fn) {
      joinCbs.add(fn);
    },
    onPeerLeave(fn) {
      leaveCbs.add(fn);
    },
    peers() {
      return [...lastSeen.keys()];
    },
    leave() {
      try {
        channel.unsubscribe();
      } catch {}
    },
  };
}
