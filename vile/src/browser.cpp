#include "vile/browser.hpp"

#include <algorithm>

#include "vile/url.hpp"

namespace vile {

Browser::Browser(Engine& engine, HistoryStore* history, bool private_mode)
    : engine_(engine), history_(history), private_mode_(private_mode) {
    engine_.set_listener(this);
    if (private_mode_) engine_.set_private_mode(true);
}

Browser::~Browser() {
    engine_.set_listener(nullptr);
    for (const auto& t : tabs_) engine_.destroy_view(t.id);
}

const Tab* Browser::find(TabId id) const {
    auto it = std::find_if(tabs_.begin(), tabs_.end(), [id](const Tab& t) { return t.id == id; });
    return it == tabs_.end() ? nullptr : &*it;
}

Tab* Browser::find_mut(TabId id) {
    return const_cast<Tab*>(static_cast<const Browser*>(this)->find(id));
}

TabId Browser::open_tab(const std::string& input, int at) {
    auto r = resolve_address_input(input, *search_);
    if (r.kind == ResolvedInput::Kind::Rejected) return 0;
    TabId id = engine_.create_view(r.url);
    if (id == 0) return 0;
    Tab t;
    t.id = id;
    t.url = r.url;
    t.loading = true;
    if (at >= 0 && at <= static_cast<int>(tabs_.size()))
        tabs_.insert(tabs_.begin() + at, std::move(t));
    else
        tabs_.push_back(std::move(t));
    active_ = id;
    notify();
    return id;
}

void Browser::set_private_mode(bool on) {
    private_mode_ = on;
    // The engine adapter owns the storage consequences (off-the-record
    // profile); forwarding here keeps the wiring structural — a missed
    // call is a compile/test failure, not a silent privacy leak.
    engine_.set_private_mode(on);
}

void Browser::move_tab(TabId id, int to) {
    auto it = std::find_if(tabs_.begin(), tabs_.end(), [id](const Tab& t) { return t.id == id; });
    if (it == tabs_.end()) return;
    Tab t = *it;
    tabs_.erase(it);
    int pinned = 0;
    for (const auto& x : tabs_)
        if (x.pinned) ++pinned;
    // After the erase, `pinned` counts the OTHER pinned tabs. A pinned tab
    // may land at 0..pinned (the pinned region); an unpinned tab at
    // pinned..size (everything after it).
    const int lo = t.pinned ? 0 : pinned;
    const int hi = t.pinned ? pinned : static_cast<int>(tabs_.size());
    const int at = std::clamp(to, lo, hi);
    tabs_.insert(tabs_.begin() + at, std::move(t));
    notify();
}

TabId Browser::duplicate_tab(TabId id) {
    const Tab* t = find(id);
    if (!t) return 0;
    const std::string url = t->url;
    size_t idx = 0;
    for (const auto& x : tabs_) {
        if (x.id == id) break;
        ++idx;
    }
    return open_tab(url, static_cast<int>(idx) + 1);
}

void Browser::set_pinned(TabId id, bool pinned) {
    auto it = std::find_if(tabs_.begin(), tabs_.end(), [id](const Tab& t) { return t.id == id; });
    if (it == tabs_.end()) return;
    Tab t = *it;
    t.pinned = pinned;
    tabs_.erase(it);
    // The tab joins the end of the pinned region when pinning, and the
    // start of the unpinned region when unpinning; both are the index
    // equal to the number of pinned tabs that remain.
    size_t at = 0;
    for (const auto& x : tabs_)
        if (x.pinned) ++at;
    tabs_.insert(tabs_.begin() + static_cast<std::ptrdiff_t>(at), std::move(t));
    notify();
}

void Browser::close_tab(TabId id) {
    auto it = std::find_if(tabs_.begin(), tabs_.end(), [id](const Tab& t) { return t.id == id; });
    if (it == tabs_.end()) return;
    size_t idx = static_cast<size_t>(it - tabs_.begin());
    engine_.destroy_view(id);
    tabs_.erase(it);
    if (active_ == id) {
        if (tabs_.empty()) active_.reset();
        else active_ = tabs_[std::min(idx, tabs_.size() - 1)].id;
    }
    notify();
}

bool Browser::activate(TabId id) {
    if (!find(id)) return false;
    active_ = id;
    notify();
    return true;
}

void Browser::find_text(TabId id, const std::string& text, bool backward,
                        std::function<void(int, int)> on_result) {
    if (find(id)) engine_.find_text(id, text, backward, std::move(on_result));
}

void Browser::set_zoom(TabId id, double factor) {
    if (find(id)) engine_.set_zoom(id, factor);
}

double Browser::zoom(TabId id) const {
    return find(id) ? engine_.zoom(id) : 1.0;
}

void Browser::page_text(TabId id, std::function<void(const std::string&)> on_text) {
    if (find(id)) engine_.page_text(id, std::move(on_text));
}

bool Browser::navigate(TabId id, const std::string& input) {
    // Honest contract: false means the navigation definitely did not
    // start — no such tab, the input was rejected, or the engine has
    // no live view / a valid URL for it. True means a live view
    // accepted the URL; whether the page loads is reported later
    // through the engine events, not by this return value.
    if (!find(id)) return false;
    auto r = resolve_address_input(input, *search_);
    if (r.kind == ResolvedInput::Kind::Rejected) return false;
    return engine_.load_url(id, r.url);
}

void Browser::back(TabId id) { if (find(id)) engine_.go_back(id); }
void Browser::forward(TabId id) { if (find(id)) engine_.go_forward(id); }
void Browser::reload(TabId id) { if (find(id)) engine_.reload(id); }
void Browser::stop(TabId id) { if (find(id)) engine_.stop(id); }
void Browser::close_session(bool clear_site_data, bool clear_history) {
    while (!tabs_.empty()) close_tab(tabs_.back().id);
    if (clear_site_data) engine_.clear_site_data();
    if (clear_history && history_) history_->clear();
}

bool Browser::can_go_back(TabId id) const { return find(id) && engine_.can_go_back(id); }
bool Browser::can_go_forward(TabId id) const { return find(id) && engine_.can_go_forward(id); }

// ---- engine events (unknown ids are ignored: the tab may already be closed) ----

void Browser::on_url_changed(ViewId id, const std::string& url) {
    if (Tab* t = find_mut(id)) { t->url = url; notify(); }
}

void Browser::on_title_changed(ViewId id, const std::string& title) {
    if (Tab* t = find_mut(id)) { t->title = title; notify(); }
}

void Browser::on_loading_changed(ViewId id, bool loading) {
    Tab* t = find_mut(id);
    if (!t) return;
    t->loading = loading;
    // Record once a page has finished loading, never in private mode.
    if (!loading && !private_mode_ && history_ && is_safe_to_record(t->url))
        history_->record_visit(t->url, t->title);
    notify();
}

}  // namespace vile
