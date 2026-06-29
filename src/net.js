// net.js — transport over Supabase Realtime (WebSocket). No WebRTC, so no NAT or
// relay-discovery failures: every client connects to Supabase and messages are
// relayed server-side. Same interface as before, so host.js / app.js are unchanged.
//
//   transport.selfId
//   transport.send(channel, data, targetPeerId?)   // no target = broadcast
//   transport.on(channel, (data, peerId) => {})
//   transport.onPeerJoin(cb) / transport.onPeerLeave(cb)
//   transport.peers() -> string[]   (other peers)
//
// Presence handles join/leave; a single broadcast event ('m') carries our app
// messages, tagged with {ch, from, to}. Recipients filter by `to`. With
// broadcast self:true, our own messages come back to us (built-in loopback).
//
// NOTE: Supabase broadcast has no true per-recipient delivery, so per-player
// "view" payloads are sent to everyone and filtered client-side by `to`. Hands
// are therefore visible to a determined network snooper — fine for a friendly
// game; revisit if you ever need anti-cheat.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://ganlqftyyvuahfneruxt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_erk-6v_AmWeNbeHBkMGyIg_weFaqrdp'; // publishable: safe in browser
const APP_PREFIX = 'onecard-';

export const selfId =
  globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : 'p' + Math.random().toString(36).slice(2);

export function createTransport(roomId) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    realtime: { params: { eventsPerSecond: 20 } },
  });

  const handlers = new Map(); // channel -> Set<fn>
  const joinCbs = new Set();
  const leaveCbs = new Set();
  const known = new Set(); // currently-present peer ids (excluding self)
  const outbox = []; // queued sends until subscribed
  let subscribed = false;

  const channel = supabase.channel(APP_PREFIX + encodeURIComponent(roomId), {
    config: { broadcast: { self: true }, presence: { key: selfId } },
  });

  function dispatch(ch, data, from) {
    const set = handlers.get(ch);
    if (set) for (const fn of set) fn(data, from);
  }

  // App messages.
  channel.on('broadcast', { event: 'm' }, ({ payload }) => {
    if (!payload) return;
    const { ch, data, from, to } = payload;
    if (to && to !== selfId) return; // addressed to someone else
    dispatch(ch, data, from);
  });

  // Presence: derive join/leave by diffing the synced state (robust ordering).
  channel.on('presence', { event: 'sync' }, () => {
    const now = new Set(peerIds());
    for (const id of now) {
      if (!known.has(id)) {
        known.add(id);
        joinCbs.forEach((fn) => fn(id));
      }
    }
    for (const id of [...known]) {
      if (!now.has(id)) {
        known.delete(id);
        leaveCbs.forEach((fn) => fn(id));
      }
    }
  });

  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      subscribed = true;
      channel.track({ id: selfId });
      for (const p of outbox.splice(0)) rawSend(p);
    }
  });

  function rawSend(payload) {
    channel.send({ type: 'broadcast', event: 'm', payload });
  }

  function peerIds() {
    const state = channel.presenceState();
    return Object.keys(state).filter((k) => k !== selfId);
  }

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
      return peerIds();
    },
    leave() {
      try {
        channel.unsubscribe();
      } catch {}
    },
  };
}
