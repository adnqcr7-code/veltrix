#pragma once
// In-memory Engine used for tests and headless development. Like CEF it is
// asynchronous: events are queued and delivered when pump() is called.
#include <functional>
#include <map>
#include <queue>
#include <vector>

#include "vile/engine.hpp"

namespace vile {

class FakeEngine : public Engine {
public:
    void set_listener(EngineEvents* l) override { listener_ = l; }

    ViewId create_view(const std::string& url) override {
        ViewId id = next_id_++;
        views_[id] = {};
        navigate_to(id, url);
        return id;
    }
    void destroy_view(ViewId id) override { views_.erase(id); zoom_.erase(id); }

    bool load_url(ViewId id, const std::string& url) override {
        if (!views_.count(id)) return false;
        auto& v = views_[id];
        v.history.resize(v.pos + 1);  // drop forward entries
        navigate_to(id, url);
        return true;
    }
    void go_back(ViewId id) override {
        if (!can_go_back(id)) return;
        views_[id].pos--;
        emit_load(id, views_[id].history[views_[id].pos]);
    }
    void go_forward(ViewId id) override {
        if (!can_go_forward(id)) return;
        views_[id].pos++;
        emit_load(id, views_[id].history[views_[id].pos]);
    }
    void reload(ViewId id) override {
        auto it = views_.find(id);
        if (it != views_.end() && !it->second.history.empty())
            emit_load(id, it->second.history[it->second.pos]);
    }
    void stop(ViewId id) override { queue_.push([this, id] { if (listener_) listener_->on_loading_changed(id, false); }); }

    bool can_go_back(ViewId id) const override {
        auto it = views_.find(id);
        return it != views_.end() && it->second.pos > 0;
    }
    bool can_go_forward(ViewId id) const override {
        auto it = views_.find(id);
        return it != views_.end() && it->second.pos + 1 < it->second.history.size();
    }

    // Deliver all queued events (including ones queued by handlers).
    void pump() {
        while (!queue_.empty()) {
            auto fn = std::move(queue_.front());
            queue_.pop();
            fn();
        }
    }

    void find_text(ViewId id, const std::string& text, bool backward,
                   std::function<void(int, int)> on_result) override {
        if (!views_.count(id)) return;
        last_find_ = text;
        find_backward_ = backward;
        // Delivered on pump(), like the real adapter's async result —
        // a synchronous callback here would let tests pass against a
        // timing the shipped engine never exhibits.
        if (on_result) queue_.push([on_result] { on_result(0, 0); });
    }
    const std::string& last_find() const { return last_find_; }
    bool find_backward() const { return find_backward_; }

    void set_zoom(ViewId id, double factor) override {
        if (views_.count(id)) zoom_[id] = factor;
    }
    double zoom(ViewId id) const override {
        auto it = zoom_.find(id);
        return it != zoom_.end() ? it->second : 1.0;
    }

    void page_text(ViewId id,
                   std::function<void(const std::string&)> on_text) override {
        auto it = views_.find(id);
        if (it == views_.end() || !on_text) return;
        const std::string url =
            it->second.history.empty() ? std::string() : it->second.history[it->second.pos];
        // Existence is re-checked at DELIVERY: the real adapter may
        // never call back for a view that dies first, and a fake that
        // answers for a corpse teaches the wrong lesson.
        queue_.push([this, id, on_text, url] {
            if (views_.count(id)) on_text("Fake page text for " + url);
        });
    }

    void clear_site_data() override { ++clear_count_; }
    int clear_count() const { return clear_count_; }

    void set_private_mode(bool on) override { private_mode_ = on; }
    bool private_mode() const { return private_mode_; }

    size_t view_count() const { return views_.size(); }

private:
    struct View {
        std::vector<std::string> history;
        size_t pos = 0;
    };

    void navigate_to(ViewId id, const std::string& url) {
        auto& v = views_[id];
        v.history.push_back(url);
        v.pos = v.history.size() - 1;
        emit_load(id, url);
    }
    void emit_load(ViewId id, const std::string& url) {
        queue_.push([this, id, url] {
            if (!listener_) return;
            listener_->on_loading_changed(id, true);
            listener_->on_url_changed(id, url);
            listener_->on_title_changed(id, "Page: " + url);
            listener_->on_loading_changed(id, false);
        });
    }

    EngineEvents* listener_ = nullptr;
    ViewId next_id_ = 1;
    int clear_count_ = 0;
    bool private_mode_ = false;
    std::map<ViewId, View> views_;
    std::map<ViewId, double> zoom_;
    std::string last_find_;
    bool find_backward_ = false;
    std::queue<std::function<void()>> queue_;
};

}  // namespace vile
