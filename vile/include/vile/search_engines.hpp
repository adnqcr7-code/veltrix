#pragma once
// Search engine catalog shown during first-run setup.
// The promise/downside text must stay factual and sourced: every entry carries
// the page its claims came from and the date they were last checked.
#include <string>
#include <vector>

namespace vile {

struct SearchEngine {
    std::string id;
    std::string name;
    std::string url_template;  // contains "{q}" for the percent-encoded query
    std::string promise;       // what the provider says it does
    std::string downside;      // honest tradeoffs
    std::string source_url;    // where the claims come from
    std::string checked_on;    // YYYY-MM-DD
    std::string summary;       // one or two blunt sentences for the setup card
};

const std::vector<SearchEngine>& search_engines();
const SearchEngine* find_search_engine(const std::string& id);
const SearchEngine& default_search_engine();  // Brave Search
std::string build_search_url(const SearchEngine&, const std::string& query);

}  // namespace vile
