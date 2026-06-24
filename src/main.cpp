// #define CPPHTTPLIB_OPENSSL_SUPPORT
#include "../include/httplib.h"
#include "../include/json.hpp"
#include "Database.hpp"
#include <iostream>
#include <fstream>
#include <sstream>
#include <algorithm>
#include <map>
#include <mutex>
#include <chrono>

using json = nlohmann::json;

// ── In-memory transient state (not persisted) ─────────────────────────────
// typing state: {receiver -> {sender -> timestamp_ms}}
std::map<std::string, std::map<std::string, long long>> typingState;
std::mutex typingMutex;

// WebRTC signaling relay store: {to_callsign -> [signal_objects]}
std::map<std::string, std::vector<json>> signalStore;
std::mutex signalMutex;

long long nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

void set_cors_headers(httplib::Response& res) {
    res.set_header("Access-Control-Allow-Origin", "*");
    res.set_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.set_header("Access-Control-Allow-Headers", "Content-Type");
}

// Helper: build user JSON object
json userToJson(const User& u) {
    return {
        {"callsign", u.callsign},
        {"role", u.role},
        {"clearance", u.clearance},
        {"publicKey", u.publicKey},
        {"lastSeen", u.lastSeen},
        {"statusMsg", u.statusMsg}
    };
}

// Helper: build message JSON object
json msgToJson(const Message& m, const std::string& dir) {
    json reactions;
    try { reactions = json::parse(m.reactions); } catch (...) { reactions = json::object(); }
    return {
        {"id", m.id},
        {"dir", dir},
        {"from", m.senderCallsign},
        {"to", m.receiverCallsign},
        {"subject", m.subject},
        {"classification", m.classification},
        {"encryptedBody", m.encryptedBody},
        {"encryptedAesKey", m.encryptedAesKey},
        {"time", m.timestamp},
        {"replyToId", m.replyToId},
        {"expiresAt", m.expiresAt},
        {"reactions", reactions},
        {"isRead", m.isRead}
    };
}

int main() {
    Database* db = Database::getInstance();
    if (!db->initialize()) {
        std::cerr << "Failed to initialize database." << std::endl;
        return 1;
    }

    httplib::Server svr;

    // CORS preflight
    svr.Options(R"(.*)", [](const httplib::Request&, httplib::Response& res) {
        set_cors_headers(res);
        res.status = 200;
    });

    // ── Users ─────────────────────────────────────────────────────────────

    // GET /api/users — list all users with valid public keys
    svr.Get("/api/users", [db](const httplib::Request&, httplib::Response& res) {
        set_cors_headers(res);
        db->deleteExpiredMessages();
        auto users = db->getAllUsers();
        json j = json::array();
        for (const auto& u : users)
            if (!u.publicKey.empty()) j.push_back(userToJson(u));
        res.set_content(j.dump(), "application/json");
    });

    // GET /api/users/search?q= — case-insensitive substring search
    svr.Get("/api/users/search", [db](const httplib::Request& req, httplib::Response& res) {
        set_cors_headers(res);
        std::string q = req.has_param("q") ? req.get_param_value("q") : "";
        auto users = db->getAllUsers();
        json j = json::array();
        for (const auto& u : users) {
            if (u.publicKey.empty()) continue;
            std::string cl = u.callsign, ql = q;
            std::transform(cl.begin(), cl.end(), cl.begin(), ::tolower);
            std::transform(ql.begin(), ql.end(), ql.begin(), ::tolower);
            if (q.empty() || cl.find(ql) != std::string::npos)
                j.push_back(userToJson(u));
        }
        res.set_content(j.dump(), "application/json");
    });

    // POST /api/users — register / update user
    svr.Post("/api/users", [db](const httplib::Request& req, httplib::Response& res) {
        set_cors_headers(res);
        try {
            auto j = json::parse(req.body);
            User u(
                j.value("callsign", ""),
                j.value("role", "Operator"),
                j.value("clearance", "TOP SECRET"),
                j.value("publicKey", ""),
                "",
                j.value("statusMsg", "Active"),
                j.value("expiresAt", "")
            );
            if (u.callsign.empty()) { res.status = 400; res.set_content("{\"error\":\"Callsign required\"}", "application/json"); return; }
            if (db->addUser(u)) { res.set_content("{\"status\":\"success\"}", "application/json"); }
            else { res.status = 500; res.set_content("{\"error\":\"DB error\"}", "application/json"); }
        } catch (...) { res.status = 400; res.set_content("{\"error\":\"Invalid JSON\"}", "application/json"); }
    });

    // POST /api/heartbeat — keep-alive; updates lastSeen + optional status
    svr.Post("/api/heartbeat", [db](const httplib::Request& req, httplib::Response& res) {
        set_cors_headers(res);
        try {
            auto j = json::parse(req.body);
            std::string callsign = j.value("callsign", "");
            std::string statusMsg = j.value("statusMsg", "Active");
            if (!callsign.empty()) db->updateHeartbeat(callsign, statusMsg);
            res.set_content("{\"status\":\"ok\"}", "application/json");
        } catch (...) { res.status = 400; }
    });

    // ── Typing ────────────────────────────────────────────────────────────

    // POST /api/typing — {callsign, receiver, typing: bool}
    svr.Post("/api/typing", [](const httplib::Request& req, httplib::Response& res) {
        set_cors_headers(res);
        try {
            auto j = json::parse(req.body);
            std::string from = j.value("callsign", "");
            std::string to   = j.value("receiver", "");
            bool typing      = j.value("typing", false);
            std::lock_guard<std::mutex> lock(typingMutex);
            if (typing) typingState[to][from] = nowMs();
            else typingState[to].erase(from);
            res.set_content("{\"status\":\"ok\"}", "application/json");
        } catch (...) { res.status = 400; }
    });

    // GET /api/typing?callsign=X&with=Y — is Y typing to X?
    svr.Get("/api/typing", [](const httplib::Request& req, httplib::Response& res) {
        set_cors_headers(res);
        std::string me   = req.has_param("callsign") ? req.get_param_value("callsign") : "";
        std::string with = req.has_param("with") ? req.get_param_value("with") : "";
        std::lock_guard<std::mutex> lock(typingMutex);
        long long threshold = nowMs() - 4000; // 4s timeout
        bool isTyping = false;
        if (typingState.count(me) && typingState[me].count(with)) {
            isTyping = typingState[me][with] > threshold;
            if (!isTyping) typingState[me].erase(with);
        }
        json j = {{"typing", isTyping}};
        res.set_content(j.dump(), "application/json");
    });

    // ── Messages ──────────────────────────────────────────────────────────

    // POST /api/messages — send encrypted message
    svr.Post("/api/messages", [db](const httplib::Request& req, httplib::Response& res) {
        set_cors_headers(res);
        try {
            auto j = json::parse(req.body);

            // Build full ISO timestamp
            time_t rawtime; time(&rawtime);
            struct tm* ti = localtime(&rawtime);
            char buf[32]; strftime(buf, sizeof(buf), "%H:%M", ti);
            char dateBuf[32]; strftime(dateBuf, sizeof(dateBuf), "%Y-%m-%dT%H:%M:%SZ", gmtime(&rawtime));

            Message msg(
                0,
                j.value("sender", ""),
                j.value("receiver", ""),
                j.value("subject", "Message"),
                j.value("classification", "TOP SECRET"),
                j.value("encryptedBody", ""),
                j.value("encryptedAesKey", ""),
                std::string(buf),           // display time HH:MM
                j.value("replyToId", -1),
                j.value("expiresAt", ""),   // ISO expiry or ""
                "{}", 0
            );

            if (db->addMessage(msg)) { res.set_content("{\"status\":\"success\"}", "application/json"); }
            else { res.status = 500; res.set_content("{\"error\":\"DB error\"}", "application/json"); }
        } catch (...) { res.status = 400; res.set_content("{\"error\":\"Invalid JSON\"}", "application/json"); }
    });

    // GET /api/messages/inbox?callsign=
    svr.Get("/api/messages/inbox", [db](const httplib::Request& req, httplib::Response& res) {
        set_cors_headers(res);
        if (!req.has_param("callsign")) { res.status = 400; return; }
        db->deleteExpiredMessages();
        auto msgs = db->getInbox(req.get_param_value("callsign"));
        json j = json::array();
        for (const auto& m : msgs) j.push_back(msgToJson(m, "inbox"));
        res.set_content(j.dump(), "application/json");
    });

    // GET /api/messages/sent?callsign=
    svr.Get("/api/messages/sent", [db](const httplib::Request& req, httplib::Response& res) {
        set_cors_headers(res);
        if (!req.has_param("callsign")) { res.status = 400; return; }
        db->deleteExpiredMessages();
        auto msgs = db->getSent(req.get_param_value("callsign"));
        json j = json::array();
        for (const auto& m : msgs) j.push_back(msgToJson(m, "sent"));
        res.set_content(j.dump(), "application/json");
    });

    // DELETE /api/messages/:id — delete for everyone
    svr.Delete(R"(/api/messages/(\d+))", [db](const httplib::Request& req, httplib::Response& res) {
        set_cors_headers(res);
        int id = std::stoi(req.matches[1]);
        if (db->deleteMessage(id)) { res.set_content("{\"status\":\"success\"}", "application/json"); }
        else { res.status = 500; res.set_content("{\"error\":\"DB error\"}", "application/json"); }
    });

    // PUT /api/messages/:id/read
    svr.Put(R"(/api/messages/(\d+)/read)", [db](const httplib::Request& req, httplib::Response& res) {
        set_cors_headers(res);
        int id = std::stoi(req.matches[1]);
        db->markMessageRead(id);
        res.set_content("{\"status\":\"ok\"}", "application/json");
    });

    // POST /api/messages/:id/react — {callsign, emoji}
    svr.Post(R"(/api/messages/(\d+)/react)", [db](const httplib::Request& req, httplib::Response& res) {
        set_cors_headers(res);
        try {
            int id = std::stoi(req.matches[1]);
            auto j = json::parse(req.body);
            std::string callsign = j.value("callsign", "");
            std::string emoji    = j.value("emoji", "");

            // Get current reactions
            auto msgs = db->getInbox(callsign); // try both directions
            // We need the message directly — use a search or fetch all
            // Simple approach: fetch from both directions and find by id
            auto sents = db->getSent(callsign);
            msgs.insert(msgs.end(), sents.begin(), sents.end());

            json reactions = json::object();
            for (const auto& m : msgs) {
                if (m.id == id) {
                    try { reactions = json::parse(m.reactions); } catch (...) {}
                    break;
                }
            }
            // Toggle reaction
            if (!reactions.contains(emoji)) reactions[emoji] = json::array();
            auto& arr = reactions[emoji];
            bool found = false;
            for (int i = 0; i < (int)arr.size(); i++) {
                if (arr[i] == callsign) { arr.erase(i); found = true; break; }
            }
            if (!found) arr.push_back(callsign);
            if (arr.empty()) reactions.erase(emoji);

            db->updateReactions(id, reactions.dump());
            res.set_content(reactions.dump(), "application/json");
        } catch (...) { res.status = 400; }
    });

    // ── Burn Protocol ─────────────────────────────────────────────────────

    // POST /api/burn — wipe user + all their messages
    svr.Post("/api/burn", [db](const httplib::Request& req, httplib::Response& res) {
        set_cors_headers(res);
        try {
            auto j = json::parse(req.body);
            std::string callsign = j.value("callsign", "");
            if (callsign.empty()) { res.status = 400; return; }
            if (db->deleteAllUserData(callsign)) { res.set_content("{\"status\":\"burned\"}", "application/json"); }
            else { res.status = 500; }
        } catch (...) { res.status = 400; }
    });

    // ── Latency Ping ───────────────────────────────────────────────────────

    // GET /api/ping — returns timestamp for RTT measurement
    svr.Get("/api/ping", [](const httplib::Request&, httplib::Response& res) {
        set_cors_headers(res);
        long long ts = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
        res.set_content(json{{"pong", true}, {"ts", ts}}.dump(), "application/json");
    });

    // ── WebRTC Signaling Relay ─────────────────────────────────────────────

    // POST /api/signal — store signal message for a target callsign
    svr.Post("/api/signal", [](const httplib::Request& req, httplib::Response& res) {
        set_cors_headers(res);
        try {
            auto j = json::parse(req.body);
            std::string to = j.value("to", "");
            if (to.empty()) { res.status = 400; return; }
            std::lock_guard<std::mutex> lock(signalMutex);
            // Limit queue size to 50 per recipient
            if (signalStore[to].size() < 50) signalStore[to].push_back(j);
            res.set_content("{\"ok\":true}", "application/json");
        } catch (...) { res.status = 400; }
    });

    // GET /api/signal?callsign=X — drain pending signals for X
    svr.Get("/api/signal", [](const httplib::Request& req, httplib::Response& res) {
        set_cors_headers(res);
        std::string cs = req.has_param("callsign") ? req.get_param_value("callsign") : "";
        std::lock_guard<std::mutex> lock(signalMutex);
        auto it = signalStore.find(cs);
        if (it != signalStore.end() && !it->second.empty()) {
            res.set_content(json(it->second).dump(), "application/json");
            it->second.clear();
        } else {
            res.set_content("[]", "application/json");
        }
    });

    std::cout << "[SDCMS] Server running on http://localhost:8080" << std::endl;
    svr.listen("0.0.0.0", 8080);
    return 0;
}
