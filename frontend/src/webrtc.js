// SDCMS WebRTC P2P relay module
// Uses C++ backend ONLY for signaling; all message data flows directly between browsers

const API = import.meta.env.VITE_API_URL || 'http://localhost:8080/api';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:openrelay.metered.ca:80' },
];

// Active peer connections: callsign → { pc, dc, state }
const peers = new Map();

// ── Signal helpers ─────────────────────────────────────────────────────────────
export async function sendSignal(from, to, data) {
  try {
    await fetch(`${API}/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, data }),
    });
  } catch (_) {}
}

export async function pollSignals(callsign) {
  try {
    const res = await fetch(`${API}/signal?callsign=${encodeURIComponent(callsign)}`);
    if (!res.ok) return [];
    return await res.json();
  } catch (_) {
    return [];
  }
}

// ── Create offer (initiator side) ─────────────────────────────────────────────
export async function initWebRTC(myCallsign, peerCallsign, onMessage, onStateChange) {
  // Close any existing connection first
  closeWebRTC(peerCallsign);

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const dc = pc.createDataChannel('sdcms-msg', { ordered: true });

  dc.onopen = () => {
    onStateChange('connected');
    updatePeerState(peerCallsign, 'connected');
  };
  dc.onclose = () => {
    onStateChange('disconnected');
    updatePeerState(peerCallsign, 'disconnected');
  };
  dc.onmessage = (e) => {
    try { onMessage(JSON.parse(e.data)); } catch (_) {}
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendSignal(myCallsign, peerCallsign, { type: 'ice', candidate: e.candidate.toJSON() });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      onStateChange('failed');
      updatePeerState(peerCallsign, 'failed');
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await sendSignal(myCallsign, peerCallsign, { type: 'offer', sdp: offer.sdp });

  peers.set(peerCallsign, { pc, dc, state: 'connecting' });
  onStateChange('connecting');
  return { pc, dc };
}

// ── Handle incoming offer (answerer side) ─────────────────────────────────────
export async function answerWebRTC(myCallsign, peerCallsign, offerData, onMessage, onStateChange) {
  // Close any existing connection first
  closeWebRTC(peerCallsign);

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.ondatachannel = (e) => {
    const dc = e.channel;
    dc.onopen = () => {
      onStateChange('connected');
      peers.get(peerCallsign).dc = dc;
      updatePeerState(peerCallsign, 'connected');
    };
    dc.onclose = () => {
      onStateChange('disconnected');
      updatePeerState(peerCallsign, 'disconnected');
    };
    dc.onmessage = (ev) => {
      try { onMessage(JSON.parse(ev.data)); } catch (_) {}
    };
    // Store dc reference
    const existing = peers.get(peerCallsign);
    if (existing) existing.dc = dc;
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendSignal(myCallsign, peerCallsign, { type: 'ice', candidate: e.candidate.toJSON() });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      onStateChange('failed');
      updatePeerState(peerCallsign, 'failed');
    }
  };

  await pc.setRemoteDescription({ type: 'offer', sdp: offerData.sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await sendSignal(myCallsign, peerCallsign, { type: 'answer', sdp: answer.sdp });

  peers.set(peerCallsign, { pc, dc: null, state: 'connecting' });
  onStateChange('connecting');
  return { pc };
}

// ── Handle answer ─────────────────────────────────────────────────────────────
export async function handleAnswer(peerCallsign, answerData) {
  const peer = peers.get(peerCallsign);
  if (!peer?.pc) return;
  try {
    await peer.pc.setRemoteDescription({ type: 'answer', sdp: answerData.sdp });
  } catch (_) {}
}

// ── Handle ICE candidate ──────────────────────────────────────────────────────
export async function handleIceCandidate(peerCallsign, candidateData) {
  const peer = peers.get(peerCallsign);
  if (!peer?.pc) return;
  try {
    await peer.pc.addIceCandidate(new RTCIceCandidate(candidateData));
  } catch (_) {}
}

// ── Send via WebRTC data channel ───────────────────────────────────────────────
export function sendViaWebRTC(peerCallsign, message) {
  const peer = peers.get(peerCallsign);
  if (peer?.dc?.readyState === 'open') {
    try {
      peer.dc.send(JSON.stringify(message));
      return true;
    } catch (_) {}
  }
  return false;
}

// ── Close connection ──────────────────────────────────────────────────────────
export function closeWebRTC(peerCallsign) {
  const peer = peers.get(peerCallsign);
  if (peer) {
    try { peer.dc?.close(); } catch (_) {}
    try { peer.pc?.close(); } catch (_) {}
    peers.delete(peerCallsign);
  }
}

// ── Get connection state ──────────────────────────────────────────────────────
export function getConnectionState(peerCallsign) {
  return peers.get(peerCallsign)?.state || 'none';
}

function updatePeerState(peerCallsign, state) {
  const peer = peers.get(peerCallsign);
  if (peer) peer.state = state;
}
