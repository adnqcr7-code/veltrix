#pragma once
// vile-core: browser lifecycle. Owns tab state, drives the Engine, records history.
// The Qt UI and the future CLI/API all talk to this class, never to the engine directly.
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "vile/engine.hpp"
#include "vile/search_engines.hpp"
#include "vile/storage.hpp"

namespace vile {

using TabId = ViewId;

struct Tab {
    TabId id = 0;
    std::string url;
    std::string title;
    bool loading = false;
    bool pinned = false;
};

class Browser : public EngineEvents {
public:
    // history may be null. In private mode nothing is ever recorded.
    Browser(Engine& engine, HistoryStore* history = nullptr, bool private_mode = false);
    ~Browser() override;
    Browser(const Browser&) = delete;
    Browser& operator=(const Browser&) = delete;

    // Returns 0 if the input was rejected (e.g. "javascript:...").
    TabId open_tab(const std::string& input = "about:blank", int at = -1);
    // Insert at `at` (0-based) when given, else append — used by
    // "reopen closed tab" to restore the tab's old position.
    void close_tab(TabId);
    // Moves the tab to index `to` (clamped to the region it belongs to:
    // pinned tabs stay in the pinned region, unpinned tabs can't enter it).
    void move_tab(TabId, int to);
    // Opens a copy of the tab's page right after it and activates the
    // copy. Returns 0 when the tab doesn't exist.
    TabId duplicate_tab(TabId);
    // Pinning moves the tab into the pinned region at the front (after the
    // other pinned tabs); unpinning moves it to the first unpinned slot.
    void set_pinned(TabId, bool pinned);
    bool activate(TabId);
    bool navigate(TabId, const std::string& input);
    void back(TabId);
    void forward(TabId);
    void reload(TabId);
    void stop(TabId);

    // Page operations, forwarded to the engine (which owns the
    // per-view state): find in page, zoom, and the page's text for
    // the assistant. Unknown tabs are ignored.
    void find_text(TabId, const std::string& text, bool backward,
                   std::function<void(int active, int total)> on_result);
    void set_zoom(TabId, double factor);
    double zoom(TabId) const;
    void page_text(TabId, std::function<void(const std::string&)> on_text);

    // Call when the app quits: closes every tab, then optionally wipes site data
    // (settings.clear_on_exit) and history (when history recording is off).
    void close_session(bool clear_site_data, bool clear_history);
    bool can_go_back(TabId) const;
    bool can_go_forward(TabId) const;

    const std::vector<Tab>& tabs() const { return tabs_; }
    const Tab* find(TabId) const;
    std::optional<TabId> active_tab() const { return active_; }
    bool private_mode() const { return private_mode_; }
    // Private mode (e.g. !settings.save_history): also forwarded to the
    // engine, whose adapter makes storage memory-only.
    void set_private_mode(bool on);

    // Which engine the address bar uses for plain-text queries (default: Brave Search).
    // The engine must outlive the Browser; catalog entries do.
    void set_search_engine(const SearchEngine& e) { search_ = &e; }
    const SearchEngine& search_engine() const { return *search_; }

    // UI hook: fired whenever tab list, active tab, or tab metadata changes.
    std::function<void()> on_tabs_changed;

    // EngineEvents
    void on_url_changed(ViewId, const std::string&) override;
    void on_title_changed(ViewId, const std::string&) override;
    void on_loading_changed(ViewId, bool) override;

private:
    Tab* find_mut(TabId);
    void notify() { if (on_tabs_changed) on_tabs_changed(); }

    Engine& engine_;
    HistoryStore* history_;
    bool private_mode_;
    const SearchEngine* search_ = &default_search_engine();
    std::vector<Tab> tabs_;
    std::optional<TabId> active_;
};

}  // namespace vile
