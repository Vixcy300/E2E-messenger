#pragma once
#include <string>

// Represents a user in the system
class User {
public:
    std::string callsign;
    std::string role;
    std::string clearance;
    std::string publicKey;   // RSA Public Key for E2EE
    std::string lastSeen;    // ISO timestamp of last heartbeat
    std::string statusMsg;   // Custom status message
    std::string expiresAt;   // ISO timestamp of account expiration

    User(std::string c, std::string r, std::string cl,
         std::string pk = "", std::string ls = "", std::string sm = "", std::string exp = "")
        : callsign(c), role(r), clearance(cl), publicKey(pk), lastSeen(ls), statusMsg(sm), expiresAt(exp) {}
};

// Represents an End-to-End Encrypted message
class Message {
public:
    int id;
    std::string senderCallsign;
    std::string receiverCallsign;
    std::string subject;
    std::string classification;
    std::string encryptedBody;     // AES-GCM Encrypted Payload
    std::string encryptedAesKey;   // AES Key encrypted with Receiver's RSA Public Key
    std::string timestamp;
    int replyToId;                 // ID of message being replied to (-1 = none)
    std::string expiresAt;         // ISO timestamp for self-destruct ("" = never)
    std::string reactions;         // JSON: {"👍":["alice","bob"], "❤️":["carol"]}
    int isRead;                    // 0 = unread, 1 = read

    Message(int id, std::string sender, std::string receiver,
            std::string subj, std::string cls,
            std::string encBody, std::string encKey, std::string ts,
            int replyTo = -1, std::string exp = "", std::string react = "{}", int read = 0)
        : id(id), senderCallsign(sender), receiverCallsign(receiver), subject(subj),
          classification(cls), encryptedBody(encBody), encryptedAesKey(encKey), timestamp(ts),
          replyToId(replyTo), expiresAt(exp), reactions(react), isRead(read) {}
};
