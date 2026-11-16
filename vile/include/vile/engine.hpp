#pragma once
// vile-engine boundary. The core talks ONLY to this interface; adapters
// (the Qt WebEngine adapter in qt/, the FakeEngine in tests) plug in here.
#include <cstdint>
#include <functional>
#include <string>

namespace vile {

using ViewId = std::uint64_t;  // 0 is never a valid id

// Events flow engine -> core. CEF delivers these asynchronously on the UI thread.
class EngineEvents {
public:
    virtual ~EngineEvents() = default;
    virtual void on_url_changed(ViewId, const std::string& url) = 0;
    virtual void on_title_changed(ViewId, const std::string& title) = 0;
    virtual void on_loading_changed(ViewId, bool loading) = 0;
};

// Commands flow core -> engine.
class Engine {
public:
    virtual ~Engine() = default;
    virtual void set_listener(EngineEvents* listener) = 0;

    virtual ViewId create_view(const std::string& url) = 0;
    virtual void destroy_view(ViewId) = 0;

    // Hands a URL to a live view for loading. Returns false when the
    // load definitely did not start (no such view, invalid URL) —
    // callers must not report success on false. A true return means
    // the view accepted the URL; the load itself may still fail,
    // which is reported asynchronously through the events listener.
    virtual bool load_url(ViewId, const std::string& url) = 0;
    virtual void go_back(ViewId) = 0;
    virtual void go_forward(ViewId) = 0;
    virtual void reload(ViewId) = 0;
    virtual void stop(ViewId) = 0;
    virtual bool can_go_back(ViewId) const = 0;
    virtual bool can_go_forward(ViewId) const = 0;

    // Find in page. The result is reported through on_result
    // (active match, total matches) when the adapter has it; an
    // empty query clears the find state. A null on_result means the
    // caller doesn't care about the count.
    virtual void find_text(ViewId, const std::string& text, bool backward,
                           std::function<void(int active, int total)> on_result) = 0;

    // Zoom. The ADAPTER owns the per-view factor (the UI used to keep
    // it in a dynamic property on the widget — a string-keyed bag
    // invisible to the core and to tests). zoom() returns 1.0 for a
    // view the adapter has never zoomed.
    virtual void set_zoom(ViewId, double factor) = 0;
    virtual double zoom(ViewId) const = 0;

    // The page's visible text, for the local assistant. Async: the
    // callback may legitimately NEVER fire (the view died first), so
    // callers must not wait on it unguarded.
    virtual void page_text(ViewId,
                           std::function<void(const std::string&)> on_text) = 0;

    // Wipe cookies, local storage and cache (used by "clear on exit").
    virtual void clear_site_data() = 0;

    // Private mode: nothing the engine stores may persist — cookies,
    // cache, local storage, IndexedDB all become memory-only. Adapters
    // implement this with an off-the-record/in-memory profile and apply
    // it to live views, not just future ones. The core owns the decision;
    // Browser::set_private_mode forwards here so the wiring is structural
    // (and testable), not a UI-layer convention.
    virtual void set_private_mode(bool on) = 0;
};

}  // namespace vile
