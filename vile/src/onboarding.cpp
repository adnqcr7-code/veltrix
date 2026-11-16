#include "vile/onboarding.hpp"

#include <stdexcept>

#include "vile/search_engines.hpp"

namespace vile {

namespace {

constexpr const char* kCompleteKey = "onboarding.complete";

std::vector<Question> base_questions() {
    std::vector<Question> qs;

    // 1. Search engine, with each provider's promise and honest downside.
    Question search;
    search.id = "search_engine";
    search.prompt = "Which search engine do you want to use?";
    search.default_id = default_search_engine().id;
    for (const auto& e : search_engines())
        search.options.push_back({e.id, e.name, e.promise, e.downside, e.source_url, e.summary});
    qs.push_back(std::move(search));

    qs.push_back({"https_only", "Always use secure connections (HTTPS)?",
                  {{"yes", "Yes, upgrade automatically", "Plain http:// links are upgraded to https://.",
                    "A few old sites that only support HTTP won't load.", ""},
                   {"no", "No", "Loads every site exactly as linked.",
                    "Your traffic to those sites can be read or changed on the network.", ""}},
                  "yes"});

    qs.push_back({"block_trackers", "Block known ad and tracker domains?",
                  {{"yes", "Yes, block them", "Third-party trackers are stopped, and you can see what was blocked.",
                    "Some sites can break or show missing content.", ""},
                   {"no", "No", "Nothing is blocked.", "Trackers can follow you across sites.", ""}},
                  "yes"});

    qs.push_back({"third_party_cookies", "What about third-party cookies?",
                  {{"block", "Block them", "Stops cross-site cookie tracking.",
                    "Some embedded logins and widgets may stop working.", ""},
                   {"allow", "Allow them", "Everything works as the site intended.",
                    "Cross-site tracking via cookies is possible.", ""}},
                  "block"});

    qs.push_back({"history", "Should VILE remember the pages you visit?",
                  {{"never", "No, never record history", "Nothing is recorded.",
                    "No address-bar suggestions from past visits.", ""},
                   {"save", "Yes, keep history on this computer", "Lets you find past pages and get suggestions.",
                    "Anyone with access to this account can see it.", ""}},
                  "never"});

    qs.push_back({"clear_on_exit", "Clear cookies and site data when you close VILE?",
                  {{"yes", "Yes, clear them", "Leaves no cookies or site data behind.",
                    "You'll sign in to sites again each time.", ""},
                   {"no", "No, keep them", "Stay signed in between visits.",
                    "Cookies and site data stay on this computer until you clear them.", ""}},
                  "yes"});

    return qs;
}

std::string join_names(const std::vector<LocalAiProvider>& d) {
    std::string out;
    for (size_t i = 0; i < d.size(); ++i) {
        if (i > 0) out += (i + 1 == d.size()) ? " and " : ", ";
        out += d[i].display_name;
    }
    return out;
}

// Short card text: where none was written, promise + downside is already short.
void fill_summaries(std::vector<Question>& qs) {
    for (auto& q : qs)
        for (auto& o : q.options)
            if (o.summary.empty()) o.summary = o.promise + (o.downside.empty() ? "" : " " + o.downside);
}

}  // namespace

const std::vector<Question>& Onboarding::questions() {
    static const std::vector<Question> kQuestions = [] {
        auto qs = base_questions();
        fill_summaries(qs);
        return qs;
    }();
    return kQuestions;
}

std::vector<Question> Onboarding::questions_for(const std::vector<LocalAiProvider>& detected) {
    std::vector<Question> qs = base_questions();

    if (!detected.empty()) {
        Question ai;
        ai.id = "local_ai";
        ai.prompt = "VILE found AI running on this computer (" + join_names(detected) +
                    "). Add an assistant that can read the page you're on and explain it?";
        ai.options = {
            {"no", "No", "No AI features.", "", "", "No AI features."},
            {"yes", "Yes, add the assistant",
             "Reads the page you're on and explains it. VILE only talks to AI running on this computer.",
             "Page text is given to the model you pick. Large models can be slow or memory-hungry.", "",
             "Explains the page you're on. VILE only talks to AI on this computer."},
        };
        ai.default_id = "no";
        qs.push_back(std::move(ai));

        Question model;
        model.id = "ai_model";
        model.prompt = "Which model should VILE use? Smaller models answer faster; larger ones usually answer "
                       "better. You can change this in Settings.";
        for (const auto& p : detected) {
            for (const auto& m : p.models) {
                std::string size = format_size(m.size_bytes);
                model.options.push_back({p.id + "|" + m.name, m.name,
                                         "Runs on this computer via " + p.display_name + ".", "", "",
                                         p.display_name + (size.empty() ? "" : " · " + size)});
            }
        }
        if (!model.options.empty()) model.default_id = model.options.front().id;
        qs.push_back(std::move(model));
    }

    fill_summaries(qs);
    return qs;
}

bool Onboarding::is_complete(const SettingsStore& s) {
    return s.get_or(kCompleteKey, "0") == "1";
}

std::string Onboarding::validate(const std::map<std::string, std::string>& answers,
                                 const std::vector<LocalAiProvider>& detected) {
    const auto qs = questions_for(detected);
    for (const auto& [qid, oid] : answers) {
        const Question* q = nullptr;
        for (const auto& cand : qs)
            if (cand.id == qid) q = &cand;
        if (!q) return "unknown question: " + qid;
        bool ok = false;
        for (const auto& o : q->options)
            if (o.id == oid) ok = true;
        if (!ok) return "invalid answer '" + oid + "' for question " + qid;
    }
    return {};
}

PrivacySettings Onboarding::apply(Database& db, const std::map<std::string, std::string>& answers,
                                  const std::vector<LocalAiProvider>& detected) {
    if (auto err = validate(answers, detected); !err.empty()) throw std::invalid_argument(err);

    const auto qs = questions_for(detected);
    auto pick = [&](const char* qid) {
        auto it = answers.find(qid);
        if (it != answers.end()) return it->second;
        for (const auto& q : qs)
            if (q.id == qid) return q.default_id;
        return std::string();
    };

    PrivacySettings p;
    p.search_engine_id = pick("search_engine");
    p.https_only = pick("https_only") == "yes";
    p.block_trackers = pick("block_trackers") == "yes";
    p.block_third_party_cookies = pick("third_party_cookies") == "block";
    p.save_history = pick("history") == "save";
    p.clear_on_exit = pick("clear_on_exit") == "yes";

    if (pick("local_ai") == "yes") {
        std::string choice = pick("ai_model");  // "provider|model"
        auto bar = choice.find('|');
        if (bar != std::string::npos) {
            p.ai_enabled = true;
            p.ai_provider = choice.substr(0, bar);
            p.ai_model = choice.substr(bar + 1);
        }
    }

    db.exec("BEGIN;");
    try {
        SettingsStore s(db);
        p.save(s);
        s.set(kCompleteKey, "1");
        db.exec("COMMIT;");
    } catch (...) {
        db.exec("ROLLBACK;");
        throw;
    }
    return p;
}

}  // namespace vile
