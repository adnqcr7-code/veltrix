#pragma once
// First-run setup: six privacy questions, plus a seventh (and a model picker) that is
// only asked when local AI is detected on this computer. All validation and persistence
// lives here so any front end (Qt, CLI) behaves identically.
#include <map>
#include <string>
#include <vector>

#include "vile/local_ai.hpp"
#include "vile/privacy.hpp"
#include "vile/storage.hpp"

namespace vile {

struct AnswerOption {
    std::string id;
    std::string label;
    std::string promise;   // what you get
    std::string downside;  // what it costs you (may be empty)
    std::string source_url;
    std::string summary = {};  // short text for the option card
};

struct Question {
    std::string id;
    std::string prompt;
    std::vector<AnswerOption> options;
    std::string default_id;  // the most private choice
};

class Onboarding {
public:
    static bool is_complete(const SettingsStore&);

    // The six standard questions (always asked).
    static const std::vector<Question>& questions();

    // The standard six, plus "local_ai" and "ai_model" when providers were detected.
    // The UI shows "ai_model" only if the user answered local_ai = "yes".
    // Model option ids look like "ollama|llama3.2:3b" (provider|model).
    static std::vector<Question> questions_for(const std::vector<LocalAiProvider>& detected);

    // Returns an empty string if valid, else a description of the problem.
    // Missing questions fall back to their (private) defaults.
    static std::string validate(const std::map<std::string, std::string>& answers,
                                const std::vector<LocalAiProvider>& detected = {});

    // Validates, saves everything in one transaction, marks setup complete.
    // Throws std::invalid_argument on bad answers.
    static PrivacySettings apply(Database&, const std::map<std::string, std::string>& answers,
                                 const std::vector<LocalAiProvider>& detected = {});
};

}  // namespace vile
