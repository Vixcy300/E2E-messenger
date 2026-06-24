import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  generateRSAKeyPair, exportPublicKey, importPublicKey,
  generateAESKey, encryptTextAES, decryptTextAES,
  encryptAESKeyWithRSA, decryptAESKeyWithRSA,
  saveSession, loadSession, clearSession
} from './crypto';
import {
  Shield, ShieldAlert, Send, User, Lock, Zap, Search,
  CheckCheck, Check, Smile, Reply, Copy, Trash2, Bell, BellOff,
  LogOut, ChevronDown, X, MessageSquare, Mic, MicOff, Paperclip,
  Pin, Archive, Settings, Download, Upload, Wifi, WifiOff, Activity,
  Eye, EyeOff, Fingerprint, Volume2, VolumeX, Palette, Image, Clock, ChevronLeft
} from 'lucide-react';
import {
  initWebRTC, answerWebRTC, handleAnswer, handleIceCandidate,
  sendViaWebRTC, pollSignals, closeWebRTC, getConnectionState, sendSignal
} from './webrtc';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8080/api';
const DURESS_CODE = 'BURN911';
const INACTIVITY_MS = 5 * 60 * 1000; // 5 minutes

// ── Constants ─────────────────────────────────────────────────────────────────
const EMOJI_LIST = ['😀','😂','😍','🥰','😎','🤔','😢','😡','🤯','🥳','👍','👎','❤️','🔥','✅','🎉','💯','🙏','👀','💪','🤝','🎯','⚡','🛡️','🔐'];
const REACTION_EMOJIS = ['👍','❤️','😂','😮','😢','🔥'];
const STATUS_OPTIONS = ['Active', 'Away', 'Busy', 'In a Meeting', 'Do Not Disturb', 'On Mission', 'Stand By', 'Compromised'];
const TIMER_OPTIONS = [
  { label: 'No timer', value: '' },
  { label: '30 seconds', value: 30 },
  { label: '5 minutes', value: 300 },
  { label: '1 hour', value: 3600 },
];
const THEMES = [
  { id: 'dark-navy', label: 'Dark Navy', dot: '#5288c1' },
  { id: 'amoled', label: 'AMOLED Black', dot: '#888' },
  { id: 'matrix', label: 'Matrix Green', dot: '#00ff41' },
  { id: 'amber', label: 'Amber CRT', dot: '#ff8c00' },
];
const CANVAS_MODES = [
  { id: 'particles', label: '⚛ Particles' },
  { id: 'matrix-rain', label: '🟩 Matrix Rain' },
  { id: 'none', label: '⬛ None' },
];

// ── Audio ─────────────────────────────────────────────────────────────────────
let _audioCtx = null;
function getCtx() {
  if (!_audioCtx) try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(_) {}
  return _audioCtx;
}
function playTone(freq, type = 'sine', dur = 0.3, vol = 0.25) {
  try {
    const ctx = getCtx(); if (!ctx) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = freq; o.type = type;
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.start(); o.stop(ctx.currentTime + dur);
  } catch(_) {}
}
const playSent   = (v = 0.2) => playTone(660, 'sine', 0.15, v);
const playRecv   = (v = 0.3) => playTone(880, 'sine', 0.4, v);
const playDelete = (v = 0.2) => playTone(220, 'sawtooth', 0.2, v);

// ── Utility ───────────────────────────────────────────────────────────────────
function isOnline(lastSeen) {
  if (!lastSeen) return false;
  return Date.now() - new Date(lastSeen).getTime() < 60000;
}
function formatTime(ts) { return ts ? ts.substring(0, 5) : ''; }
function avatarColor(name) {
  const colors = ['#5288c1','#e84393','#f4a261','#2ec4b6','#9b5de5','#f15bb5','#00bbf9','#00f5d4'];
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % colors.length;
  return colors[h];
}
function ab2b64(ab) { return btoa(String.fromCharCode(...new Uint8Array(ab))); }
function b642ab(b64) { return Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer; }

// ── Markdown Renderer ─────────────────────────────────────────────────────────
function processInline(text, base = 0) {
  const parts = []; let rem = text, k = base;
  while (rem.length) {
    const boldM = rem.match(/\*\*(.+?)\*\*/);
    const italM = rem.match(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/);
    const codeM = rem.match(/`(.+?)`/);
    const candidates = [boldM && {i: boldM.index, m: boldM, t: 'b'}, italM && {i: italM.index, m: italM, t: 'i'}, codeM && {i: codeM.index, m: codeM, t: 'c'}].filter(Boolean).sort((a,b) => a.i - b.i);
    if (!candidates.length) { parts.push(rem); break; }
    const {i, m, t} = candidates[0];
    if (i > 0) parts.push(rem.slice(0, i));
    if (t === 'b') parts.push(<strong key={k++}>{m[1]}</strong>);
    else if (t === 'i') parts.push(<em key={k++}>{m[1]}</em>);
    else if (t === 'c') parts.push(<code key={k++} className="md-code">{m[1]}</code>);
    rem = rem.slice(i + m[0].length);
  }
  return parts;
}

function MarkdownText({ text }) {
  if (!text) return null;
  return (
    <div className="md-content">
      {text.split('\n').map((line, i) => {
        if (line.startsWith('### ')) return <h4 key={i} className="md-h">{line.slice(4)}</h4>;
        if (line.startsWith('## '))  return <h3 key={i} className="md-h">{line.slice(3)}</h3>;
        if (line.startsWith('# '))   return <h2 key={i} className="md-h">{line.slice(2)}</h2>;
        if (line.startsWith('- ') || line.startsWith('* ')) return <div key={i} className="md-li">• <span>{processInline(line.slice(2), i*100)}</span></div>;
        if (line.startsWith('> ')) return <blockquote key={i} className="md-blockquote">{processInline(line.slice(2), i*100)}</blockquote>;
        if (line.trim() === '') return <div key={i} style={{height: 6}} />;
        return <div key={i} className="md-line">{processInline(line, i * 100)}</div>;
      })}
    </div>
  );
}

// ── WebAuthn ──────────────────────────────────────────────────────────────────
function webAuthnAvailable() { return typeof window !== 'undefined' && !!window.PublicKeyCredential; }
function hasCred(cs) { return !!localStorage.getItem(`sdcms_cred_${cs.toUpperCase()}`); }

async function registerBiometric(cs) {
  const uid = new Uint8Array(16);
  window.crypto.getRandomValues(uid);
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: window.crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'SDCMS', id: window.location.hostname },
      user: { id: uid, name: cs, displayName: `SDCMS:${cs}` },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
      timeout: 60000
    }
  });
  localStorage.setItem(`sdcms_cred_${cs.toUpperCase()}`, ab2b64(cred.rawId));
  return true;
}

async function authenticateBiometric(cs) {
  const b64 = localStorage.getItem(`sdcms_cred_${cs.toUpperCase()}`);
  if (!b64) throw new Error('No biometric credential registered for this callsign');
  await navigator.credentials.get({
    publicKey: {
      challenge: window.crypto.getRandomValues(new Uint8Array(32)),
      rpId: window.location.hostname,
      allowCredentials: [{ type: 'public-key', id: new Uint8Array(b642ab(b64)) }],
      userVerification: 'required',
      timeout: 60000
    }
  });
  return true;
}

// ── Canvas Background ─────────────────────────────────────────────────────────
function CanvasBg({ mode }) {
  const cvRef = useRef(null);
  const animRef = useRef(null);
  const mouseRef = useRef({ x: -9999, y: -9999 });

  useEffect(() => {
    if (mode === 'none') return;
    const canvas = cvRef.current; if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resize();
    window.addEventListener('resize', resize);
    const onMouse = (e) => { mouseRef.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener('mousemove', onMouse);

    if (mode === 'particles') {
      const particles = Array.from({ length: 70 }, () => ({
        x: Math.random() * window.innerWidth, y: Math.random() * window.innerHeight,
        vx: (Math.random() - 0.5) * 0.5, vy: (Math.random() - 0.5) * 0.5,
        r: Math.random() * 1.8 + 0.4, op: Math.random() * 0.35 + 0.05
      }));
      const animate = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const { x: mx, y: my } = mouseRef.current;
        particles.forEach(p => {
          const dx = mx - p.x, dy = my - p.y, d = Math.sqrt(dx*dx + dy*dy);
          if (d < 180) { p.vx += dx / d * 0.015; p.vy += dy / d * 0.015; }
          const sp = Math.sqrt(p.vx*p.vx + p.vy*p.vy);
          if (sp > 1.8) { p.vx = p.vx/sp*1.8; p.vy = p.vy/sp*1.8; }
          p.x += p.vx; p.y += p.vy;
          if (p.x < 0) p.x = canvas.width; if (p.x > canvas.width) p.x = 0;
          if (p.y < 0) p.y = canvas.height; if (p.y > canvas.height) p.y = 0;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
          ctx.fillStyle = `rgba(82,136,193,${p.op})`; ctx.fill();
        });
        for (let i = 0; i < particles.length; i++)
          for (let j = i+1; j < particles.length; j++) {
            const dx = particles[i].x - particles[j].x, dy = particles[i].y - particles[j].y;
            const dist = Math.sqrt(dx*dx + dy*dy);
            if (dist < 110) {
              ctx.beginPath(); ctx.moveTo(particles[i].x, particles[i].y); ctx.lineTo(particles[j].x, particles[j].y);
              ctx.strokeStyle = `rgba(82,136,193,${0.12*(1-dist/110)})`; ctx.lineWidth = 0.6; ctx.stroke();
            }
          }
        animRef.current = requestAnimationFrame(animate);
      };
      animate();
    } else if (mode === 'matrix-rain') {
      const chars = 'SDCMS01アイウエオカキクケコサシスセソタチツテト0123456789';
      const fs = 13, cols = Math.floor(canvas.width / fs);
      const drops = Array(cols).fill(1);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const animate = () => {
        ctx.fillStyle = 'rgba(0,0,0,0.05)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#00cc33'; ctx.font = `${fs}px monospace`;
        drops.forEach((y, i) => {
          ctx.fillText(chars[Math.floor(Math.random()*chars.length)], i*fs, y*fs);
          if (y*fs > canvas.height && Math.random() > 0.975) drops[i] = 0;
          drops[i]++;
        });
        animRef.current = requestAnimationFrame(animate);
      };
      animate();
    }
    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMouse);
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [mode]);

  if (mode === 'none') return null;
  return <canvas ref={cvRef} className="canvas-bg" />;
}

// ── App Root ──────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState('login');
  const [callsign, setCallsign] = useState('');
  const [keys, setKeys] = useState(null);
  const [userStatus, setUserStatus] = useState('Active');
  const [theme, setTheme] = useState(() => localStorage.getItem('sdcms_theme') || 'dark-navy');
  const [canvasMode, setCanvasMode] = useState(() => localStorage.getItem('sdcms_canvas') || 'particles');
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [accountExpiresAt, setAccountExpiresAt] = useState('');
  const inactivityRef = useRef(null);

  useEffect(() => {
    if (localStorage.getItem('sdcms_session')) {
      setScreen('session-recovery');
    }
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('sdcms_theme', theme);
  }, [theme]);

  useEffect(() => { localStorage.setItem('sdcms_canvas', canvasMode); }, [canvasMode]);

  // Inactivity lock (only when logged in + biometric enabled)
  useEffect(() => {
    if (screen !== 'app' || !biometricEnabled) return;
    const reset = () => {
      clearTimeout(inactivityRef.current);
      inactivityRef.current = setTimeout(() => setScreen('locked'), INACTIVITY_MS);
    };
    const evts = ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'];
    evts.forEach(e => window.addEventListener(e, reset));
    reset();
    return () => { evts.forEach(e => window.removeEventListener(e, reset)); clearTimeout(inactivityRef.current); };
  }, [screen, biometricEnabled]);

  const handleLogin = async (cs, pw, st, registerBio, lifespan) => {
    // Duress code check — silently burn
    if (pw.trim() === DURESS_CODE) {
      try { await fetch(`${API}/burn`, { method: 'POST', body: JSON.stringify({ callsign: cs }) }); } catch(_) {}
      setScreen('burned'); return;
    }
    
    let exp = "";
    if (lifespan) {
      exp = new Date(Date.now() + parseInt(lifespan) * 1000).toISOString();
    }
    
    const kp = await generateRSAKeyPair();
    const pub = await exportPublicKey(kp.publicKey);
    await fetch(`${API}/users`, {
      method: 'POST',
      body: JSON.stringify({ callsign: cs, role: 'Operator', clearance: 'TOP SECRET', publicKey: pub, statusMsg: st || 'Active', expiresAt: exp })
    });
    
    await saveSession(cs, kp, pw, exp);
    
    setCallsign(cs); setKeys(kp); setUserStatus(st || 'Active'); setAccountExpiresAt(exp);
    if (registerBio && webAuthnAvailable()) {
      try { await registerBiometric(cs); setBiometricEnabled(true); } catch(_) {}
    } else if (hasCred(cs)) {
      setBiometricEnabled(true);
    }
    setScreen('app');
  };

  const handleBiometricLogin = async (cs) => {
    await authenticateBiometric(cs);
    const kp = await generateRSAKeyPair();
    const pub = await exportPublicKey(kp.publicKey);
    await fetch(`${API}/users`, {
      method: 'POST',
      body: JSON.stringify({ callsign: cs, role: 'Operator', clearance: 'TOP SECRET', publicKey: pub, statusMsg: 'Active' })
    });
    setCallsign(cs); setKeys(kp); setUserStatus('Active'); setBiometricEnabled(true); setScreen('app');
  };

  const handleLogout = useCallback(async () => {
    setScreen('burned'); setKeys(null); clearSession();
    const cs = callsign;
    try { navigator.sendBeacon(`${API}/burn`, new Blob([JSON.stringify({ callsign: cs })], { type: 'application/json' })); } catch(_) {}
  }, [callsign]);

  const handleRecover = async (pw) => {
    if (pw.trim() === DURESS_CODE) { handleLogout(); return; }
    try {
      const session = await loadSession(pw);
      // Re-register heartbeat
      const pub = await exportPublicKey(session.keys.publicKey);
      await fetch(`${API}/users`, {
        method: 'POST',
        body: JSON.stringify({ callsign: session.callsign, role: 'Operator', clearance: 'TOP SECRET', publicKey: pub, statusMsg: 'Active', expiresAt: session.expiresAt })
      });
      setCallsign(session.callsign);
      setKeys(session.keys);
      setAccountExpiresAt(session.expiresAt);
      if (hasCred(session.callsign)) setBiometricEnabled(true);
      setScreen('app');
    } catch (e) {
      throw new Error(e.message);
    }
  };

  const handleUnlock = async () => {
    await authenticateBiometric(callsign);
    setScreen('app');
  };

  // Removing beforeunload so session survives refresh
  // but if they actively logout, it burns.

  return (
    <>
      <CanvasBg mode={screen === 'app' ? canvasMode : 'none'} />
      {screen === 'burned' && <BurnScreen />}
      {screen === 'locked' && <BiometricLock callsign={callsign} onUnlock={handleUnlock} onBurn={handleLogout} />}
      {screen === 'session-recovery' && <SessionRecoveryScreen onRecover={handleRecover} onBurn={handleLogout} />}
      {screen === 'login' && <LoginPage onLogin={handleLogin} onBiometricLogin={handleBiometricLogin} />}
      {screen === 'app' && (
        <Dashboard
          callsign={callsign} keys={keys} onLogout={handleLogout}
          userStatus={userStatus} theme={theme} setTheme={setTheme}
          canvasMode={canvasMode} setCanvasMode={setCanvasMode}
          biometricEnabled={biometricEnabled} setBiometricEnabled={setBiometricEnabled}
          accountExpiresAt={accountExpiresAt}
        />
      )}
    </>
  );
}

// ── Burn Screen ───────────────────────────────────────────────────────────────
function BurnScreen() {
  return (
    <div className="burn-screen">
      <ShieldAlert size={80} className="burn-icon" />
      <div className="glitch">SYSTEM PURGED.</div>
      <p className="burn-sub">NO TRACE REMAINS. ALL KEYS DESTROYED.</p>
    </div>
  );
}

// ── Biometric Lock Screen ─────────────────────────────────────────────────────
function BiometricLock({ callsign, onUnlock, onBurn }) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [attempts, setAttempts] = useState(0);

  const tryUnlock = async () => {
    if (attempts >= 3) { onBurn(); return; }
    setLoading(true); setErr('');
    try { await onUnlock(); }
    catch(e) {
      const a = attempts + 1;
      setAttempts(a);
      setErr(a >= 3 ? 'Too many failed attempts — session will be destroyed' : `Authentication failed. ${3 - a} attempt${3 - a > 1 ? 's' : ''} remaining.`);
    }
    finally { setLoading(false); }
  };

  return (
    <div className="bio-lock-screen">
      <div className="bio-lock-card">
        <div className="bio-lock-avatar" style={{ background: avatarColor(callsign) }}>
          {callsign[0]}
          <div className="bio-lock-ring" />
        </div>
        <h2 className="bio-lock-name">{callsign}</h2>
        <p className="bio-lock-sub">Session locked due to inactivity</p>
        <div className="bio-lock-icon-wrap">
          <Fingerprint size={56} className="bio-fingerprint-icon" />
        </div>
        <button className="bio-unlock-btn" onClick={tryUnlock} disabled={loading || attempts >= 3}>
          {loading ? <span className="spinner" /> : <Fingerprint size={20} />}
          {loading ? 'Authenticating...' : attempts >= 3 ? 'Session Compromised' : 'Unlock with Biometric'}
        </button>
        {err && <p className="bio-lock-error">{err}</p>}
        <button className="bio-burn-link" onClick={onBurn}>
          <Zap size={12} /> Burn Session Instead
        </button>
      </div>
    </div>
  );
}

// ── Session Recovery Screen ───────────────────────────────────────────────────
function SessionRecoveryScreen({ onRecover, onBurn }) {
  const [pw, setPw] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [showPw, setShowPw] = useState(false);

  const submit = async () => {
    if (!pw.trim()) return;
    setLoading(true); setErr('');
    try { await onRecover(pw); }
    catch(e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div className="login-bg">
      <div className="login-noise" />
      <div className="login-card" style={{ textAlign: 'center' }}>
        <div className="login-logo" style={{ background: '#3b82f6' }}><Lock size={40} color="#fff" /></div>
        <h1 className="login-title">Session Recovered</h1>
        <p className="login-subtitle">Enter passcode to decrypt session</p>

        <div className="login-fields" style={{ marginTop: 24 }}>
          <div className="login-field">
            <Lock size={18} className="login-field-icon" />
            <input type={showPw ? 'text' : 'password'} placeholder="Passcode" value={pw}
              onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} autoFocus />
            <button className="pw-toggle" onClick={() => setShowPw(s => !s)} tabIndex={-1}>
              {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>

        {err && <div className="login-error">{err}</div>}

        <button className="login-btn" onClick={submit} disabled={loading} style={{ marginTop: 20 }}>
          {loading ? <span className="spinner" /> : 'Unlock Session'}
        </button>

        <button className="bio-burn-link" onClick={onBurn} style={{ marginTop: 20 }}>
          <Zap size={12} /> Burn Local Session
        </button>
      </div>
    </div>
  );
}

// ── Login Page ────────────────────────────────────────────────────────────────
function LoginPage({ onLogin, onBiometricLogin }) {
  const [cs, setCs] = useState('');
  const [pw, setPw] = useState('');
  const [st, setSt] = useState('Active');
  const [loading, setLoading] = useState(false);
  const [bioLoading, setBioLoading] = useState(false);
  const [err, setErr] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [registerBio, setRegisterBio] = useState(false);
  const [lifespan, setLifespan] = useState('');
  const hasExistingCred = cs.length > 1 && hasCred(cs.toUpperCase());
  const waAvail = webAuthnAvailable();

  const submit = async () => {
    if (!cs.trim() || !pw.trim()) return;
    setLoading(true); setErr('');
    try { await onLogin(cs.toUpperCase(), pw, st, registerBio, lifespan); }
    catch(e) { setErr(e.message || 'Login failed'); }
    finally { setLoading(false); }
  };

  const bioLogin = async () => {
    if (!cs.trim()) { setErr('Enter your callsign first'); return; }
    setBioLoading(true); setErr('');
    try { await onBiometricLogin(cs.toUpperCase()); }
    catch(e) { setErr(e.message || 'Biometric authentication failed'); }
    finally { setBioLoading(false); }
  };

  return (
    <div className="login-bg">
      <div className="login-noise" />
      <div className="login-card">
        <div className="login-logo"><Shield size={40} color="#fff" /></div>
        <h1 className="login-title">SDCMS</h1>
        <p className="login-subtitle">Secure Defense Communication</p>

        <div className="login-fields">
          <div className="login-field">
            <User size={18} className="login-field-icon" />
            <input placeholder="Enter Callsign" value={cs}
              onChange={e => setCs(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && submit()} maxLength={20} autoFocus />
          </div>
          <div className="login-field">
            <Lock size={18} className="login-field-icon" />
            <input type={showPw ? 'text' : 'password'} placeholder="Passcode" value={pw}
              onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
            <button className="pw-toggle" onClick={() => setShowPw(s => !s)} tabIndex={-1}>
              {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          <div className="login-field">
            <MessageSquare size={18} className="login-field-icon" />
            <select value={st} onChange={e => setSt(e.target.value)}>
              {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="login-field">
            <Clock size={18} className="login-field-icon" />
            <select value={lifespan} onChange={e => setLifespan(e.target.value)}>
              {TIMER_OPTIONS.map(o => <option key={o.label} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>

        {err && <div className="login-error">{err}</div>}

        {/* Biometric options */}
        {waAvail && cs.length > 1 && (
          <div className="bio-login-section">
            {hasExistingCred ? (
              <button className="bio-login-btn" onClick={bioLogin} disabled={bioLoading}>
                <Fingerprint size={18} />
                {bioLoading ? 'Authenticating...' : 'Login with Fingerprint / Face ID'}
              </button>
            ) : (
              <label className="bio-register-check">
                <input type="checkbox" checked={registerBio} onChange={e => setRegisterBio(e.target.checked)} />
                <Fingerprint size={15} />
                Register biometric after login
              </label>
            )}
          </div>
        )}

        <button className="login-btn" onClick={submit} disabled={!cs.trim() || !pw.trim() || loading}>
          {loading ? <span className="spinner" /> : 'START SECURE SESSION'}
        </button>

        <p className="login-disclaimer">🔒 E2EE · RSA-OAEP 2048 + AES-GCM 256 · Auto-purge on exit</p>
        <p className="login-disclaimer" style={{ color: pw === DURESS_CODE ? 'var(--danger)' : 'transparent', fontSize: '0.7rem', marginTop: 2 }}>
          ⚠ Duress code detected
        </p>
      </div>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function Dashboard({ callsign, keys, onLogout, userStatus, theme, setTheme, canvasMode, setCanvasMode, biometricEnabled, setBiometricEnabled, accountExpiresAt }) {
  const [messages, setMessages]       = useState([]);
  const [users, setUsers]             = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeChat, setActiveChat]   = useState(null);
  const [composeBody, setComposeBody] = useState('');
  const [isTyping, setIsTyping]       = useState(false);
  const [replyTo, setReplyTo]         = useState(null);
  const [timerSec, setTimerSec]       = useState('');
  const [showEmoji, setShowEmoji]     = useState(false);
  const [showTimerMenu, setShowTimerMenu] = useState(false);
  const [showSearch, setShowSearch]   = useState(false);
  const [msgSearch, setMsgSearch]     = useState('');
  const [unreadMap, setUnreadMap]     = useState({});
  const [soundOn, setSoundOn]         = useState(true);
  const [volume, setVolume]           = useState(0.3);
  const [showProfile, setShowProfile] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSteg, setShowSteg]       = useState(false);
  const [myStatus, setMyStatus]       = useState(userStatus);
  const [notification, setNotification] = useState(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [latency, setLatency]         = useState(null);
  const [rtcStates, setRtcStates]     = useState({});
  const [isRecording, setIsRecording] = useState(false);
  const [sidebarTab, setSidebarTab]   = useState('active');
  const [partnerTyping, setPartnerTyping] = useState(false);
  const [pinnedMap, setPinnedMap]     = useState({});
  const [archivedChats, setArchivedChats] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('sdcms_archived') || '[]')); } catch(_) { return new Set(); }
  });

  const sentCache       = useRef(new Map());
  const prevMsgIds      = useRef(new Set());
  const messagesEndRef  = useRef(null);
  const messagesListRef = useRef(null);
  const typingTimerRef  = useRef(null);
  const heartbeatRef    = useRef(null);
  const textareaRef     = useRef(null);
  const fileInputRef    = useRef(null);
  const mediaRecRef     = useRef(null);
  const audioChunks     = useRef([]);
  const origTitle       = useRef(document.title);
  const origFavicon     = useRef(null);

  // Persist archive
  useEffect(() => { localStorage.setItem('sdcms_archived', JSON.stringify([...archivedChats])); }, [archivedChats]);

  // Load pins for active chat
  useEffect(() => {
    if (!activeChat) return;
    const key = `sdcms_pin_${callsign}_${activeChat.callsign}`;
    try { setPinnedMap(p => ({ ...p, [activeChat.callsign]: JSON.parse(localStorage.getItem(key) || '[]') })); } catch(_) {}
  }, [activeChat, callsign]);

  // ── Tab Decoy ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        origTitle.current = document.title;
        document.title = 'Untitled Document - Google Docs';
        let fav = document.querySelector("link[rel*='icon']");
        if (!fav) { fav = document.createElement('link'); fav.rel = 'icon'; document.head.appendChild(fav); }
        origFavicon.current = fav.href;
        fav.href = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><rect width='24' height='24' fill='%234285f4' rx='3'/><rect x='6' y='7' width='12' height='1.5' fill='white' rx='1'/><rect x='6' y='11' width='9' height='1.5' fill='white' rx='1'/><rect x='6' y='15' width='10' height='1.5' fill='white' rx='1'/></svg>";
      } else {
        document.title = origTitle.current;
        const fav = document.querySelector("link[rel*='icon']");
        if (fav && origFavicon.current) fav.href = origFavicon.current;
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // ── Account Expiration Timer ──────────────────────────────────────────────
  const [timeLeftStr, setTimeLeftStr] = useState('');

  useEffect(() => {
    if (!accountExpiresAt) return;
    const expDate = new Date(accountExpiresAt).getTime();
    
    const interval = setInterval(() => {
      const now = Date.now();
      const diff = expDate - now;
      if (diff <= 0) {
        clearInterval(interval);
        onLogout();
      } else {
        const totalSecs = Math.floor(diff / 1000);
        const m = Math.floor(totalSecs / 60);
        const s = totalSecs % 60;
        setTimeLeftStr(`${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [accountExpiresAt, onLogout]);

  // ── Data Fetching ─────────────────────────────────────────────────────────
  const fetchMessages = useCallback(async () => {
    try {
      const [ri, rs] = await Promise.all([
        fetch(`${API}/messages/inbox?callsign=${callsign}`),
        fetch(`${API}/messages/sent?callsign=${callsign}`)
      ]);
      const [inbox, sent] = await Promise.all([ri.json(), rs.json()]);
      const all = [...inbox, ...sent].sort((a, b) => a.id - b.id);
      const newIds = new Set(all.map(m => m.id));
      for (const m of all) {
        if (!prevMsgIds.current.has(m.id) && m.dir === 'inbox') {
          if (soundOn) playRecv(volume);
          if (m.from !== activeChat?.callsign) setUnreadMap(p => ({ ...p, [m.from]: (p[m.from] || 0) + 1 }));
          setNotification({ from: m.from, time: m.time });
          setTimeout(() => setNotification(null), 4000);
          // Browser notification
          if (Notification.permission === 'granted') {
            new Notification(`SDCMS: ${m.from}`, { body: 'New encrypted message', icon: '/favicon.ico', silent: false });
          }
        }
      }
      prevMsgIds.current = newIds;
      setMessages(all);
    } catch(_) {}
  }, [callsign, soundOn, activeChat, volume]);

  const fetchUsers = useCallback(async () => {
    try {
      const url = searchQuery ? `${API}/users/search?q=${encodeURIComponent(searchQuery)}` : `${API}/users`;
      const data = await (await fetch(url)).json();
      setUsers(data.filter(u => u.callsign !== callsign));
    } catch(_) {}
  }, [callsign, searchQuery]);

  const fetchTyping = useCallback(async () => {
    if (!activeChat) return;
    try {
      const res = await fetch(`${API}/typing?callsign=${callsign}&with=${activeChat.callsign}`);
      const data = await res.json();
      setPartnerTyping(data.typing);
    } catch(_) {}
  }, [callsign, activeChat]);

  useEffect(() => {
    fetchMessages(); fetchUsers();
    const iv = setInterval(() => { fetchMessages(); fetchUsers(); fetchTyping(); }, 3000);
    return () => clearInterval(iv);
  }, [fetchMessages, fetchUsers, fetchTyping]);

  // Heartbeat
  useEffect(() => {
    const beat = async () => {
      try { await fetch(`${API}/heartbeat`, { method: 'POST', body: JSON.stringify({ callsign, statusMsg: myStatus }) }); } catch(_) {}
    };
    beat();
    heartbeatRef.current = setInterval(beat, 20000);
    return () => clearInterval(heartbeatRef.current);
  }, [callsign, myStatus]);

  // ── Latency Monitor ───────────────────────────────────────────────────────
  useEffect(() => {
    const ping = async () => {
      try { const t0 = Date.now(); await fetch(`${API}/ping`); setLatency(Date.now() - t0); }
      catch(_) { setLatency(null); }
    };
    ping();
    const iv = setInterval(ping, 5000);
    return () => clearInterval(iv);
  }, []);

  // ── WebRTC Signal Polling ─────────────────────────────────────────────────
  useEffect(() => {
    const poll = async () => {
      const signals = await pollSignals(callsign);
      for (const sig of signals) {
        const { from, data } = sig;
        if (!data) continue;
        if (data.type === 'offer') {
          try {
            await answerWebRTC(callsign, from, data,
              () => {},
              (state) => setRtcStates(p => ({ ...p, [from]: state }))
            );
          } catch(_) {}
        } else if (data.type === 'answer') {
          await handleAnswer(from, data);
        } else if (data.type === 'ice') {
          await handleIceCandidate(from, data.candidate);
        }
      }
    };
    const iv = setInterval(poll, 2000);
    return () => clearInterval(iv);
  }, [callsign]);

  // Clear unread on open chat
  useEffect(() => {
    if (activeChat) {
      setUnreadMap(p => { const n = {...p}; delete n[activeChat.callsign]; return n; });
      messages.filter(m => m.dir === 'inbox' && m.from === activeChat.callsign && !m.isRead)
        .forEach(m => fetch(`${API}/messages/${m.id}/read`, { method: 'PUT' }).catch(() => {}));
    }
  }, [activeChat]);

  // Auto-scroll
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, activeChat]);

  // Keyboard shortcuts
  useEffect(() => {
    const h = (e) => {
      if (e.ctrlKey && e.key === 'f') { e.preventDefault(); setShowSearch(s => !s); }
      if (e.key === 'Escape') { setShowSearch(false); setShowEmoji(false); setReplyTo(null); setShowProfile(false); setShowSettings(false); setShowSteg(false); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // Request desktop notification permission
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  const handleScroll = () => {
    const el = messagesListRef.current; if (!el) return;
    setShowScrollBtn(el.scrollHeight - el.scrollTop - el.clientHeight > 200);
  };

  // ── Typing ────────────────────────────────────────────────────────────────
  const reportTyping = useCallback(async (typing) => {
    if (!activeChat) return;
    try { await fetch(`${API}/typing`, { method: 'POST', body: JSON.stringify({ callsign, receiver: activeChat.callsign, typing }) }); } catch(_) {}
  }, [callsign, activeChat]);

  const handleComposeChange = (e) => {
    setComposeBody(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 150) + 'px';
    if (!isTyping) { setIsTyping(true); reportTyping(true); }
    clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => { setIsTyping(false); reportTyping(false); }, 3000);
  };

  // ── Send ──────────────────────────────────────────────────────────────────
  const sendEncryptedMsg = async (body) => {
    if (!activeChat) return;
    const aesKey = await generateAESKey();
    const encBody = await encryptTextAES(body, aesKey);
    if (!body.startsWith('VOICE:') && !body.startsWith('FILE:')) sentCache.current.set(encBody, body);
    const recipPub = await importPublicKey(activeChat.publicKey);
    const encAes = await encryptAESKeyWithRSA(aesKey, recipPub);
    let expiresAt = '';
    if (timerSec) expiresAt = new Date(Date.now() + timerSec * 1000).toISOString();
    await fetch(`${API}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        sender: callsign, receiver: activeChat.callsign,
        subject: 'Message', classification: 'TOP SECRET',
        encryptedBody: encBody, encryptedAesKey: encAes,
        replyToId: replyTo?.id ?? -1, expiresAt
      })
    });
    fetchMessages();
  };

  const handleSend = async () => {
    if (!activeChat || !composeBody.trim()) return;
    try {
      await sendEncryptedMsg(composeBody);
      if (soundOn) playSent(volume);
    } catch(e) { console.error('Send failed:', e); }
    setComposeBody(''); setReplyTo(null); setIsTyping(false); reportTyping(false);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  // ── Voice Note ────────────────────────────────────────────────────────────
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks.current = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = e => audioChunks.current.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(audioChunks.current, { type: 'audio/webm' });
        const b64 = ab2b64(await blob.arrayBuffer());
        await sendEncryptedMsg(`VOICE:${b64}`);
      };
      mr.start();
      mediaRecRef.current = mr;
      setIsRecording(true);
    } catch(_) { alert('Microphone access denied'); }
  };

  const stopRecording = () => {
    if (mediaRecRef.current?.state === 'recording') mediaRecRef.current.stop();
    setIsRecording(false);
  };

  // ── File Share ────────────────────────────────────────────────────────────
  const handleFileSelect = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (file.size > 5 * 1024 * 1024) { alert('File too large. Max 5MB.'); return; }
    const b64 = ab2b64(await file.arrayBuffer());
    await sendEncryptedMsg(`FILE:${file.name}:${file.type}:${b64}`);
    e.target.value = '';
  };

  // ── React/Delete/Pin ──────────────────────────────────────────────────────
  const handleReact = async (msgId, emoji) => {
    try { await fetch(`${API}/messages/${msgId}/react`, { method: 'POST', body: JSON.stringify({ callsign, emoji }) }); fetchMessages(); } catch(_) {}
  };

  const handleDelete = async (msgId) => {
    try { await fetch(`${API}/messages/${msgId}`, { method: 'DELETE' }); if (soundOn) playDelete(volume); fetchMessages(); } catch(_) {}
  };

  const handlePin = (msgId) => {
    if (!activeChat) return;
    const key = `sdcms_pin_${callsign}_${activeChat.callsign}`;
    setPinnedMap(prev => {
      const cur = prev[activeChat.callsign] || [];
      const upd = cur.includes(msgId) ? cur.filter(id => id !== msgId) : [...cur, msgId].slice(-3);
      localStorage.setItem(key, JSON.stringify(upd));
      return { ...prev, [activeChat.callsign]: upd };
    });
  };

  const toggleArchive = (cs) => {
    setArchivedChats(prev => {
      const next = new Set(prev);
      if (next.has(cs)) next.delete(cs);
      else { next.add(cs); if (activeChat?.callsign === cs) setActiveChat(null); }
      return next;
    });
  };

  // ── Backup Export/Import ──────────────────────────────────────────────────
  const handleExport = async (password) => {
    const chatData = {};
    for (const [k, v] of sentCache.current.entries()) chatData[k] = v;
    const payload = JSON.stringify({ messages: chatData, callsign, exportedAt: new Date().toISOString() });
    const enc = new TextEncoder();
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const km = await window.crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    const aesKey = await window.crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
    );
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(payload));
    const combined = new Uint8Array(16 + 12 + encrypted.byteLength);
    combined.set(salt, 0); combined.set(iv, 16); combined.set(new Uint8Array(encrypted), 28);
    const blob = new Blob([combined], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `sdcms_${callsign}.sdcms`; a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = async (file, password) => {
    const data = new Uint8Array(await file.arrayBuffer());
    const salt = data.slice(0, 16), iv = data.slice(16, 28), enc_data = data.slice(28);
    try {
      const textEnc = new TextEncoder();
      const km = await window.crypto.subtle.importKey('raw', textEnc.encode(password), 'PBKDF2', false, ['deriveKey']);
      const aesKey = await window.crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
        km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
      );
      const dec = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, enc_data);
      const payload = JSON.parse(new TextDecoder().decode(dec));
      for (const [k, v] of Object.entries(payload.messages || {})) sentCache.current.set(k, v);
      return true;
    } catch(_) { return false; }
  };

  // ── Computed ──────────────────────────────────────────────────────────────
  const chatMessages = messages.filter(m => m.from === activeChat?.callsign || m.to === activeChat?.callsign);
  const totalUnread  = Object.values(unreadMap).reduce((a, b) => a + b, 0);
  const pinnedIds    = activeChat ? (pinnedMap[activeChat.callsign] || []) : [];
  const pinnedMsgs   = chatMessages.filter(m => pinnedIds.includes(m.id));
  const activeUsers  = users.filter(u => !archivedChats.has(u.callsign));
  const archivedUsers = users.filter(u => archivedChats.has(u.callsign));
  const showUsers    = sidebarTab === 'active' ? activeUsers : archivedUsers;

  useEffect(() => {
    const t = totalUnread > 0 ? `(${totalUnread}) SDCMS` : 'SDCMS';
    document.title = t; origTitle.current = t;
  }, [totalUnread]);

  return (
    <div className={`app ${activeChat ? 'chat-active' : ''}`}>

      {/* Toast */}
      {notification && (
        <div className="toast" onClick={() => setNotification(null)}>
          <div className="toast-avatar" style={{ background: avatarColor(notification.from) }}>{notification.from[0]}</div>
          <div><div className="toast-name">{notification.from}</div><div className="toast-msg">New encrypted message · {notification.time}</div></div>
          <X size={14} className="toast-close" />
        </div>
      )}

      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="my-profile" onClick={() => setShowProfile(true)}>
            <div className="avatar lg" style={{ background: avatarColor(callsign) }}>
              {callsign[0]}<span className="online-dot" />
            </div>
            <div className="profile-info">
              <div className="profile-name">
                {callsign}
                {timeLeftStr && <span className="timer-badge">⏱ {timeLeftStr}</span>}
              </div>
              <div className="profile-status">{myStatus}</div>
            </div>
            <div className="sidebar-actions">
              <button className="icon-btn" title={soundOn ? 'Mute' : 'Unmute'} onClick={e => { e.stopPropagation(); setSoundOn(s => !s); }}>
                {soundOn ? <Bell size={16} /> : <BellOff size={16} />}
              </button>
              <button className="icon-btn" title="Settings" onClick={e => { e.stopPropagation(); setShowSettings(true); }}>
                <Settings size={16} />
              </button>
              <button className="icon-btn danger" title="Burn Session" onClick={e => { e.stopPropagation(); onLogout(); }}>
                <LogOut size={16} />
              </button>
            </div>
          </div>

          <div className="search-bar">
            <Search size={15} className="search-icon" />
            <input placeholder="Search by callsign..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
            {searchQuery && <X size={14} className="search-clear" onClick={() => setSearchQuery('')} />}
          </div>

          <div className="sidebar-tabs">
            <button className={`sidebar-tab ${sidebarTab === 'active' ? 'active' : ''}`} onClick={() => setSidebarTab('active')}>
              Active {totalUnread > 0 && <span className="badge sm">{totalUnread}</span>}
            </button>
            <button className={`sidebar-tab ${sidebarTab === 'archived' ? 'active' : ''}`} onClick={() => setSidebarTab('archived')}>
              <Archive size={13} /> Archived {archivedUsers.length > 0 && <span className="badge sm">{archivedUsers.length}</span>}
            </button>
          </div>
        </div>

        <div className="contact-list">
          {showUsers.length === 0 && (
            <div className="empty-list">
              {sidebarTab === 'archived' ? <><Archive size={32} /><p>No archived chats</p></> : <><Search size={32} /><p>No contacts online</p><p style={{fontSize:'0.75rem',color:'var(--text3)'}}>Right-click to archive</p></>}
            </div>
          )}
          {showUsers.map(u => {
            const online = isOnline(u.lastSeen);
            const unread = unreadMap[u.callsign] || 0;
            const lastMsg = [...messages].filter(m => m.from === u.callsign || m.to === u.callsign).pop();
            const rtcState = rtcStates[u.callsign];
            return (
              <div key={u.callsign}
                className={`contact-item ${activeChat?.callsign === u.callsign ? 'active' : ''}`}
                onClick={() => setActiveChat(u)}
                onContextMenu={e => { e.preventDefault(); toggleArchive(u.callsign); }}
                title="Right-click to archive / unarchive"
              >
                <div className="avatar md" style={{ background: avatarColor(u.callsign) }}>
                  {u.callsign[0]}{online && <span className="online-dot" />}
                </div>
                <div className="contact-info">
                  <div className="contact-row">
                    <span className="contact-name">{u.callsign}</span>
                    <div style={{ display:'flex', gap:4, alignItems:'center' }}>
                      {rtcState === 'connected' && <span className="rtc-badge">⚡P2P</span>}
                      {lastMsg && <span className="contact-time">{formatTime(lastMsg.time)}</span>}
                    </div>
                  </div>
                  <div className="contact-row">
                    <span className="contact-preview">{online ? '🟢 Online' : u.statusMsg || 'Offline'}</span>
                    {unread > 0 && <span className="badge">{unread}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="latency-bar">
          {latency !== null
            ? <span className={`latency-badge ${latency < 100 ? 'good' : latency < 300 ? 'warn' : 'bad'}`}><Activity size={11} />{latency}ms</span>
            : <span className="latency-badge bad"><WifiOff size={11} />Offline</span>
          }
        </div>
      </aside>

      {/* ── Chat Area ── */}
      <main className="chat-area">
        {activeChat ? (
          <>
            <div className="chat-header">
              <div className="chat-header-left">
                <button className="icon-btn mobile-back-btn" onClick={() => setActiveChat(null)}>
                  <ChevronLeft size={24} />
                </button>
                <div className="avatar md" style={{ background: avatarColor(activeChat.callsign) }}>
                  {activeChat.callsign[0]}{isOnline(activeChat.lastSeen) && <span className="online-dot" />}
                </div>
                <div>
                  <div className="chat-name">{activeChat.callsign}</div>
                  <div className="chat-sub">
                    {partnerTyping
                      ? <span className="typing-indicator">typing<span className="dots"><span/><span/><span/></span></span>
                      : isOnline(activeChat.lastSeen) ? '🟢 Online' : activeChat.statusMsg || 'Offline'
                    }
                  </div>
                </div>
              </div>
              <div className="chat-header-right">
                <button className="icon-btn" title="Search (Ctrl+F)" onClick={() => setShowSearch(s => !s)}><Search size={18} /></button>
                <button className="icon-btn danger" title="Burn Protocol" onClick={onLogout}><Zap size={18} /></button>
              </div>
            </div>

            {/* Pinned banner */}
            {pinnedMsgs.length > 0 && (
              <PinnedBanner msgs={pinnedMsgs} onUnpin={handlePin} />
            )}

            {/* Message search */}
            {showSearch && (
              <div className="msg-search-bar">
                <Search size={15} />
                <input autoFocus placeholder="Search messages..." value={msgSearch} onChange={e => setMsgSearch(e.target.value)} />
                <X size={15} onClick={() => { setShowSearch(false); setMsgSearch(''); }} />
              </div>
            )}

            {/* Messages */}
            <div className="messages" ref={messagesListRef} onScroll={handleScroll}>
              {chatMessages.length === 0 && (
                <div className="empty-chat">
                  <Shield size={48} opacity={0.3} />
                  <p>Start of secure E2EE conversation</p>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text3)' }}>Supports **markdown** formatting</p>
                </div>
              )}
              {chatMessages.map(m => (
                <MessageBubble
                  key={m.id} msg={m} isSent={m.dir === 'sent'}
                  sentCache={sentCache} privateKey={keys.privateKey}
                  replyMsg={m.replyToId >= 0 ? chatMessages.find(r => r.id === m.replyToId) : null}
                  msgSearch={msgSearch} callsign={callsign}
                  isPinned={pinnedIds.includes(m.id)}
                  onReply={() => setReplyTo(m)}
                  onReact={(emoji) => handleReact(m.id, emoji)}
                  onDelete={() => handleDelete(m.id)}
                  onPin={() => handlePin(m.id)}
                  onAutoDelete={() => handleDelete(m.id)}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>

            {showScrollBtn && (
              <button className="scroll-btn" onClick={() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })}>
                <ChevronDown size={20} />
                {totalUnread > 0 && <span className="badge sm">{totalUnread}</span>}
              </button>
            )}

            {replyTo && (
              <div className="reply-preview">
                <Reply size={14} />
                <div className="reply-preview-text">
                  <span className="reply-preview-from">Replying to {replyTo.from}</span>
                  <span className="reply-preview-body">[ encrypted ]</span>
                </div>
                <X size={14} onClick={() => setReplyTo(null)} />
              </div>
            )}

            {/* Compose */}
            <div className="compose">
              {showEmoji && (
                <div className="emoji-picker">
                  {EMOJI_LIST.map(e => (
                    <button key={e} className="emoji-btn"
                      onClick={() => { setComposeBody(b => b + e); setShowEmoji(false); textareaRef.current?.focus(); }}>
                      {e}
                    </button>
                  ))}
                </div>
              )}
              <div className="compose-inner">
                <button className="icon-btn" onClick={() => setShowEmoji(s => !s)} title="Emoji"><Smile size={20} /></button>
                <input type="file" ref={fileInputRef} style={{ display: 'none' }} onChange={handleFileSelect} />
                <button className="icon-btn" onClick={() => fileInputRef.current?.click()} title="Attach file (≤5MB)"><Paperclip size={20} /></button>
                <div className="compose-input-wrap">
                  <textarea ref={textareaRef} rows={1} placeholder="Message... (**bold**, *italic*, `code`)"
                    value={composeBody} onChange={handleComposeChange}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                  />
                </div>
                <button
                  className={`icon-btn ${isRecording ? 'recording-btn' : ''}`}
                  title="Hold to record voice note"
                  onMouseDown={startRecording} onMouseUp={stopRecording}
                  onTouchStart={startRecording} onTouchEnd={stopRecording}
                >
                  {isRecording ? <MicOff size={20} /> : <Mic size={20} />}
                </button>
                <div style={{ position: 'relative' }}>
                  <button className={`icon-btn ${timerSec ? 'active' : ''}`} title="Ephemeral timer" onClick={() => setShowTimerMenu(s => !s)}>
                    <Clock size={18} />
                  </button>
                  {showTimerMenu && (
                    <div className="timer-menu">
                      {TIMER_OPTIONS.map(t => (
                        <button key={t.label} className={`timer-option ${timerSec === t.value ? 'selected' : ''}`}
                          onClick={() => { setTimerSec(t.value); setShowTimerMenu(false); }}>
                          {t.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button className="send-btn" onClick={handleSend} disabled={!composeBody.trim()}><Send size={18} /></button>
              </div>
            </div>
          </>
        ) : (
          <div className="no-chat">
            <div className="no-chat-icon"><Shield size={72} /></div>
            <h2>SDCMS</h2>
            <p>Select a contact to start end-to-end encrypted messaging</p>
            <p className="no-chat-hint">🔒 RSA-OAEP 2048 + AES-GCM 256 · Ephemeral keys</p>
            <p className="no-chat-hint">📌 Hover messages to pin · Right-click contacts to archive</p>
            <p className="no-chat-hint">⚡ WebRTC P2P relay · 🎤 Voice notes · 📎 File sharing</p>
          </div>
        )}
      </main>

      {showProfile && (
        <ProfileModal callsign={callsign} status={myStatus}
          onStatusChange={s => setMyStatus(s)} onClose={() => setShowProfile(false)} onLogout={onLogout}
          biometricEnabled={biometricEnabled}
          onToggleBiometric={async () => {
            if (!biometricEnabled) {
              try { await registerBiometric(callsign); setBiometricEnabled(true); } catch(_) {}
            } else {
              localStorage.removeItem(`sdcms_cred_${callsign}`);
              setBiometricEnabled(false);
            }
          }}
        />
      )}

      {showSettings && (
        <SettingsDrawer
          theme={theme} setTheme={setTheme}
          canvasMode={canvasMode} setCanvasMode={setCanvasMode}
          volume={volume} setVolume={setVolume}
          soundOn={soundOn} setSoundOn={setSoundOn}
          onClose={() => setShowSettings(false)}
          onExport={handleExport} onImport={handleImport}
          onSteg={() => { setShowSettings(false); setShowSteg(true); }}
        />
      )}

      {showSteg && <SteganographyTool onClose={() => setShowSteg(false)} />}
    </div>
  );
}

// ── Pinned Banner ─────────────────────────────────────────────────────────────
function PinnedBanner({ msgs, onUnpin }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pinned-banner">
      <div className="pinned-banner-row" onClick={() => setOpen(o => !o)}>
        <Pin size={13} className="pinned-icon" />
        <span className="pinned-label">{msgs.length} pinned message{msgs.length > 1 ? 's' : ''}</span>
        <ChevronDown size={13} style={{ marginLeft: 'auto', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
      </div>
      {open && (
        <div className="pinned-expanded">
          {msgs.map(m => (
            <div key={m.id} className="pinned-item">
              <span className="pinned-from">{m.from}</span>
              <span className="pinned-body">[ encrypted · pinned message ]</span>
              <button className="icon-btn" onClick={() => onUnpin(m.id)} title="Unpin" style={{width:22,height:22}}><X size={11} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Typewriter Text ──────────────────────────────────────────────────────────
function TypewriterText({ text, hasMarkdown, isSent, highlight }) {
  const [displayed, setDisplayed] = useState(isSent ? text : '');

  useEffect(() => {
    if (isSent || text === '…' || text.startsWith('[') || text === '') {
      setDisplayed(text);
      return;
    }
    let i = 0;
    const t = setInterval(() => {
      i += 2; 
      setDisplayed(text.slice(0, Math.min(i, text.length)));
      if (i >= text.length) clearInterval(t);
    }, 10);
    return () => clearInterval(t);
  }, [text, isSent]);

  return hasMarkdown ? <MarkdownText text={displayed} /> : highlight(displayed);
}

// ── Message Bubble ────────────────────────────────────────────────────────────
function MessageBubble({ msg, isSent, sentCache, privateKey, replyMsg, msgSearch, callsign, isPinned, onReply, onReact, onDelete, onPin, onAutoDelete }) {
  const [text, setText]           = useState('…');
  const [msgType, setMsgType]     = useState('text');
  const [voiceUrl, setVoiceUrl]   = useState(null);
  const [fileData, setFileData]   = useState(null);
  const [showActions, setShowActions] = useState(false);
  const [showReact, setShowReact] = useState(false);
  const [copied, setCopied]       = useState(false);
  const [timeLeft, setTimeLeft]   = useState('');
  const [burnPct, setBurnPct]     = useState(100);
  const autoDeletedRef = useRef(false);
  const expiryTotalRef = useRef(null);

  useEffect(() => {
    let active = true;
    if (isSent && sentCache.current.has(msg.encryptedBody)) {
      const plain = sentCache.current.get(msg.encryptedBody);
      if (plain.startsWith('VOICE:')) { setMsgType('voice'); return; }
      if (plain.startsWith('FILE:')) {
        setMsgType('file');
        const [, name, type] = plain.split(':');
        setFileData({ name, type, url: null });
        return;
      }
      setText(plain); return;
    }
    (async () => {
      try {
        const aes = await decryptAESKeyWithRSA(msg.encryptedAesKey, privateKey);
        const plain = await decryptTextAES(msg.encryptedBody, aes);
        if (!active) return;
        if (plain.startsWith('VOICE:')) {
          setMsgType('voice');
          const ab = b642ab(plain.slice(6));
          setVoiceUrl(URL.createObjectURL(new Blob([ab], { type: 'audio/webm' })));
        } else if (plain.startsWith('FILE:')) {
          setMsgType('file');
          const parts = plain.split(':');
          const name = parts[1], type = parts[2], b64 = parts.slice(3).join(':');
          const ab = b642ab(b64);
          setFileData({ name, type, url: URL.createObjectURL(new Blob([ab], { type })) });
        } else {
          setText(plain);
        }
      } catch {
        if (active) setText(isSent ? '[ Message sent ]' : '[ Encrypted ]');
      }
    })();
    return () => { active = false; };
  }, [msg, privateKey, isSent]);

  // Burn-on-read countdown
  useEffect(() => {
    if (!msg.expiresAt) return;
    const expiryMs = new Date(msg.expiresAt).getTime();
    const total = expiryMs - Date.now();
    if (expiryTotalRef.current === null) expiryTotalRef.current = total;
    const tick = () => {
      const diff = expiryMs - Date.now();
      if (diff <= 0) {
        setTimeLeft('Expired'); setBurnPct(0);
        if (!autoDeletedRef.current) { autoDeletedRef.current = true; onAutoDelete(); }
        return;
      }
      const s = Math.floor(diff / 1000);
      setTimeLeft(s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s/60)}m` : `${Math.floor(s/3600)}h`);
      setBurnPct(Math.max(0, (diff / (expiryTotalRef.current || total)) * 100));
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [msg.expiresAt]);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  const reactions = typeof msg.reactions === 'object' ? msg.reactions : {};
  const hasMarkdown = text !== '…' && /\*\*|(?<!\*)\*(?!\*)|`|^# |^- |^> /m.test(text);

  const highlight = (str) => {
    if (!msgSearch || !str) return str;
    const re = new RegExp(`(${msgSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return str.split(re).map((p, i) => re.test(p) ? <mark key={i}>{p}</mark> : p);
  };

  return (
    <div className={`bubble-wrap ${isSent ? 'sent' : 'recv'}`}
      onMouseEnter={() => setShowActions(true)} onMouseLeave={() => { setShowActions(false); setShowReact(false); }}>

      {replyMsg && (
        <div className={`reply-quote ${isSent ? 'sent' : ''}`}>
          <span className="reply-quote-from">{replyMsg.from}</span>
          <span className="reply-quote-body">[ encrypted reply ]</span>
        </div>
      )}

      <div className={`bubble ${isSent ? 'sent' : 'recv'} ${isPinned ? 'pinned-bubble' : ''}`}>
        {!isSent && <div className="bubble-sender">{msg.from}</div>}

        {msgType === 'voice' && (
          <div className="voice-note">
            <Mic size={15} className="voice-icon" />
            {voiceUrl
              ? <audio controls src={voiceUrl} className="voice-audio" />
              : <div className="voice-waveform">{Array(16).fill(0).map((_, i) => <div key={i} className="wave-bar" style={{ animationDelay: `${i*0.07}s` }} />)}</div>
            }
          </div>
        )}

        {msgType === 'file' && fileData && (
          <div className="file-attach">
            <Paperclip size={20} className="file-icon" />
            <div className="file-info">
              <span className="file-name">{fileData.name}</span>
              <span className="file-type">{fileData.type}</span>
            </div>
            {fileData.url && (
              <a href={fileData.url} download={fileData.name} className="file-dl-btn" title="Download"><Download size={16} /></a>
            )}
          </div>
        )}

        {msgType === 'text' && (
          <div className="bubble-text">
            <TypewriterText text={text} hasMarkdown={hasMarkdown} isSent={isSent} highlight={highlight} />
          </div>
        )}

        {/* Burn-on-read progress bar */}
        {msg.expiresAt && (
          <div className="burn-bar">
            <div className="burn-bar-fill" style={{
              width: `${burnPct}%`,
              background: burnPct > 60 ? 'var(--accent)' : burnPct > 25 ? 'var(--warn)' : 'var(--danger)'
            }} />
          </div>
        )}

        <div className="bubble-footer">
          {msg.expiresAt && <span className="ephemeral-timer"><Clock size={10} /> {timeLeft}</span>}
          <span className="bubble-time">{formatTime(msg.time)}</span>
          {isSent && (msg.isRead ? <CheckCheck size={13} color="var(--accent)" /> : <Check size={13} color="rgba(255,255,255,0.35)" />)}
          {isPinned && <Pin size={10} style={{ color: 'var(--accent)', opacity: 0.7 }} />}
        </div>
      </div>

      {Object.keys(reactions).length > 0 && (
        <div className="reactions-bar">
          {Object.entries(reactions).map(([emoji, users]) => (
            <button key={emoji} className={`reaction-chip ${users.includes(callsign) ? 'mine' : ''}`}
              onClick={() => onReact(emoji)} title={users.join(', ')}>
              {emoji} <span>{users.length}</span>
            </button>
          ))}
        </div>
      )}

      {showActions && (
        <div className={`msg-actions ${isSent ? 'sent' : 'recv'}`}>
          <button className="action-btn" title="Reply" onClick={onReply}><Reply size={14} /></button>
          <button className="action-btn" title="React" onClick={() => setShowReact(s => !s)}><Smile size={14} /></button>
          <button className="action-btn" title={isPinned ? 'Unpin' : 'Pin'} onClick={onPin}><Pin size={14} /></button>
          {msgType === 'text' && <button className="action-btn" title={copied ? 'Copied!' : 'Copy'} onClick={handleCopy}><Copy size={14} /></button>}
          {isSent && <button className="action-btn danger" title="Delete for everyone" onClick={onDelete}><Trash2 size={14} /></button>}
          {showReact && (
            <div className="react-picker">
              {REACTION_EMOJIS.map(e => (
                <button key={e} className="emoji-btn sm" onClick={() => { onReact(e); setShowReact(false); }}>{e}</button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Settings Drawer ───────────────────────────────────────────────────────────
function SettingsDrawer({ theme, setTheme, canvasMode, setCanvasMode, volume, setVolume, soundOn, setSoundOn, onClose, onExport, onImport, onSteg }) {
  const [exportPw, setExportPw] = useState('');
  const [importPw, setImportPw] = useState('');
  const [importStatus, setImportStatus] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const importRef = useRef(null);

  const doExport = async () => {
    if (!exportPw) return;
    setExporting(true);
    await onExport(exportPw);
    setExporting(false); setExportPw('');
  };

  const doImport = async (e) => {
    const file = e.target.files[0]; if (!file || !importPw) return;
    setImporting(true);
    const ok = await onImport(file, importPw);
    setImportStatus(ok ? 'success' : 'error');
    setImporting(false);
    setTimeout(() => setImportStatus(null), 3000);
    e.target.value = '';
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="settings-drawer" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <Settings size={18} /><span>Settings</span>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="settings-body">

          <div className="settings-section">
            <div className="settings-section-title"><Palette size={14} /> Theme</div>
            <div className="theme-grid">
              {THEMES.map(t => (
                <button key={t.id} className={`theme-chip ${theme === t.id ? 'active' : ''}`} onClick={() => setTheme(t.id)}>
                  <span className="theme-dot" style={{ background: t.dot }} />
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title"><Activity size={14} /> Background Effect</div>
            <div className="canvas-options">
              {CANVAS_MODES.map(m => (
                <button key={m.id} className={`canvas-chip ${canvasMode === m.id ? 'active' : ''}`} onClick={() => setCanvasMode(m.id)}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title"><Volume2 size={14} /> Audio Feedback</div>
            <div className="audio-row">
              <button className="icon-btn" onClick={() => setSoundOn(s => !s)} title={soundOn ? 'Mute' : 'Unmute'}>
                {soundOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
              </button>
              <input type="range" min="0" max="1" step="0.05" value={volume}
                onChange={e => setVolume(parseFloat(e.target.value))}
                className="volume-slider" disabled={!soundOn} />
              <span className="volume-label">{Math.round(volume * 100)}%</span>
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title"><Download size={14} /> Export Encrypted Backup</div>
            <div className="backup-row">
              <input type="password" placeholder="Backup password" value={exportPw}
                onChange={e => setExportPw(e.target.value)} className="backup-input" />
              <button className="backup-btn" onClick={doExport} disabled={!exportPw || exporting}>
                {exporting ? <span className="spinner" /> : <Download size={14} />} Export
              </button>
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title"><Upload size={14} /> Import Backup</div>
            <div className="backup-row">
              <input type="password" placeholder="Backup password" value={importPw}
                onChange={e => setImportPw(e.target.value)} className="backup-input" />
              <input type="file" ref={importRef} accept=".sdcms" style={{ display: 'none' }} onChange={doImport} />
              <button className="backup-btn" onClick={() => importPw && importRef.current?.click()} disabled={!importPw || importing}>
                {importing ? <span className="spinner" /> : <Upload size={14} />} Import
              </button>
            </div>
            {importStatus === 'success' && <div className="backup-result success">✅ Imported successfully</div>}
            {importStatus === 'error'   && <div className="backup-result error">❌ Wrong password or corrupt file</div>}
          </div>

          <div className="settings-section">
            <div className="settings-section-title"><Image size={14} /> Steganography Tool</div>
            <button className="settings-action-btn" onClick={onSteg}><Image size={15} /> Open Encoder / Decoder</button>
          </div>

        </div>
      </div>
    </div>
  );
}

// ── Steganography Tool ────────────────────────────────────────────────────────
function SteganographyTool({ onClose }) {
  const [mode, setMode]       = useState('encode');
  const [message, setMessage] = useState('');
  const [resultUrl, setResultUrl] = useState(null);
  const [decoded, setDecoded] = useState('');
  const canvasRef = useRef(null);
  const fileRef   = useRef(null);

  const encode = () => {
    if (!message.trim()) return;
    const canvas = canvasRef.current;
    canvas.width = canvas.height = 400;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(400, 400);
    for (let i = 0; i < imgData.data.length; i += 4) {
      const v = Math.floor(Math.random() * 200) + 30;
      imgData.data[i] = v; imgData.data[i+1] = Math.floor(v*0.85); imgData.data[i+2] = Math.floor(v*0.7); imgData.data[i+3] = 255;
    }
    const bytes = new TextEncoder().encode('\x00' + message + '\x00');
    for (let b = 0; b < bytes.length && b * 8 * 4 < imgData.data.length; b++) {
      for (let bit = 0; bit < 8; bit++) {
        const idx = (b * 8 + bit) * 4;
        imgData.data[idx] = (imgData.data[idx] & 0xFE) | ((bytes[b] >> (7 - bit)) & 1);
      }
    }
    ctx.putImageData(imgData, 0, 0);
    setResultUrl(canvas.toDataURL('image/png'));
  };

  const decode = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const img = new Image();
    img.onload = () => {
      const canvas = canvasRef.current;
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const bytes = [];
      for (let b = 0; b < imgData.data.length / 32; b++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) byte = (byte << 1) | (imgData.data[(b * 8 + bit) * 4] & 1);
        bytes.push(byte);
        if (bytes.length > 2 && byte === 0 && bytes[0] === 0) break;
      }
      setDecoded(new TextDecoder().decode(new Uint8Array(bytes)).replace(/\0/g, '').trim() || 'No hidden message detected');
    };
    img.src = URL.createObjectURL(file);
    e.target.value = '';
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="steg-tool" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <Image size={18} /><span>Steganography Tool</span>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="steg-tabs">
          <button className={`steg-tab ${mode === 'encode' ? 'active' : ''}`} onClick={() => setMode('encode')}>Encode</button>
          <button className={`steg-tab ${mode === 'decode' ? 'active' : ''}`} onClick={() => setMode('decode')}>Decode</button>
        </div>
        {mode === 'encode' ? (
          <div className="steg-body">
            <p className="steg-hint">Embeds a secret message into the LSBs of pixel values in a noise image.</p>
            <textarea className="steg-input" rows={4} placeholder="Secret message to hide..." value={message} onChange={e => setMessage(e.target.value)} />
            <button className="backup-btn" onClick={encode} disabled={!message.trim()}><Image size={14} /> Generate Steg Image</button>
            {resultUrl && (
              <div className="steg-result">
                <img src={resultUrl} alt="Steg output" className="steg-preview" />
                <a href={resultUrl} download="sdcms_steg.png" className="backup-btn"><Download size={14} /> Download</a>
              </div>
            )}
          </div>
        ) : (
          <div className="steg-body">
            <p className="steg-hint">Upload a steg image generated by this tool to extract the hidden message.</p>
            <input type="file" ref={fileRef} accept="image/*" style={{ display: 'none' }} onChange={decode} />
            <button className="backup-btn" onClick={() => fileRef.current?.click()}><Upload size={14} /> Upload Image</button>
            {decoded && <div className="steg-decoded"><strong>Decoded message:</strong><p>{decoded}</p></div>}
          </div>
        )}
        <canvas ref={canvasRef} style={{ display: 'none' }} />
      </div>
    </div>
  );
}

// ── Profile Modal ─────────────────────────────────────────────────────────────
function ProfileModal({ callsign, status, onStatusChange, onClose, onLogout, biometricEnabled, onToggleBiometric }) {
  const [st, setSt] = useState(status);
  const [bioLoading, setBioLoading] = useState(false);
  const waAvail = webAuthnAvailable();

  const toggleBio = async () => {
    setBioLoading(true);
    try { await onToggleBiometric(); } catch(_) {}
    setBioLoading(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}><X size={18} /></button>
        <div className="modal-avatar" style={{ background: avatarColor(callsign) }}>
          {callsign[0]}<span className="online-dot lg" />
        </div>
        <h2 className="modal-name">{callsign}</h2>
        <p className="modal-role">Operator · TOP SECRET CLEARANCE</p>

        <div className="modal-section">
          <label>Status</label>
          <select value={st} onChange={e => { setSt(e.target.value); onStatusChange(e.target.value); }}>
            {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div className="modal-section">
          <label>Biometric Authentication</label>
          <div className="bio-toggle-row">
            <div>
              <div style={{ fontSize: '0.88rem', color: biometricEnabled ? 'var(--success)' : 'var(--text2)' }}>
                {biometricEnabled ? '✅ Fingerprint / Face ID enabled' : '⬜ Not configured'}
              </div>
              <div style={{ fontSize: '0.73rem', color: 'var(--text3)', marginTop: 2 }}>
                Used for login + inactivity lock
              </div>
            </div>
            {waAvail ? (
              <button className="bio-toggle-btn" onClick={toggleBio} disabled={bioLoading}>
                {bioLoading ? <span className="spinner" /> : <Fingerprint size={15} />}
                {biometricEnabled ? 'Disable' : 'Enable'}
              </button>
            ) : (
              <span style={{ fontSize: '0.75rem', color: 'var(--text3)' }}>Not available</span>
            )}
          </div>
        </div>

        <div className="modal-section">
          <label>Security</label>
          <div className="modal-info-row">🔐 RSA-OAEP 2048 + AES-GCM 256</div>
          <div className="modal-info-row">🗝️ Session-only ephemeral keys</div>
          <div className="modal-info-row">💀 Auto-purge on exit / lock</div>
          <div className="modal-info-row">⚡ WebRTC P2P available</div>
          <div className="modal-info-row">🥷 Tab decoy mode active</div>
        </div>

        <button className="btn-danger full" onClick={onLogout}><Zap size={16} /> Burn Protocol</button>
      </div>
    </div>
  );
}
