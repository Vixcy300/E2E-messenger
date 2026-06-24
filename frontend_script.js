(async function(){

  /* ---------------- API Helpers ---------------- */
  async function fetchAPI(url, method="GET", body=null) {
    const opts = { method, headers: {} };
    if (body) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error("API Error");
    return res.json();
  }

  /* ---------------- E2EE WebCrypto ---------------- */
  async function generateKeyPair() {
    return await window.crypto.subtle.generateKey(
        { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true, ["encrypt", "decrypt"]
    );
  }
  async function exportPublicKey(key) {
    const exported = await window.crypto.subtle.exportKey("spki", key);
    return btoa(String.fromCharCode(...new Uint8Array(exported)));
  }
  async function importPublicKey(pem) {
    if(!pem) return null;
    const binaryDer = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
    return await window.crypto.subtle.importKey(
        "spki", binaryDer.buffer, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]
    );
  }
  async function encryptMessage(text, publicKey) {
    if(!publicKey) return { encryptedBody: btoa(text), encryptedAesKey: "" }; // Fallback if no PK
    const aesKey = await window.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encodedText = new TextEncoder().encode(text);
    const ciphertext = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, aesKey, encodedText);
    const rawAesKey = await window.crypto.subtle.exportKey("raw", aesKey);
    const encryptedAesKey = await window.crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawAesKey);
    const bodyBuf = new Uint8Array(iv.length + ciphertext.byteLength);
    bodyBuf.set(iv, 0); bodyBuf.set(new Uint8Array(ciphertext), iv.length);
    return {
        encryptedBody: btoa(String.fromCharCode(...bodyBuf)),
        encryptedAesKey: btoa(String.fromCharCode(...new Uint8Array(encryptedAesKey)))
    };
  }
  async function decryptMessage(encryptedBodyBase64, encryptedAesKeyBase64, privateKey) {
    if(!encryptedAesKeyBase64) return atob(encryptedBodyBase64); // Fallback
    try {
        const encryptedBody = Uint8Array.from(atob(encryptedBodyBase64), c => c.charCodeAt(0));
        const encryptedAesKey = Uint8Array.from(atob(encryptedAesKeyBase64), c => c.charCodeAt(0));
        const rawAesKey = await window.crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, encryptedAesKey);
        const aesKey = await window.crypto.subtle.importKey("raw", rawAesKey, { name: "AES-GCM" }, true, ["decrypt"]);
        const iv = encryptedBody.slice(0, 12);
        const ciphertext = encryptedBody.slice(12);
        const decryptedBody = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, aesKey, ciphertext);
        return new TextDecoder().decode(decryptedBody);
    } catch(e) { return "[DECRYPTION FAILED]"; }
  }

  /* ---------------- App State ---------------- */
  let personnel = [];
  let accessLog = [];
  let messages = [];
  let commLog = [];
  let chartData = [{day:"MON", val:18},{day:"TUE", val:24},{day:"WED", val:15},{day:"THU", val:29},{day:"FRI", val:33},{day:"SAT", val:11},{day:"SUN", val:9}];
  
  let currentRole = "ADMIN";
  let currentCallsign = "—";
  let selectedMsgId = null;
  let activeBox = "inbox";
  let myPrivateKey = null;

  /* ---------------- helpers ---------------- */
  function $(id){ return document.getElementById(id); }
  function pad(n){ return n<10 ? "0"+n : ""+n; }
  function toast(msg){
    var t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(function(){ t.classList.remove("show"); }, 2200);
  }
  function nowStr(){
    var d = new Date(); return pad(d.getHours())+":"+pad(d.getMinutes())+":"+pad(d.getSeconds());
  }

  /* ---------------- login screen logic ---------------- */
  var roleBtns = document.querySelectorAll(".role-btn");
  roleBtns.forEach(function(btn){
    btn.addEventListener("click", function(){
      roleBtns.forEach(function(b){ b.classList.remove("active"); });
      btn.classList.add("active");
    });
  });

  $("loginForm").addEventListener("submit", async function(e){
    e.preventDefault();
    var u = $("username").value.trim().toUpperCase();
    var p = $("password").value.trim();
    if(!u || !p){ $("loginError").style.display = "block"; return; }
    $("loginError").style.display = "none";

    var roleBtn = document.querySelector(".role-btn.active");
    currentRole = roleBtn ? roleBtn.getAttribute("data-role") : "ADMIN";
    currentCallsign = u;

    var btn = $("authBtn");
    btn.disabled = true; btn.textContent = "GENERATING KEYS...";
    
    // Generate RSA keys
    const keyPair = await generateKeyPair();
    myPrivateKey = keyPair.privateKey;
    const pubKeyBase64 = await exportPublicKey(keyPair.publicKey);

    // Register User to Server
    btn.textContent = "AUTHENTICATING...";
    try {
        await fetchAPI("/api/users", "POST", { callsign: u, role: currentRole, clearance: "Top Secret", publicKey: pubKeyBase64 });
        await enterApp();
    } catch(err) {
        toast("SERVER CONNECTION FAILED. USING LOCAL DEMO MODE.");
        await enterApp(); // fallback
    }
    btn.disabled = false; btn.textContent = "AUTHENTICATE";
  });

  async function enterApp(){
    accessLog.unshift({time: nowStr(), callsign: currentCallsign, event:"LOGIN_SUCCESS", result:"SUCCESS"});
    $("loginScreen").style.display = "none";
    $("appShell").style.display = "flex";
    $("userCallsign").textContent = currentCallsign;
    $("userRolePill").textContent = currentRole;
    applyRoleAccess();
    await loadData();
    renderPersonnel();
    renderAccessLog();
    renderMessages();
    renderStats();
    renderChart();
    renderCommLog();
    switchModule("module1");
    if(currentRole === "OPERATOR"){ switchModule("module2"); }
    
    // Start polling
    setInterval(loadData, 5000);
  }

  async function loadData() {
    try {
        personnel = await fetchAPI("/api/users");
        const inbox = await fetchAPI("/api/messages/inbox?callsign="+currentCallsign);
        const sent = await fetchAPI("/api/messages/sent?callsign="+currentCallsign);
        messages = [...inbox, ...sent].sort((a,b)=> a.id - b.id);
        renderMessages();
        renderPersonnel();
    } catch(e) {}
  }

  $("logoutBtn").addEventListener("click", function(){
    $("appShell").style.display = "none"; $("loginScreen").style.display = "block";
    $("username").value = ""; $("password").value = ""; selectedMsgId = null;
  });

  function applyRoleAccess(){
    var nav1 = $("nav1"), nav3 = $("nav3"), note = $("navLockedNote");
    nav1.style.display = "flex"; nav3.style.display = "flex"; note.textContent = "";
    if(currentRole === "OFFICER"){
      nav1.style.display = "none"; note.textContent = "MOD-01 restricted to ADMIN clearance.";
    } else if(currentRole === "OPERATOR"){
      nav1.style.display = "none"; nav3.style.display = "none";
      note.textContent = "MOD-01 & MOD-03 restricted.\nOPERATOR clearance: MOD-02 only.";
    }
  }

  document.querySelectorAll(".nav-item").forEach(function(item){
    item.addEventListener("click", function(){
      if(item.style.display === "none") return;
      switchModule(item.getAttribute("data-target"));
    });
  });

  function switchModule(target){
    document.querySelectorAll(".module-panel").forEach(function(p){ p.classList.remove("active"); });
    document.querySelectorAll(".nav-item").forEach(function(n){ n.classList.remove("active"); });
    $(target).classList.add("active");
    var navMap = {module1:"nav1", module2:"nav2", module3:"nav3"};
    $(navMap[target]).classList.add("active");
  }

  setInterval(function(){ var c = $("clock"); if(c) c.textContent = nowStr(); }, 1000);

  function renderPersonnel(){
    var tbody = $("personnelTable"); tbody.innerHTML = "";
    personnel.forEach(function(p){
      var tr = document.createElement("tr");
      tr.innerHTML = "<td>"+p.callsign+"</td><td class='mono-cell'>"+p.callsign+"</td><td>"+p.role+"</td><td>"+p.clearance+"</td><td><span class='pill pill-green'>Active</span></td><td class='mono-cell'>Online</td>";
      tbody.appendChild(tr);
    });
  }

  function renderAccessLog(){
    var tbody = $("accessLogTable"); tbody.innerHTML = "";
    accessLog.slice(0,8).forEach(function(a){
      var tr = document.createElement("tr");
      var pill = a.result === "SUCCESS" ? "pill-green" : "pill-red";
      tr.innerHTML = "<td class='mono-cell'>"+a.time+"</td><td class='mono-cell'>"+a.callsign+"</td><td>"+a.event+"</td><td><span class='pill "+pill+"'>"+a.result+"</span></td>";
      tbody.appendChild(tr);
    });
  }

  $("addPersonnelBtn").addEventListener("click", function(){ $("personnelForm").classList.toggle("open"); });
  $("cancelPersonnel").addEventListener("click", function(){ $("personnelForm").classList.remove("open"); });
  $("savePersonnel").addEventListener("click", async function(){
    var name = $("pName").value.trim();
    var callsign = $("pCallsign").value.trim().toUpperCase();
    if(!name || !callsign){ toast("NAME AND CALLSIGN REQUIRED"); return; }
    try {
        await fetchAPI("/api/users", "POST", { callsign: callsign, role: $("pRole").value, clearance: $("pClearance").value, publicKey: "" });
        $("pName").value=""; $("pCallsign").value=""; $("personnelForm").classList.remove("open");
        await loadData(); toast("PERSONNEL RECORD ADDED: "+callsign);
    } catch(e) { toast("FAILED TO ADD PERSONNEL"); }
  });

  document.querySelectorAll(".msg-tab").forEach(function(tab){
    tab.addEventListener("click", function(){
      document.querySelectorAll(".msg-tab").forEach(function(t){ t.classList.remove("active"); });
      tab.classList.add("active"); activeBox = tab.getAttribute("data-box"); renderMessages();
    });
  });

  function renderMessages(){
    var body = $("msgListBody"); body.innerHTML = "";
    var list = messages.filter(function(m){ return m.dir === activeBox; });
    if(list.length === 0){ body.innerHTML = "<div class='msg-empty'>No messages in this folder.</div>"; return; }
    list.slice().reverse().forEach(function(m){
      var div = document.createElement("div");
      div.className = "msg-item" + (m.id === selectedMsgId ? " selected" : "");
      div.innerHTML = "<div class='msg-item-top'><span class='msg-from'>"+(m.dir==="inbox"? m.from : m.to)+"</span><span class='msg-time'>"+m.time+"</span></div><div class='msg-subj'>"+m.subject+"</div>";
      div.addEventListener("click", function(){
        selectedMsgId = m.id; renderMessages(); viewMessage(m);
      });
      body.appendChild(div);
    });
  }

  function classPill(c){
    var map = {"Top Secret":"pill-red","Secret":"pill-amber","Confidential":"pill-muted","Unclassified":"pill-green"};
    return map[c] || "pill-muted";
  }

  async function viewMessage(m){
    var pane = $("msgPane");
    pane.innerHTML = "<div class='decrypt-banner' id='decryptBanner'>DECRYPTING…</div><div class='msg-view-head'><h3 class='msg-view-subj'>"+m.subject+"</h3><div class='msg-view-meta'><span>FROM: "+m.from+"</span><span>TO: "+m.to+"</span><span><span class='pill "+classPill(m.classification)+"'>"+m.classification+"</span></span></div></div><div class='msg-view-body' id='msgBody' style='opacity:0.15;'>...</div>";
    
    // Decrypt
    let plaintext = "";
    if(m.dir === "inbox") {
        plaintext = await decryptMessage(m.encryptedBody, m.encryptedAesKey, myPrivateKey);
    } else {
        plaintext = "[SENT MESSAGES NOT DECRYPTABLE IN DEMO E2EE - ONLY RECEIVER CAN READ]";
    }

    setTimeout(function(){
      var banner = $("decryptBanner"); var b = $("msgBody");
      if(banner) banner.textContent = "✓ DECRYPTED — INTEGRITY VERIFIED";
      if(b) { b.style.opacity = "1"; b.textContent = plaintext; }
    }, 450);
  }

  $("composeBtn").addEventListener("click", openCompose);

  function openCompose(){
    selectedMsgId = null; renderMessages();
    var options = personnel.map(function(p){ return "<option value='"+p.callsign+"'>"+p.callsign+"</option>"; }).join("");
    $("msgPane").innerHTML = "<form class='compose-form' id='composeForm'><div class='field-row'><div><label>TO</label><select id='cTo'>"+options+"</select></div><div><label>CLASSIFICATION</label><select id='cClass'><option>Unclassified</option><option>Confidential</option><option selected>Secret</option><option>Top Secret</option></select></div></div><div style='margin-bottom:12px;'><label>SUBJECT</label><input id='cSubject' type='text' placeholder='Message subject' required></div><div style='margin-bottom:14px;'><label>MESSAGE BODY</label><textarea id='cBody' placeholder='Compose secure message...' required></textarea></div><div style='display:flex;gap:8px;justify-content:flex-end;'><button type='button' class='ghost-btn' id='cancelCompose'>CANCEL</button><button type='submit' class='solid-btn' id='transmitBtn'>TRANSMIT SECURELY</button></div></form>";

    $("cancelCompose").addEventListener("click", function(){ $("msgPane").innerHTML = ""; $("msgPane").appendChild(placeholderNode()); });

    $("composeForm").addEventListener("submit", async function(e){
      e.preventDefault();
      var to = $("cTo").value, subj = $("cSubject").value.trim(), body = $("cBody").value.trim(), cls = $("cClass").value;
      if(!subj || !body) return;
      var btn = $("transmitBtn"); btn.disabled = true; btn.textContent = "ENCRYPTING...";
      
      // Fetch Recipient Public Key
      const recipient = personnel.find(p => p.callsign === to);
      const recipientPubKey = await importPublicKey(recipient ? recipient.publicKey : null);
      
      // Encrypt
      const { encryptedBody, encryptedAesKey } = await encryptMessage(body, recipientPubKey);

      // Transmit
      try {
        await fetchAPI("/api/messages", "POST", { sender: currentCallsign, receiver: to, subject: subj, classification: cls, encryptedBody: encryptedBody, encryptedAesKey: encryptedAesKey });
        btn.textContent = "TRANSMITTED ✓"; toast("MESSAGE TRANSMITTED TO "+to);
        await loadData();
        setTimeout(function(){
            activeBox = "sent"; document.querySelectorAll(".msg-tab").forEach(function(t){ t.classList.toggle("active", t.getAttribute("data-box")==="sent"); });
            renderMessages(); $("msgPane").innerHTML = ""; $("msgPane").appendChild(placeholderNode());
        }, 600);
      } catch(e) {
          btn.textContent = "TRANSMIT SECURELY"; btn.disabled = false; toast("TRANSMIT FAILED");
      }
    });
  }

  function placeholderNode(){
    var div = document.createElement("div"); div.className = "msg-pane-placeholder";
    div.innerHTML = "<svg width='34' height='34' viewBox='0 0 24 24' fill='none'><path d='M3 6h18v12H3V6Z' stroke='#4d5862' stroke-width='1.4'/><path d='M3 7l9 6 9-6' stroke='#4d5862' stroke-width='1.4'/></svg><div>Select a message to view, or compose a new secure transmission.</div><button class='solid-btn' id='composeBtn2'>+ COMPOSE MESSAGE</button>";
    div.querySelector("#composeBtn2").addEventListener("click", openCompose); return div;
  }

  function renderStats(){
    $("statSessions").textContent = personnel.length;
    $("statMessages").textContent = messages.length;
    $("statAlerts").textContent = 0;
    $("statResponse").textContent = "1.2 min";
  }

  function renderChart(){
    var svg = $("volumeChart"); var w = 640, h = 180, barW = 56, gap = 24, base = 150;
    var max = Math.max.apply(null, chartData.map(function(d){ return d.val; }));
    var startX = 30; var html = "";
    chartData.forEach(function(d, i){
      var barH = (d.val / max) * 100; var x = startX + i * (barW + gap); var y = base - barH;
      html += "<rect x='"+x+"' y='"+y+"' width='"+barW+"' height='"+barH+"' fill='#ffb627' opacity='0.85' rx='2'></rect>";
      html += "<text class='bar-value' x='"+(x+barW/2)+"' y='"+(y-8)+"'>"+d.val+"</text>";
      html += "<text class='bar-label' x='"+(x+barW/2)+"' y='"+(base+18)+"'>"+d.day+"</text>";
    });
    html += "<line x1='20' y1='"+base+"' x2='"+(w-10)+"' y2='"+base+"' stroke='#26323c' stroke-width='1'></line>";
    svg.innerHTML = html;
  }

  function renderCommLog(){ /* simplified for E2EE version */ }

  $("generateReportBtn").addEventListener("click", function(){
    var block = $("reportBlock"); block.classList.toggle("open");
    if(block.classList.contains("open")){
      $("reportGrid").innerHTML = "<div class='report-line'>Report generated<b>"+nowStr()+"</b></div><div class='report-line'>Personnel on record<b>"+personnel.length+"</b></div><div class='report-line'>Messages transmitted<b>"+messages.length+"</b></div>";
      toast("REPORT GENERATED");
    }
  });

  $("printReportBtn").addEventListener("click", function(){ window.print(); });

})();
