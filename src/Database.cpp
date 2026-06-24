#include "Database.hpp"
#include <iostream>
#include <ctime>
#include <algorithm>

Database* Database::instance = nullptr;

Database::Database() : db(nullptr) {}

Database::~Database() {
    if (db) sqlite3_close(db);
}

Database* Database::getInstance() {
    if (instance == nullptr) instance = new Database();
    return instance;
}

bool Database::initialize() {
    int rc = sqlite3_open("sdcms.db", &db);
    if (rc) {
        std::cerr << "Can't open database: " << sqlite3_errmsg(db) << std::endl;
        return false;
    }

    // Enable WAL mode for better concurrent access
    sqlite3_exec(db, "PRAGMA journal_mode=WAL;", nullptr, nullptr, nullptr);

    char* errMsg = nullptr;

    // Users table
    const char* sqlUsers =
        "CREATE TABLE IF NOT EXISTS Users ("
        "callsign TEXT PRIMARY KEY, "
        "role TEXT, "
        "clearance TEXT, "
        "public_key TEXT, "
        "last_seen TEXT DEFAULT '', "
        "status_msg TEXT DEFAULT 'Active', "
        "expires_at TEXT DEFAULT '');";
    rc = sqlite3_exec(db, sqlUsers, nullptr, nullptr, &errMsg);
    if (rc != SQLITE_OK) {
        std::cerr << "SQL error creating Users table: " << errMsg << std::endl;
        sqlite3_free(errMsg);
        return false;
    }

    // Add columns if upgrading from older DB (safe to ignore errors)
    sqlite3_exec(db, "ALTER TABLE Users ADD COLUMN last_seen TEXT DEFAULT '';", nullptr, nullptr, nullptr);
    sqlite3_exec(db, "ALTER TABLE Users ADD COLUMN status_msg TEXT DEFAULT 'Active';", nullptr, nullptr, nullptr);
    sqlite3_exec(db, "ALTER TABLE Users ADD COLUMN expires_at TEXT DEFAULT '';", nullptr, nullptr, nullptr);

    // Messages table
    const char* sqlMessages =
        "CREATE TABLE IF NOT EXISTS Messages ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "sender TEXT, "
        "receiver TEXT, "
        "subject TEXT, "
        "classification TEXT, "
        "encrypted_body TEXT, "
        "encrypted_aes_key TEXT, "
        "timestamp TEXT, "
        "reply_to_id INTEGER DEFAULT -1, "
        "expires_at TEXT DEFAULT '', "
        "reactions TEXT DEFAULT '{}', "
        "is_read INTEGER DEFAULT 0);";
    rc = sqlite3_exec(db, sqlMessages, nullptr, nullptr, &errMsg);
    if (rc != SQLITE_OK) {
        std::cerr << "SQL error creating Messages table: " << errMsg << std::endl;
        sqlite3_free(errMsg);
        return false;
    }

    // Safe column upgrades for existing DBs
    sqlite3_exec(db, "ALTER TABLE Messages ADD COLUMN reply_to_id INTEGER DEFAULT -1;", nullptr, nullptr, nullptr);
    sqlite3_exec(db, "ALTER TABLE Messages ADD COLUMN expires_at TEXT DEFAULT '';", nullptr, nullptr, nullptr);
    sqlite3_exec(db, "ALTER TABLE Messages ADD COLUMN reactions TEXT DEFAULT '{}';", nullptr, nullptr, nullptr);
    sqlite3_exec(db, "ALTER TABLE Messages ADD COLUMN is_read INTEGER DEFAULT 0;", nullptr, nullptr, nullptr);

    return true;
}

// ── User Operations ──────────────────────────────────────────────────────────

bool Database::addUser(const User& user) {
    const char* sql = "INSERT OR REPLACE INTO Users (callsign, role, clearance, public_key, last_seen, status_msg, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?);";
    sqlite3_stmt* stmt;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) return false;

    // Get current time as ISO string
    time_t now = time(nullptr);
    char tsBuf[32];
    strftime(tsBuf, sizeof(tsBuf), "%Y-%m-%dT%H:%M:%SZ", gmtime(&now));

    sqlite3_bind_text(stmt, 1, user.callsign.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, user.role.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, user.clearance.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 4, user.publicKey.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 5, tsBuf, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 6, user.statusMsg.empty() ? "Active" : user.statusMsg.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 7, user.expiresAt.c_str(), -1, SQLITE_TRANSIENT);

    bool ok = (sqlite3_step(stmt) == SQLITE_DONE);
    sqlite3_finalize(stmt);
    return ok;
}

bool Database::updateHeartbeat(const std::string& callsign, const std::string& statusMsg) {
    const char* sql = "UPDATE Users SET last_seen = ?, status_msg = ? WHERE callsign = ?;";
    sqlite3_stmt* stmt;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) return false;

    time_t now = time(nullptr);
    char tsBuf[32];
    strftime(tsBuf, sizeof(tsBuf), "%Y-%m-%dT%H:%M:%SZ", gmtime(&now));

    sqlite3_bind_text(stmt, 1, tsBuf, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, statusMsg.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, callsign.c_str(), -1, SQLITE_TRANSIENT);

    bool ok = (sqlite3_step(stmt) == SQLITE_DONE);
    sqlite3_finalize(stmt);
    return ok;
}

bool Database::updateStatus(const std::string& callsign, const std::string& statusMsg) {
    const char* sql = "UPDATE Users SET status_msg = ? WHERE callsign = ?;";
    sqlite3_stmt* stmt;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) return false;
    sqlite3_bind_text(stmt, 1, statusMsg.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, callsign.c_str(), -1, SQLITE_TRANSIENT);
    bool ok = (sqlite3_step(stmt) == SQLITE_DONE);
    sqlite3_finalize(stmt);
    return ok;
}

std::vector<User> Database::getAllUsers() {
    deleteExpiredUsers();
    std::vector<User> users;
    const char* sql = "SELECT callsign, role, clearance, public_key, last_seen, status_msg, expires_at FROM Users;";
    sqlite3_stmt* stmt;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) return users;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        auto text = [&](int col) -> std::string {
            const char* p = reinterpret_cast<const char*>(sqlite3_column_text(stmt, col));
            return p ? p : "";
        };
        users.emplace_back(text(0), text(1), text(2), text(3), text(4), text(5), text(6));
    }
    sqlite3_finalize(stmt);
    return users;
}

User Database::getUser(const std::string& callsign) {
    User user("", "", "");
    const char* sql = "SELECT callsign, role, clearance, public_key, last_seen, status_msg, expires_at FROM Users WHERE callsign = ?;";
    sqlite3_stmt* stmt;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) return user;
    sqlite3_bind_text(stmt, 1, callsign.c_str(), -1, SQLITE_TRANSIENT);
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        auto text = [&](int col) -> std::string {
            const char* p = reinterpret_cast<const char*>(sqlite3_column_text(stmt, col));
            return p ? p : "";
        };
        user = User(text(0), text(1), text(2), text(3), text(4), text(5), text(6));
    }
    sqlite3_finalize(stmt);
    return user;
}

// ── Message Operations ───────────────────────────────────────────────────────

bool Database::addMessage(const Message& msg) {
    const char* sql =
        "INSERT INTO Messages (sender, receiver, subject, classification, "
        "encrypted_body, encrypted_aes_key, timestamp, reply_to_id, expires_at, reactions, is_read) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 0);";
    sqlite3_stmt* stmt;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) return false;

    sqlite3_bind_text(stmt, 1, msg.senderCallsign.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, msg.receiverCallsign.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, msg.subject.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 4, msg.classification.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 5, msg.encryptedBody.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 6, msg.encryptedAesKey.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 7, msg.timestamp.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 8, msg.replyToId);
    sqlite3_bind_text(stmt, 9, msg.expiresAt.c_str(), -1, SQLITE_TRANSIENT);

    bool ok = (sqlite3_step(stmt) == SQLITE_DONE);
    sqlite3_finalize(stmt);
    return ok;
}

// Helper lambda to build a Message from a sqlite3_stmt row
static Message msgFromStmt(sqlite3_stmt* stmt) {
    auto text = [&](int col) -> std::string {
        const char* p = reinterpret_cast<const char*>(sqlite3_column_text(stmt, col));
        return p ? p : "";
    };
    return Message(
        sqlite3_column_int(stmt, 0),   // id
        text(1), text(2), text(3), text(4), text(5), text(6), text(7),
        sqlite3_column_int(stmt, 8),   // replyToId
        text(9),                        // expiresAt
        text(10),                       // reactions
        sqlite3_column_int(stmt, 11)   // isRead
    );
}

std::vector<Message> Database::getInbox(const std::string& callsign) {
    deleteExpiredUsers();
    std::vector<Message> messages;
    const char* sql =
        "SELECT id, sender, receiver, subject, classification, encrypted_body, encrypted_aes_key, "
        "timestamp, reply_to_id, expires_at, reactions, is_read "
        "FROM Messages WHERE receiver = ? ORDER BY id ASC;";
    sqlite3_stmt* stmt;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) return messages;
    sqlite3_bind_text(stmt, 1, callsign.c_str(), -1, SQLITE_TRANSIENT);
    while (sqlite3_step(stmt) == SQLITE_ROW) messages.push_back(msgFromStmt(stmt));
    sqlite3_finalize(stmt);
    return messages;
}

std::vector<Message> Database::getSent(const std::string& callsign) {
    deleteExpiredUsers();
    std::vector<Message> messages;
    const char* sql =
        "SELECT id, sender, receiver, subject, classification, encrypted_body, encrypted_aes_key, "
        "timestamp, reply_to_id, expires_at, reactions, is_read "
        "FROM Messages WHERE sender = ? ORDER BY id ASC;";
    sqlite3_stmt* stmt;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) return messages;
    sqlite3_bind_text(stmt, 1, callsign.c_str(), -1, SQLITE_TRANSIENT);
    while (sqlite3_step(stmt) == SQLITE_ROW) messages.push_back(msgFromStmt(stmt));
    sqlite3_finalize(stmt);
    return messages;
}

bool Database::deleteMessage(int id) {
    const char* sql = "DELETE FROM Messages WHERE id = ?;";
    sqlite3_stmt* stmt;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) return false;
    sqlite3_bind_int(stmt, 1, id);
    bool ok = (sqlite3_step(stmt) == SQLITE_DONE);
    sqlite3_finalize(stmt);
    return ok;
}

bool Database::deleteExpiredMessages() {
    time_t now = time(nullptr);
    char tsBuf[32];
    strftime(tsBuf, sizeof(tsBuf), "%Y-%m-%dT%H:%M:%SZ", gmtime(&now));
    const char* sql = "DELETE FROM Messages WHERE expires_at != '' AND expires_at <= ?;";
    sqlite3_stmt* stmt;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) return false;
    sqlite3_bind_text(stmt, 1, tsBuf, -1, SQLITE_TRANSIENT);
    bool ok = (sqlite3_step(stmt) == SQLITE_DONE);
    sqlite3_finalize(stmt);
    return ok;
}

bool Database::deleteExpiredUsers() {
    time_t now = time(nullptr);
    char tsBuf[32];
    strftime(tsBuf, sizeof(tsBuf), "%Y-%m-%dT%H:%M:%SZ", gmtime(&now));
    const char* sql = "DELETE FROM Users WHERE expires_at != '' AND expires_at <= ?;";
    sqlite3_stmt* stmt;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) return false;
    sqlite3_bind_text(stmt, 1, tsBuf, -1, SQLITE_TRANSIENT);
    bool ok = (sqlite3_step(stmt) == SQLITE_DONE);
    sqlite3_finalize(stmt);
    return ok;
}

bool Database::markMessageRead(int id) {
    const char* sql = "UPDATE Messages SET is_read = 1 WHERE id = ?;";
    sqlite3_stmt* stmt;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) return false;
    sqlite3_bind_int(stmt, 1, id);
    bool ok = (sqlite3_step(stmt) == SQLITE_DONE);
    sqlite3_finalize(stmt);
    return ok;
}

bool Database::updateReactions(int id, const std::string& reactionsJson) {
    const char* sql = "UPDATE Messages SET reactions = ? WHERE id = ?;";
    sqlite3_stmt* stmt;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) return false;
    sqlite3_bind_text(stmt, 1, reactionsJson.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 2, id);
    bool ok = (sqlite3_step(stmt) == SQLITE_DONE);
    sqlite3_finalize(stmt);
    return ok;
}

std::vector<Message> Database::searchMessages(const std::string& callsign, const std::string& query) {
    // Note: encrypted_body is ciphertext — search is over timestamp/sender/receiver only
    // Full plaintext search would require client-side decryption
    std::vector<Message> messages;
    const char* sql =
        "SELECT id, sender, receiver, subject, classification, encrypted_body, encrypted_aes_key, "
        "timestamp, reply_to_id, expires_at, reactions, is_read "
        "FROM Messages WHERE (sender = ? OR receiver = ?) "
        "AND (sender LIKE ? OR receiver LIKE ?) ORDER BY id ASC;";
    sqlite3_stmt* stmt;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) return messages;
    std::string like = "%" + query + "%";
    sqlite3_bind_text(stmt, 1, callsign.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, callsign.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, like.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 4, like.c_str(), -1, SQLITE_TRANSIENT);
    while (sqlite3_step(stmt) == SQLITE_ROW) messages.push_back(msgFromStmt(stmt));
    sqlite3_finalize(stmt);
    return messages;
}

bool Database::deleteAllUserData(const std::string& callsign) {
    sqlite3_stmt* stmt;

    const char* sqlMsgs = "DELETE FROM Messages WHERE sender = ? OR receiver = ?;";
    if (sqlite3_prepare_v2(db, sqlMsgs, -1, &stmt, nullptr) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, callsign.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmt, 2, callsign.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_step(stmt);
    }
    sqlite3_finalize(stmt);

    const char* sqlUsers = "DELETE FROM Users WHERE callsign = ?;";
    if (sqlite3_prepare_v2(db, sqlUsers, -1, &stmt, nullptr) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, callsign.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_step(stmt);
    }
    sqlite3_finalize(stmt);

    return true;
}
