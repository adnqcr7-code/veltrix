#pragma once
// vile-intelligence: on-device AI only. Detects local model servers (Ollama, LM Studio,
// llama.cpp) and runs a read-only page assistant against the one the user picked.
// Everything goes through HttpTransport, which in production is loopback-only.
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "vile/http.hpp"
#include "vile/privacy.hpp"

namespace vile {

enum class AiKind { Ollama, OpenAiCompatible };

struct AiModel {
    std::string name;
    std::int64_t size_bytes = 0;  // 0 if the server doesn't report it
};

struct LocalAiProvider {
    std::string id;  // "ollama" | "lmstudio" | "llamacpp"
    std::string display_name;
    std::string host;
    int port = 0;
    AiKind kind = AiKind::Ollama;
    std::vector<AiModel> models;
};

std::optional<LocalAiProvider> known_provider(const std::string& id);  // endpoint only, no models

// Probes the default local ports. Only providers that are running AND have at least one
// usable model are returned (embedding-only models are skipped).
std::vector<LocalAiProvider> detect_local_ai(HttpTransport& http, int timeout_ms = 400);

std::string format_size(std::int64_t bytes);  // "2.0 GB", "850 MB", or "" if unknown

struct PageContext {
    std::string url;
    std::string title;
    std::string text;  // visible text of the page, extracted by the engine layer
};

struct AiResult {
    bool ok = false;
    std::string text;
    std::string error;
};

// What was sent, shown to the user in the AI activity list (never the page text itself).
struct AiActivity {
    std::int64_t time = 0;
    std::string url;
    std::string provider;
    std::string model;
    std::string task;  // "explain" | "question"
    std::size_t chars_sent = 0;
};

class LocalAssistant {
public:
    LocalAssistant(HttpTransport& http, PrivacySettings settings);

    void set_settings(const PrivacySettings& s) { settings_ = s; }
    bool available() const;  // enabled, provider known, model chosen

    // Read-only: these only ask a model about the page. They never act on the browser.
    // Both block until the model answers (up to ~2 minutes): call off the UI thread.
    AiResult explain_page(const PageContext& page);
    AiResult ask_about_page(const PageContext& page, const std::string& question);

    const std::vector<AiActivity>& activity() const { return activity_; }

    // Cleans untrusted page text before it reaches a model: drops control characters and
    // invalid UTF-8, defuses the </page> delimiter, and truncates.
    static std::string sanitize_page_text(const std::string& text, std::size_t max_bytes = 12000);

private:
    AiResult run(const PageContext& page, const std::string& task_text, const char* task_label);

    HttpTransport& http_;
    PrivacySettings settings_;
    std::vector<AiActivity> activity_;
};

}  // namespace vile
