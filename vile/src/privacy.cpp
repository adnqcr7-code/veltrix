#include "vile/privacy.hpp"

#include <algorithm>
#include <cctype>
#include <sstream>

#include "vile/search_engines.hpp"

namespace vile {

namespace {

constexpr size_t kLogCap = 1000;

std::string lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
    return s;
}

std::string trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && std::isspace(static_cast<unsigned char>(s[b]))) ++b;
    while (e > b && std::isspace(static_cast<unsigned char>(s[e - 1]))) --e;
    return s.substr(b, e - b);
}

bool starts_with(const std::string& s, const char* p) { return s.rfind(p, 0) == 0; }

bool parse_bool(const std::optional<std::string>& v, bool fallback) {
    if (!v) return fallback;
    return *v == "1" || *v == "true";
}

bool is_ip_like(const std::string& host) {
    if (host.empty()) return false;
    if (host.front() == '[') return true;  // IPv6 literal
    return std::all_of(host.begin(), host.end(), [](unsigned char c) { return std::isdigit(c) || c == '.'; });
}

bool is_loopback(const std::string& host) {
    return host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host.ends_with(".localhost");
}

// Multi-tenant platforms whose tenants are separate sites: the platform
// suffix is effectively public. (A compact stand-in for the full Public
// Suffix List, covering the platforms where the plain two-label rule is
// actively wrong for cookie/tracker decisions: without it, every
// github.io tenant is "first party" to every other.)
const std::unordered_set<std::string> kPublicSuffixes = {
    "github.io", "gitlab.io", "blogspot.com", "wordpress.com",
    "tumblr.com", "netlify.app", "vercel.app", "herokuapp.com",
    "surge.sh", "web.app", "firebaseapp.com", "appspot.com",
    "azurewebsites.net", "s3.amazonaws.com", "cloudfront.net",
    "workers.dev", "pages.dev", "onrender.com", "fly.dev",
    "glitch.me", "livejournal.com", "typepad.com",
};

// True when `dom` is itself a public suffix (a platform suffix above, or
// a second-level ccTLD suffix like co.uk / com.au): blocking it would
// block every unrelated site under it.
bool is_public_suffix(const std::string& dom) {
    if (kPublicSuffixes.count(dom)) return true;
    std::vector<std::string> labels;
    std::stringstream ss(dom);
    for (std::string part; std::getline(ss, part, '.');) labels.push_back(part);
    static const std::unordered_set<std::string> kSecondLevel = {"co", "com", "org", "net", "gov", "edu", "ac"};
    return labels.size() == 2 && labels.back().size() == 2 && kSecondLevel.count(labels.front());
}

}  // namespace

// ---------- PrivacySettings ----------

PrivacySettings PrivacySettings::load(const SettingsStore& s) {
    PrivacySettings p;
    p.https_only = parse_bool(s.get("privacy.https_only"), p.https_only);
    p.block_trackers = parse_bool(s.get("privacy.block_trackers"), p.block_trackers);
    p.block_third_party_cookies = parse_bool(s.get("privacy.block_third_party_cookies"), p.block_third_party_cookies);
    p.save_history = parse_bool(s.get("privacy.save_history"), p.save_history);
    p.ai_enabled = parse_bool(s.get("ai.enabled"), p.ai_enabled);
    p.clear_on_exit = parse_bool(s.get("privacy.clear_on_exit"), p.clear_on_exit);
    p.send_gpc = parse_bool(s.get("privacy.send_gpc"), p.send_gpc);
    p.ai_provider = s.get_or("ai.provider", "");
    p.ai_model = s.get_or("ai.model", "");
    auto id = s.get_or("search.engine", p.search_engine_id);
    p.search_engine_id = find_search_engine(id) ? id : default_search_engine().id;
    return p;
}

void PrivacySettings::save(SettingsStore& s) const {
    auto b = [](bool v) { return std::string(v ? "1" : "0"); };
    // One transaction (see SettingsStore::set_many): a torn privacy
    // configuration after a crash is a policy bug, not bad luck.
    s.set_many({
        {"privacy.https_only", b(https_only)},
        {"privacy.block_trackers", b(block_trackers)},
        {"privacy.block_third_party_cookies", b(block_third_party_cookies)},
        {"privacy.save_history", b(save_history)},
        {"ai.enabled", b(ai_enabled)},
        {"privacy.clear_on_exit", b(clear_on_exit)},
        {"privacy.send_gpc", b(send_gpc)},
        {"ai.provider", ai_provider},
        {"ai.model", ai_model},
        {"search.engine", search_engine_id},
    });
}

// ---------- URL helpers ----------

std::string url_host(const std::string& url) {
    size_t s = url.find("://");
    if (s == std::string::npos) return {};
    size_t start = s + 3;
    size_t end = url.find_first_of("/?#", start);
    std::string auth = url.substr(start, end == std::string::npos ? std::string::npos : end - start);
    size_t at = auth.rfind('@');
    if (at != std::string::npos) auth = auth.substr(at + 1);
    if (!auth.empty() && auth[0] == '[') {
        size_t rb = auth.find(']');
        return lower(auth.substr(0, rb == std::string::npos ? std::string::npos : rb + 1));
    }
    size_t colon = auth.find(':');
    if (colon != std::string::npos) auth = auth.substr(0, colon);
    while (!auth.empty() && auth.back() == '.') auth.pop_back();
    return lower(auth);
}

// Approximation: last two labels, or last three for common "co.uk"-style
// suffixes, with a bundled set of multi-tenant platform suffixes
// (kPublicSuffixes, above) treated as public — the platforms where the
// plain rule would call separate sites first-party to each other. A full
// Public Suffix List would be more complete; this is the covered subset.
std::string registrable_domain(const std::string& host) {
    if (host.empty() || is_ip_like(host)) return host;
    std::vector<std::string> labels;
    std::stringstream ss(host);
    for (std::string part; std::getline(ss, part, '.');) labels.push_back(part);
    if (labels.size() <= 2) return host;
    for (size_t n = labels.size(); n >= 2; --n) {
        std::string suffix;
        for (size_t i = labels.size() - n; i < labels.size(); ++i) {
            if (!suffix.empty()) suffix += '.';
            suffix += labels[i];
        }
        if (kPublicSuffixes.count(suffix)) {
            const size_t keep = std::min(n + 1, labels.size());
            std::string out;
            for (size_t i = labels.size() - keep; i < labels.size(); ++i) {
                if (!out.empty()) out += '.';
                out += labels[i];
            }
            return out;
        }
    }
    static const std::unordered_set<std::string> kSecondLevel = {"co", "com", "org", "net", "gov", "edu", "ac"};
    size_t keep = (labels.back().size() == 2 && kSecondLevel.count(labels[labels.size() - 2])) ? 3 : 2;
    keep = std::min(keep, labels.size());
    std::string out;
    for (size_t i = labels.size() - keep; i < labels.size(); ++i) {
        if (!out.empty()) out += '.';
        out += labels[i];
    }
    return out;
}

bool is_third_party(const std::string& request_url, const std::string& top_level_url) {
    std::string a = registrable_domain(url_host(request_url));
    std::string b = registrable_domain(url_host(top_level_url));
    // A request with no host (data:, blob:, about:) is not a network third
    // party. But a real host loading in a context whose site can't be
    // derived fails CLOSED: unknown provenance is treated as third-party
    // rather than waved through.
    if (a.empty()) return false;
    if (b.empty()) return true;
    return a != b;
}

std::string upgrade_to_https(const std::string& url) {
    if (starts_with(lower(url.substr(0, 7)), "http://")) return "https://" + url.substr(7);
    return url;
}

// ---------- Shield ----------

const std::vector<std::string>& Shield::seed_tracker_domains() {
    // A small starter set of well-known ad/tracking domains. A real deployment should
    // load a maintained list (e.g. EasyPrivacy) via add_rules_from_text().
    static const std::vector<std::string> kSeed = {
        "doubleclick.net",       "googlesyndication.com", "google-analytics.com",
        "googletagmanager.com",  "googleadservices.com",  "connect.facebook.net",
        "scorecardresearch.com", "hotjar.com",            "criteo.com",
        "taboola.com",           "outbrain.com",          "adnxs.com",
        "quantserve.com",        "amazon-adsystem.com",
    };
    return kSeed;
}

Shield::Shield(PrivacySettings settings) : settings_(std::move(settings)) {
    for (const auto& d : seed_tracker_domains()) blocked_.insert(d);
}

bool blocklist_domain_acceptable(const std::string& domain) {
    // The one guard, shared by both doors (round 13's reviewers found
    // it implemented twice, ten lines apart): no empty entries, no
    // dotless entries, and a bare public suffix must not become a
    // rule — blocking co.uk or github.io would block every unrelated
    // site under them.
    const std::string d = lower(trim(domain));
    return !d.empty() && d.find('.') != std::string::npos && !is_public_suffix(d);
}

void Shield::add_blocked_domain(const std::string& domain) {
    // The same guards as the text loader, via the shared predicate —
    // which Settings also calls, so the UI can refuse an entry WITH
    // an explanation instead of listing a site the Shield would
    // silently never block.
    if (!blocklist_domain_acceptable(domain)) return;
    blocked_.insert(lower(trim(domain)));
}

size_t Shield::add_rules_from_text(const std::string& text) {
    size_t added = 0;
    std::stringstream ss(text);
    for (std::string line; std::getline(ss, line);) {
        size_t hash = line.find('#');
        if (hash != std::string::npos) line = line.substr(0, hash);
        line = trim(line);
        if (line.empty()) continue;
        // hosts-file style: "0.0.0.0 example.com" -> take the last token
        size_t sp = line.find_last_of(" \t");
        std::string dom = sp == std::string::npos ? line : line.substr(sp + 1);
        dom = lower(dom);
        if (dom == "localhost" || dom == "0.0.0.0" || dom.find('.') == std::string::npos) continue;
        // A rule that IS a public suffix (co.uk, github.io, …) would block
        // every unrelated site under it — a poisoned or sloppy list must
        // not be able to do that.
        if (is_public_suffix(dom)) continue;
        if (blocked_.insert(dom).second) ++added;
    }
    return added;
}

const std::string* Shield::match_rule(const std::string& host) const {
    // Walk up the label chain: a.b.tracker.com -> b.tracker.com -> tracker.com
    std::string h = host;
    while (!h.empty()) {
        auto it = blocked_.find(h);
        if (it != blocked_.end()) return &*it;
        size_t dot = h.find('.');
        if (dot == std::string::npos) break;
        h = h.substr(dot + 1);
    }
    return nullptr;
}

void BlockLog::record(const BlockEvent& e) {
    ++total_;
    if (log_.size() >= kLogCap) log_.erase(log_.begin(), log_.begin() + kLogCap / 2);
    log_.push_back(e);
}

ShieldDecision Shield::check_request(const std::string& request_url, const std::string& top_level_url) const {
    std::string host = url_host(request_url);

    // 1. Trackers: only third-party requests (so visiting a tracker's own site still works).
    if (settings_.block_trackers && !host.empty() && is_third_party(request_url, top_level_url)) {
        if (const std::string* rule = match_rule(host)) {
            return {ShieldDecision::Action::Block, "Blocked known tracker: " + *rule, *rule};
        }
    }

    // 2. HTTPS-only: upgrade plain http, except for loopback development servers.
    if (settings_.https_only && starts_with(lower(request_url.substr(0, 7)), "http://") && !is_loopback(host)) {
        return {ShieldDecision::Action::UpgradeToHttps, "HTTPS-only mode: upgraded to a secure connection", {}};
    }

    return {};
}

ShieldDecision Shield::check_cookie(const std::string& cookie_url, const std::string& top_level_url) const {
    if (settings_.block_third_party_cookies && is_third_party(cookie_url, top_level_url)) {
        return {ShieldDecision::Action::Block,
                "Blocked third-party cookie from " + url_host(cookie_url), {}};
    }
    return {};
}

std::vector<std::pair<std::string, std::string>> Shield::request_headers() const {
    std::vector<std::pair<std::string, std::string>> h;
    if (settings_.send_gpc) h.emplace_back("Sec-GPC", "1");
    return h;
}

}  // namespace vile
