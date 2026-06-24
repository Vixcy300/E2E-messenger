#pragma once
#include <string>
#include <vector>
#include "Models.hpp"
#include "../include/sqlite3.h"

class Database {
private:
    sqlite3* db;
    static Database* instance;
    Database();

public:
    static Database* getInstance();
    ~Database();

    bool initialize();

    // User Operations
    bool addUser(const User& user);
    User getUser(const std::string& callsign);
    std::vector<User> getAllUsers();
    bool updateHeartbeat(const std::string& callsign, const std::string& statusMsg);
    bool updateStatus(const std::string& callsign, const std::string& statusMsg);

    // Message Operations
    bool addMessage(const Message& msg);
    std::vector<Message> getInbox(const std::string& callsign);
    std::vector<Message> getSent(const std::string& callsign);
    bool deleteMessage(int id);
    bool deleteExpiredMessages();
    bool deleteAllUserData(const std::string& callsign);
    bool markMessageRead(int id);
    bool updateReactions(int id, const std::string& reactionsJson);
    std::vector<Message> searchMessages(const std::string& callsign, const std::string& query);
};
