#pragma once
// vile-storage: local-only SQLite persistence. Nothing here touches the network.
#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

struct sqlite3;

namespace vile {

class Database {
public:
    // path may be ":memory:". File databases are created with 0600 permissions
    // and secure_delete on, so cleared history is overwritten, not just unlinked.
    explicit Database(const std::string& path);
    ~Database();
    Database(const Database&) = delete;
    Database& operator=(const Database&) = delete;
    Database(Database&&) noexcept;
    Database& operator=(Database&&) noexcept;

    void exec(const char* sql);
    int schema_version() const;

private:
    // The raw handle is an implementation detail of the stores in
    // storage.cpp — friended, not public, so nothing else can build
    // SQL against the user's database behind the stores' backs.
    sqlite3* handle() const { return db_; }
    friend class HistoryStore;
    friend class BookmarkStore;
    friend class SettingsStore;

    void migrate();
    sqlite3* db_ = nullptr;
};

struct HistoryEntry {
    std::string url;
    std::string title;
    int visit_count = 0;
    std::int64_t last_visit = 0;  // unix seconds
};

class HistoryStore {
public:
    explicit HistoryStore(Database& db) : db_(db) {}
    void record_visit(const std::string& url, const std::string& title, std::int64_t when = 0);
    // One row per VISIT (schema v2's visits table), newest first —
    // what a history panel actually lists. A visit row's title is
    // the title known when the visit was recorded; unlike the
    // aggregate it is not healed by later visits, so readers fall
    // back to the host when it is empty. recent()/search() below
    // read the per-URL aggregate used for counts and most-visited.
    std::vector<HistoryEntry> recent_visits(int limit = 50) const;
    std::vector<HistoryEntry> search_visits(const std::string& query, int limit = 50) const;
    std::vector<HistoryEntry> recent(int limit = 50) const;
    std::vector<HistoryEntry> most_visited(int limit = 8) const;
    std::vector<HistoryEntry> search(const std::string& query, int limit = 50) const;
    void remove(const std::string& url);
    void clear();
    // The ranged half of "clear browsing data": visits at or after
    // the cutoff (unix seconds) are deleted, and each touched URL's
    // aggregate is reconciled from its surviving visits (count,
    // last visit, title) or removed when none survive. Runs in one
    // transaction; see the implementation comment for the details
    // and the prune caveat.
    void clear_since(std::int64_t cutoff);

private:
    void clear_since_impl(std::int64_t cutoff);
    Database& db_;
    mutable int visits_since_prune_ = 0;
};

struct Bookmark {
    std::int64_t id = 0;
    std::string url;
    std::string title;
};

class BookmarkStore {
public:
    explicit BookmarkStore(Database& db) : db_(db) {}
    std::int64_t add(const std::string& url, const std::string& title);  // idempotent per URL
    bool remove(std::int64_t id);
    bool contains(const std::string& url) const;
    std::vector<Bookmark> list() const;

private:
    Database& db_;
};

class SettingsStore {
public:
    explicit SettingsStore(Database& db) : db_(db) {}
    void set(const std::string& key, const std::string& value);
    // All-or-nothing multi-key write: the pairs land in one transaction,
    // so a crash mid-save can't leave a torn configuration behind. For a
    // privacy browser, settings ARE policy — policy writes are atomic.
    void set_many(const std::vector<std::pair<std::string, std::string>>& pairs);
    std::optional<std::string> get(const std::string& key) const;
    std::string get_or(const std::string& key, const std::string& fallback) const;

private:
    Database& db_;
};

}  // namespace vile
