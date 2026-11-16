#include "vile/search_engines.hpp"

#include "vile/url.hpp"

namespace vile {

const std::vector<SearchEngine>& search_engines() {
    static const std::vector<SearchEngine> kEngines = {
        {"duckduckgo", "DuckDuckGo", "https://duckduckgo.com/?q={q}&kae=d",
         "Says it doesn't save or share your search history, and doesn't log IP addresses "
         "or identifiers in a way that links them to your searches.",
         "Search ads go through Microsoft's ad network (DuckDuckGo says clicks aren't tied to "
         "a profile). Your internet provider can still see your IP, and sites you click "
         "through to have their own policies. These are the company's own claims; VILE "
         "can't verify them.",
         "https://duckduckgo.com/privacy", "2026-11-10",
         "Privacy-focused. Doesn't save your search history. Ads run through Microsoft."},

        {"brave", "Brave Search", "https://search.brave.com/search?q={q}",
         "Privacy-focused search with its own independent index; Brave says over 93% of "
         "results come from it.",
         "Brave says the rest come from anonymous checks of other search engines. Like other "
         "private engines it skips tracking-based personalization, so results are less "
         "tailored to you.",
         "https://brave.com/learn/private-vs-personalized-search/", "2026-11-10",
         "Privacy-focused, runs its own index. Some results come from other engines."},

        {"kagi", "Kagi", "https://kagi.com/search?q={q}",
         "States it has no ads and no tracking, and is fully funded by its users.",
         "Paid service: a free trial covers 100 searches, then plans start at $5/month "
         "(prices as of the check date and may change).",
         "https://kagi.com/pricing", "2026-11-10",
         "Privacy-focused. No ads or tracking. Paid after 100 free searches."},

        {"google", "Google", "https://www.google.com/search?q={q}",
         "Offers controls to review and delete your activity, including auto-delete.",
         "Google's privacy policy lists your search terms and IP address among the data it "
         "collects, and signed-in search activity can be saved to your account.",
         "https://policies.google.com/privacy", "2026-11-10",
         "Collects your searches and IP address. Signed-in activity can be saved to your account."},
    };
    return kEngines;
}

const SearchEngine* find_search_engine(const std::string& id) {
    for (const auto& e : search_engines())
        if (e.id == id) return &e;
    return nullptr;
}

const SearchEngine& default_search_engine() { return *find_search_engine("brave"); }

std::string build_search_url(const SearchEngine& engine, const std::string& query) {
    std::string url = engine.url_template;
    auto pos = url.find("{q}");
    if (pos != std::string::npos) url.replace(pos, 3, percent_encode(query));
    return url;
}

}  // namespace vile
