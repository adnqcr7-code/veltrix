#pragma once
// Address-bar input handling. Pure logic, no engine or UI dependencies.
#include <string>
#include <vector>

#include "vile/search_engines.hpp"

namespace vile {

// !bangs, resolved locally (Helium-style): "!w rust" searches Wikipedia,
// "rust !gh" searches GitHub. A bare "!w" opens the site's home page.
struct Bang {
    std::string name;          // without the '!'
    std::string site;          // display name, e.g. "Wikipedia"
    std::string home;          // what a bare "!name" opens
    std::string url_template;  // contains "{q}" for the percent-encoded query
};
const std::vector<Bang>& bangs();
const Bang* find_bang(const std::string& name);  // name without '!', case-insensitive

struct ResolvedInput {
    enum class Kind { Url, Search, Rejected };
    Kind kind = Kind::Rejected;
    std::string url;  // Final URL to load (empty when Rejected)
};

// Turns whatever the user typed into something safe to load:
//   "example.com"        -> https://example.com
//   "localhost:3000"     -> http://localhost:3000
//   "rust borrow checker"-> search URL
//   "javascript:..."     -> Rejected (never loadable from the address bar)
ResolvedInput resolve_address_input(const std::string& raw);  // searches via default_search_engine()
ResolvedInput resolve_address_input(const std::string& raw, const SearchEngine& engine);

// Only real web pages go into history (not about:, file:, etc).
bool is_safe_to_record(const std::string& url);

std::string percent_encode(const std::string& s);

}  // namespace vile
