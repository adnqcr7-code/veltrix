#include "vile/url.hpp"

#include <algorithm>
#include <cctype>
#include <optional>

namespace vile {

const std::vector<Bang>& bangs() {
    static const std::vector<Bang> kBangs = {
        {"w", "Wikipedia", "https://en.wikipedia.org/",
         "https://en.wikipedia.org/w/index.php?search={q}"},
        {"gh", "GitHub", "https://github.com", "https://github.com/search?q={q}"},
        {"yt", "YouTube", "https://www.youtube.com",
         "https://www.youtube.com/results?search_query={q}"},
        {"so", "Stack Overflow", "https://stackoverflow.com",
         "https://stackoverflow.com/search?q={q}"},
        {"mdn", "MDN Web Docs", "https://developer.mozilla.org/",
         "https://developer.mozilla.org/en-US/search?q={q}"},
        {"r", "Reddit", "https://www.reddit.com", "https://www.reddit.com/search/?q={q}"},
        {"g", "Google", "https://www.google.com", "https://www.google.com/search?q={q}"},
    };
    return kBangs;
}

const Bang* find_bang(const std::string& name) {
    std::string n = name;
    std::transform(n.begin(), n.end(), n.begin(),
                   [](unsigned char c) { return std::tolower(c); });
    for (const auto& b : bangs())
        if (b.name == n) return &b;
    return nullptr;
}

namespace {

std::string trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && std::isspace(static_cast<unsigned char>(s[b]))) ++b;
    while (e > b && std::isspace(static_cast<unsigned char>(s[e - 1]))) --e;
    return s.substr(b, e - b);
}

std::string lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
    return s;
}

bool starts_with(const std::string& s, const char* p) { return s.rfind(p, 0) == 0; }

bool has_space(const std::string& s) {
    return std::any_of(s.begin(), s.end(), [](unsigned char c) { return std::isspace(c); });
}

// Heuristic: does this bare string look like a host (optionally with port/path)?
bool looks_like_host(const std::string& s) {
    if (s.empty() || has_space(s)) return false;
    size_t end = s.find_first_of("/?#");
    std::string hostport = s.substr(0, end);
    std::string host = hostport.substr(0, hostport.find(':'));
    if (host.empty()) return false;
    if (lower(host) == "localhost") return true;
    size_t dot = host.find('.');
    return dot != std::string::npos && dot > 0 && dot + 1 < host.size() && host.back() != '.';
}

}  // namespace

std::string percent_encode(const std::string& s) {
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : s) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            out += static_cast<char>(c);
        } else if (c == ' ') {
            out += '+';
        } else {
            out += '%';
            out += hex[c >> 4];
            out += hex[c & 0xF];
        }
    }
    return out;
}

ResolvedInput resolve_address_input(const std::string& raw) {
    return resolve_address_input(raw, default_search_engine());
}

ResolvedInput resolve_address_input(const std::string& raw, const SearchEngine& engine) {
    std::string in = trim(raw);
    if (in.empty()) return {ResolvedInput::Kind::Rejected, {}};
    std::string l = lower(in);

    // Schemes that must never be loadable from the address bar.
    for (const char* bad : {"javascript:", "data:", "blob:", "vbscript:"}) {
        if (starts_with(l, bad)) return {ResolvedInput::Kind::Rejected, {}};
    }

    if (starts_with(l, "http://") || starts_with(l, "https://") || starts_with(l, "file://"))
        return {ResolvedInput::Kind::Url, in};
    if (l == "about:blank") return {ResolvedInput::Kind::Url, "about:blank"};
    if (l == "about:settings") return {ResolvedInput::Kind::Url, "about:settings"};

    // !bangs, resolved locally (Helium-style): the bang is the first or the
    // last token, e.g. "!w rust" or "rust !gh". Unknown bangs fall through to
    // the default search, which may resolve them itself.
    auto try_bang = [](const std::string& token, const std::string& query)
        -> std::optional<ResolvedInput> {
        if (token.size() < 2 || token[0] != '!') return std::nullopt;
        const Bang* b = find_bang(token.substr(1));
        if (!b) return std::nullopt;
        std::string q = trim(query);
        if (q.empty()) return ResolvedInput{ResolvedInput::Kind::Url, b->home};
        std::string url = b->url_template;
        auto pos = url.find("{q}");
        if (pos != std::string::npos) url.replace(pos, 3, percent_encode(q));
        return ResolvedInput{ResolvedInput::Kind::Url, url};
    };
    size_t first_space = in.find(' ');
    if (first_space == std::string::npos) {
        if (auto r = try_bang(in, "")) return *r;
    } else {
        if (auto r = try_bang(in.substr(0, first_space), in.substr(first_space + 1)))
            return *r;
        size_t last_space = in.rfind(' ');
        std::string last_token = in.substr(last_space + 1);
        if (last_token != in.substr(0, first_space))
            if (auto r = try_bang(last_token, in.substr(0, last_space))) return *r;
    }

    // Any other explicit scheme (ftp://, chrome://, ...) is refused.
    if (l.find("://") != std::string::npos && !has_space(in))
        return {ResolvedInput::Kind::Rejected, {}};

    if (looks_like_host(in)) {
        bool local = starts_with(l, "localhost") || starts_with(l, "127.0.0.1");
        return {ResolvedInput::Kind::Url, std::string(local ? "http://" : "https://") + in};
    }

    return {ResolvedInput::Kind::Search, build_search_url(engine, in)};
}

bool is_safe_to_record(const std::string& url) {
    return starts_with(url, "http://") || starts_with(url, "https://");
}

}  // namespace vile
