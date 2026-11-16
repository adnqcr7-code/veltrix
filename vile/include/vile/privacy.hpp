#pragma once
// VILE Shield core: persisted privacy settings plus request-level decisions.
// The engine layer asks Shield about every request; Shield never does I/O itself.
#include <cstddef>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

#include "vile/storage.hpp"

namespace vile {

struct PrivacySettings {
    bool https_only = true;
    bool block_trackers = true;
    bool block_third_party_cookies = true;
    bool save_history = false;   // maximum privacy: nothing recorded unless the user opts in
    bool clear_on_exit = true;   // wipe cookies and site data when VILE closes
    bool send_gpc = true;        // Global Privacy Control header (a request sites may ignore)
    bool ai_enabled = false;     // on-device AI is opt-in
    std::string ai_provider;     // "ollama" | "lmstudio" | "llamacpp"
    std::string ai_model;
    std::string search_engine_id = "brave";

    bool ai_ready() const { return ai_enabled && !ai_provider.empty() && !ai_model.empty(); }

    static PrivacySettings load(const SettingsStore&);
    void save(SettingsStore&) const;
};

struct ShieldDecision {
    enum class Action { Allow, Block, UpgradeToHttps };
    Action action = Action::Allow;
    std::string reason;  // human-readable, shown in the privacy dashboard
    std::string rule;    // matching blocklist domain, if any
};

struct BlockEvent {
    std::string request_url;
    std::string top_level_url;
    std::string reason;
    std::string rule;
};

// True when Shield::add_blocked_domain would accept this (already
// host-shaped) domain: non-empty, contains a dot, not a bare public
// suffix. Exposed for Settings' personal-blocklist validation.
bool blocklist_domain_acceptable(const std::string& domain);

class Shield {
public:
    explicit Shield(PrivacySettings settings = {});

    void set_settings(const PrivacySettings& s) { settings_ = s; }
    const PrivacySettings& settings() const { return settings_; }

    // Both checks are const: once built, a Shield is immutable, so it
    // can be shared across threads behind an atomic snapshot. Blocked
    // requests are NOT recorded by the Shield — the caller logs them
    // into a BlockLog, which is what keeps checking read-only.
    ShieldDecision check_request(const std::string& request_url, const std::string& top_level_url) const;
    ShieldDecision check_cookie(const std::string& cookie_url, const std::string& top_level_url) const;

    // Extra headers the engine should add to every outgoing request.
    std::vector<std::pair<std::string, std::string>> request_headers() const;

    // Accepts one domain per line, hosts-file style ("0.0.0.0 domain"), and '#' comments.
    // Returns the number of rules added.
    size_t add_rules_from_text(const std::string& text);
    void add_blocked_domain(const std::string& domain);
    size_t rule_count() const { return blocked_.size(); }

    static const std::vector<std::string>& seed_tracker_domains();

private:
    const std::string* match_rule(const std::string& host) const;

    PrivacySettings settings_;
    std::unordered_set<std::string> blocked_;
};

// What the Shield stopped, newest last, capped. Owned by whoever wires
// the engine up (in the app: ShieldAccess in the Qt layer), written by
// the engine's checking thread and read by the UI under the owner's
// lock.
class BlockLog {
public:
    void record(const BlockEvent& e);
    const std::vector<BlockEvent>& recent() const { return log_; }  // capped
    size_t total() const { return total_; }

private:
    std::vector<BlockEvent> log_;
    size_t total_ = 0;
};

// Helpers (exposed for tests and for the engine layer).
std::string url_host(const std::string& url);
std::string registrable_domain(const std::string& host);  // approximation, see privacy.cpp
bool is_third_party(const std::string& request_url, const std::string& top_level_url);
std::string upgrade_to_https(const std::string& url);

}  // namespace vile
