#include "vile/storage.hpp"

#include <sqlite3.h>
#include <sys/stat.h>

#include <ctime>
#include <stdexcept>
#include <utility>

namespace vile {

namespace {

class Stmt {
public:
    Stmt(sqlite3* db, const char* sql) : db_(db) {
        if (sqlite3_prepare_v2(db, sql, -1, &s_, nullptr) != SQLITE_OK)
            throw std::runtime_error(std::string("sqlite prepare: ") + sqlite3_errmsg(db));
    }
    ~Stmt() { sqlite3_finalize(s_); }
    Stmt(const Stmt&) = delete;
    Stmt& operator=(const Stmt&) = delete;

    void bind(int i, const std::string& v) { sqlite3_bind_text(s_, i, v.c_str(), static_cast<int>(v.size()), SQLITE_TRANSIENT); }
    void bind(int i, std::int64_t v) { sqlite3_bind_int64(s_, i, v); }
    void bind(int i, int v) { sqlite3_bind_int(s_, i, v); }

    bool step() {
        int rc = sqlite3_step(s_);
        if (rc == SQLITE_ROW) return true;
        if (rc == SQLITE_DONE) return false;
        throw std::runtime_error(std::string("sqlite step: ") + sqlite3_errmsg(db_));
    }
    std::string text(int c) const {
        auto p = sqlite3_column_text(s_, c);
        return p ? reinterpret_cast<const char*>(p) : "";
    }
    std::int64_t i64(int c) const { return sqlite3_column_int64(s_, c); }

private:
    sqlite3* db_;
    sqlite3_stmt* s_ = nullptr;
};

std::int64_t now_or(std::int64_t t) { return t ? t : static_cast<std::int64_t>(std::time(nullptr)); }

std::string escape_like(const std::string& q) {
    std::string out;
    for (char c : q) {
        if (c == '%' || c == '_' || c == '\\') out += '\\';
        out += c;
    }
    return out;
}

constexpr int kSchemaVersion = 2;

}  // namespace

// ---------- Database ----------

Database::Database(const std::string& path) {
    if (sqlite3_open_v2(path.c_str(), &db_, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nullptr) != SQLITE_OK) {
        std::string msg = db_ ? sqlite3_errmsg(db_) : "out of memory";
        sqlite3_close(db_);
        db_ = nullptr;
        throw std::runtime_error("cannot open database: " + msg);
    }
    if (path != ":memory:") {
        ::chmod(path.c_str(), S_IRUSR | S_IWUSR);  // owner-only
        exec("PRAGMA journal_mode=WAL;");
    }
    exec("PRAGMA foreign_keys=ON;");
    exec("PRAGMA secure_delete=ON;");
    migrate();
    if (path != ":memory:") {
        // The WAL sidecars hold the same data as the database itself (the
        // most recent history, in fact): owner-only, like the main file.
        // They exist once the schema has been written under WAL.
        ::chmod((path + "-wal").c_str(), S_IRUSR | S_IWUSR);
        ::chmod((path + "-shm").c_str(), S_IRUSR | S_IWUSR);
    }
}

Database::~Database() { if (db_) sqlite3_close(db_); }

Database::Database(Database&& o) noexcept : db_(std::exchange(o.db_, nullptr)) {}

Database& Database::operator=(Database&& o) noexcept {
    if (this != &o) {
        if (db_) sqlite3_close(db_);
        db_ = std::exchange(o.db_, nullptr);
    }
    return *this;
}

void Database::exec(const char* sql) {
    char* err = nullptr;
    if (sqlite3_exec(db_, sql, nullptr, nullptr, &err) != SQLITE_OK) {
        std::string msg = err ? err : "unknown error";
        sqlite3_free(err);
        throw std::runtime_error("sqlite exec: " + msg);
    }
}

int Database::schema_version() const {
    Stmt s(db_, "PRAGMA user_version;");
    return s.step() ? static_cast<int>(s.i64(0)) : 0;
}

void Database::migrate() {
    int v = schema_version();
    if (v > kSchemaVersion) throw std::runtime_error("database is newer than this VILE version");
    if (v < 1) {
        exec("BEGIN;"
             "CREATE TABLE history("
             "  id INTEGER PRIMARY KEY,"
             "  url TEXT NOT NULL UNIQUE,"
             "  title TEXT NOT NULL DEFAULT '',"
             "  visit_count INTEGER NOT NULL DEFAULT 1,"
             "  last_visit INTEGER NOT NULL);"
             "CREATE INDEX idx_history_last_visit ON history(last_visit DESC);"
             "CREATE TABLE bookmarks("
             "  id INTEGER PRIMARY KEY,"
             "  url TEXT NOT NULL UNIQUE,"
             "  title TEXT NOT NULL DEFAULT '');"
             "CREATE TABLE settings("
             "  key TEXT PRIMARY KEY,"
             "  value TEXT NOT NULL);"
             "PRAGMA user_version=1;"
             "COMMIT;");
    }
    if (v < 2) {
        // Per-visit rows: the aggregate history table counts visits
        // per URL, which can never answer "what did I look at this
        // morning". visits keeps one row per visit; the aggregate
        // stays for counts and most-visited.
        exec("BEGIN;"
             "CREATE TABLE visits("
             "  id INTEGER PRIMARY KEY,"
             "  url TEXT NOT NULL,"
             "  title TEXT NOT NULL DEFAULT '',"
             "  visited_at INTEGER NOT NULL);"
             "CREATE INDEX idx_visits_at ON visits(visited_at DESC);"
             "PRAGMA user_version=2;"
             "COMMIT;");
    }
}

// ---------- HistoryStore ----------

void HistoryStore::record_visit(const std::string& url, const std::string& title, std::int64_t when) {
    Stmt s(db_.handle(),
           "INSERT INTO history(url,title,visit_count,last_visit) VALUES(?1,?2,1,?3) "
           "ON CONFLICT(url) DO UPDATE SET "
           "  title=CASE WHEN excluded.title<>'' THEN excluded.title ELSE title END,"
           "  visit_count=visit_count+1, last_visit=excluded.last_visit;");
    s.bind(1, url);
    s.bind(2, title);
    const std::int64_t at = now_or(when);
    s.bind(3, at);
    s.step();
    {
        Stmt v(db_.handle(), "INSERT INTO visits(url,title,visited_at) VALUES(?1,?2,?3);");
        v.bind(1, url);
        v.bind(2, title);
        v.bind(3, at);
        v.step();
    }
    // Retention cap: history must not grow without bound. Pruning is
    // batched (every 100 visits) so the DELETE isn't paid per page load.
    if (++visits_since_prune_ >= 100) {
        visits_since_prune_ = 0;
        db_.exec("DELETE FROM history WHERE id NOT IN "
                 "(SELECT id FROM history ORDER BY last_visit DESC, id DESC "
                 "LIMIT 10000);");
        db_.exec("DELETE FROM visits WHERE id NOT IN "
                 "(SELECT id FROM visits ORDER BY visited_at DESC, id DESC "
                 "LIMIT 10000);");
    }
}

static std::vector<HistoryEntry> read_history(Stmt& s) {
    std::vector<HistoryEntry> out;
    while (s.step()) {
        HistoryEntry e;
        e.url = s.text(0);
        e.title = s.text(1);
        e.visit_count = static_cast<int>(s.i64(2));
        e.last_visit = s.i64(3);
        out.push_back(std::move(e));
    }
    return out;
}

std::vector<HistoryEntry> HistoryStore::recent_visits(int limit) const {
    Stmt s(db_.handle(),
           "SELECT url,title,1,visited_at FROM visits "
           "ORDER BY visited_at DESC, id DESC LIMIT ?1;");
    s.bind(1, limit);
    return read_history(s);
}

std::vector<HistoryEntry> HistoryStore::search_visits(const std::string& query, int limit) const {
    Stmt s(db_.handle(),
           "SELECT url,title,1,visited_at FROM visits "
           "WHERE url LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\' "
           "ORDER BY visited_at DESC, id DESC LIMIT ?2;");
    s.bind(1, "%" + escape_like(query) + "%");
    s.bind(2, limit);
    return read_history(s);
}

std::vector<HistoryEntry> HistoryStore::recent(int limit) const {
    Stmt s(db_.handle(), "SELECT url,title,visit_count,last_visit FROM history ORDER BY last_visit DESC, id DESC LIMIT ?1;");
    s.bind(1, limit);
    return read_history(s);
}

std::vector<HistoryEntry> HistoryStore::most_visited(int limit) const {
    Stmt s(db_.handle(), "SELECT url,title,visit_count,last_visit FROM history ORDER BY visit_count DESC, last_visit DESC, id DESC LIMIT ?1;");
    s.bind(1, limit);
    return read_history(s);
}

std::vector<HistoryEntry> HistoryStore::search(const std::string& query, int limit) const {
    Stmt s(db_.handle(),
           "SELECT url,title,visit_count,last_visit FROM history "
           "WHERE url LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\' "
           "ORDER BY last_visit DESC, id DESC LIMIT ?2;");
    s.bind(1, "%" + escape_like(query) + "%");
    s.bind(2, limit);
    return read_history(s);
}

void HistoryStore::remove(const std::string& url) {
    Stmt s(db_.handle(), "DELETE FROM history WHERE url=?1;");
    s.bind(1, url);
    s.step();
    Stmt v(db_.handle(), "DELETE FROM visits WHERE url = ?1;");
    v.bind(1, url);
    v.step();
}

void HistoryStore::clear() {
    db_.exec("DELETE FROM history;");
    db_.exec("DELETE FROM visits;");
}

// Ranged clear: visits inside the range are deleted, then the
// aggregate is RECONCILED from what survives — a URL with visits
// left gets its remaining count, last visit and title recomputed
// from the surviving visits (never decremented by guesswork); a
// URL with none left loses its row. Aggregate rows with no visits
// at all (recorded before schema v2) keep the original rule: gone
// when their last visit is in range. Panel and most-visited
// therefore agree after a clear. The whole mutation runs in one
// transaction (SAVEPOINT, the house pattern from set_many): it is
// a collect + delete + per-URL update loop, and a crash mid-loop
// must not leave the aggregate permanently inconsistent with the
// visits table. One honesty note: the visits table is pruned to
// the newest 10k rows, so a recomputed count is the count of the
// visits that SURVIVE, which for very old URLs can be lower than
// the lifetime count the aggregate carried before.
void HistoryStore::clear_since(std::int64_t cutoff) {
    db_.exec("SAVEPOINT clear_since;");
    try {
        clear_since_impl(cutoff);
    } catch (...) {
        db_.exec("ROLLBACK TO clear_since;");
        db_.exec("RELEASE clear_since;");
        throw;
    }
    db_.exec("RELEASE clear_since;");
}

void HistoryStore::clear_since_impl(std::int64_t cutoff) {
    // URLs the range touches (they have visits inside it).
    std::vector<std::string> affected;
    {
        Stmt q(db_.handle(), "SELECT DISTINCT url FROM visits WHERE visited_at >= ?1;");
        q.bind(1, cutoff);
        while (q.step()) affected.push_back(q.text(0));
    }
    {
        Stmt v(db_.handle(), "DELETE FROM visits WHERE visited_at >= ?1;");
        v.bind(1, cutoff);
        v.step();
    }
    for (const std::string& url : affected) {
        Stmt cnt(db_.handle(),
                 "SELECT COUNT(*), COALESCE(MAX(visited_at), 0) FROM visits WHERE url = ?1;");
        cnt.bind(1, url);
        cnt.step();
        const long long remaining = cnt.i64(0);
        if (remaining == 0) {
            Stmt del(db_.handle(), "DELETE FROM history WHERE url = ?1;");
            del.bind(1, url);
            del.step();
        } else {
            // The title reconciles too: the surviving LATEST visit
            // names the row now, so a cleared visit's title cannot
            // outlive the visit that carried it (round 12).
            std::string title;
            {
                // The latest surviving NON-EMPTY title: record_visit's
                // upsert never lets an empty title clobber a real one
                // (storage.cpp:156), and the reconcile follows the
                // same rule (round 13's architect) — a page that
                // reported no title on its last surviving visit must
                // not erase the title an earlier visit earned.
                Stmt t(db_.handle(),
                       "SELECT title FROM visits WHERE url = ?1 AND title <> '' "
                       "ORDER BY visited_at DESC LIMIT 1;");
                t.bind(1, url);
                if (t.step()) title = t.text(0);
            }
            Stmt upd(db_.handle(),
                     "UPDATE history SET visit_count = ?2, last_visit = ?3, title = ?4 "
                     "WHERE url = ?1;");
            upd.bind(1, url);
            upd.bind(2, static_cast<std::int64_t>(remaining));
            upd.bind(3, cnt.i64(1));
            upd.bind(4, title);
            upd.step();
        }
    }
    // Pre-v2 aggregate rows (no visits were ever recorded for them).
    {
        Stmt pre(db_.handle(),
                 "DELETE FROM history WHERE last_visit >= ?1 "
                 "AND url NOT IN (SELECT url FROM visits);");
        pre.bind(1, cutoff);
        pre.step();
    }
}

// ---------- BookmarkStore ----------

std::int64_t BookmarkStore::add(const std::string& url, const std::string& title) {
    {
        Stmt s(db_.handle(), "INSERT INTO bookmarks(url,title) VALUES(?1,?2) ON CONFLICT(url) DO UPDATE SET title=excluded.title;");
        s.bind(1, url);
        s.bind(2, title);
        s.step();
    }
    Stmt q(db_.handle(), "SELECT id FROM bookmarks WHERE url=?1;");
    q.bind(1, url);
    return q.step() ? q.i64(0) : 0;
}

bool BookmarkStore::remove(std::int64_t id) {
    Stmt s(db_.handle(), "DELETE FROM bookmarks WHERE id=?1 RETURNING id;");
    s.bind(1, id);
    return s.step();
}

bool BookmarkStore::contains(const std::string& url) const {
    Stmt s(db_.handle(), "SELECT 1 FROM bookmarks WHERE url=?1;");
    s.bind(1, url);
    return s.step();
}

std::vector<Bookmark> BookmarkStore::list() const {
    Stmt s(db_.handle(), "SELECT id,url,title FROM bookmarks ORDER BY id;");
    std::vector<Bookmark> out;
    while (s.step()) out.push_back({s.i64(0), s.text(1), s.text(2)});
    return out;
}

// ---------- SettingsStore ----------

void SettingsStore::set(const std::string& key, const std::string& value) {
    Stmt s(db_.handle(), "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value;");
    s.bind(1, key);
    s.bind(2, value);
    s.step();
}

void SettingsStore::set_many(const std::vector<std::pair<std::string, std::string>>& pairs) {
    // A SAVEPOINT, not a bare BEGIN: callers may already be inside a
    // transaction (Onboarding::apply is), and a savepoint nests cleanly
    // while still being atomic on its own.
    db_.exec("SAVEPOINT vile_set_many;");
    try {
        for (const auto& [key, value] : pairs) set(key, value);
        db_.exec("RELEASE vile_set_many;");
    } catch (...) {
        try {
            db_.exec("ROLLBACK TO vile_set_many;");
            db_.exec("RELEASE vile_set_many;");
        } catch (...) {
        }
        throw;
    }
}

std::optional<std::string> SettingsStore::get(const std::string& key) const {
    Stmt s(db_.handle(), "SELECT value FROM settings WHERE key=?1;");
    s.bind(1, key);
    if (s.step()) return s.text(0);
    return std::nullopt;
}

std::string SettingsStore::get_or(const std::string& key, const std::string& fallback) const {
    auto v = get(key);
    return v ? *v : fallback;
}

}  // namespace vile
